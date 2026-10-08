package checks

import (
	"encoding/json"
	"fmt"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v3/process"

	"looksee-agent/internal/execx"
	"looksee-agent/internal/metrics"
)

func runService(c Cfg) Result {
	name := c.Str("serviceName", "")
	if name == "" {
		return unknown("no service name configured")
	}
	running, err := metrics.IsServiceActive(name)
	if err != nil {
		return down(err.Error())
	}
	r := Result{Status: "down", Message: name + " is not running"}
	if running {
		r = Result{Status: "up", Message: name + " is running"}
	}
	// F3: systemd's restart counter; the engine turns it into "restarts in
	// the last hour".
	if runtime.GOOS == "linux" {
		if res, err := execx.Run(10*time.Second, nil, "systemctl", "show", "-p", "NRestarts", "--value", name); err == nil {
			if n, err := strconv.Atoi(strings.TrimSpace(res.Stdout)); err == nil {
				r.Details = map[string]any{"restarts": n}
			}
		}
	}
	return r
}

// F1/F2: process count plus CPU and memory of every matching process.
// CPU% is computed from CPU-time deltas between this agent's own cycles, so
// it reflects recent usage rather than a lifetime average.
func runProcess(c Cfg, st map[string]any) Result {
	name := strings.ToLower(c.Str("serviceName", ""))
	if name == "" {
		return unknown("no process name configured")
	}
	procs, err := process.Processes()
	if err != nil {
		return down(err.Error())
	}
	now := time.Now()
	count := 0
	var rssMB, cpuSeconds float64
	for _, p := range procs {
		n, err := p.Name()
		if err != nil || !strings.Contains(strings.ToLower(n), name) {
			continue
		}
		count++
		if mi, err := p.MemoryInfo(); err == nil {
			rssMB += float64(mi.RSS) / 1048576
		}
		if t, err := p.Times(); err == nil {
			cpuSeconds += t.User + t.System
		}
	}
	var cpuPct *float64
	if prevAt, ok := st["at"].(time.Time); ok {
		prevCPU, _ := st["cpu"].(float64)
		if dt := now.Sub(prevAt).Seconds(); dt > 0 && cpuSeconds >= prevCPU {
			cpuPct = val((cpuSeconds - prevCPU) / dt * 100)
		}
	}
	st["at"], st["cpu"] = now, cpuSeconds
	details := map[string]any{"count": count, "memoryMb": *val(rssMB)}
	if cpuPct != nil {
		details["cpuPercent"] = *cpuPct
	}
	minCount := int(c.Num("minCount", 1))
	if count < minCount {
		return Result{Status: "down", Message: fmt.Sprintf("%d %s process(es) running, expected at least %d", count, name, minCount), Value: val(float64(count)), Details: details}
	}
	if maxCount := c.Num("maxCount", -1); maxCount >= 0 && float64(count) > maxCount {
		return Result{Status: "warn", Message: fmt.Sprintf("%d %s process(es) running, expected at most %v", count, name, maxCount), Value: val(float64(count)), Details: details}
	}
	msg := fmt.Sprintf("%d running, %.0f MB", count, rssMB)
	if cpuPct != nil {
		msg += fmt.Sprintf(", %.1f%% CPU", *cpuPct)
	}
	switch c.Str("measure", "count") {
	case "cpu_percent":
		if cpuPct == nil {
			return Result{Status: "up", Message: msg + " (CPU baseline on next cycle)", Details: details}
		}
		return Result{Status: "up", Message: msg, Value: cpuPct, Details: details}
	case "memory_mb":
		return Result{Status: "up", Message: msg, Value: val(rssMB), Details: details}
	default:
		return Result{Status: "up", Message: msg, Value: val(float64(count)), Details: details}
	}
}

func splitList(s string) map[string]bool {
	out := map[string]bool{}
	for _, part := range strings.FieldsFunc(s, func(r rune) bool { return r == ',' || r == '\n' }) {
		if p := strings.ToLower(strings.TrimSpace(part)); p != "" {
			out[p] = true
		}
	}
	return out
}

// F4 (Linux: failed systemd units) / F5 (Windows: automatic-start services
// that aren't running, skipping trigger-start services that are meant to
// sit stopped until something wakes them).
func runServicesOverview(c Cfg) Result {
	exclude := splitList(c.Str("exclude", ""))
	var bad []string
	switch runtime.GOOS {
	case "linux":
		res, err := execx.Run(15*time.Second, nil, "systemctl", "list-units", "--state=failed", "--no-legend", "--plain", "--no-pager")
		if err != nil {
			return down(err.Error())
		}
		for _, line := range strings.Split(res.Stdout, "\n") {
			f := strings.Fields(line)
			if len(f) == 0 {
				continue
			}
			unit := f[0]
			if exclude[strings.ToLower(unit)] || exclude[strings.ToLower(strings.TrimSuffix(unit, ".service"))] {
				continue
			}
			bad = append(bad, unit)
		}
		return countOrFail(c, len(bad), overviewMsg(bad, "failed unit"), bad)
	case "windows":
		res, err := execx.PowerShell(60*time.Second, nil, `ConvertTo-Json -Compress -Depth 4 -InputObject @(Get-CimInstance Win32_Service -Filter "StartMode='Auto' AND State<>'Running'" | Where-Object { -not (Test-Path ("HKLM:\SYSTEM\CurrentControlSet\Services\" + $_.Name + "\TriggerInfo")) } | Select-Object Name,DisplayName,ExitCode)`)
		if err != nil || res.ExitCode != 0 {
			return down("couldn't list services: " + execx.FirstLine(res.Stderr))
		}
		var rows []struct {
			Name, DisplayName string
			ExitCode          int
		}
		out := strings.TrimSpace(res.Stdout)
		if out != "" {
			if err := json.Unmarshal([]byte(out), &rows); err != nil {
				var one struct {
					Name, DisplayName string
					ExitCode          int
				}
				if json.Unmarshal([]byte(out), &one) == nil {
					rows = append(rows, one)
				}
			}
		}
		// Updaters and on-demand services routinely stop themselves with
		// exit code 0; only an error exit is a failure unless asked.
		includeClean := c.Bool("includeCleanStops", false)
		for _, r := range rows {
			if exclude[strings.ToLower(r.Name)] || exclude[strings.ToLower(r.DisplayName)] || (r.ExitCode == 0 && !includeClean) {
				continue
			}
			bad = append(bad, r.Name)
		}
		return countOrFail(c, len(bad), overviewMsg(bad, "stopped automatic service"), bad)
	default:
		return unknown("service overview is supported on Linux (systemd) and Windows")
	}
}

func overviewMsg(items []string, noun string) string {
	if len(items) == 0 {
		return "none — all good"
	}
	shown := items
	if len(shown) > 8 {
		shown = shown[:8]
	}
	return fmt.Sprintf("%d %s(s): %s", len(items), noun, strings.Join(shown, ", "))
}
