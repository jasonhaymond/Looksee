// Process and service inventory: every running process (with owner,
// resource use and a credential-masked command line) and every registered
// OS service, for the endpoint page's Processes/Services tabs and the check
// form's pickers. Collected every few cycles in the background (main.go's
// discovery), so a slow listing never holds up a report.
//
// Security: command lines often carry passwords or tokens; RedactCommand
// masks them before they leave the machine.
package metrics

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/process"

	"looksee-agent/internal/execx"
)

// ProcessInfo is one running process for the host's inventory (Hosts page →
// Processes, and the process picker when adding checks).
type ProcessInfo struct {
	PID        int32   `json:"pid"`
	Name       string  `json:"name"`
	User       string  `json:"user,omitempty"`
	CPUPercent float64 `json:"cpuPercent"`
	MemoryMB   float64 `json:"memoryMb"`
	Command    string  `json:"command,omitempty"`
	Started    int64   `json:"started,omitempty"`
}

// ServiceInfo is one registered OS service: systemd unit, Windows service,
// or launchd job.
type ServiceInfo struct {
	Name        string `json:"name"`
	DisplayName string `json:"displayName,omitempty"`
	State       string `json:"state"`
	StartType   string `json:"startType,omitempty"`
}

const maxCommandLen = 300

// Command lines often carry credentials (--password=…, -p secret, a token
// in a URL). They're masked before the inventory leaves the host, since the
// engine stores it and shows it in the dashboard.
var (
	secretArg = regexp.MustCompile(`(?i)((?:^|\s)(?:--?|/)?[\w.-]*(?:pass(?:word|wd|phrase)?|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|auth|credential|cred)s?(?:[=:]|\s+))("[^"]*"|'[^']*'|\S+)`)
	urlCreds  = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*://[^\s:/@]+:)[^\s@/]+@`)
	shortPass = regexp.MustCompile(`(\s-p)(\S+)`)
)

// RedactCommand masks values that look like credentials in a command line.
func RedactCommand(cmd string) string {
	cmd = urlCreds.ReplaceAllString(cmd, "${1}***@")
	cmd = secretArg.ReplaceAllString(cmd, "${1}***")
	// mysql-style -pSECRET (no space) — but leave bare "-p" alone.
	cmd = shortPass.ReplaceAllString(cmd, "${1}***")
	return cmd
}

// How long ListProcesses keeps looking up process owners. Looking up the
// account name of a process owner on Windows can take many seconds per
// lookup on a domain-joined machine that can't reach a domain controller
// (each lookup waits on the network). Once this budget is spent, the rest of
// the list goes out without user names rather than delaying the report.
const processUserBudget = 15 * time.Second

// ListProcesses returns every process with its resource use. CPU % is
// gopsutil's lifetime average for the process, which is what's cheaply
// available without sampling twice. Owner names are looked up only until
// processUserBudget is spent (see above).
func ListProcesses() ([]ProcessInfo, error) {
	procs, err := process.Processes()
	if err != nil {
		return nil, err
	}
	out := make([]ProcessInfo, 0, len(procs))
	userDeadline := time.Now().Add(processUserBudget)
	for _, p := range procs {
		name, err := p.Name()
		if err != nil || name == "" {
			continue
		}
		info := ProcessInfo{PID: p.Pid, Name: name}
		if time.Now().Before(userDeadline) {
			info.User, _ = p.Username()
		}
		if cpu, err := p.CPUPercent(); err == nil {
			info.CPUPercent = round2(cpu)
		}
		if mem, err := p.MemoryInfo(); err == nil && mem != nil {
			info.MemoryMB = round2(float64(mem.RSS) / 1024 / 1024)
		}
		if cmd, err := p.Cmdline(); err == nil {
			cmd = RedactCommand(cmd)
			if len(cmd) > maxCommandLen {
				cmd = cmd[:maxCommandLen] + "…"
			}
			info.Command = cmd
		}
		if created, err := p.CreateTime(); err == nil {
			info.Started = created / 1000
		}
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].MemoryMB > out[j].MemoryMB })
	return out, nil
}

// ListServices returns every registered service with its state and start
// type. Best-effort: an unsupported OS returns an empty list.
func ListServices() ([]ServiceInfo, error) {
	switch runtime.GOOS {
	case "linux":
		return linuxServices()
	case "windows":
		return windowsServices()
	case "darwin":
		return darwinServices()
	default:
		return nil, nil
	}
}

func linuxServices() ([]ServiceInfo, error) {
	units, err := execx.Run(30*time.Second, nil, "systemctl", "list-units", "--type=service", "--all", "--no-legend", "--plain", "--no-pager")
	if err != nil {
		return nil, err
	}
	files, _ := execx.Run(30*time.Second, nil, "systemctl", "list-unit-files", "--type=service", "--no-legend", "--plain", "--no-pager")
	startType := map[string]string{}
	for _, line := range strings.Split(files.Stdout, "\n") {
		f := strings.Fields(line)
		if len(f) >= 2 {
			startType[strings.TrimSuffix(f[0], ".service")] = f[1]
		}
	}
	var out []ServiceInfo
	seen := map[string]bool{}
	for _, line := range strings.Split(units.Stdout, "\n") {
		// UNIT LOAD ACTIVE SUB DESCRIPTION...
		f := strings.Fields(line)
		if len(f) < 4 || f[1] == "not-found" {
			continue
		}
		name := strings.TrimSuffix(f[0], ".service")
		seen[name] = true
		out = append(out, ServiceInfo{Name: name, DisplayName: strings.Join(f[4:], " "), State: f[2] + "/" + f[3], StartType: startType[name]})
	}
	// Installed but never loaded (disabled, not started this boot).
	for name, st := range startType {
		if !seen[name] && !strings.Contains(name, "@") {
			out = append(out, ServiceInfo{Name: name, State: "inactive", StartType: st})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func windowsServices() ([]ServiceInfo, error) {
	res, err := execx.PowerShell(60*time.Second, nil, `ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Service | Select-Object Name,DisplayName,State,StartMode)`)
	if err != nil {
		return nil, err
	}
	var rows []struct {
		Name        string
		DisplayName string
		State       string
		StartMode   string
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &rows); err != nil {
		return nil, err
	}
	out := make([]ServiceInfo, 0, len(rows))
	for _, r := range rows {
		out = append(out, ServiceInfo{Name: r.Name, DisplayName: r.DisplayName, State: strings.ToLower(r.State), StartType: strings.ToLower(r.StartMode)})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

func darwinServices() ([]ServiceInfo, error) {
	res, err := execx.Run(20*time.Second, nil, "launchctl", "list")
	if err != nil {
		return nil, err
	}
	var out []ServiceInfo
	for i, line := range strings.Split(res.Stdout, "\n") {
		f := strings.Fields(line)
		if i == 0 || len(f) < 3 {
			continue
		}
		state := "running"
		if f[0] == "-" {
			state = "stopped"
		}
		out = append(out, ServiceInfo{Name: f[2], State: state})
	}
	return out, nil
}

// ListScripts names the files directly in script_dir — the only scripts a
// custom script check may run.
func ListScripts(dir string) []string {
	if dir == "" {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	var out []string
	for _, e := range entries {
		if e.Type().IsRegular() && !strings.HasPrefix(e.Name(), ".") {
			out = append(out, filepath.Base(e.Name()))
		}
	}
	sort.Strings(out)
	return out
}
