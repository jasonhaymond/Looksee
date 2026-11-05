// Tests for the shared memory-detail logic: reading Linux process status files,
// adding up private memory, and working out memory outside processes.

package metrics

import (
	"os"
	"path/filepath"
	"testing"
)

// Proves private memory is RssAnon plus VmSwap, and that shared memory (RssFile,
// RssShmem) isn't counted, or shared libraries would count once per process.
func TestParseProcStatus(t *testing.T) {
	name, private, ok := parseProcStatus("Name:\tnginx\nVmRSS:\t 9000 kB\nRssAnon:\t 1024 kB\nRssFile:\t 7000 kB\nRssShmem:\t 976 kB\nVmSwap:\t 1024 kB\n")
	if !ok || name != "nginx" || private != 2048*1024 {
		t.Fatalf("got %q %d %v", name, private, ok)
	}
}

// Proves a kernel thread, which has no memory lines of its own, counts as zero
// rather than as an unreadable process.
func TestParseProcStatusKernelThread(t *testing.T) {
	name, private, ok := parseProcStatus("Name:\tkworker/0:1\nState:\tI (idle)\n")
	if !ok || name != "kworker/0:1" || private != 0 {
		t.Fatalf("got %q %d %v", name, private, ok)
	}
}

// Proves damaged status text is flagged rather than reported as a zero-byte process.
func TestParseProcStatusNoName(t *testing.T) {
	if _, _, ok := parseProcStatus("garbage"); ok {
		t.Fatal("expected not ok")
	}
}

// Proves the folder walk reads only numbered process folders and counts a process
// with a damaged status file as unreadable, so the report can say the total is short.
func TestListProcPrivate(t *testing.T) {
	root := t.TempDir()
	write := func(dir, text string) {
		t.Helper()
		if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, dir, "status"), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("1", "Name:\tinit\nRssAnon:\t 10 kB\n")
	write("22", "Name:\tapp\nRssAnon:\t 20 kB\nVmSwap:\t 5 kB\n")
	write("333", "garbage")
	write("sys", "Name:\tnot-a-process\nRssAnon:\t 999 kB\n")

	rows, unread, ok := listProcPrivate(root)
	if !ok || len(rows) != 2 || unread != 1 {
		t.Fatalf("rows=%+v unread=%d ok=%v", rows, unread, ok)
	}
	if total, _ := summarizePrivate(rows); total != 35*1024 {
		t.Fatalf("total %d", total)
	}
}

// Proves a missing /proc reports "not available" rather than a total of zero,
// which would make all memory look like it's outside processes.
func TestListProcPrivateMissingFolder(t *testing.T) {
	if _, _, ok := listProcPrivate(filepath.Join(t.TempDir(), "absent")); ok {
		t.Fatal("expected not ok")
	}
}

// Proves copies of one program add up under one name, the biggest come first, and
// only the top few are sent, while the total still counts everything.
func TestSummarizePrivate(t *testing.T) {
	rows := []ProcessPrivate{{"a", 1}, {"b", 2}, {"svchost.exe", 5}, {"c", 3}, {"d", 4}, {"svchost.exe", 5}, {"e", 1}}
	total, top := summarizePrivate(rows)
	if total != 21 {
		t.Fatalf("total %d", total)
	}
	if len(top) != topPrivateCount || top[0] != (ProcessPrivate{"svchost.exe", 10}) || top[1].Name != "d" {
		t.Fatalf("top %+v", top)
	}
}

// Proves two figures read a moment apart can't wrap around to an enormous number
// when processes briefly appear to hold more than the total in use.
func TestNonProcessBytes(t *testing.T) {
	if got := nonProcessBytes(100, 30); got != 70 {
		t.Fatalf("got %d", got)
	}
	if got := nonProcessBytes(30, 100); got != 0 {
		t.Fatalf("got %d", got)
	}
}
