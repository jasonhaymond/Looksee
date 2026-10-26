// Tests for the agent's main loop helpers (main.go). Each test says what
// it proves.
package main

import (
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

// Proves an agent the engine keeps refusing (old key, blocked address)
// polls at the normal interval for the first few refusals, then
// progressively less often, never waiting more than maxAuthBackoff — so a
// stale agent stops counting toward the engine's key-guessing rule every
// 30 seconds, but still recovers on its own once it's accepted again.
func TestAuthBackoff(t *testing.T) {
	a := &agent{}
	interval := 30 * time.Second
	want := map[int]time.Duration{0: interval, 2: interval, 3: 60 * time.Second, 4: 120 * time.Second, 5: 240 * time.Second, 6: 480 * time.Second, 7: maxAuthBackoff, 50: maxAuthBackoff}
	for failures, d := range want {
		a.authFailures = failures
		if got := a.authBackoff(interval); got != d {
			t.Errorf("%d failures: got %s want %s", failures, got, d)
		}
	}
}

// Proves where the log file goes: next to the config on Windows by default
// (the Scheduled Task discards console output), nowhere by default on other
// systems (their service managers keep the log), and exactly where -log-file
// says otherwise.
func TestResolveLogFile(t *testing.T) {
	cfg := filepath.Join(t.TempDir(), "looksee-agent.yaml")
	auto := resolveLogFile("auto", cfg)
	if runtime.GOOS == "windows" {
		if auto != filepath.Join(filepath.Dir(cfg), "looksee-agent.log") {
			t.Fatalf("auto on Windows: %q", auto)
		}
	} else if auto != "" {
		t.Fatalf("auto elsewhere should be no file, got %q", auto)
	}
	if resolveLogFile("none", cfg) != "" || resolveLogFile("", cfg) != "" {
		t.Fatal("none should disable the file")
	}
	if resolveLogFile("/var/log/x.log", cfg) != "/var/log/x.log" {
		t.Fatal("an explicit path should be used as given")
	}
}
