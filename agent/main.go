// Looksee agent: a single cross-platform binary that reports host metrics
// and the results of its assigned checks back to a Looksee engine on an
// interval. No runtime dependency beyond the OS itself — see README.md.
//
// Each cycle (every interval_seconds, 30 by default) it: collects metrics,
// fetches its config from the engine (which checks to run, update and
// collector requests), starts any checks that are due, and posts a report.
// Anything slow — process/service discovery, software inventory, long
// checks — runs in the background and rides along with a later report, so
// the check-in itself is never held up by it.
//
// Security: the agent key from the config file is the only credential; it's
// sent as a bearer token over the engine URL (HTTPS in production) and never
// logged. The engine decides which checks run; it can't send code to run
// (script checks only run files already in the local script_dir).
package main

import (
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"time"

	"looksee-agent/internal/android"
	"looksee-agent/internal/checks"
	"looksee-agent/internal/collector"
	"looksee-agent/internal/config"
	"looksee-agent/internal/logfile"
	"looksee-agent/internal/metrics"
	"looksee-agent/internal/report"
	"looksee-agent/internal/selfupdate"
	"looksee-agent/internal/watchdog"
)

// Set via -ldflags "-X main.version=..." in build-all.sh, from the single
// source of truth at agent/VERSION. "dev" for a manual `go build`.
var version = "dev"

// Discovery lists (every process/service name) change slowly and listing
// services is expensive on Windows, so they're refreshed every few cycles.
const discoveryEvery = 10

// The agent's log file is rotated at this size (one older copy is kept).
const logFileMaxBytes = 5 << 20 // 5 MB

// After this many refused requests in a row (401 key not accepted, 403
// address blocked), the agent polls less often — see authBackoff.
const authFailuresBeforeBackoff = 3

// The longest the agent waits between polls while it's being refused.
const maxAuthBackoff = 10 * time.Minute

func main() {
	configPath := flag.String("config", "looksee-agent.yaml", "path to the agent's config file")
	diskPath := flag.String("disk-path", defaultDiskPath(), "filesystem path reported as the legacy single disk-usage figure")
	showVersion := flag.Bool("version", false, "print the agent's version and exit")
	once := flag.Bool("once", false, "collect and report a single cycle, then exit (for testing)")
	logFile := flag.String("log-file", "auto", `also write the log to this file (rotated at 5 MB); "auto" = looksee-agent.log next to the config file on Windows, none elsewhere; "none" = console only`)
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	// Set up the log file before anything can fail, so even "can't read
	// the config file" is written somewhere an admin can find it.
	if path := resolveLogFile(*logFile, *configPath); path != "" {
		if w, err := logfile.Open(path, logFileMaxBytes); err != nil {
			log.Printf("looksee-agent: can't write log file %s (continuing with console only): %v", path, err)
		} else {
			// io.MultiWriter sends each log line to both the console and the file.
			log.SetOutput(io.MultiWriter(os.Stderr, w))
		}
	}

	// Leftover from a Windows update that hasn't been cleaned up yet — the
	// process that renamed it aside has already exited by the time a fresh
	// one starts. No-op on every other platform and on a normal start.
	selfupdate.CleanupPrevious()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("looksee-agent: %v", err)
	}
	if cfg.ProxyURL != "" {
		applyProxy(cfg.ProxyURL)
	}
	// Android (Termux) has no /etc/resolv.conf, so DNS is pointed at a real
	// server before the first lookup (internal/android).
	if server := android.ConfigureDNS(cfg.DNSServer); server != "" {
		log.Printf("looksee-agent: using DNS server %s", server)
	}

	slow := metrics.NewSlowCollector(cfg.NTPServer)
	slow.Start()
	a := &agent{
		cfg:       cfg,
		client:    report.NewClient(cfg.EngineURL, cfg.AgentKey),
		collector: metrics.NewCollector(*diskPath, slow),
		slow:      slow,
		runner:    checks.NewRunner(checks.Options{ScriptDir: cfg.ScriptDir, DockerSocket: cfg.DockerSocket}),
		inFlight:  map[string]bool{},
		site:      collector.New(cfg.EngineURL, cfg.AgentKey, collector.DefaultDir()),
		watch:     watchdog.New(watchdog.DefaultPath(*configPath), time.Now()),
	}
	interval := time.Duration(cfg.IntervalSeconds) * time.Second
	log.Printf("looksee-agent %s starting on %s/%s, reporting to %s every %s", version, runtime.GOOS, runtime.GOARCH, cfg.EngineURL, interval)

	for cycle := 0; ; cycle++ {
		a.runOnce(cycle)
		if *once {
			// Let in-flight checks and discovery finish so a single test run
			// reports them.
			a.wg.Wait()
			a.discWG.Wait()
			a.runOnce(cycle + 1)
			return
		}
		time.Sleep(a.authBackoff(interval))
	}
}

// resolveLogFile turns the -log-file flag into a path ("" = no file).
// "auto" means: on Windows, looksee-agent.log in the config file's folder
// (C:\ProgramData\LookseeAgent for a normal install), because the Scheduled
// Task the agent runs under discards console output; elsewhere none, since
// systemd's journal and launchd's log file already capture it.
func resolveLogFile(flagValue, configPath string) string {
	switch flagValue {
	case "", "none":
		return ""
	case "auto":
		if runtime.GOOS != "windows" {
			return ""
		}
		abs, err := filepath.Abs(configPath)
		if err != nil {
			return ""
		}
		return filepath.Join(filepath.Dir(abs), "looksee-agent.log")
	default:
		return flagValue
	}
}

// applyProxy sends the agent's own engine traffic through the proxy in the
// config (proxy_url). Every client that talks to the engine — reports,
// config polls, self-update and collector downloads, watchdog webhooks —
// uses Go's default HTTP transport, so setting its proxy covers all of
// them. Check probes build their own transports and still go direct, which
// is what LAN checks need. The URL was validated by config.Load.
func applyProxy(raw string) {
	u, _ := url.Parse(raw)
	if t, ok := http.DefaultTransport.(*http.Transport); ok {
		t.Proxy = http.ProxyURL(u)
		// Log the proxy without any user:password it may contain.
		log.Printf("using proxy %s://%s for connections to the engine", u.Scheme, u.Host)
	}
}

type agent struct {
	cfg       config.Config
	client    *report.Client
	collector *metrics.Collector
	slow      *metrics.SlowCollector
	runner    *checks.Runner
	site      *collector.Supervisor
	// Alerts by email/chat if the engine can't be reached (when this
	// endpoint is a watchdog agent; otherwise it does nothing).
	watch *watchdog.Watchdog

	mu        sync.Mutex
	inFlight  map[string]bool
	completed []checks.Result
	wg        sync.WaitGroup

	// Discovery (process/service/container lists and inventories) runs in
	// the background; a finished one waits in discReady until a report
	// takes it. discMu guards both fields; discWG lets -once wait for it.
	discMu      sync.Mutex
	discRunning bool
	discReady   *report.Discovery
	discWG      sync.WaitGroup

	inventoryHash string
	inventoryAt   time.Time
	// The software report (installed and upgradable packages) is large, so
	// like the inventory it's only sent when it changed, or once a day.
	softwareHash string
	softwareAt   time.Time

	// Requests the engine refused in a row (401/403) and the last such
	// status — drive authBackoff. Only touched by the main loop.
	authFailures int
	authStatus   int
	// Whether a report has been accepted since the agent started — the first
	// one is logged, so the log shows the agent did check in.
	reported bool
}

// Checks run in the background: a slow one (a borg repository listing, a
// big folder walk) doesn't delay the report — its result simply goes out
// with whichever report follows its completion.
func (a *agent) startCheck(c checks.Check) {
	a.mu.Lock()
	if a.inFlight[c.ID] {
		a.mu.Unlock()
		return
	}
	a.inFlight[c.ID] = true
	a.mu.Unlock()
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		res := a.runner.Run(c)
		a.mu.Lock()
		delete(a.inFlight, c.ID)
		a.completed = append(a.completed, res)
		a.mu.Unlock()
	}()
}

// drain takes every finished check result, to send with this report.
func (a *agent) drain() []checks.Result {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := a.completed
	a.completed = nil
	return out
}

// startDiscovery begins listing processes, services, containers and
// scripts in the background, unless a listing is already running. Each
// listing has its own timeout, but even a slow one (thousands of processes,
// a domain-joined machine whose owner lookups wait on the network) can no
// longer delay a report — before 5.1 this ran inline, before the first
// report, and could keep a new install from ever checking in.
func (a *agent) startDiscovery() {
	a.discMu.Lock()
	if a.discRunning {
		a.discMu.Unlock()
		return
	}
	a.discRunning = true
	a.discMu.Unlock()
	a.discWG.Add(1)
	go func() {
		defer a.discWG.Done()
		d := a.collectDiscovery()
		a.discMu.Lock()
		a.discReady = &d
		a.discRunning = false
		a.discMu.Unlock()
	}()
}

// collectDiscovery does the listing itself; each part is best-effort, and
// a part that fails is logged and left out.
func (a *agent) collectDiscovery() report.Discovery {
	d := report.Discovery{}
	if names, err := metrics.ListProcessNames(); err != nil {
		log.Printf("listing processes: %v", err)
	} else {
		d.Processes = names
	}
	if names, err := metrics.ListServiceNames(); err != nil {
		log.Printf("listing services: %v", err)
	} else {
		d.Services = names
	}
	d.Containers = checks.ListContainers(a.cfg.DockerSocket)
	if procs, err := metrics.ListProcesses(); err != nil {
		log.Printf("process inventory: %v", err)
	} else {
		d.ProcessInventory = procs
	}
	if svcs, err := metrics.ListServices(); err != nil {
		log.Printf("service inventory: %v", err)
	} else {
		d.ServiceInventory = svcs
	}
	d.Scripts = metrics.ListScripts(a.cfg.ScriptDir)
	d.ScriptsListed = a.cfg.ScriptDir != ""
	return d
}

// takeDiscovery returns a finished discovery for this report (and forgets
// it), or an empty one if none is ready.
func (a *agent) takeDiscovery() (report.Discovery, bool) {
	a.discMu.Lock()
	defer a.discMu.Unlock()
	if a.discReady == nil {
		return report.Discovery{}, false
	}
	d := *a.discReady
	a.discReady = nil
	return d, true
}

// putBackDiscovery keeps a discovery whose report failed, so the next
// report sends it — unless a newer one has finished meanwhile.
func (a *agent) putBackDiscovery(d report.Discovery) {
	a.discMu.Lock()
	defer a.discMu.Unlock()
	if a.discReady == nil {
		a.discReady = &d
	}
}

// authBackoff is how long to wait before the next cycle. Normally the
// configured interval; after authFailuresBeforeBackoff refused requests in a
// row it doubles each cycle up to maxAuthBackoff. An agent with an old key,
// or behind a blocked address, would otherwise keep hammering the engine
// every 30 seconds — and each refused try counts toward the engine's
// "Agent key guessing" rule.
func (a *agent) authBackoff(interval time.Duration) time.Duration {
	if a.authFailures < authFailuresBeforeBackoff {
		return interval
	}
	d := interval
	for i := authFailuresBeforeBackoff; i <= a.authFailures && d < maxAuthBackoff; i++ {
		d *= 2
	}
	if d > maxAuthBackoff {
		d = maxAuthBackoff
	}
	return d
}

// noteRefused records a 401/403 from the engine and logs, in plain terms,
// what it most likely means — once when it starts, and again when the
// agent starts backing off.
func (a *agent) noteRefused(code int) {
	a.authFailures++
	a.authStatus = code
	if a.authFailures == 1 || a.authFailures == authFailuresBeforeBackoff {
		why := "the engine didn't accept this agent's key (401) — the key was probably regenerated or the endpoint deleted; reinstall the agent with the endpoint's current install command"
		if code == http.StatusForbidden {
			why = "the engine refused this machine's address (403) — it may be blocked on the Security page, or not on the IP allowlist when that also applies to agents"
		}
		log.Printf("%s; refused %d time(s) in a row", why, a.authFailures)
		if a.authFailures == authFailuresBeforeBackoff {
			log.Printf("polling less often until the engine accepts this agent again (up to every %s)", maxAuthBackoff)
		}
	}
}

// runOnce is one cycle: collect, poll config, start due checks, report.
func (a *agent) runOnce(cycle int) {
	snap := a.collector.Collect()

	cfgResp, err := a.client.FetchConfig()
	if err != nil {
		log.Printf("fetching agent config: %v", err)
		a.watch.Unreachable(err, time.Now())
		// Refused outright (wrong key, blocked address): a report would be
		// refused the same way, so don't send one this cycle.
		if code := report.StatusCode(err); code == http.StatusUnauthorized || code == http.StatusForbidden {
			a.noteRefused(code)
			return
		}
	} else {
		if a.authFailures > 0 {
			log.Printf("the engine accepts this agent again (after %d refused request(s), last status %d)", a.authFailures, a.authStatus)
		}
		a.authFailures = 0
		a.watch.Reachable(cfgResp.Watchdog, time.Now())
		var lockfiles []string
		if cfgResp.SoftwareScan != nil {
			lockfiles = cfgResp.SoftwareScan.Lockfiles
		}
		a.slow.SetLockfiles(lockfiles)
	}

	if cfgResp.UpdateAvailable {
		log.Printf("update requested — downloading and installing looksee-agent for %s", selfupdate.Platform())
		if err := selfupdate.Apply(a.cfg.EngineURL); err != nil {
			log.Printf("self-update failed, continuing on the current version: %v", err)
		} else if a.site.Shutdown(); selfupdate.Supervised() {
			log.Printf("update installed, exiting so the service manager restarts the new version")
			os.Exit(selfupdate.RestartExitCode)
		} else if err := selfupdate.Relaunch(); err != nil {
			log.Printf("update installed but failed to relaunch — restart the service manually: %v", err)
		} else {
			log.Printf("update installed, relaunching")
			os.Exit(0)
		}
	}

	// Only act on a successful poll: an engine outage must not stop a running
	// collector (it buffers and keeps monitoring its site meanwhile).
	if err == nil {
		a.site.Apply(cfgResp.Collector)
	}

	now := time.Now()
	active := map[string]bool{}
	for _, c := range cfgResp.Checks {
		active[c.ID] = true
		if a.runner.Due(c, now) {
			a.startCheck(c)
		}
	}
	if err == nil {
		a.runner.Forget(active)
	}
	// Give quick checks a moment so most results ride along with this
	// report rather than the next one.
	waitUntil := time.Now().Add(8 * time.Second)
	for time.Now().Before(waitUntil) {
		a.mu.Lock()
		pending := len(a.inFlight)
		a.mu.Unlock()
		if pending == 0 {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}

	// Refresh discovery every few cycles, in the background; whatever has
	// finished (from this cycle or an earlier one) goes with this report.
	if cycle%discoveryEvery == 0 {
		a.startDiscovery()
	}
	discovery, haveDiscovery := a.takeDiscovery()

	// Inventory goes out when it changes, and at least every 6 hours.
	var inventory map[string]any
	if inv := a.slow.Inventory(); inv != nil {
		b, _ := json.Marshal(inv)
		h := fmt.Sprintf("%x", sha256.Sum256(b))
		if h != a.inventoryHash || time.Since(a.inventoryAt) > 6*time.Hour {
			inventory, a.inventoryHash, a.inventoryAt = inv, h, time.Now()
		}
	}

	var software *metrics.Software
	if sw := a.slow.Software(); sw != nil {
		b, _ := json.Marshal(sw)
		h := fmt.Sprintf("%x", sha256.Sum256(b))
		if h != a.softwareHash || time.Since(a.softwareAt) > 24*time.Hour {
			software, a.softwareHash, a.softwareAt = sw, h, time.Now()
		}
	}

	results := a.drain()
	err = a.client.SendReport(snap, results, discovery, inventory, version, a.site.LastError(), a.watch.Status(), software)
	if report.StatusCode(err) == http.StatusRequestEntityTooLarge {
		// Over the engine's size limit — the process, service and software
		// lists are the big parts. Send the essentials (metrics, results,
		// version) now so the endpoint still checks in; the large parts are
		// treated as sent and only go again once they change.
		log.Printf("report too large for the engine (413) — resending without process/service lists, inventory and software")
		err = a.client.SendReport(snap, results, report.Discovery{}, nil, version, a.site.LastError(), a.watch.Status(), nil)
		haveDiscovery = false
	}
	if err != nil {
		log.Printf("sending report: %v", err)
		if code := report.StatusCode(err); code == http.StatusUnauthorized || code == http.StatusForbidden {
			a.noteRefused(code)
		}
		// Keep results for the next attempt rather than dropping them.
		a.mu.Lock()
		a.completed = append(results, a.completed...)
		if len(a.completed) > 500 {
			a.completed = a.completed[len(a.completed)-500:]
		}
		a.mu.Unlock()
		if haveDiscovery {
			a.putBackDiscovery(discovery)
		}
		a.inventoryHash = ""
		a.softwareHash = ""
		return
	}
	if !a.reported {
		a.reported = true
		log.Printf("first report accepted by the engine — this endpoint is checked in")
	}
}

func defaultDiskPath() string {
	if runtime.GOOS == "windows" {
		return "C:\\"
	}
	return "/"
}
