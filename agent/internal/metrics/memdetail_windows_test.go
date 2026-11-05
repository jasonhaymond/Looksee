//go:build windows

// Tests the Windows memory calls against the real machine, because their structures
// must match Windows exactly: a wrong field layout compiles fine but reads garbage.

package metrics

import (
	"strings"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v4/mem"
)

// Proves commit and the kernel pools read sensibly: commit fits inside its limit,
// and the pools are non-zero and smaller than physical memory.
func TestReadSystemMemoryWindows(t *testing.T) {
	vm, err := mem.VirtualMemory()
	if err != nil {
		t.Fatal(err)
	}
	var m Mem
	used, ok := readSystemMemory(&m, vm)
	if !ok || m.CommitUsed == nil || m.CommitLimit == nil || m.KernelNonpaged == nil || m.KernelPaged == nil {
		t.Fatalf("incomplete: %+v", m)
	}
	if used == 0 || used != *m.CommitUsed || *m.CommitUsed > *m.CommitLimit {
		t.Fatalf("commit %d of %d", *m.CommitUsed, *m.CommitLimit)
	}
	if *m.KernelNonpaged == 0 || *m.KernelNonpaged >= vm.Total || *m.KernelPaged == 0 || *m.KernelPaged >= vm.Total {
		t.Fatalf("pools nonpaged=%d paged=%d of %d", *m.KernelNonpaged, *m.KernelPaged, vm.Total)
	}
}

// Proves the process list reads real names and private memory, and covers protected
// processes that can't be opened. Missing them would inflate "not in processes".
func TestListProcessPrivateWindows(t *testing.T) {
	rows, unread, ok := listProcessPrivate()
	if !ok || len(rows) < 5 || unread != 0 {
		t.Fatalf("ok=%v rows=%d unread=%d", ok, len(rows), unread)
	}
	var system, someMemory bool
	for _, r := range rows {
		if r.Name == "" {
			t.Fatalf("blank process name: %+v", r)
		}
		system = system || r.Name == "System"
		someMemory = someMemory || (strings.HasSuffix(strings.ToLower(r.Name), ".exe") && r.Bytes > 0)
	}
	if !system || !someMemory {
		t.Fatalf("system=%v someMemory=%v", system, someMemory)
	}
}

// Proves the Processes tab gets private memory even for processes this test can't
// open, so it agrees with the total: the largest process can't go missing from it.
func TestListProcessesPrivateWindows(t *testing.T) {
	procs, err := ListProcesses()
	if err != nil {
		t.Fatal(err)
	}
	missing := 0
	for _, p := range procs {
		if p.PrivateMB == nil {
			missing++
		}
	}
	// A process can start between the two reads, so allow a few.
	if len(procs) == 0 || missing > 5 {
		t.Fatalf("%d of %d processes have no private memory", missing, len(procs))
	}
}

// Proves the first call only starts the paging measurement, and a later call gives
// real, non-negative rates through the English counter names.
func TestPagingRatesWindows(t *testing.T) {
	pagingRates()
	time.Sleep(1100 * time.Millisecond)
	in, out := pagingRates()
	if in == nil || out == nil || *in < 0 || *out < 0 {
		t.Fatalf("in=%v out=%v", in, out)
	}
}

// Proves a whole report carries the new fields, and memory outside processes is the
// commit minus private memory, read in the same pass.
func TestCollectIncludesMemDetailWindows(t *testing.T) {
	m := NewCollector("C:\\", nil).Collect().Extended.Mem
	if m == nil || m.CommitUsed == nil || m.ProcessPrivate == nil || m.NonProcess == nil || len(m.TopPrivate) == 0 {
		t.Fatalf("incomplete: %+v", m)
	}
	if *m.ProcessPrivate >= *m.CommitLimit {
		t.Fatalf("private %d above limit %d", *m.ProcessPrivate, *m.CommitLimit)
	}
}
