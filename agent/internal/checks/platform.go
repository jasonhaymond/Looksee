package checks

import (
	"encoding/json"
	"fmt"
	"math"
	"net"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"looksee-agent/internal/execx"
)

// I3 (Hyper-V side). "*" checks every VM; a name checks just that one.
func runHyperV(c Cfg) Result {
	if runtime.GOOS != "windows" {
		return unknown("Hyper-V checks are Windows-only")
	}
	res, err := execx.PowerShell(60*time.Second, nil, `ConvertTo-Json -Compress -Depth 4 -InputObject @(Get-VM | Select-Object Name,@{n='State';e={[string]$_.State}},CPUUsage,@{n='MemoryMB';e={[math]::Round($_.MemoryAssigned/1MB)}},@{n='Uptime';e={[int]$_.Uptime.TotalSeconds}})`)
	if err != nil || res.ExitCode != 0 {
		return down("Get-VM failed (is the Hyper-V module installed?): " + execx.FirstLine(res.Stderr))
	}
	var vms []struct {
		Name     string
		State    string
		CPUUsage float64
		MemoryMB float64
		Uptime   int
	}
	out := strings.TrimSpace(res.Stdout)
	if out != "" {
		if err := json.Unmarshal([]byte(out), &vms); err != nil {
			return down("couldn't parse Get-VM output")
		}
	}
	name := c.Str("vmName", "*")
	ignore := splitList(c.Str("ignore", ""))
	var stopped []string
	matched := 0
	for _, vm := range vms {
		if name != "*" && !strings.EqualFold(vm.Name, name) {
			continue
		}
		if ignore[strings.ToLower(vm.Name)] {
			continue
		}
		matched++
		if vm.State != "Running" {
			stopped = append(stopped, fmt.Sprintf("%s (%s)", vm.Name, vm.State))
		}
	}
	if matched == 0 {
		return down("no VM matches " + name)
	}
	if name != "*" {
		vm := vms[0]
		for _, v := range vms {
			if strings.EqualFold(v.Name, name) {
				vm = v
			}
		}
		if vm.State != c.Str("expectedState", "Running") {
			return down(fmt.Sprintf("%s is %s", vm.Name, vm.State))
		}
		return Result{Status: "up", Message: fmt.Sprintf("%s %s, CPU %.0f%%, %.0f MB", vm.Name, vm.State, vm.CPUUsage, vm.MemoryMB), Value: val(vm.CPUUsage), Details: vms}
	}
	return countOrFail(c, len(stopped), overviewMsg(stopped, "VM not running")+fmt.Sprintf(" — %d/%d running", matched-len(stopped), matched), vms)
}

// G3: any Windows performance counter path; wildcard instances are
// combined with the chosen aggregation.
func runPerfCounter(c Cfg) Result {
	if runtime.GOOS != "windows" {
		return unknown("performance counters are Windows-only")
	}
	counter := c.Str("counter", "")
	if counter == "" {
		return unknown("no counter path configured")
	}
	res, err := execx.PowerShell(45*time.Second, map[string]string{"LOOKSEE_COUNTER": counter}, `ConvertTo-Json -Compress -Depth 4 -InputObject @((Get-Counter -Counter $env:LOOKSEE_COUNTER -SampleInterval 1 -MaxSamples 1).CounterSamples | Select-Object Path,CookedValue)`)
	if err != nil || res.ExitCode != 0 {
		return down("Get-Counter failed: " + execx.FirstLine(res.Stderr))
	}
	var samples []struct {
		Path        string
		CookedValue float64
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &samples); err != nil || len(samples) == 0 {
		return down("no samples returned for " + counter)
	}
	agg := c.Str("aggregation", "sum")
	v := samples[0].CookedValue
	if len(samples) > 1 {
		v = 0
		if agg == "max" {
			v = math.Inf(-1)
		} else if agg == "min" {
			v = math.Inf(1)
		}
		for _, s := range samples {
			switch agg {
			case "max":
				v = math.Max(v, s.CookedValue)
			case "min":
				v = math.Min(v, s.CookedValue)
			default:
				v += s.CookedValue
			}
		}
		if agg == "avg" {
			v /= float64(len(samples))
		}
	}
	return Result{Status: "up", Message: fmt.Sprintf("%s = %.2f", counter, v), Value: val(v), Details: samples}
}

func findWg() string {
	if execx.Exists("wg") {
		return "wg"
	}
	if p := `C:\Program Files\WireGuard\wg.exe`; fileExists(p) {
		return p
	}
	return ""
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

// E7. WireGuard: age of the most recent peer handshake (WireGuard
// re-handshakes every ~2 minutes while traffic flows). Interface: just that
// the tunnel interface exists and is up (OpenVPN, Tailscale, ZeroTier...).
func runVPN(c Cfg) Result {
	iface := c.Str("interface", "")
	switch c.Str("kind", "wireguard") {
	case "wireguard":
		wg := findWg()
		if wg == "" {
			return unknown("wg isn't installed on this host")
		}
		if iface == "" {
			return unknown("no WireGuard interface configured")
		}
		res, err := execx.Run(15*time.Second, nil, wg, "show", iface, "latest-handshakes")
		if err != nil {
			return down(err.Error())
		}
		if res.ExitCode != 0 {
			return down(execx.FirstLine(res.Stderr + res.Stdout))
		}
		peer := c.Str("peer", "")
		var newest int64
		for _, line := range strings.Split(strings.TrimSpace(res.Stdout), "\n") {
			f := strings.Fields(line)
			if len(f) != 2 || (peer != "" && f[0] != peer) {
				continue
			}
			if ts, err := strconv.ParseInt(f[1], 10, 64); err == nil && ts > newest {
				newest = ts
			}
		}
		if newest == 0 {
			return down("no handshake recorded on " + iface)
		}
		age := time.Since(time.Unix(newest, 0))
		r := Result{Status: "up", Message: fmt.Sprintf("%s: last handshake %s ago", iface, humanAge(age)), Value: val(age.Seconds())}
		if max := c.Num("maxHandshakeAgeSeconds", 300); age.Seconds() > max {
			r.Status = "down"
		}
		return r
	default:
		if iface == "" {
			return unknown("no interface configured")
		}
		ifc, err := net.InterfaceByName(iface)
		if err != nil {
			return down(iface + " doesn't exist (tunnel down?)")
		}
		if ifc.Flags&net.FlagUp == 0 {
			return down(iface + " is down")
		}
		addrs, _ := ifc.Addrs()
		return up(fmt.Sprintf("%s is up (%d address(es))", iface, len(addrs)), nil)
	}
}

// ParseKeyValues reads "key: value" lines (upsc, apcaccess).
func ParseKeyValues(out string) map[string]string {
	kv := map[string]string{}
	for _, line := range strings.Split(out, "\n") {
		if k, v, ok := strings.Cut(line, ":"); ok {
			kv[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	return kv
}

func leadingFloat(s string) (float64, bool) {
	f := strings.Fields(s)
	if len(f) == 0 {
		return 0, false
	}
	v, err := strconv.ParseFloat(f[0], 64)
	return v, err == nil
}

// B12 (UPS side): Network UPS Tools or apcupsd on this host. On battery
// is a warn; low battery is down.
func runUPS(c Cfg) Result {
	var charge, runtimeMin float64
	var onBattery, low bool
	var status string
	switch c.Str("driver", "nut") {
	case "apcupsd":
		res, err := execx.Run(15*time.Second, nil, "apcaccess", "status")
		if err != nil {
			return down(err.Error())
		}
		kv := ParseKeyValues(res.Stdout)
		charge, _ = leadingFloat(kv["BCHARGE"])
		runtimeMin, _ = leadingFloat(kv["TIMELEFT"])
		status = kv["STATUS"]
		onBattery = strings.Contains(status, "ONBATT")
		low = strings.Contains(status, "LOWBATT")
	default:
		name := c.Str("upsName", "ups@localhost")
		res, err := execx.Run(15*time.Second, nil, "upsc", name)
		if err != nil {
			return down(err.Error())
		}
		if res.ExitCode != 0 {
			return down(execx.FirstLine(res.Stderr))
		}
		kv := ParseKeyValues(res.Stdout)
		charge, _ = leadingFloat(kv["battery.charge"])
		secs, _ := leadingFloat(kv["battery.runtime"])
		runtimeMin = secs / 60
		status = kv["ups.status"]
		flags := strings.Fields(status)
		for _, f := range flags {
			switch f {
			case "OB":
				onBattery = true
			case "LB":
				low = true
			}
		}
	}
	msg := fmt.Sprintf("%s — battery %.0f%%, %.0f min runtime", status, charge, runtimeMin)
	r := Result{Status: "up", Message: msg, Value: val(charge), Details: map[string]any{"runtimeMinutes": runtimeMin, "status": status}}
	if low {
		r.Status = "down"
	} else if onBattery {
		r.Status = "warn"
	}
	return r
}

// J5. Borg and restic list their newest archive/snapshot; Veeam is read
// from its "job finished" event (ID 190). The repository passphrase reaches
// the tool through its own environment variable, never argv.
func runBackup(c Cfg) Result {
	maxAge := c.Num("maxAgeHours", 26)
	extra := map[string]string{}
	for _, line := range strings.Split(c.Str("extraEnv", ""), "\n") {
		if k, v, ok := strings.Cut(strings.TrimSpace(line), "="); ok && k != "" {
			extra[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	var last time.Time
	var detail string
	switch tool := c.Str("tool", "borg"); tool {
	case "borg":
		env := map[string]string{"BORG_PASSPHRASE": c.Str("passphrase", ""), "BORG_RELOCATED_REPO_ACCESS_IS_OK": "yes", "BORG_UNKNOWN_UNENCRYPTED_REPO_ACCESS_IS_OK": "yes"}
		for k, v := range extra {
			env[k] = v
		}
		res, err := execx.Run(5*time.Minute, env, "borg", "list", "--last", "1", "--json", c.Str("repo", ""))
		if err != nil {
			return down(err.Error())
		}
		if res.ExitCode != 0 {
			return down("borg list failed: " + execx.FirstLine(res.Stderr))
		}
		var out struct {
			Archives []struct {
				Name string `json:"name"`
				Time string `json:"time"`
			} `json:"archives"`
		}
		if err := json.Unmarshal([]byte(res.Stdout), &out); err != nil || len(out.Archives) == 0 {
			return down("repository has no archives")
		}
		// borg prints local time without an offset.
		last, _ = time.ParseInLocation("2006-01-02T15:04:05.000000", out.Archives[0].Time, time.Local)
		detail = out.Archives[0].Name
	case "restic":
		env := map[string]string{"RESTIC_PASSWORD": c.Str("passphrase", ""), "RESTIC_REPOSITORY": c.Str("repo", "")}
		for k, v := range extra {
			env[k] = v
		}
		res, err := execx.Run(5*time.Minute, env, "restic", "snapshots", "--latest", "1", "--json", "--no-lock")
		if err != nil {
			return down(err.Error())
		}
		if res.ExitCode != 0 {
			return down("restic snapshots failed: " + execx.FirstLine(res.Stderr))
		}
		var snaps []struct {
			Time  time.Time `json:"time"`
			Short string    `json:"short_id"`
		}
		if err := json.Unmarshal([]byte(res.Stdout), &snaps); err != nil || len(snaps) == 0 {
			return down("repository has no snapshots")
		}
		for _, s := range snaps {
			if s.Time.After(last) {
				last, detail = s.Time, s.Short
			}
		}
	case "veeam":
		if runtime.GOOS != "windows" {
			return unknown("Veeam checks read the Windows event log")
		}
		res, err := execx.PowerShell(60*time.Second, nil, `$e = $null; foreach ($log in 'Veeam Agent','Veeam Backup','Application') { try { $e = Get-WinEvent -FilterHashtable @{LogName=$log; Id=190} -MaxEvents 1 -ErrorAction Stop; if ($e) { break } } catch {} }; if ($e) { [pscustomobject]@{ Time=$e.TimeCreated.ToString('o'); Message=($e.Message -split "`+"`"+`n")[0] } | ConvertTo-Json -Compress }`)
		if err != nil || res.ExitCode != 0 || strings.TrimSpace(res.Stdout) == "" {
			return down("no Veeam job-finished event (ID 190) found")
		}
		var ev struct{ Time, Message string }
		if err := json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &ev); err != nil {
			return down("couldn't parse the Veeam event")
		}
		last, _ = time.Parse(time.RFC3339Nano, ev.Time)
		detail = ev.Message
		lower := strings.ToLower(ev.Message)
		if strings.Contains(lower, "failed") {
			return Result{Status: "down", Message: "Last Veeam job failed: " + ev.Message, Value: val(time.Since(last).Hours())}
		}
		if strings.Contains(lower, "warning") {
			return Result{Status: "warn", Message: "Last Veeam job finished with warnings: " + ev.Message, Value: val(time.Since(last).Hours())}
		}
	default:
		return unknown("unknown backup tool: " + tool)
	}
	age := time.Since(last)
	r := Result{Status: "up", Message: fmt.Sprintf("Latest backup %s ago (%s)", humanAge(age), detail), Value: val(age.Hours())}
	if age.Hours() > maxAge {
		r.Status = "down"
		r.Message = fmt.Sprintf("No backup for %s (latest: %s)", humanAge(age), detail)
	}
	return r
}
