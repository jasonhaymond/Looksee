//go:build !windows && !linux

// Memory detail on systems that don't provide it (macOS and others). Everything
// reports "not available", so the matching checks say "isn't reported" instead of
// showing a false zero. Memory percent and swap still come from metrics.go.

package metrics

import "github.com/shirou/gopsutil/v4/mem"

// readSystemMemory has nothing to add on this system.
func readSystemMemory(_ *Mem, _ *mem.VirtualMemoryStat) (uint64, bool) { return 0, false }

// listProcessPrivate has nothing to report on this system.
func listProcessPrivate() ([]ProcessPrivate, int, bool) { return nil, 0, false }

// privateByPID has nothing to report on this system.
func privateByPID() map[int32]uint64 { return nil }

// pagingRates has nothing to report on this system.
func pagingRates() (in, out *float64) { return nil, nil }
