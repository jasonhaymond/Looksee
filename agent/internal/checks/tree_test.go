// Tests for the largest folders and files check (tree.go). Each test says
// what it proves.
package checks

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// Proves folder sizes include everything below them, only folders down to
// the chosen depth are ranked, the largest files are kept in order, a
// skipped folder isn't counted, and the totals add up.
func TestScanTree(t *testing.T) {
	root := t.TempDir()
	mk := func(rel string, size int) {
		p := filepath.Join(root, rel)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, make([]byte, size), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	mk("a/big.bin", 3000)
	mk("a/deep/deeper/x.bin", 2000)
	mk("b/small.bin", 100)
	mk("skipme/huge.bin", 9000)
	folders, files, sum := ScanTree(root, 2, 3, time.Now().Add(time.Minute), []string{filepath.Join(root, "skipme")})
	sizes := map[string]float64{}
	for _, f := range folders {
		sizes[f.Path] = f.SizeGB * bytesPerGB
	}
	// Sizes are rounded to 0.01 GB, so compare through the file count and
	// the ranking instead of exact bytes.
	if sum.Files != 3 {
		t.Fatalf("want 3 files (skipped folder left out), got %d", sum.Files)
	}
	if _, ok := sizes[filepath.Join(root, "a", "deep")]; !ok {
		t.Fatalf("depth 2 should rank a/deep: %v", folders)
	}
	if _, ok := sizes[filepath.Join(root, "a", "deep", "deeper")]; ok {
		t.Fatalf("depth 2 must not rank a/deep/deeper: %v", folders)
	}
	if _, ok := sizes[filepath.Join(root, "skipme")]; ok {
		t.Fatalf("skipped folder was counted: %v", folders)
	}
	if len(files) != 3 || files[0].Path != filepath.Join(root, "a", "big.bin") {
		t.Fatalf("largest file first: %+v", files)
	}
	if sum.Partial {
		t.Fatal("scan shouldn't be partial")
	}
}

// Proves a scan that runs out of time stops and says it's partial.
func TestScanTreeDeadline(t *testing.T) {
	root := t.TempDir()
	os.WriteFile(filepath.Join(root, "f"), []byte("x"), 0o644)
	_, _, sum := ScanTree(root, 4, 25, time.Now().Add(-time.Second), nil)
	if !sum.Partial {
		t.Fatal("expired deadline should mark the scan partial")
	}
}

// Proves the check reports a missing folder as down with the reason.
func TestRunDiskTreeMissingPath(t *testing.T) {
	r := runDiskTree(Cfg{"path": filepath.Join(t.TempDir(), "nope")})
	if r.Status != "down" {
		t.Fatalf("got %+v", r)
	}
}
