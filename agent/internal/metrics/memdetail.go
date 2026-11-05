// Memory detail that a plain "percent used" can't show: system commit, kernel
// memory, private memory held by processes, and how much is held by none of
// them. That last number is what points at a leaking driver: Task Manager shows
// memory full, yet no process is using it.
//
// Where this sits: Collect (metrics.go) calls fillMemDetail on every report. This
// file holds the parts shared by every operating system. The OS-specific reading
// lives in memdetail_windows.go, memdetail_linux.go and memdetail_other.go. The
// engine turns these fields into checks (engine/src/services/endpointMetrics.ts).
//
// Services count as processes here, because every service runs inside one.
//
// Security: read-only. Only process names and byte counts are reported, never
// command lines, which can hold passwords.

package metrics

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"

	"github.com/shirou/gopsutil/v4/mem"
)

// How many of the biggest process names each report carries. Enough to name the
// culprit in an alert while keeping the report small.
const topPrivateCount = 5

// ProcessPrivate is the private memory of all processes sharing one name, so the
// many copies of svchost.exe or php-fpm show as one line.
type ProcessPrivate struct {
	Name  string `json:"name"`
	Bytes uint64 `json:"bytes"`
}

// u64p returns a pointer to n. Optional report fields are pointers so that "not
// available here" stays different from a real zero.
func u64p(n uint64) *uint64 { return &n }

// fillMemDetail adds commit, kernel and process figures to m. Anything this
// system can't provide is left out, so the matching check says "isn't reported"
// instead of showing a false zero.
//
//	m:  the memory section of the report being built; changed in place
//	vm: the operating system's memory figures, already read by the caller
func fillMemDetail(m *Mem, vm *mem.VirtualMemoryStat) {
	inUse, ok := readSystemMemory(m, vm)
	rows, unread, listed := listProcessPrivate()
	if !listed {
		return
	}
	total, top := summarizePrivate(rows)
	m.ProcessPrivate = u64p(total)
	m.TopPrivate = top
	m.PrivateUnread = unread
	if ok {
		m.NonProcess = u64p(nonProcessBytes(inUse, total))
	}
}

// nonProcessBytes is memory in use minus what processes hold. The two figures are
// read a moment apart and processes come and go in between, so a result below
// zero is reported as zero rather than wrapping around to an enormous number.
func nonProcessBytes(inUse, private uint64) uint64 {
	if private >= inUse {
		return 0
	}
	return inUse - private
}

// summarizePrivate adds up the rows and returns the overall total plus the
// biggest names, largest first. Ties sort by name so reports stay stable.
func summarizePrivate(rows []ProcessPrivate) (uint64, []ProcessPrivate) {
	byName := map[string]uint64{}
	var total uint64
	for _, r := range rows {
		byName[r.Name] += r.Bytes
		total += r.Bytes
	}
	top := make([]ProcessPrivate, 0, len(byName))
	for name, bytes := range byName {
		top = append(top, ProcessPrivate{Name: name, Bytes: bytes})
	}
	sort.Slice(top, func(i, j int) bool {
		if top[i].Bytes != top[j].Bytes {
			return top[i].Bytes > top[j].Bytes
		}
		return top[i].Name < top[j].Name
	})
	if len(top) > topPrivateCount {
		top = top[:topPrivateCount]
	}
	return total, top
}

// parseProcStatus reads a Linux /proc/<pid>/status file. It returns the process
// name and its private memory: RssAnon (private and in RAM) plus VmSwap (moved out
// to swap). Together they match what Windows calls private bytes. Kernel threads
// have neither line and so come back as 0. ok is false when there is no Name line.
//
// Example lines: "Name:\tnginx", "RssAnon:\t    1024 kB", "VmSwap:\t       0 kB".
func parseProcStatus(text string) (name string, private uint64, ok bool) {
	for _, line := range strings.Split(text, "\n") {
		key, rest, found := strings.Cut(line, ":")
		if !found {
			continue
		}
		switch key {
		case "Name":
			name = strings.TrimSpace(rest)
		case "RssAnon", "VmSwap":
			// The value is always in kB, whatever the system's page size.
			if f := strings.Fields(rest); len(f) > 0 {
				if kb, err := strconv.ParseUint(f[0], 10, 64); err == nil {
					private += kb * 1024
				}
			}
		}
	}
	return name, private, name != ""
}

// listProcPrivate reads every process folder under a Linux /proc directory. These
// status files are readable without root, so an unprivileged agent still sees
// every process's total.
//
//	root: normally "/proc"; tests pass a folder of sample files
//
// Returns the rows, how many processes couldn't be read, and false if the folder
// itself couldn't be listed. A process that exits mid-walk isn't counted as
// unreadable, because it no longer holds any memory.
func listProcPrivate(root string) ([]ProcessPrivate, int, bool) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, 0, false
	}
	var rows []ProcessPrivate
	unread := 0
	for _, e := range entries {
		// Only the numbered folders are processes; "meminfo" and friends aren't.
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		b, err := os.ReadFile(filepath.Join(root, e.Name(), "status"))
		if err != nil {
			if !os.IsNotExist(err) {
				unread++
			}
			continue
		}
		name, private, ok := parseProcStatus(string(b))
		if !ok {
			unread++
			continue
		}
		rows = append(rows, ProcessPrivate{Name: name, Bytes: private})
	}
	return rows, unread, true
}

// processPrivateMB gives one process's private memory in MB for the Processes tab,
// or nil where this system doesn't provide it (macOS).
//
//	pid:   the process
//	byPID: Windows' figures for every process, from privateByPID; nil elsewhere
func processPrivateMB(pid int32, byPID map[int32]uint64) *float64 {
	switch runtime.GOOS {
	case "windows":
		if bytes, ok := byPID[pid]; ok {
			return fp(float64(bytes) / 1024 / 1024)
		}
	case "linux":
		if b, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(int(pid)), "status")); err == nil {
			if _, private, ok := parseProcStatus(string(b)); ok {
				return fp(float64(private) / 1024 / 1024)
			}
		}
	}
	return nil
}
