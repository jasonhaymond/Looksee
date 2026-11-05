//go:build windows

// Windows memory detail: system commit, kernel pools, each process's private
// memory, and paging rates, for the report built in metrics.go. See memdetail.go
// for what they're used for.
//
// It calls Windows directly rather than starting PowerShell, because this runs on
// every report and PowerShell is slow enough to time out on a busy machine.
//
// Security: read-only. No process is opened; only system-wide totals and the
// process list are read. DLLs load from the Windows system folder only, so a planted
// DLL next to the agent can't be picked up instead.

package metrics

import (
	"sync"
	"unsafe"

	"github.com/shirou/gopsutil/v4/mem"
	"golang.org/x/sys/windows"
)

var (
	psapi                  = windows.NewLazySystemDLL("psapi.dll")
	procGetPerformanceInfo = psapi.NewProc("GetPerformanceInfo")

	// PDH is Windows' performance-counter library, the source behind Performance
	// Monitor.
	pdh                             = windows.NewLazySystemDLL("pdh.dll")
	procPdhOpenQueryW               = pdh.NewProc("PdhOpenQueryW")
	procPdhAddEnglishCounterW       = pdh.NewProc("PdhAddEnglishCounterW")
	procPdhCollectQueryData         = pdh.NewProc("PdhCollectQueryData")
	procPdhGetFormattedCounterValue = pdh.NewProc("PdhGetFormattedCounterValue")
	procPdhCloseQuery               = pdh.NewProc("PdhCloseQuery")
)

// performanceInformation mirrors Windows' PERFORMANCE_INFORMATION, field for
// field, because Windows fills it in directly. uintptr matches Windows' SIZE_T on
// both 32- and 64-bit builds. The memory fields count pages, not bytes.
type performanceInformation struct {
	cb                uint32
	commitTotal       uintptr
	commitLimit       uintptr
	commitPeak        uintptr
	physicalTotal     uintptr
	physicalAvailable uintptr
	systemCache       uintptr
	kernelTotal       uintptr
	kernelPaged       uintptr
	kernelNonpaged    uintptr
	pageSize          uintptr
	handleCount       uint32
	processCount      uint32
	threadCount       uint32
}

// readSystemMemory fills in commit and the kernel pools from GetPerformanceInfo,
// the source behind Task Manager's Memory page.
//
// Returns the system commit in bytes as the "in use" figure to compare against
// process private memory (both are commit charge, so the two are like for like),
// and false if Windows wouldn't answer.
func readSystemMemory(m *Mem, _ *mem.VirtualMemoryStat) (uint64, bool) {
	var info performanceInformation
	info.cb = uint32(unsafe.Sizeof(info))
	ok, _, _ := procGetPerformanceInfo.Call(uintptr(unsafe.Pointer(&info)), uintptr(info.cb))
	if ok == 0 {
		return 0, false
	}
	page := uint64(info.pageSize)
	used := uint64(info.commitTotal) * page
	m.CommitUsed = u64p(used)
	m.CommitLimit = u64p(uint64(info.commitLimit) * page)
	m.KernelNonpaged = u64p(uint64(info.kernelNonpaged) * page)
	m.KernelPaged = u64p(uint64(info.kernelPaged) * page)
	return used, true
}

// How much memory the process list may need before giving up. The list is well
// under a megabyte on most machines; the limit only stops a runaway retry loop.
const maxProcessListBytes = 256 << 20

// readProcessList asks Windows for its list of all processes in one call, growing
// the buffer until the list fits (Windows says so when it doesn't).
func readProcessList() ([]byte, bool) {
	for size := 1 << 20; size <= maxProcessListBytes; size *= 2 {
		buf := make([]byte, size)
		var needed uint32
		err := windows.NtQuerySystemInformation(windows.SystemProcessInformation, unsafe.Pointer(&buf[0]), uint32(size), &needed)
		if err == nil {
			return buf, true
		}
		if err != windows.STATUS_INFO_LENGTH_MISMATCH {
			return nil, false
		}
	}
	return nil, false
}

// walkProcessList calls visit for each process in Windows' system-wide process list,
// the same source as Get-Process and Task Manager. It needs no access to the
// individual processes, so protected ones are included too.
//
//	visit: receives the process ID, its name, and its private memory in bytes
//
// Returns false if Windows wouldn't provide the list.
func walkProcessList(visit func(pid uint32, name string, private uint64)) bool {
	buf, ok := readProcessList()
	if !ok {
		return false
	}
	// Entries are variable length, each giving the distance to the next; 0 ends it.
	for offset := 0; ; {
		entry := (*windows.SYSTEM_PROCESS_INFORMATION)(unsafe.Pointer(&buf[offset]))
		// PID 0 is the Idle placeholder: it isn't a real process and holds nothing.
		if entry.UniqueProcessID != 0 {
			name := ""
			if entry.ImageName.Buffer != nil {
				// Length is in bytes, and the text is 2 bytes per character.
				name = windows.UTF16ToString(unsafe.Slice(entry.ImageName.Buffer, entry.ImageName.Length/2))
			}
			// PrivatePageCount holds bytes, despite its name.
			visit(uint32(entry.UniqueProcessID), name, uint64(entry.PrivatePageCount))
		}
		next := int(entry.NextEntryOffset)
		if next == 0 || offset+next >= len(buf) {
			return true
		}
		offset += next
	}
}

// listProcessPrivate gathers every process's private memory for the report's total.
// A process missed here would wrongly show as memory outside processes, which is
// why this uses the system-wide list.
//
// Returns the rows, 0 unreadable (the list always covers everything), and false if
// Windows wouldn't provide the list.
func listProcessPrivate() ([]ProcessPrivate, int, bool) {
	var rows []ProcessPrivate
	ok := walkProcessList(func(_ uint32, name string, private uint64) {
		rows = append(rows, ProcessPrivate{Name: name, Bytes: private})
	})
	return rows, 0, ok
}

// privateByPID gives each process's private memory, for the Processes tab, from the
// same list as the total so the two always agree. Returns nil if it can't be read.
func privateByPID() map[int32]uint64 {
	out := map[int32]uint64{}
	if !walkProcessList(func(pid uint32, _ string, private uint64) { out[int32(pid)] = private }) {
		return nil
	}
	return out
}

// pdhCounterValue mirrors Windows' PDH_FMT_COUNTERVALUE when asked for a double.
type pdhCounterValue struct {
	status uint32
	_      uint32
	value  float64
}

const (
	// Ask for the counter's value as a floating-point number.
	pdhFmtDouble = 0x00000200
	// The two statuses meaning a reading is good (valid, and valid and new).
	pdhStatusValid    = 0
	pdhStatusNewValid = 1
)

// The open counter query, kept between reports. A rate needs two readings, so
// holding it open gives each report the average since the previous one instead of
// a brief spot sample.
var pageCounters struct {
	mu       sync.Mutex
	query    uintptr
	in       uintptr
	out      uintptr
	lastTick bool
}

// openPageCounters starts the query. It uses English counter names through
// PdhAddEnglishCounter, because the ordinary call expects names translated into
// the system's language and fails on a non-English Windows.
func openPageCounters() bool {
	var query uintptr
	if r, _, _ := procPdhOpenQueryW.Call(0, 0, uintptr(unsafe.Pointer(&query))); r != 0 {
		return false
	}
	add := func(path string, into *uintptr) bool {
		p, err := windows.UTF16PtrFromString(path)
		if err != nil {
			return false
		}
		r, _, _ := procPdhAddEnglishCounterW.Call(query, uintptr(unsafe.Pointer(p)), 0, uintptr(unsafe.Pointer(into)))
		return r == 0
	}
	// Pages Input and Output, not Pages/sec: Pages/sec also counts ordinary file
	// reads through memory mapping, so it runs high on healthy machines.
	if !add(`\Memory\Pages Input/sec`, &pageCounters.in) || !add(`\Memory\Pages Output/sec`, &pageCounters.out) {
		procPdhCloseQuery.Call(query)
		return false
	}
	pageCounters.query = query
	return true
}

// readPageCounter returns one counter's latest value, or nil if it isn't valid.
func readPageCounter(counter uintptr) *float64 {
	var v pdhCounterValue
	r, _, _ := procPdhGetFormattedCounterValue.Call(counter, pdhFmtDouble, 0, uintptr(unsafe.Pointer(&v)))
	if r != 0 || (v.status != pdhStatusValid && v.status != pdhStatusNewValid) {
		return nil
	}
	return fp(v.value)
}

// pagingRates returns pages per second read from and written to disk because of
// memory pressure, averaged since the previous call. The first call only starts
// the measurement and returns nil, as do machines with performance counters
// disabled, where the checks say "isn't reported" instead of showing 0.
func pagingRates() (in, out *float64) {
	pageCounters.mu.Lock()
	defer pageCounters.mu.Unlock()
	if pageCounters.query == 0 && !openPageCounters() {
		return nil, nil
	}
	if r, _, _ := procPdhCollectQueryData.Call(pageCounters.query); r != 0 {
		return nil, nil
	}
	if !pageCounters.lastTick {
		pageCounters.lastTick = true
		return nil, nil
	}
	return readPageCounter(pageCounters.in), readPageCounter(pageCounters.out)
}
