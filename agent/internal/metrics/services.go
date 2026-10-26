// Process and service lookups: "is this process running", "is this service
// active", and the name lists the dashboard's check form suggests from.
//
// Every OS command here runs through execx with a timeout. A service
// manager that hangs (a wedged systemd, a slow WMI on Windows) must not stall
// the agent's report cycle — before 5.1 these calls had no timeout, and one
// hang on the first cycle meant the endpoint never checked in at all.
package metrics

import (
	"fmt"
	"runtime"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/process"

	"looksee-agent/internal/execx"
)

// How long a single service-manager query may take before it's abandoned.
const (
	serviceQueryTimeout = 20 * time.Second
	serviceListTimeout  = 60 * time.Second
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
// a matching name. On Linux, `name` is a separate argv element, never
// concatenated into a shell string. On Windows, PowerShell's -Command
// treats everything after it as script text to parse — trailing argv
// elements do NOT bind to $args the way they do with -File, so `name` is
// passed via an environment variable instead ($env:LOOKSEE_SVC_NAME), which
// PowerShell reads as a plain string value, never as code.
func IsServiceActive(name string) (bool, error) {
	if name == "" {
		return false, nil
	}
	switch runtime.GOOS {
	case "linux":
		res, err := execx.Run(serviceQueryTimeout, nil, "systemctl", "is-active", name)
		// systemctl exits non-zero for "inactive"/"failed"/unknown units —
		// that's a real result (service isn't active), returned as data by
		// execx, so only a failure to run it at all is an error.
		status := strings.TrimSpace(res.Stdout)
		if err != nil {
			return false, fmt.Errorf("running systemctl: %w", err)
		}
		// No answer at all (systemd unreachable) is a failure to check,
		// not "inactive".
		if status == "" && res.ExitCode != 0 {
			return false, fmt.Errorf("running systemctl: %s", strings.TrimSpace(res.Stderr))
		}
		return status == "active", nil
	case "windows":
		res, err := execx.PowerShell(serviceQueryTimeout, map[string]string{"LOOKSEE_SVC_NAME": name},
			"(Get-Service -Name $env:LOOKSEE_SVC_NAME -ErrorAction SilentlyContinue).Status")
		if err != nil {
			return false, fmt.Errorf("running Get-Service: %w", err)
		}
		return strings.TrimSpace(res.Stdout) == "Running", nil
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
		res, err := execx.Run(serviceListTimeout, nil, "systemctl", "list-units", "--type=service", "--all", "--no-legend", "--plain", "--no-pager")
		if err != nil {
			return nil, fmt.Errorf("running systemctl: %w", err)
		}
		var names []string
		for _, line := range strings.Split(res.Stdout, "\n") {
			fields := strings.Fields(line)
			if len(fields) == 0 {
				continue
			}
			names = append(names, strings.TrimSuffix(fields[0], ".service"))
		}
		return names, nil
	case "windows":
		// -ErrorAction SilentlyContinue: one service this account can't
		// query mustn't fail the whole list (execx.PowerShell otherwise
		// stops at the first error).
		res, err := execx.PowerShell(serviceListTimeout, nil, "Get-Service -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name")
		if err != nil {
			return nil, fmt.Errorf("running Get-Service: %w", err)
		}
		return lines(res.Stdout), nil
	default:
		return nil, nil
	}
}
