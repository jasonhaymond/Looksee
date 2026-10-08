//go:build !windows

package collector

import (
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// A stand-in "node" that records its arguments and environment, then runs
// until stdin closes — the same shutdown contract as the real collector.
const fakeNode = `#!/bin/sh
echo "$@ engine=$LOOKSEE_ENGINE_URL key=$LOOKSEE_AGENT_KEY" > "$LOOKSEE_COLLECTOR_STATE/ran.txt"
cat > /dev/null
echo stopped >> "$LOOKSEE_COLLECTOR_STATE/ran.txt"
`

func hash(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

type fakeEngine struct {
	*httptest.Server
	bundle    []byte
	corrupt   bool
	downloads int
}

func newFakeEngine(t *testing.T) *fakeEngine {
	f := &fakeEngine{bundle: []byte("// collector bundle v1")}
	var gz bytes.Buffer
	zw := gzip.NewWriter(&gz)
	_, _ = zw.Write([]byte(fakeNode))
	_ = zw.Close()
	platform := runtime.GOOS + "-" + runtime.GOARCH
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/install/collector/manifest.json":
			sha := hash([]byte(fakeNode))
			if f.corrupt {
				sha = strings.Repeat("0", 64)
			}
			_ = json.NewEncoder(w).Encode(manifest{
				Version:  "9.9.9",
				Node:     "v24.0.0",
				Bundle:   manifestFile{File: "collector.cjs", Sha256: hash(f.bundle)},
				Runtimes: map[string]manifestFile{platform: {File: "node.gz", Sha256: sha}},
			})
		case "/install/collector/files/node.gz":
			f.downloads++
			_, _ = w.Write(gz.Bytes())
		case "/install/collector/files/collector.cjs":
			f.downloads++
			_, _ = w.Write(f.bundle)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(f.Close)
	return f
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestInstallStartStop(t *testing.T) {
	f := newFakeEngine(t)
	dir := t.TempDir()
	s := New(f.URL, "key123", dir)
	spec := &Spec{Version: "9.9.9", Node: "v24.0.0", BundleSha256: hash(f.bundle)}

	s.Apply(spec)
	ranFile := filepath.Join(dir, "ran.txt")
	waitFor(t, "collector to start", func() bool { _, err := os.Stat(ranFile); return err == nil })
	ran, _ := os.ReadFile(ranFile)
	if !strings.Contains(string(ran), "--use-system-ca") || !strings.Contains(string(ran), "collector.cjs") || !strings.Contains(string(ran), "key=key123") {
		t.Fatalf("unexpected invocation: %q", ran)
	}
	if f.downloads != 2 {
		t.Fatalf("expected runtime + bundle downloads, got %d", f.downloads)
	}

	// Same spec again: nothing re-downloaded, still one process.
	waitFor(t, "install to finish", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return !s.busy })
	s.Apply(spec)
	if f.downloads != 2 {
		t.Fatalf("re-downloaded an unchanged collector (%d downloads)", f.downloads)
	}

	// No longer a collector: stopped through stdin, not killed.
	s.Apply(nil)
	ran, _ = os.ReadFile(ranFile)
	if !strings.Contains(string(ran), "stopped") {
		t.Fatalf("collector wasn't stopped gracefully: %q", ran)
	}
	s.mu.Lock()
	running := s.cmd != nil
	s.mu.Unlock()
	if running {
		t.Fatal("collector still running after Apply(nil)")
	}
}

func TestNewBundleReplacesRunningCollector(t *testing.T) {
	f := newFakeEngine(t)
	dir := t.TempDir()
	s := New(f.URL, "k", dir)
	s.Apply(&Spec{Node: "v24.0.0", BundleSha256: hash(f.bundle)})
	waitFor(t, "first start", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return s.cmd != nil && !s.busy })

	f.bundle = []byte("// collector bundle v2")
	s.Apply(&Spec{Node: "v24.0.0", BundleSha256: hash(f.bundle)})
	waitFor(t, "restart on the new bundle", func() bool {
		b, _ := os.ReadFile(filepath.Join(dir, "collector.cjs"))
		s.mu.Lock()
		defer s.mu.Unlock()
		return string(b) == "// collector bundle v2" && s.cmd != nil && !s.busy
	})
	if f.downloads != 3 {
		t.Fatalf("expected only the bundle to be re-downloaded, got %d downloads", f.downloads)
	}
	s.Shutdown()
}

func TestRejectsRuntimeWithWrongHash(t *testing.T) {
	f := newFakeEngine(t)
	f.corrupt = true
	dir := t.TempDir()
	s := New(f.URL, "k", dir)
	s.Apply(&Spec{Node: "v24.0.0", BundleSha256: hash(f.bundle)})
	waitFor(t, "install attempt", func() bool { return s.LastError() != "" })
	if !strings.Contains(s.LastError(), "failed verification") {
		t.Fatalf("unexpected error: %s", s.LastError())
	}
	if _, err := os.Stat(filepath.Join(dir, "node")); err == nil {
		t.Fatal("an unverified runtime was installed")
	}
}
