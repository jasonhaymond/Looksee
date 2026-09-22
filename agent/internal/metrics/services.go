package metrics

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strings"

	"github.com/shirou/gopsutil/v3/process"
)

// IsProcessRunning matches by process name substring rather than requiring
// an exact/full-path match — the same service often shows up as "nginx" on
// Linux and "nginx.exe" on Windows, and asking the user to know the exact
// binary name per platform would undercut "simple to configure."
func IsProcessRunning(name string) (bool, error) {
	if name == "" {
		return false, nil
	}
	procs, err := process.Processes()
	if err != nil {
		return false, err
	}
	target := strings.ToLower(name)
	for _, p := range procs {
		procName, err := p.Name()
		if err != nil {
			continue
		}
		if strings.Contains(strings.ToLower(procName), target) {
			return true, nil
		}
	}
	return false, nil
}

// ListProcessNames returns every distinct running process name, for the
// check form's suggestion list — the same underlying process.Processes()
// call IsProcessRunning already makes, just collecting names instead of
// matching one.
func ListProcessNames() ([]string, error) {
	procs, err := process.Processes()
	if err != nil {
		return nil, err
	}
	seen := make(map[string]bool)
	names := make([]string, 0, len(procs))
	for _, p := range procs {
		name, err := p.Name()
		if err != nil || name == "" || seen[name] {
			continue
		}
		seen[name] = true
		names = append(names, name)
	}
	return names, nil
}

// IsServiceActive queries the real OS service manager — unlike
// IsProcessRunning, this checks whether `name` is a *registered service*
// that's active, not just whether some process happens to be running with
// a matching name. On Linux, `name` is a separate exec.Command argv
// element, never concatenated into a shell string. On Windows, PowerShell's
// -Command treats everything after it as script text to parse — trailing
// argv elements do NOT bind to $args the way they do with -File, so `name`
// is passed via an environment variable instead ($env:LOOKSEE_SVC_NAME),
// which PowerShell reads as a plain string value, never as code. (Verified
// for real against powershell.exe: the $args[0] form fails to parse
// entirely — "Unexpected token" — while $env: works correctly for both a
// running and a nonexistent service.)
func IsServiceActive(name string) (bool, error) {
	if name == "" {
		return false, nil
	}
	switch runtime.GOOS {
	case "linux":
		out, err := exec.Command("systemctl", "is-active", name).Output()
		// systemctl exits non-zero for "inactive"/"failed"/unknown units —
		// that's a real result (service isn't active), not a failure to run
		// the check itself, so only bail out if there's no output at all.
		status := strings.TrimSpace(string(out))
		if status == "" && err != nil {
			return false, fmt.Errorf("running systemctl: %w", err)
		}
		return status == "active", nil
	case "windows":
		cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
			"(Get-Service -Name $env:LOOKSEE_SVC_NAME -ErrorAction SilentlyContinue).Status")
		cmd.Env = append(os.Environ(), "LOOKSEE_SVC_NAME="+name)
		out, err := cmd.Output()
		if err != nil {
			return false, fmt.Errorf("running Get-Service: %w", err)
		}
		return strings.TrimSpace(string(out)) == "Running", nil
	default:
		return false, fmt.Errorf("service checks aren't supported on %s yet", runtime.GOOS)
	}
}

// ListServiceNames returns every registered OS service name, for the check
// form's suggestion list. Best-effort: an unsupported OS returns an empty
// list rather than an error, since discovery is a convenience, not a hard
// requirement the way a configured check's result is.
func ListServiceNames() ([]string, error) {
	switch runtime.GOOS {
	case "linux":
		out, err := exec.Command("systemctl", "list-units", "--type=service", "--all", "--no-legend", "--plain", "--no-pager").Output()
		if err != nil {
			return nil, fmt.Errorf("running systemctl: %w", err)
		}
		var names []string
		for _, line := range strings.Split(string(out), "\n") {
			fields := strings.Fields(line)
			if len(fields) == 0 {
				continue
			}
			names = append(names, strings.TrimSuffix(fields[0], ".service"))
		}
		return names, nil
	case "windows":
		out, err := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command",
			"Get-Service | Select-Object -ExpandProperty Name").Output()
		if err != nil {
			return nil, fmt.Errorf("running Get-Service: %w", err)
		}
		var names []string
		for _, line := range strings.Split(string(out), "\n") {
			line = strings.TrimSpace(line)
			if line != "" {
				names = append(names, line)
			}
		}
		return names, nil
	default:
		return nil, nil
	}
}
