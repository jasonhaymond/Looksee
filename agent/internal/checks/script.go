package checks

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"looksee-agent/internal/execx"
)

var perfdata = regexp.MustCompile(`'?([^'=]+)'?=(-?[\d.]+)`)
var firstNumber = regexp.MustCompile(`-?\d+(?:\.\d+)?`)

// ParseScriptOutput follows the Nagios plugin convention: the first line is
// the message, an optional "| label=value" suffix carries performance data
// (the first value becomes the check's value).
func ParseScriptOutput(out string, wantNumber bool) (msg string, value *float64) {
	first := execx.FirstLine(out)
	msg = first
	if i := strings.Index(first, "|"); i >= 0 {
		msg = strings.TrimSpace(first[:i])
		if m := perfdata.FindStringSubmatch(first[i+1:]); m != nil {
			if f, err := strconv.ParseFloat(m[2], 64); err == nil {
				value = &f
			}
		}
	}
	if value == nil && wantNumber {
		if m := firstNumber.FindString(msg); m != "" {
			if f, err := strconv.ParseFloat(m, 64); err == nil {
				value = &f
			}
		}
	}
	return msg, value
}

var scriptName = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)

// F7. Only scripts sitting directly in the agent's configured script_dir
// can run, named by file name — the engine can choose which approved
// script runs, never what it contains. Without script_dir set, script
// checks are disabled entirely.
func runScript(c Cfg, scriptDir string) Result {
	if scriptDir == "" {
		return unknown("script checks are disabled on this host — set script_dir in looksee-agent.yaml (agent README → Custom scripts)")
	}
	name := c.Str("script", "")
	if !scriptName.MatchString(name) || name == "." || name == ".." {
		return unknown("script must be a plain file name inside " + scriptDir)
	}
	path := filepath.Join(scriptDir, name)
	if _, err := os.Stat(path); err != nil {
		return down("script not found: " + path)
	}
	args := strings.Fields(c.Str("args", ""))
	timeout := time.Duration(c.Num("timeoutSeconds", 30)) * time.Second
	var res execx.Result
	var err error
	switch strings.ToLower(filepath.Ext(name)) {
	case ".ps1":
		res, err = execx.Run(timeout, nil, "powershell", append([]string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path}, args...)...)
	default:
		res, err = execx.Run(timeout, nil, path, args...)
	}
	if err != nil {
		return down(err.Error())
	}
	msg, value := ParseScriptOutput(res.Stdout, c.Bool("parseValue", true))
	if msg == "" {
		msg = execx.FirstLine(res.Stderr)
	}
	r := Result{Message: msg, Value: value}
	switch res.ExitCode {
	case 0:
		r.Status = "up"
	case 1:
		r.Status = "warn"
	case 2:
		r.Status = "down"
	default:
		r.Status = "unknown"
		r.Message = fmt.Sprintf("exit code %d: %s", res.ExitCode, msg)
	}
	return r
}

// F6. Windows: Task Scheduler's last run result + time. Linux: a systemd
// timer's service (cron has no record of exit codes — use a heartbeat
// check for cron jobs instead).
func runScheduledTask(c Cfg) Result {
	name := c.Str("taskName", "")
	if name == "" {
		return unknown("no task name configured")
	}
	maxAge := c.Num("maxAgeHours", -1)
	switch runtime.GOOS {
	case "windows":
		path, task := "\\", name
		if i := strings.LastIndex(name, "\\"); i >= 0 {
			path, task = name[:i+1], name[i+1:]
		}
		res, err := execx.PowerShell(30*time.Second, map[string]string{"LOOKSEE_TASK": task, "LOOKSEE_TASK_PATH": path},
			`Get-ScheduledTask -TaskName $env:LOOKSEE_TASK -TaskPath $env:LOOKSEE_TASK_PATH | Get-ScheduledTaskInfo | Select-Object @{n='Last';e={$_.LastRunTime.ToString('o')}},LastTaskResult,@{n='Next';e={if($_.NextRunTime){$_.NextRunTime.ToString('o')}}} | ConvertTo-Json -Compress`)
		if err != nil || res.ExitCode != 0 {
			return down("task not found: " + execx.FirstLine(res.Stderr))
		}
		var info struct {
			Last           string
			LastTaskResult int64
			Next           string
		}
		if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &info); err != nil {
			return down("couldn't read task info")
		}
		last, _ := time.Parse(time.RFC3339Nano, info.Last)
		// 0x41303 = "has not yet run"; 0x41301 = currently running.
		if info.LastTaskResult == 0x41303 || last.Year() < 2000 {
			return Result{Status: "warn", Message: "task has never run"}
		}
		age := time.Since(last)
		r := Result{Status: "up", Message: fmt.Sprintf("last run %s ago, result 0x%X", humanAge(age), info.LastTaskResult), Value: val(age.Hours())}
		if info.LastTaskResult != 0 && info.LastTaskResult != 0x41301 {
			r.Status = "down"
		}
		if maxAge >= 0 && age.Hours() > maxAge {
			r.Status = "down"
			r.Message = fmt.Sprintf("hasn't run for %s (expected every %vh)", humanAge(age), maxAge)
		}
		return r
	case "linux":
		unit := strings.TrimSuffix(name, ".timer")
		if !strings.Contains(unit, ".") {
			unit += ".service"
		}
		res, err := execx.Run(15*time.Second, nil, "systemctl", "show", unit, "-p", "Result", "-p", "ExecMainStatus", "-p", "ExecMainExitTimestamp", "-p", "LoadState", "--timestamp=unix")
		if err != nil {
			return down(err.Error())
		}
		props := map[string]string{}
		for _, l := range strings.Split(res.Stdout, "\n") {
			if k, v, ok := strings.Cut(strings.TrimSpace(l), "="); ok {
				props[k] = v
			}
		}
		if props["LoadState"] == "not-found" {
			return down(unit + " not found")
		}
		ts, _ := strconv.ParseInt(strings.TrimPrefix(props["ExecMainExitTimestamp"], "@"), 10, 64)
		if ts == 0 {
			return Result{Status: "warn", Message: unit + " has never run"}
		}
		age := time.Since(time.Unix(ts, 0))
		r := Result{Status: "up", Message: fmt.Sprintf("%s last finished %s ago: %s (exit %s)", unit, humanAge(age), props["Result"], props["ExecMainStatus"]), Value: val(age.Hours())}
		if props["Result"] != "success" {
			r.Status = "down"
		}
		if maxAge >= 0 && age.Hours() > maxAge {
			r.Status = "down"
		}
		return r
	default:
		return unknown("scheduled task checks support Windows Task Scheduler and systemd timers")
	}
}
