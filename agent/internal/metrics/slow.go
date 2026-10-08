package metrics

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/mem"

	"looksee-agent/internal/execx"
)

type Temp struct {
	Sensor  string  `json:"sensor"`
	Celsius float64 `json:"celsius"`
}

type Fan struct {
	Sensor string  `json:"sensor"`
	RPM    float64 `json:"rpm"`
}

type Battery struct {
	Percent  float64 `json:"percent"`
	Charging bool    `json:"charging"`
	Present  bool    `json:"present"`
}

type Session struct {
	User     string `json:"user"`
	Terminal string `json:"terminal,omitempty"`
	Host     string `json:"host,omitempty"`
	Started  int64  `json:"started,omitempty"`
}

type Users struct {
	Count    int       `json:"count"`
	Sessions []Session `json:"sessions"`
}

type TimeSync struct {
	OffsetMs *float64 `json:"offsetMs,omitempty"`
	Synced   *bool    `json:"synced,omitempty"`
	Server   string   `json:"server,omitempty"`
}

type Updates struct {
	Total     int   `json:"total"`
	Security  int   `json:"security"`
	CheckedAt int64 `json:"checkedAt"`
}

type Defender struct {
	Enabled          bool `json:"enabled"`
	Realtime         bool `json:"realtime"`
	SignatureAgeDays int  `json:"signatureAgeDays"`
}

type Toggle struct {
	Enabled bool   `json:"enabled"`
	Detail  string `json:"detail,omitempty"`
}

type SmartDisk struct {
	Device      string   `json:"device"`
	Model       string   `json:"model,omitempty"`
	Passed      *bool    `json:"passed,omitempty"`
	Reallocated *float64 `json:"reallocated,omitempty"`
	Pending     *float64 `json:"pending,omitempty"`
	WearPercent *float64 `json:"wearPercent,omitempty"`
	TempC       *float64 `json:"tempC,omitempty"`
}

type RaidArray struct {
	Name    string `json:"name"`
	Kind    string `json:"kind"`
	Healthy bool   `json:"healthy"`
	State   string `json:"state,omitempty"`
	Detail  string `json:"detail,omitempty"`
}

// SlowCollector gathers expensive or rarely-changing data on its own
// schedule in the background; Apply copies the latest results into each
// report so report latency never depends on a slow command.
type SlowCollector struct {
	NTPServer string

	mu         sync.Mutex
	users      *Users
	temps      []Temp
	fans       []Fan
	battery    *Battery
	reboot     *bool
	timeSync   *TimeSync
	updates    *Updates
	defender   *Defender
	firewall   *Toggle
	encryption *Toggle
	failed     *int
	smart      []SmartDisk
	raid       []RaidArray
	linkSpeeds map[string]int
	winSystem  *winPerfSystem
	inventory  map[string]any
}

type winPerfSystem struct {
	ContextSwitchesPersec float64
	Threads               int
	Processes             int
}

func NewSlowCollector(ntpServer string) *SlowCollector {
	if ntpServer == "" {
		ntpServer = "pool.ntp.org"
	}
	return &SlowCollector{NTPServer: ntpServer}
}

type job struct {
	every time.Duration
	run   func(s *SlowCollector)
}

var jobs = []job{
	{time.Minute, (*SlowCollector).collectSessions},
	{time.Minute, (*SlowCollector).collectSensors},
	{time.Minute, (*SlowCollector).collectFailedLogins},
	{time.Minute, (*SlowCollector).collectWinSystem},
	{10 * time.Minute, (*SlowCollector).collectSecurity},
	{10 * time.Minute, (*SlowCollector).collectTime},
	{10 * time.Minute, (*SlowCollector).collectRaid},
	{10 * time.Minute, (*SlowCollector).collectLinkSpeeds},
	{30 * time.Minute, (*SlowCollector).collectSmart},
	{6 * time.Hour, (*SlowCollector).collectUpdates},
	{6 * time.Hour, (*SlowCollector).collectInventory},
}

// Start runs every job once immediately, then on its own interval. Each job
// gets its own goroutine so one hung command can't stall the others.
func (s *SlowCollector) Start() {
	for _, j := range jobs {
		j := j
		go func() {
			for {
				func() {
					defer func() {
						if r := recover(); r != nil {
							log.Printf("slow collector panic: %v", r)
						}
					}()
					j.run(s)
				}()
				time.Sleep(j.every)
			}
		}()
	}
}

func (s *SlowCollector) Apply(ext *Extended) {
	s.mu.Lock()
	defer s.mu.Unlock()
	ext.Users = s.users
	ext.Temps = s.temps
	ext.Fans = s.fans
	ext.Battery = s.battery
	ext.PendingReboot = s.reboot
	ext.Time = s.timeSync
	ext.Updates = s.updates
	ext.Defender = s.defender
	ext.Firewall = s.firewall
	ext.Encryption = s.encryption
	ext.FailedLogins = s.failed
	ext.Smart = s.smart
	ext.Raid = s.raid
	if s.winSystem != nil {
		ext.CtxSwitchesPerSec = fp(s.winSystem.ContextSwitchesPersec)
		if ext.Procs != nil {
			t := s.winSystem.Threads
			ext.Procs.Threads = &t
		}
	}
}

func (s *SlowCollector) LinkSpeeds() map[string]int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.linkSpeeds
}

// Inventory returns the latest hardware/OS inventory, or nil before the
// first collection finishes.
func (s *SlowCollector) Inventory() map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.inventory
}

func ps(script string, env map[string]string, timeout time.Duration) (string, bool) {
	res, err := execx.PowerShell(timeout, env, script)
	if err != nil || res.ExitCode != 0 {
		return "", false
	}
	return strings.TrimSpace(res.Stdout), true
}

func boolp(b bool) *bool { return &b }

// ---- sessions ----

func (s *SlowCollector) collectSessions() {
	var sessions []Session
	if runtime.GOOS == "windows" {
		res, err := execx.Run(15*time.Second, nil, "quser")
		if err == nil {
			for _, line := range strings.Split(res.Stdout, "\n")[1:] {
				f := strings.Fields(strings.TrimPrefix(line, ">"))
				if len(f) < 3 {
					continue
				}
				sess := Session{User: f[0]}
				if len(f) >= 6 && (f[3] == "Active" || f[3] == "Disc") {
					sess.Terminal = f[1]
				}
				sessions = append(sessions, sess)
			}
		}
	} else if us, err := host.Users(); err == nil {
		for _, u := range us {
			sessions = append(sessions, Session{User: u.User, Terminal: u.Terminal, Host: u.Host, Started: int64(u.Started)})
		}
	}
	s.mu.Lock()
	s.users = &Users{Count: len(sessions), Sessions: sessions}
	s.mu.Unlock()
}

// ---- temperatures, fans, battery ----

func (s *SlowCollector) collectSensors() {
	var temps []Temp
	if ts, err := host.SensorsTemperatures(); err == nil {
		for _, t := range ts {
			if t.Temperature > 0 && t.Temperature < 150 {
				temps = append(temps, Temp{Sensor: t.SensorKey, Celsius: round2(t.Temperature)})
			}
		}
	}
	var fans []Fan
	var battery *Battery
	switch runtime.GOOS {
	case "linux":
		fans = linuxFans()
		battery = linuxBattery()
	case "windows":
		if out, ok := ps(`$b = Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus; if ($b) { $b | ConvertTo-Json -Compress }`, nil, 20*time.Second); ok && out != "" {
			var b struct {
				EstimatedChargeRemaining float64
				BatteryStatus            int
			}
			if json.Unmarshal([]byte(out), &b) == nil {
				// BatteryStatus 2 = on AC power.
				battery = &Battery{Percent: b.EstimatedChargeRemaining, Charging: b.BatteryStatus == 2 || b.BatteryStatus >= 6, Present: true}
			}
		}
	case "darwin":
		if res, err := execx.Run(10*time.Second, nil, "pmset", "-g", "batt"); err == nil {
			if m := regexp.MustCompile(`(\d+)%;\s*(\w+)`).FindStringSubmatch(res.Stdout); m != nil {
				p, _ := strconv.ParseFloat(m[1], 64)
				battery = &Battery{Percent: p, Charging: strings.Contains(res.Stdout, "AC Power"), Present: true}
			}
		}
	}
	s.mu.Lock()
	s.temps, s.fans, s.battery = temps, fans, battery
	s.mu.Unlock()
}

func readTrim(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func linuxFans() []Fan {
	var fans []Fan
	inputs, _ := filepath.Glob("/sys/class/hwmon/hwmon*/fan*_input")
	for _, in := range inputs {
		rpm, err := strconv.ParseFloat(readTrim(in), 64)
		if err != nil {
			continue
		}
		dir := filepath.Dir(in)
		label := readTrim(strings.TrimSuffix(in, "_input") + "_label")
		if label == "" {
			label = readTrim(filepath.Join(dir, "name")) + " " + strings.TrimSuffix(filepath.Base(in), "_input")
		}
		fans = append(fans, Fan{Sensor: strings.TrimSpace(label), RPM: rpm})
	}
	return fans
}

func linuxBattery() *Battery {
	bats, _ := filepath.Glob("/sys/class/power_supply/BAT*")
	if len(bats) == 0 {
		return nil
	}
	p, err := strconv.ParseFloat(readTrim(filepath.Join(bats[0], "capacity")), 64)
	if err != nil {
		return nil
	}
	status := readTrim(filepath.Join(bats[0], "status"))
	onAC := status == "Charging" || status == "Full" || status == "Not charging"
	if acs, _ := filepath.Glob("/sys/class/power_supply/A*/online"); len(acs) > 0 {
		onAC = readTrim(acs[0]) == "1"
	}
	return &Battery{Percent: p, Charging: onAC, Present: true}
}

// ---- failed logins (last 5 minutes) ----

var sshFailure = regexp.MustCompile(`(?i)(Failed password|Invalid user|authentication failure|Failed publickey)`)

func (s *SlowCollector) collectFailedLogins() {
	var count *int
	switch runtime.GOOS {
	case "windows":
		out, ok := ps(`try { @(Get-WinEvent -FilterHashtable @{LogName='Security';Id=4625;StartTime=(Get-Date).AddMinutes(-5)} -ErrorAction Stop).Count } catch { if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { 0 } else { throw } }`, nil, 30*time.Second)
		if ok {
			if n, err := strconv.Atoi(out); err == nil {
				count = &n
			}
		}
	case "linux":
		res, err := execx.Run(20*time.Second, nil, "journalctl", "-q", "--no-pager", "-o", "cat", "--since", "-5min", "_COMM=sshd")
		if err == nil && res.ExitCode == 0 {
			n := len(sshFailure.FindAllString(res.Stdout, -1))
			count = &n
		}
	}
	s.mu.Lock()
	s.failed = count
	s.mu.Unlock()
}

func (s *SlowCollector) collectWinSystem() {
	if runtime.GOOS != "windows" {
		return
	}
	out, ok := ps(`Get-CimInstance Win32_PerfFormattedData_PerfOS_System | Select-Object ContextSwitchesPersec,Threads,Processes | ConvertTo-Json -Compress`, nil, 20*time.Second)
	if !ok {
		return
	}
	var w winPerfSystem
	if json.Unmarshal([]byte(out), &w) == nil {
		s.mu.Lock()
		s.winSystem = &w
		s.mu.Unlock()
	}
}

// ---- reboot pending, firewall, encryption, Defender ----

func (s *SlowCollector) collectSecurity() {
	reboot := pendingReboot()
	fw := firewallState()
	enc := encryptionState()
	var def *Defender
	if runtime.GOOS == "windows" {
		if out, ok := ps(`Get-MpComputerStatus | Select-Object AntivirusEnabled,RealTimeProtectionEnabled,AntivirusSignatureAge | ConvertTo-Json -Compress`, nil, 30*time.Second); ok {
			var d struct {
				AntivirusEnabled          bool
				RealTimeProtectionEnabled bool
				AntivirusSignatureAge     int
			}
			if json.Unmarshal([]byte(out), &d) == nil {
				def = &Defender{Enabled: d.AntivirusEnabled, Realtime: d.RealTimeProtectionEnabled, SignatureAgeDays: d.AntivirusSignatureAge}
			}
		}
	}
	s.mu.Lock()
	s.reboot, s.firewall, s.encryption, s.defender = reboot, fw, enc, def
	s.mu.Unlock()
}

func pendingReboot() *bool {
	switch runtime.GOOS {
	case "linux":
		if _, err := os.Stat("/var/run/reboot-required"); err == nil {
			return boolp(true)
		}
		if execx.Exists("needs-restarting") {
			res, err := execx.Run(60*time.Second, nil, "needs-restarting", "-r")
			if err == nil {
				return boolp(res.ExitCode == 1)
			}
		}
		return boolp(false)
	case "windows":
		keys := []string{
			`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending`,
			`HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired`,
		}
		for _, k := range keys {
			if res, err := execx.Run(10*time.Second, nil, "reg", "query", k); err == nil && res.ExitCode == 0 {
				return boolp(true)
			}
		}
		if res, err := execx.Run(10*time.Second, nil, "reg", "query", `HKLM\SYSTEM\CurrentControlSet\Control\Session Manager`, "/v", "PendingFileRenameOperations"); err == nil && res.ExitCode == 0 {
			return boolp(true)
		}
		return boolp(false)
	}
	return nil
}

func firewallState() *Toggle {
	switch runtime.GOOS {
	case "windows":
		out, ok := ps(`Get-NetFirewallProfile | Select-Object Name,Enabled | ConvertTo-Json -Compress`, nil, 30*time.Second)
		if !ok {
			return nil
		}
		var profiles []struct {
			Name    string
			Enabled any
		}
		if json.Unmarshal([]byte(out), &profiles) != nil {
			var single struct {
				Name    string
				Enabled any
			}
			if json.Unmarshal([]byte(out), &single) != nil {
				return nil
			}
			profiles = append(profiles, single)
		}
		var off []string
		for _, p := range profiles {
			if fmt.Sprint(p.Enabled) != "1" && fmt.Sprint(p.Enabled) != "true" && fmt.Sprint(p.Enabled) != "True" {
				off = append(off, p.Name)
			}
		}
		if len(off) > 0 {
			return &Toggle{Enabled: false, Detail: "disabled profiles: " + strings.Join(off, ", ")}
		}
		return &Toggle{Enabled: true, Detail: "all profiles enabled"}
	case "linux":
		if res, err := execx.Run(10*time.Second, nil, "ufw", "status"); err == nil && res.ExitCode == 0 {
			return &Toggle{Enabled: strings.Contains(res.Stdout, "Status: active"), Detail: "ufw"}
		}
		if res, err := execx.Run(10*time.Second, nil, "firewall-cmd", "--state"); err == nil {
			return &Toggle{Enabled: strings.TrimSpace(res.Stdout) == "running", Detail: "firewalld"}
		}
		if res, err := execx.Run(10*time.Second, nil, "nft", "list", "ruleset"); err == nil && res.ExitCode == 0 {
			return &Toggle{Enabled: strings.Contains(res.Stdout, "hook input"), Detail: "nftables"}
		}
		return nil
	case "darwin":
		if res, err := execx.Run(10*time.Second, nil, "/usr/libexec/ApplicationFirewall/socketfilterfw", "--getglobalstate"); err == nil {
			return &Toggle{Enabled: strings.Contains(res.Stdout, "enabled"), Detail: "application firewall"}
		}
	}
	return nil
}

func encryptionState() *Toggle {
	switch runtime.GOOS {
	case "windows":
		out, ok := ps(`$v = Get-BitLockerVolume -MountPoint $env:SystemDrive; "$($v.ProtectionStatus)|$($v.VolumeStatus)"`, nil, 30*time.Second)
		if !ok {
			return nil
		}
		parts := strings.SplitN(out, "|", 2)
		return &Toggle{Enabled: parts[0] == "On", Detail: "BitLocker " + strings.Join(parts, ", ")}
	case "linux":
		res, err := execx.Run(10*time.Second, nil, "findmnt", "-no", "SOURCE", "/")
		if err != nil || res.ExitCode != 0 {
			return nil
		}
		src := strings.TrimSpace(res.Stdout)
		chain, err := execx.Run(10*time.Second, nil, "lsblk", "-s", "-no", "TYPE", src)
		if err != nil || chain.ExitCode != 0 {
			return nil
		}
		on := strings.Contains(chain.Stdout, "crypt")
		return &Toggle{Enabled: on, Detail: "root on " + src}
	case "darwin":
		if res, err := execx.Run(10*time.Second, nil, "fdesetup", "status"); err == nil {
			return &Toggle{Enabled: strings.Contains(res.Stdout, "On"), Detail: "FileVault"}
		}
	}
	return nil
}

// ---- time ----

func (s *SlowCollector) collectTime() {
	ts := &TimeSync{Server: s.NTPServer}
	if off, err := SNTPOffset(s.NTPServer, 5*time.Second); err == nil {
		ts.OffsetMs = fp(off.Seconds() * 1000)
	}
	switch runtime.GOOS {
	case "linux":
		if res, err := execx.Run(10*time.Second, nil, "timedatectl", "show", "-p", "NTPSynchronized", "--value"); err == nil && res.ExitCode == 0 {
			ts.Synced = boolp(strings.TrimSpace(res.Stdout) == "yes")
		}
	case "windows":
		if res, err := execx.Run(15*time.Second, nil, "w32tm", "/query", "/status"); err == nil && res.ExitCode == 0 {
			// Leap Indicator 3 means "not synchronized"; a local-clock source
			// means no time server is in use at all.
			unsynced := strings.Contains(res.Stdout, "3(not synchronized)") || strings.Contains(res.Stdout, "Local CMOS Clock") || strings.Contains(res.Stdout, "Free-running")
			ts.Synced = boolp(!unsynced)
		}
	}
	s.mu.Lock()
	s.timeSync = ts
	s.mu.Unlock()
}

// ---- RAID / pools ----

var mdstatHeader = regexp.MustCompile(`^(md\d+)\s*:\s*(\w+)\s+(\S+)?`)
var mdstatStatus = regexp.MustCompile(`\[(\d+)/(\d+)\]\s*\[([U_]+)\]`)

// ParseMdstat reads /proc/mdstat: an array is unhealthy when a member is
// missing ([U_]) or marked failed ((F)).
func ParseMdstat(text string) []RaidArray {
	var arrays []RaidArray
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		m := mdstatHeader.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		a := RaidArray{Name: m[1], Kind: "mdadm", Healthy: true, State: m[2]}
		if strings.Contains(line, "(F)") {
			a.Healthy = false
			a.Detail = "failed member"
		}
		if m[2] != "active" {
			a.Healthy = false
		}
		for j := i + 1; j < len(lines) && j <= i+3 && strings.TrimSpace(lines[j]) != ""; j++ {
			if st := mdstatStatus.FindStringSubmatch(lines[j]); st != nil {
				a.Detail = strings.TrimSpace(a.Detail + " [" + st[3] + "]")
				if strings.Contains(st[3], "_") {
					a.Healthy = false
				}
			}
			if strings.Contains(lines[j], "recovery") || strings.Contains(lines[j], "resync") {
				a.Detail = strings.TrimSpace(a.Detail + " rebuilding")
			}
		}
		arrays = append(arrays, a)
	}
	return arrays
}

func (s *SlowCollector) collectRaid() {
	var arrays []RaidArray
	switch runtime.GOOS {
	case "linux":
		if b, err := os.ReadFile("/proc/mdstat"); err == nil {
			arrays = append(arrays, ParseMdstat(string(b))...)
		}
		if res, err := execx.Run(20*time.Second, nil, "zpool", "list", "-H", "-o", "name,health"); err == nil && res.ExitCode == 0 {
			arrays = append(arrays, ParseZpoolList(res.Stdout)...)
		}
		if res, err := execx.Run(30*time.Second, nil, "storcli64", "/call/vall", "show", "J"); err == nil && res.ExitCode == 0 {
			arrays = append(arrays, parseStorcli(res.Stdout)...)
		}
	case "windows":
		if out, ok := ps(`ConvertTo-Json -Compress -Depth 4 -InputObject @(Get-VirtualDisk | Select-Object FriendlyName,HealthStatus,OperationalStatus)`, nil, 30*time.Second); ok && out != "" {
			var disks []struct {
				FriendlyName      string
				HealthStatus      string
				OperationalStatus string
			}
			if err := json.Unmarshal([]byte(out), &disks); err == nil {
				for _, d := range disks {
					arrays = append(arrays, RaidArray{Name: d.FriendlyName, Kind: "storage-spaces", Healthy: d.HealthStatus == "Healthy", State: d.OperationalStatus})
				}
			}
		}
	}
	s.mu.Lock()
	s.raid = arrays
	s.mu.Unlock()
}

func ParseZpoolList(out string) []RaidArray {
	var arrays []RaidArray
	for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		arrays = append(arrays, RaidArray{Name: f[0], Kind: "zfs", Healthy: f[1] == "ONLINE", State: f[1]})
	}
	return arrays
}

func parseStorcli(out string) []RaidArray {
	var doc struct {
		Controllers []struct {
			ResponseData map[string]json.RawMessage `json:"Response Data"`
		}
	}
	if json.Unmarshal([]byte(out), &doc) != nil {
		return nil
	}
	var arrays []RaidArray
	for ci, c := range doc.Controllers {
		for key, raw := range c.ResponseData {
			if !strings.HasPrefix(key, "/c") {
				continue
			}
			var vds []map[string]any
			if json.Unmarshal(raw, &vds) != nil {
				continue
			}
			for _, vd := range vds {
				state := fmt.Sprint(vd["State"])
				arrays = append(arrays, RaidArray{Name: fmt.Sprintf("c%d %s", ci, fmt.Sprint(vd["DG/VD"])), Kind: "hw-raid", Healthy: state == "Optl", State: state})
			}
		}
	}
	return arrays
}

// ---- SMART ----

func (s *SlowCollector) collectSmart() {
	var disks []SmartDisk
	if execx.Exists("smartctl") {
		disks = smartctlDisks()
	} else if runtime.GOOS == "windows" {
		disks = windowsStorageReliability()
	}
	s.mu.Lock()
	s.smart = disks
	s.mu.Unlock()
}

type smartJSON struct {
	ModelName   string `json:"model_name"`
	SmartStatus *struct {
		Passed bool `json:"passed"`
	} `json:"smart_status"`
	Temperature *struct {
		Current float64 `json:"current"`
	} `json:"temperature"`
	AtaSmartAttributes *struct {
		Table []struct {
			ID    int     `json:"id"`
			Value float64 `json:"value"`
			Raw   struct {
				Value float64 `json:"value"`
			} `json:"raw"`
		} `json:"table"`
	} `json:"ata_smart_attributes"`
	NvmeHealth *struct {
		PercentageUsed float64 `json:"percentage_used"`
		MediaErrors    float64 `json:"media_errors"`
	} `json:"nvme_smart_health_information_log"`
}

// ParseSmartctl turns `smartctl -a -j` output into the fields Looksee
// alerts on. ATA wear comes from whichever wear attribute the vendor uses
// (177/231/233, normalized 100 = new); NVMe reports percentage_used.
func ParseSmartctl(device string, out []byte) (SmartDisk, error) {
	var j smartJSON
	if err := json.Unmarshal(out, &j); err != nil {
		return SmartDisk{}, err
	}
	d := SmartDisk{Device: device, Model: j.ModelName}
	if j.SmartStatus != nil {
		d.Passed = boolp(j.SmartStatus.Passed)
	}
	if j.Temperature != nil && j.Temperature.Current > 0 {
		d.TempC = fp(j.Temperature.Current)
	}
	if j.AtaSmartAttributes != nil {
		for _, a := range j.AtaSmartAttributes.Table {
			switch a.ID {
			case 5:
				d.Reallocated = fp(a.Raw.Value)
			case 197:
				d.Pending = fp(a.Raw.Value)
			case 177, 231, 233:
				if d.WearPercent == nil && a.Value > 0 && a.Value <= 100 {
					d.WearPercent = fp(100 - a.Value)
				}
			}
		}
	}
	if j.NvmeHealth != nil {
		d.WearPercent = fp(j.NvmeHealth.PercentageUsed)
		d.Pending = fp(j.NvmeHealth.MediaErrors)
	}
	return d, nil
}

func smartctlDisks() []SmartDisk {
	res, err := execx.Run(30*time.Second, nil, "smartctl", "--scan", "-j")
	if err != nil {
		return nil
	}
	var scan struct {
		Devices []struct {
			Name string `json:"name"`
			Type string `json:"type"`
		} `json:"devices"`
	}
	if json.Unmarshal([]byte(res.Stdout), &scan) != nil {
		return nil
	}
	var out []SmartDisk
	for _, d := range scan.Devices {
		r, err := execx.Run(60*time.Second, nil, "smartctl", "-a", "-j", "-d", d.Type, d.Name)
		if err != nil {
			continue
		}
		if sd, err := ParseSmartctl(d.Name, []byte(r.Stdout)); err == nil && (sd.Passed != nil || sd.TempC != nil) {
			out = append(out, sd)
		}
	}
	return out
}

func windowsStorageReliability() []SmartDisk {
	out, ok := ps(`ConvertTo-Json -Compress -Depth 4 -InputObject @(Get-PhysicalDisk | ForEach-Object { $r = $_ | Get-StorageReliabilityCounter; [pscustomobject]@{ Name=$_.FriendlyName; Id=$_.DeviceId; Health=[string]$_.HealthStatus; Wear=$r.Wear; Temp=$r.Temperature; Errors=$r.ReadErrorsUncorrected } })`, nil, 60*time.Second)
	if !ok || out == "" {
		return nil
	}
	var rows []struct {
		Name   string
		Id     string
		Health string
		Wear   *float64
		Temp   *float64
		Errors *float64
	}
	if json.Unmarshal([]byte(out), &rows) != nil {
		return nil
	}
	var disks []SmartDisk
	for _, r := range rows {
		d := SmartDisk{Device: "disk" + r.Id, Model: r.Name, Passed: boolp(r.Health == "Healthy"), WearPercent: r.Wear, Pending: r.Errors}
		if r.Temp != nil && *r.Temp > 0 {
			d.TempC = r.Temp
		}
		disks = append(disks, d)
	}
	return disks
}

// ---- link speeds (Windows; Linux reads sysfs directly) ----

func (s *SlowCollector) collectLinkSpeeds() {
	if runtime.GOOS != "windows" {
		return
	}
	out, ok := ps(`ConvertTo-Json -Compress -Depth 4 -InputObject @(Get-NetAdapter | Select-Object Name,InterfaceDescription,@{n='Mbps';e={[math]::Round($_.Speed/1e6)}})`, nil, 30*time.Second)
	if !ok || out == "" {
		return
	}
	var rows []struct {
		Name                 string
		InterfaceDescription string
		Mbps                 int
	}
	if json.Unmarshal([]byte(out), &rows) != nil {
		return
	}
	speeds := map[string]int{}
	for _, r := range rows {
		speeds[r.Name] = r.Mbps
		speeds[r.InterfaceDescription] = r.Mbps
	}
	s.mu.Lock()
	s.linkSpeeds = speeds
	s.mu.Unlock()
}

// ---- pending OS updates ----

// ParseAptSimulate counts "Inst" lines from `apt-get -s upgrade`; ones
// sourced from a -security pocket are security updates.
func ParseAptSimulate(out string) (total, security int) {
	for _, line := range strings.Split(out, "\n") {
		if !strings.HasPrefix(line, "Inst ") {
			continue
		}
		total++
		if strings.Contains(strings.ToLower(line), "security") {
			security++
		}
	}
	return
}

func (s *SlowCollector) collectUpdates() {
	var u *Updates
	now := time.Now().Unix()
	switch runtime.GOOS {
	case "linux":
		if execx.Exists("apt-get") {
			if res, err := execx.Run(5*time.Minute, map[string]string{"LC_ALL": "C"}, "apt-get", "-s", "-o", "Debug::NoLocking=true", "upgrade"); err == nil && res.ExitCode == 0 {
				t, sec := ParseAptSimulate(res.Stdout)
				u = &Updates{Total: t, Security: sec, CheckedAt: now}
			}
		} else if execx.Exists("dnf") || execx.Exists("yum") {
			tool := "dnf"
			if !execx.Exists("dnf") {
				tool = "yum"
			}
			res, err := execx.Run(5*time.Minute, nil, tool, "-q", "check-update")
			if err == nil && (res.ExitCode == 0 || res.ExitCode == 100) {
				total := 0
				for _, l := range strings.Split(res.Stdout, "\n") {
					if f := strings.Fields(l); len(f) == 3 && strings.Contains(f[0], ".") {
						total++
					}
				}
				sec := 0
				if r2, err := execx.Run(5*time.Minute, nil, tool, "-q", "updateinfo", "list", "--security"); err == nil {
					for _, l := range strings.Split(r2.Stdout, "\n") {
						if strings.TrimSpace(l) != "" {
							sec++
						}
					}
				}
				u = &Updates{Total: total, Security: sec, CheckedAt: now}
			}
		} else if execx.Exists("checkupdates") {
			if res, err := execx.Run(5*time.Minute, nil, "checkupdates"); err == nil {
				n := 0
				for _, l := range strings.Split(res.Stdout, "\n") {
					if strings.TrimSpace(l) != "" {
						n++
					}
				}
				u = &Updates{Total: n, CheckedAt: now}
			}
		}
	case "windows":
		out, ok := ps(`$r = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'"); $sec = @($r.Updates | Where-Object { $_.Categories | Where-Object { $_.Name -eq 'Security Updates' -or $_.Name -eq 'Critical Updates' } }).Count; "$($r.Updates.Count)|$sec"`, nil, 15*time.Minute)
		if ok {
			parts := strings.SplitN(out, "|", 2)
			if len(parts) == 2 {
				t, _ := strconv.Atoi(parts[0])
				sec, _ := strconv.Atoi(parts[1])
				u = &Updates{Total: t, Security: sec, CheckedAt: now}
			}
		}
	case "darwin":
		if res, err := execx.Run(10*time.Minute, nil, "softwareupdate", "-l"); err == nil {
			n := strings.Count(res.Stdout+res.Stderr, "* Label:")
			u = &Updates{Total: n, CheckedAt: now}
		}
	}
	if u != nil {
		s.mu.Lock()
		s.updates = u
		s.mu.Unlock()
	}
}

// ---- inventory ----

func (s *SlowCollector) collectInventory() {
	inv := map[string]any{}
	if info, err := host.Info(); err == nil {
		inv["hostname"] = info.Hostname
		inv["os"] = strings.TrimSpace(info.Platform + " " + info.PlatformVersion)
		inv["kernel"] = info.KernelVersion
		inv["arch"] = info.KernelArch
		if info.VirtualizationRole == "guest" {
			inv["virtualization"] = info.VirtualizationSystem
		}
	}
	if cpus, err := cpu.Info(); err == nil && len(cpus) > 0 {
		inv["cpuModel"] = strings.TrimSpace(cpus[0].ModelName)
	}
	inv["cpuCores"] = runtime.NumCPU()
	if vm, err := mem.VirtualMemory(); err == nil {
		inv["memoryGb"] = round2(float64(vm.Total) / 1e9)
	}
	switch runtime.GOOS {
	case "linux":
		for key, file := range map[string]string{"vendor": "sys_vendor", "model": "product_name", "serial": "product_serial", "bios": "bios_version"} {
			if v := readTrim("/sys/class/dmi/id/" + file); v != "" {
				inv[key] = v
			}
		}
	case "windows":
		if out, ok := ps(`$c = Get-CimInstance Win32_ComputerSystem; $b = Get-CimInstance Win32_BIOS; [pscustomobject]@{vendor=$c.Manufacturer; model=$c.Model; serial=$b.SerialNumber; bios=$b.SMBIOSBIOSVersion} | ConvertTo-Json -Compress`, nil, 30*time.Second); ok {
			var extra map[string]string
			if json.Unmarshal([]byte(out), &extra) == nil {
				for k, v := range extra {
					if strings.TrimSpace(v) != "" {
						inv[k] = strings.TrimSpace(v)
					}
				}
			}
		}
	case "darwin":
		if res, err := execx.Run(30*time.Second, nil, "sysctl", "-n", "hw.model"); err == nil {
			inv["model"] = strings.TrimSpace(res.Stdout)
		}
	}
	s.mu.Lock()
	s.inventory = inv
	s.mu.Unlock()
}
