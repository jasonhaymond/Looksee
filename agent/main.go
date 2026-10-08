// Looksee agent: a single cross-platform binary that reports host metrics
// and the results of its assigned checks back to a Looksee engine on an
// interval. No runtime dependency beyond the OS itself — see README.md.
package main

import (
	"crypto/sha256"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"runtime"
	"sync"
	"time"

	"looksee-agent/internal/checks"
	"looksee-agent/internal/collector"
	"looksee-agent/internal/config"
	"looksee-agent/internal/metrics"
	"looksee-agent/internal/report"
	"looksee-agent/internal/selfupdate"
)

// Set via -ldflags "-X main.version=..." in build-all.sh, from the single
// source of truth at agent/VERSION. "dev" for a manual `go build`.
var version = "dev"

// Discovery lists (every process/service name) change slowly and listing
// services is expensive on Windows, so they're refreshed every few cycles.
const discoveryEvery = 10

func main() {
	configPath := flag.String("config", "looksee-agent.yaml", "path to the agent's config file")
	diskPath := flag.String("disk-path", defaultDiskPath(), "filesystem path reported as the legacy single disk-usage figure")
	showVersion := flag.Bool("version", false, "print the agent's version and exit")
	once := flag.Bool("once", false, "collect and report a single cycle, then exit (for testing)")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	// Leftover from a Windows update that hasn't been cleaned up yet — the
	// process that renamed it aside has already exited by the time a fresh
	// one starts. No-op on every other platform and on a normal start.
	selfupdate.CleanupPrevious()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("looksee-agent: %v", err)
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
	}
	interval := time.Duration(cfg.IntervalSeconds) * time.Second
	log.Printf("looksee-agent %s starting, reporting to %s every %s", version, cfg.EngineURL, interval)

	for cycle := 0; ; cycle++ {
		a.runOnce(cycle)
		if *once {
			// Let in-flight checks finish so a single test run reports them.
			a.wg.Wait()
			a.runOnce(cycle + 1)
			return
		}
		time.Sleep(interval)
	}
}

type agent struct {
	cfg       config.Config
	client    *report.Client
	collector *metrics.Collector
	slow      *metrics.SlowCollector
	runner    *checks.Runner
	site      *collector.Supervisor

	mu        sync.Mutex
	inFlight  map[string]bool
	completed []checks.Result
	wg        sync.WaitGroup

	discovery     report.Discovery
	inventoryHash string
	inventoryAt   time.Time
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

func (a *agent) drain() []checks.Result {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := a.completed
	a.completed = nil
	return out
}

func (a *agent) runOnce(cycle int) {
	snap := a.collector.Collect()

	cfgResp, err := a.client.FetchConfig()
	if err != nil {
		log.Printf("fetching agent config: %v", err)
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

	if cycle%discoveryEvery == 0 {
		a.discovery = report.Discovery{}
		if names, err := metrics.ListProcessNames(); err != nil {
			log.Printf("listing processes: %v", err)
		} else {
			a.discovery.Processes = names
		}
		if names, err := metrics.ListServiceNames(); err != nil {
			log.Printf("listing services: %v", err)
		} else {
			a.discovery.Services = names
		}
		a.discovery.Containers = checks.ListContainers(a.cfg.DockerSocket)
	}
	discovery := report.Discovery{}
	if cycle%discoveryEvery == 0 {
		discovery = a.discovery
	}

	// Inventory goes out when it changes, and at least every 6 hours.
	var inventory map[string]any
	if inv := a.slow.Inventory(); inv != nil {
		b, _ := json.Marshal(inv)
		h := fmt.Sprintf("%x", sha256.Sum256(b))
		if h != a.inventoryHash || time.Since(a.inventoryAt) > 6*time.Hour {
			inventory, a.inventoryHash, a.inventoryAt = inv, h, time.Now()
		}
	}

	results := a.drain()
	if err := a.client.SendReport(snap, results, discovery, inventory, version, a.site.LastError()); err != nil {
		log.Printf("sending report: %v", err)
		// Keep results for the next attempt rather than dropping them.
		a.mu.Lock()
		a.completed = append(results, a.completed...)
		if len(a.completed) > 500 {
			a.completed = a.completed[len(a.completed)-500:]
		}
		a.mu.Unlock()
		a.inventoryHash = ""
	}
}

func defaultDiskPath() string {
	if runtime.GOOS == "windows" {
		return "C:\\"
	}
	return "/"
}
