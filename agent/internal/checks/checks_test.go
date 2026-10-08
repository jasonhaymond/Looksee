package checks

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestFileModes(t *testing.T) {
	dir := t.TempDir()
	old := filepath.Join(dir, "backup-1.tar")
	newer := filepath.Join(dir, "backup-2.tar")
	os.WriteFile(old, make([]byte, 2048), 0o644)
	os.WriteFile(newer, make([]byte, 1024), 0o644)
	os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("x"), 0o644)
	past := time.Now().Add(-3 * time.Hour)
	os.Chtimes(old, past, past)

	run := func(cfg Cfg) Result { return runFile(cfg, map[string]any{}) }
	if r := run(Cfg{"path": newer, "mode": "exists"}); r.Status != "up" {
		t.Fatalf("exists: %+v", r)
	}
	if r := run(Cfg{"path": filepath.Join(dir, "nope"), "mode": "exists"}); r.Status != "down" {
		t.Fatalf("missing should be down: %+v", r)
	}
	if r := run(Cfg{"path": filepath.Join(dir, "nope"), "mode": "not_exists"}); r.Status != "up" {
		t.Fatalf("not_exists: %+v", r)
	}
	if r := run(Cfg{"path": dir, "mode": "count", "pattern": "*.tar"}); *r.Value != 2 {
		t.Fatalf("count: %+v", r)
	}
	r := run(Cfg{"path": dir, "mode": "age", "pattern": "*.tar"})
	if r.Status != "up" || *r.Value > 1 || !strings.Contains(r.Message, "backup-2.tar") {
		t.Fatalf("age should pick the newest file: %+v", r)
	}
	if r := run(Cfg{"path": old, "mode": "age", "maxAgeMinutes": 60}); r.Status != "down" {
		t.Fatalf("stale file should be down: %+v", r)
	}
	if r := run(Cfg{"path": dir, "mode": "folder_size", "pattern": "*.tar"}); *r.Value != 0 {
		// 3 KiB rounds to 0.00 MB
		t.Fatalf("folder_size: %+v", r)
	}
	if r := run(Cfg{"path": newer, "mode": "checksum"}); r.Details.(map[string]any)["sha256"] != "5f70bf18a086007016e948b04aed3b82103a36bea41755b6cddfaf10ace3c6ef" {
		t.Fatalf("checksum: %+v", r)
	}
}

func TestWatchdog(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("1"), 0o644)
	os.WriteFile(filepath.Join(dir, "b.txt"), []byte("1"), 0o644)
	st := map[string]any{}
	cfg := Cfg{"path": dir, "mode": "watchdog", "events": "created,deleted"}
	if r := runFile(cfg, st); r.Status != "up" || !strings.Contains(r.Message, "baseline") {
		t.Fatalf("first run should baseline: %+v", r)
	}
	if r := runFile(cfg, st); r.Status != "up" {
		t.Fatalf("no change: %+v", r)
	}
	os.WriteFile(filepath.Join(dir, "c.txt"), []byte("new"), 0o644)
	os.Remove(filepath.Join(dir, "b.txt"))
	future := time.Now().Add(time.Minute)
	os.Chtimes(filepath.Join(dir, "a.txt"), future, future)
	r := runFile(cfg, st)
	if r.Status != "warn" || !strings.Contains(r.Message, "1 created: c.txt") || !strings.Contains(r.Message, "1 deleted: b.txt") || strings.Contains(r.Message, "modified") {
		t.Fatalf("watchdog should report only the watched events: %+v", r)
	}
	if r.Details.(map[string]any)["event"] != true {
		t.Fatal("event flag missing")
	}
}

func TestTailNewHandlesRotation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "app.log")
	os.WriteFile(path, []byte("old line\n"), 0o644)
	st := map[string]any{}
	if lines, _ := TailNew(path, st, false); len(lines) != 0 {
		t.Fatalf("first read must skip history, got %v", lines)
	}
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	f.WriteString("ERROR one\nok\npartial")
	f.Close()
	lines, _ := TailNew(path, st, false)
	if strings.Join(lines, "|") != "ERROR one|ok" {
		t.Fatalf("got %v", lines)
	}
	// Rotation: file replaced by a shorter one.
	os.WriteFile(path, []byte("ERROR after rotate\n"), 0o644)
	lines, _ = TailNew(path, st, false)
	if strings.Join(lines, "|") != "ERROR after rotate" {
		t.Fatalf("after rotation got %v", lines)
	}
	res := runLog(Cfg{"path": path, "pattern": "error"}, map[string]any{"offset": int64(0), "path": path})
	if res.Status != "down" || *res.Value != 1 {
		t.Fatalf("runLog: %+v", res)
	}
	res = runLog(Cfg{"path": path, "pattern": "error", "criticalAbove": 5}, map[string]any{"offset": int64(0), "path": path})
	if res.Status != "up" {
		t.Fatalf("with thresholds the engine judges: %+v", res)
	}
}

func TestParseScriptOutput(t *testing.T) {
	msg, v := ParseScriptOutput("DISK OK - 42% used | used=42%;80;90\nmore\n", true)
	if msg != "DISK OK - 42% used" || v == nil || *v != 42 {
		t.Fatalf("%q %v", msg, v)
	}
	_, v = ParseScriptOutput("queue depth 17 items", true)
	if v == nil || *v != 17 {
		t.Fatalf("first number: %v", v)
	}
	_, v = ParseScriptOutput("no number", true)
	if v != nil {
		t.Fatal("expected nil")
	}
}

func TestScriptChecks(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script fixture")
	}
	if r := runScript(Cfg{"script": "x.sh"}, ""); r.Status != "unknown" || !strings.Contains(r.Message, "disabled") {
		t.Fatalf("no script_dir must disable scripts: %+v", r)
	}
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "check.sh"), []byte("#!/bin/sh\necho \"WARNING - $1 is high | load=$1\"\nexit 1\n"), 0o755)
	if r := runScript(Cfg{"script": "../etc/passwd"}, dir); r.Status != "unknown" {
		t.Fatalf("path traversal must be refused: %+v", r)
	}
	r := runScript(Cfg{"script": "check.sh", "args": "7.5"}, dir)
	if r.Status != "warn" || *r.Value != 7.5 || r.Message != "WARNING - 7.5 is high" {
		t.Fatalf("%+v", r)
	}
}

func TestParsers(t *testing.T) {
	if got := ParsePingTimes("time=1.5 ms\ntime<1ms"); len(got) != 2 || got[0] != 1.5 {
		t.Fatal(got)
	}
	kv := ParseKeyValues("battery.charge: 87\nups.status: OB LB\n")
	if kv["battery.charge"] != "87" || kv["ups.status"] != "OB LB" {
		t.Fatal(kv)
	}
	if !statusMatches(204, "200-299") || statusMatches(301, "2xx") || !statusMatches(404, "200,404") {
		t.Fatal("statusMatches")
	}
	doc := map[string]any{"a": map[string]any{"b": []any{map[string]any{"c": 5.0}}}}
	if jsonPath(doc, "$.a.b[0].c") != 5.0 {
		t.Fatal("jsonPath")
	}
	if !matchContainer("web-1", "web-*") || matchContainer("db", "web-*") || !matchContainer("x", "*") {
		t.Fatal("matchContainer")
	}
	c := Cfg{"n": "12", "b": "true", "t": "", "warnAbove": "5"}
	if c.Num("n", 0) != 12 || !c.Bool("b", false) || c.Str("t", "def") != "def" || !c.HasThresholds() {
		t.Fatal("Cfg accessors")
	}
}

func TestRemoteHTTPProbe(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/old" {
			http.Redirect(w, r, "/new", http.StatusMovedPermanently)
			return
		}
		w.Write([]byte(`{"status":"ok","depth":9}`))
	}))
	defer srv.Close()
	r := probeHTTP(Cfg{"url": srv.URL + "/old", "jsonPath": "$.depth", "expectedFinalUrl": srv.URL + "/new"})
	if r.Status != "up" || r.Value == nil || *r.Value != 9 {
		t.Fatalf("%+v", r)
	}
	if r := probeHTTP(Cfg{"url": srv.URL, "bodyNotContains": "ok"}); r.Status != "down" {
		t.Fatalf("%+v", r)
	}
	if r := probeTCP(Cfg{"host": "127.0.0.1", "port": strings.Split(srv.URL, ":")[2]}); r.Status != "up" {
		t.Fatalf("tcp %+v", r)
	}
}

func TestRunnerDueAndUnknownType(t *testing.T) {
	r := NewRunner(Options{})
	c := Check{ID: "1", Type: "nope", IntervalSeconds: 300}
	if !r.Due(c, time.Now()) {
		t.Fatal("first run is always due")
	}
	res := r.Run(c)
	if res.Status != "unknown" || res.CheckID != "1" {
		t.Fatalf("%+v", res)
	}
	if r.Due(c, time.Now()) {
		t.Fatal("must respect the check's own interval")
	}
}
