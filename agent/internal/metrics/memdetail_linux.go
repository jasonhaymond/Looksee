//go:build linux

// Linux memory detail for the report built in metrics.go: commit from
// /proc/meminfo, kernel memory, and each process's private memory. See memdetail.go
// for what they're used for. Paging rates are measured in metrics.go, alongside
// the other /proc/vmstat counters.
//
// Security: read-only, and everything here is readable without root.

package metrics

import (
	"github.com/shirou/gopsutil/v4/mem"

	"looksee-agent/internal/android"
)

// readSystemMemory fills in commit and kernel memory from what the OS reports.
// Linux has no pools by those names, so the closest equivalents are used:
//
//   - nonpaged: unreclaimable slab, page tables and kernel stacks, which the kernel
//     can't give back under memory pressure
//   - paged: reclaimable slab, which it can
//
// Commit on Linux counts promises made rather than memory used, and its limit is
// only enforced in strict overcommit mode (vm.overcommit_memory=2), so used above
// total is normal on most systems.
//
// Returns RAM in use plus swap in use as the figure to compare against process
// private memory, which also counts both.
func readSystemMemory(m *Mem, vm *mem.VirtualMemoryStat) (uint64, bool) {
	if vm.CommitLimit > 0 {
		m.CommitUsed = u64p(vm.CommittedAS)
		m.CommitLimit = u64p(vm.CommitLimit)
	}
	nonpaged := vm.Sunreclaim + vm.PageTables
	if ex, err := mem.NewExLinux().VirtualMemory(); err == nil {
		nonpaged += ex.KernelStack
	}
	m.KernelNonpaged = u64p(nonpaged)
	m.KernelPaged = u64p(vm.Sreclaimable)
	if vm.Available > vm.Total {
		return 0, false
	}
	return vm.Total - vm.Available + m.SwapUsed, true
}

// listProcessPrivate reads every process's private memory from /proc. Android
// hides other apps' processes, so a total there would only cover the agent itself
// and everything else would wrongly look like memory outside processes. It's left
// out instead.
func listProcessPrivate() ([]ProcessPrivate, int, bool) {
	if android.IsAndroid() {
		return nil, 0, false
	}
	return listProcPrivate("/proc")
}

// privateByPID isn't needed on Linux: processPrivateMB reads each process's own
// status file.
func privateByPID() map[int32]uint64 { return nil }

// pagingRates is measured in Collect on Linux, from /proc/vmstat.
func pagingRates() (in, out *float64) { return nil, nil }
