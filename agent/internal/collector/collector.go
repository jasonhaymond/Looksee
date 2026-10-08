// Package collector runs the Looksee site collector when the engine says
// this host is a site's collector: it downloads the collector bundle and a
// Node.js runtime from the engine (verifying each SHA-256 against the
// engine's manifest), keeps the process running, restarts it if it dies,
// and stops it when the host stops being a collector.
package collector

import (
	"bufio"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
	"time"
)

// Spec is the engine's instruction, from GET /api/agent/config.
type Spec struct {
	Version      string `json:"version"`
	Node         string `json:"node"`
	BundleSha256 string `json:"bundleSha256"`
}

type manifestFile struct {
	File   string `json:"file"`
	Sha256 string `json:"sha256"`
}

type manifest struct {
	Version  string                  `json:"version"`
	Node     string                  `json:"node"`
	Bundle   manifestFile            `json:"bundle"`
	Runtimes map[string]manifestFile `json:"runtimes"`
}

// installed records what's on disk, so a restart doesn't re-download.
type installed struct {
	Node         string `json:"node"`
	NodeSha256   string `json:"nodeSha256"`
	BundleSha256 string `json:"bundleSha256"`
	Version      string `json:"version"`
}

type Supervisor struct {
	engineURL string
	agentKey  string
	dir       string
	http      *http.Client

	mu        sync.Mutex
	want      *Spec
	busy      bool
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	exited    chan struct{}
	failures  int
	lastError string
}

func New(engineURL, agentKey, dir string) *Supervisor {
	return &Supervisor{engineURL: engineURL, agentKey: agentKey, dir: dir, http: &http.Client{Timeout: 15 * time.Minute}}
}

// DefaultDir is a "collector" folder beside the agent binary — writable by
// the agent on every platform (on Linux that's its StateDirectory).
func DefaultDir() string {
	exe, err := os.Executable()
	if err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		return filepath.Join(filepath.Dir(exe), "collector")
	}
	return "collector"
}

// LastError is the most recent problem installing or running the collector,
// reported to the engine so it shows on the dashboard.
func (s *Supervisor) LastError() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastError
}

func (s *Supervisor) setError(format string, args ...any) {
	msg := fmt.Sprintf(format, args...)
	log.Printf("collector: %s", msg)
	s.mu.Lock()
	s.lastError = msg
	s.mu.Unlock()
}

// Apply is called every agent cycle with the engine's current instruction
// (nil = not a collector). Downloads happen in the background so a slow
// runtime download never delays the agent's own report.
func (s *Supervisor) Apply(spec *Spec) {
	s.mu.Lock()
	s.want = spec
	busy := s.busy
	running := s.cmd != nil
	s.mu.Unlock()

	if spec == nil {
		if running {
			log.Printf("collector: this host is no longer a site collector — stopping it")
			s.stop()
		}
		s.mu.Lock()
		s.lastError = ""
		s.mu.Unlock()
		return
	}
	if busy {
		return
	}
	have := s.readInstalled()
	if have.BundleSha256 == spec.BundleSha256 && have.Node == spec.Node && s.filesPresent() {
		if !running {
			s.start()
		}
		return
	}
	s.mu.Lock()
	s.busy = true
	s.mu.Unlock()
	go func() {
		defer func() {
			s.mu.Lock()
			s.busy = false
			s.mu.Unlock()
		}()
		if err := s.install(have); err != nil {
			s.setError("installing the site collector failed: %v", err)
			return
		}
		s.mu.Lock()
		stillWanted := s.want != nil
		s.mu.Unlock()
		if stillWanted {
			s.start()
		}
	}()
}

func (s *Supervisor) nodePath() string {
	if runtime.GOOS == "windows" {
		return filepath.Join(s.dir, "node.exe")
	}
	return filepath.Join(s.dir, "node")
}

func (s *Supervisor) bundlePath() string { return filepath.Join(s.dir, "collector.cjs") }

func (s *Supervisor) filesPresent() bool {
	for _, p := range []string{s.nodePath(), s.bundlePath()} {
		if _, err := os.Stat(p); err != nil {
			return false
		}
	}
	return true
}

func (s *Supervisor) readInstalled() installed {
	var have installed
	if b, err := os.ReadFile(filepath.Join(s.dir, "installed.json")); err == nil {
		_ = json.Unmarshal(b, &have)
	}
	return have
}

func (s *Supervisor) install(have installed) error {
	if err := os.MkdirAll(s.dir, 0o750); err != nil {
		return err
	}
	var m manifest
	if err := s.getJSON("/install/collector/manifest.json", &m); err != nil {
		return fmt.Errorf("fetching the collector manifest: %w", err)
	}
	platform := runtime.GOOS + "-" + runtime.GOARCH
	rt, ok := m.Runtimes[platform]
	if !ok {
		return fmt.Errorf("the Looksee server has no Node runtime for %s — add it to COLLECTOR_PLATFORMS and re-run scripts/update.sh", platform)
	}

	var newNode, newBundle string
	if have.Node != m.Node || have.NodeSha256 != rt.Sha256 || !fileHasHash(s.nodePath(), rt.Sha256) {
		log.Printf("collector: downloading Node %s for %s", m.Node, platform)
		newNode = s.nodePath() + ".new"
		if err := s.download("/install/collector/files/"+rt.File, newNode, true, rt.Sha256); err != nil {
			return err
		}
	}
	if have.BundleSha256 != m.Bundle.Sha256 || !fileHasHash(s.bundlePath(), m.Bundle.Sha256) {
		log.Printf("collector: downloading site collector %s", m.Version)
		newBundle = s.bundlePath() + ".new"
		if err := s.download("/install/collector/files/"+m.Bundle.File, newBundle, false, m.Bundle.Sha256); err != nil {
			return err
		}
	}

	// A running node.exe can't be replaced on Windows, so stop first.
	s.stop()
	if newNode != "" {
		if err := os.Chmod(newNode, 0o755); err != nil {
			return err
		}
		if err := os.Rename(newNode, s.nodePath()); err != nil {
			return fmt.Errorf("installing the Node runtime: %w", err)
		}
	}
	if newBundle != "" {
		if err := os.Rename(newBundle, s.bundlePath()); err != nil {
			return fmt.Errorf("installing the collector bundle: %w", err)
		}
	}
	b, _ := json.Marshal(installed{Node: m.Node, NodeSha256: rt.Sha256, BundleSha256: m.Bundle.Sha256, Version: m.Version})
	return os.WriteFile(filepath.Join(s.dir, "installed.json"), b, 0o640)
}

func (s *Supervisor) getJSON(path string, into any) error {
	res, err := s.http.Get(s.engineURL + path)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(res.Body, 300))
		return fmt.Errorf("HTTP %d: %s", res.StatusCode, body)
	}
	return json.NewDecoder(res.Body).Decode(into)
}

func (s *Supervisor) download(path, dest string, gunzip bool, wantSha string) error {
	res, err := s.http.Get(s.engineURL + path)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("downloading %s: HTTP %d", path, res.StatusCode)
	}
	var body io.Reader = res.Body
	if gunzip {
		zr, err := gzip.NewReader(res.Body)
		if err != nil {
			return fmt.Errorf("downloading %s: %w", path, err)
		}
		defer zr.Close()
		body = zr
	}
	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(out, h), body)
	closeErr := out.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(dest)
		return fmt.Errorf("downloading %s: %w", path, err)
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != wantSha {
		_ = os.Remove(dest)
		return fmt.Errorf("%s failed verification (SHA-256 %s, expected %s)", path, got, wantSha)
	}
	return nil
}

func fileHasHash(path, want string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return false
	}
	return hex.EncodeToString(h.Sum(nil)) == want
}

func (s *Supervisor) start() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cmd != nil || s.want == nil {
		return
	}
	// --use-system-ca: trust the OS certificate store like the agent does, so
	// an engine behind a private CA works for both.
	cmd := exec.Command(s.nodePath(), "--use-system-ca", s.bundlePath())
	cmd.Dir = s.dir
	cmd.Env = append(os.Environ(),
		"LOOKSEE_ENGINE_URL="+s.engineURL,
		"LOOKSEE_AGENT_KEY="+s.agentKey,
		"LOOKSEE_COLLECTOR_STATE="+s.dir,
		"LOOKSEE_COLLECTOR_WATCH_STDIN=1",
	)
	hideWindow(cmd)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		s.lastError = err.Error()
		return
	}
	stdout, _ := cmd.StdoutPipe()
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		s.lastError = fmt.Sprintf("starting the site collector: %v", err)
		log.Printf("collector: %s", s.lastError)
		return
	}
	log.Printf("collector: started (pid %d)", cmd.Process.Pid)
	s.cmd, s.stdin, s.exited = cmd, stdin, make(chan struct{})
	startedAt := time.Now()
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			log.Printf("[collector] %s", sc.Text())
		}
	}()
	go s.wait(cmd, startedAt)
}

func (s *Supervisor) wait(cmd *exec.Cmd, startedAt time.Time) {
	err := cmd.Wait()
	s.mu.Lock()
	close(s.exited)
	s.cmd, s.stdin = nil, nil
	wanted := s.want != nil
	if time.Since(startedAt) > 2*time.Minute {
		s.failures = 0
	}
	s.failures++
	delay := time.Duration(min(60, 5*s.failures)) * time.Second
	s.mu.Unlock()
	if !wanted {
		return
	}
	s.setError("site collector exited (%v) — restarting in %s", err, delay)
	time.AfterFunc(delay, s.start)
}

// stop asks the collector to finish (closing its stdin makes it flush and
// exit), then kills it if it hasn't within 10 seconds.
func (s *Supervisor) stop() {
	s.mu.Lock()
	cmd, stdin, exited := s.cmd, s.stdin, s.exited
	want := s.want
	s.want = nil // so wait() doesn't schedule a restart
	s.mu.Unlock()
	if cmd == nil {
		s.mu.Lock()
		s.want = want
		s.mu.Unlock()
		return
	}
	_ = stdin.Close()
	select {
	case <-exited:
	case <-time.After(10 * time.Second):
		_ = cmd.Process.Kill()
		<-exited
	}
	s.mu.Lock()
	s.want = want
	s.failures = 0
	s.mu.Unlock()
}

// Shutdown stops the collector for good (agent exiting).
func (s *Supervisor) Shutdown() {
	s.mu.Lock()
	s.want = nil
	s.mu.Unlock()
	s.stop()
}
