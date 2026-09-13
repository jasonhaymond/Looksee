// Package metrics collects host-level resource usage via gopsutil, which
// handles the actual per-OS syscalls (Windows/Linux/macOS) so this package
// doesn't need any platform-specific code of its own.
package metrics

import (
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/mem"
	"github.com/shirou/gopsutil/v3/net"
)

type Snapshot struct {
	CPUPercent float64 `json:"cpuPercent"`
	MemPercent float64 `json:"memPercent"`
	DiskPercent float64 `json:"diskPercent"`
	NetRxBytes  uint64  `json:"netRxBytes"`
	NetTxBytes  uint64  `json:"netTxBytes"`
}

// Collect takes a snapshot of current host resource usage. cpu.Percent with
// a non-zero interval blocks for that long to compute a real usage delta
// (a 0 interval would just return the delta since last call, which is
// noisier on first-ever run) — 1s is a reasonable tradeoff against report
// latency at the default 30s interval.
func Collect(diskPath string) (Snapshot, error) {
	var snap Snapshot

	cpuPercents, err := cpu.Percent(time.Second, false)
	if err == nil && len(cpuPercents) > 0 {
		snap.CPUPercent = cpuPercents[0]
	}

	if vm, err := mem.VirtualMemory(); err == nil {
		snap.MemPercent = vm.UsedPercent
	}

	if du, err := disk.Usage(diskPath); err == nil {
		snap.DiskPercent = du.UsedPercent
	}

	if counters, err := net.IOCounters(false); err == nil && len(counters) > 0 {
		snap.NetRxBytes = counters[0].BytesRecv
		snap.NetTxBytes = counters[0].BytesSent
	}

	return snap, nil
}
