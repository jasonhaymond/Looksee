// Tests for the size-capped log file (logfile.go). Each test says what it
// proves.
package logfile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Proves the log rotates at the cap, keeps exactly one older file, and that
// the newest lines are always in the current file — so a long-running agent
// can't fill the disk with its log.
func TestRotatesAtCap(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "sub", "agent.log")
	w, err := Open(path, 100)
	if err != nil {
		t.Fatal(err)
	}
	line := strings.Repeat("x", 39) + "\n" // 40 bytes
	for i := 0; i < 10; i++ {
		if _, err := w.Write([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	w.Write([]byte("last line\n"))
	w.Close()

	cur, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(cur) > 100 || !strings.HasSuffix(string(cur), "last line\n") {
		t.Fatalf("current file is %d bytes, ends %q", len(cur), cur)
	}
	old, err := os.ReadFile(path + ".1")
	if err != nil || len(old) == 0 || len(old) > 100 {
		t.Fatalf("rotated file: %d bytes, err %v", len(old), err)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 2 {
		t.Fatalf("expected the log and one rotated file, found %d files", len(entries))
	}
}

// Proves reopening an existing log appends instead of truncating it (an
// agent restart mustn't wipe the lines that explain why it restarted).
func TestAppendsAcrossRestarts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.log")
	w, _ := Open(path, 1<<20)
	w.Write([]byte("before restart\n"))
	w.Close()
	w, _ = Open(path, 1<<20)
	w.Write([]byte("after restart\n"))
	w.Close()
	b, _ := os.ReadFile(path)
	if string(b) != "before restart\nafter restart\n" {
		t.Fatalf("got %q", b)
	}
}
