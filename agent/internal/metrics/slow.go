// The slow collector: data that's expensive or changes rarely (sessions,
// sensors, failed logins, security state, time sync, RAID, SMART, pending
// updates with phased/security flags, hardware inventory, installed software)
// gathered in the background on its own schedules, so a slow command never
// delays a report.

package metrics

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/sensors"

	"looksee-agent/internal/android"
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

// Session is one signed-in user. The fields after Started are only filled in
// on Windows, by the session API (sessions_windows.go), for the RDP sessions
// check; other systems report who is signed in and from where.
type Session struct {
	User     string `json:"user"`
	Terminal string `json:"terminal,omitempty"`
	Host     string `json:"host,omitempty"`
	Started  int64  `json:"started,omitempty"`
	// Windows' session number.
	ID int `json:"id,omitempty"`
	// "active", "disconnected", or "idle"/"connected"/... for rarer states.
	State string `json:"state,omitempty"`
	// "rdp", "console", or "" when Windows can't say: a disconnected session
	// has no connection left to name.
	Kind string `json:"kind,omitempty"`
	// The computer name the user connected from (RDP).
	ClientName string `json:"clientName,omitempty"`
	// Seconds since the user's last keyboard or mouse input.
	IdleSeconds *int64 `json:"idleSeconds,omitempty"`
	// When the session was disconnected (Unix seconds).
	DisconnectedAt int64 `json:"disconnectedAt,omitempty"`
}

type Users struct {
	Count    int       `json:"count"`
	Sessions []Session `json:"sessions"`
	// True when Sessions carry state and connection type (Windows, agent 5.4+),
	// which is what tells the engine's RDP check that "no sessions" is a real
	// answer and not an agent that can't tell.
	Detail bool `json:"detail,omitempty"`
}

type TimeSync struct {
	OffsetMs *float64 `json:"offsetMs,omitempty"`
	Synced   *bool    `json:"synced,omitempty"`
	Server   string   `json:"server,omitempty"`
}

// Updates counts pending OS updates. Total and Security leave out Ubuntu
// phased updates, which are counted in Phased.
type Updates struct {
	Total     int   `json:"total"`
	Security  int   `json:"security"`
	Phased    int   `json:"phased"`
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

	mu           sync.Mutex
	smartAt      time.Time
	smartProblem string
	users        *Users
	temps        []Temp
	fans         []Fan
	battery      *Battery
	reboot       *bool
	timeSync     *TimeSync
	updates      *Updates
	defender     *Defender
	firewall     *Toggle
	encryption   *Toggle
	failed       *int
	smart        []SmartDisk
	raid         []RaidArray
	linkSpeeds   map[string]int
	winSystem    *winPerfSystem
	inventory    map[string]any
	// Software (software.go): upgradable packages from the updates job,
	// installed packages from the software job, and the lock files the
	// engine asked to read.
	upgradable    []Upgradable
	upgradableAt  int64
	packages      []Package
	packageErrors []string
	packagesAt    int64
	lockfiles     []string
	osRelease     map[string]string
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
	return &SlowCollector{NTPServer: ntpServer, osRelease: OSRelease()}
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
	{6 * time.Hour, (*SlowCollector).collectSoftware},
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
	ext.SmartProblem = s.smartProblem
	// Reports start before the first read finishes (it can take up to a minute),
	// and "still reading" shouldn't look like the drive isn't reporting.
	if s.smart == nil && s.smartProblem == "" {
		ext.SmartProblem = "still reading the drives; the first read can take a minute after the agent starts"
	}
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

// collectSessions records who is signed in. On Windows it asks the session API
// (windowsSessions), which also says each session's state and connection type
// and works in any display language, unlike parsing quser's translated text. A
// failed read leaves the previous list in place rather than reporting that
// everyone signed out.
func (s *SlowCollector) collectSessions() {
	var sessions []Session
	detail := false
	if runtime.GOOS == "windows" {
		found, err := windowsSessions()
		if err != nil {
			log.Printf("couldn't list sessions: %v", err)
			return
		}
		sessions, detail = found, true
	} else if us, err := host.Users(); err == nil {
		for _, u := range us {
			sessions = append(sessions, Session{User: u.User, Terminal: u.Terminal, Host: u.Host, Started: int64(u.Started)})
		}
	}
	s.mu.Lock()
	s.users = &Users{Count: len(sessions), Sessions: sessions, Detail: detail}
	s.mu.Unlock()
}

// ---- temperatures, fans, battery ----

func (s *SlowCollector) collectSensors() {
	var temps []Temp
	if ts, err := sensors.SensorsTemperatures(); err == nil {
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
	// Android phones name it "battery"; apps may not be allowed to read it,
	// in which case Termux:API is asked instead.
	if android.IsAndroid() {
		bats, _ = filepath.Glob("/sys/class/power_supply/battery")
		if len(bats) == 0 || readTrim(filepath.Join(bats[0], "capacity")) == "" {
			if p, charging, ok := android.Battery(); ok {
				return &Battery{Percent: p, Charging: charging, Present: true}
			}
			return nil
		}
	}
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
		// Failed logons (event 4625) in the last 300,000 ms. wevtutil rather than
		// PowerShell because this runs every minute: see checks/eventlog.go.
		res, err := execx.Run(30*time.Second, nil, "wevtutil", "qe", "Security", "/q:*[System[EventID=4625 and TimeCreated[timediff(@SystemTime) <= 300000]]]", "/c:1000", "/f:xml")
		if err == nil && res.ExitCode == 0 {
			n := strings.Count(res.Stdout, "<Event ")
			count = &n
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

// smartKeepFor is how long the last good SMART data is kept while collecting
// fails. A slow moment shouldn't make drives vanish from the report for half an
// hour (the job's interval); a drive that stays unreadable is reported after this.
const smartKeepFor = 2 * time.Hour

// collectSmart reads drive health: smartctl where it's installed, Windows' own
// reliability counters otherwise (or if smartctl can't read anything). When
// nothing can be read it records why (smartProblem), and the engine shows that
// reason instead of only saying SMART isn't reported.
func (s *SlowCollector) collectSmart() {
	var disks []SmartDisk
	var problem string
	if path := findSmartctl(); path != "" {
		disks, problem = smartctlDisks(path)
	} else {
		problem = "smartctl isn't installed"
	}
	if len(disks) == 0 && runtime.GOOS == "windows" {
		var why string
		if disks, why = windowsStorageReliability(); len(disks) == 0 {
			problem = strings.TrimPrefix(problem+"; Windows reliability counters: "+why, "; ")
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(disks) > 0 {
		s.smart, s.smartAt, s.smartProblem = disks, time.Now(), ""
		return
	}
	s.smartProblem = problem
	if time.Since(s.smartAt) > smartKeepFor {
		s.smart = nil
	}
}

// smartctlSearchPaths are the usual install locations, tried when smartctl isn't
// on the agent's PATH. A service's PATH is fixed when it starts, and a user's
// shell often has folders a service doesn't, which is how smartctl can work when
// typed by hand yet look missing to the agent.
//
// Security: whatever is found here runs with the agent's privileges (root on macOS,
// SYSTEM on Windows), so this must only list folders ordinary users can't write to.
// That rules out Homebrew's folders on macOS: /opt/homebrew, and /usr/local on Intel
// Macs, belong to whoever installed Homebrew, so malware running as that user could
// plant a "smartctl" there and have it run as root.
func smartctlSearchPaths(goos string) []string {
	switch goos {
	case "windows":
		var paths []string
		for _, env := range []string{"ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"} {
			if dir := os.Getenv(env); dir != "" {
				paths = append(paths, filepath.Join(dir, "smartmontools", "bin", "smartctl.exe"))
			}
		}
		return paths
	case "darwin":
		return []string{"/usr/sbin/smartctl", "/sbin/smartctl", "/usr/bin/smartctl"}
	default:
		paths := []string{"/usr/sbin/smartctl", "/sbin/smartctl", "/usr/local/sbin/smartctl", "/usr/bin/smartctl", "/usr/local/bin/smartctl"}
		// Termux's folder is only the agent's own app folder on Android. On ordinary
		// Linux nothing protects that path, so someone able to create it could plant a
		// program there for the agent to run.
		if android.IsAndroid() {
			paths = append(paths, "/data/data/com.termux/files/usr/bin/smartctl")
		}
		return paths
	}
}

// findSmartctl returns the command to run for smartctl, or "" if it isn't there.
func findSmartctl() string {
	if execx.Exists("smartctl") {
		return "smartctl"
	}
	for _, p := range smartctlSearchPaths(runtime.GOOS) {
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			return p
		}
	}
	return ""
}

type smartJSON struct {
	// smartctl's own notes about this run, e.g. "Permission denied".
	Smartctl struct {
		Messages []struct {
			String   string `json:"string"`
			Severity string `json:"severity"`
		} `json:"messages"`
	} `json:"smartctl"`
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

// SmartctlMessage returns the first error smartctl reports in its JSON output
// (e.g. "Permission denied"), or "" if there isn't one or it isn't JSON.
func SmartctlMessage(out []byte) string {
	var j smartJSON
	if json.Unmarshal(out, &j) != nil {
		return ""
	}
	for _, m := range j.Smartctl.Messages {
		if m.Severity == "error" && m.String != "" {
			return m.String
		}
	}
	return ""
}

// smartDeviceTypes lists the -d values to try for a drive, best guess first: what
// the scan said, then smartctl's own detection ("" = no -d), then SATA-behind-USB
// ("sat"). A scan often calls a USB-attached or controller-attached drive "scsi",
// which then answers with no health data, while the plain command typed by hand
// detects it correctly.
func smartDeviceTypes(scanned string) []string {
	types := []string{}
	for _, t := range []string{scanned, "", "sat"} {
		if !slices.Contains(types, t) {
			types = append(types, t)
		}
	}
	return types
}

// smartctlScanDevice is one drive from `smartctl --scan -j`.
type smartctlScanDevice struct {
	Name string `json:"name"`
	Type string `json:"type"`
}

// smartctlDisks reads every drive smartctl can find.
//
// path is the command to run (see findSmartctl). It returns the drives it could
// read, and when it could read none, a plain-language reason for the dashboard.
// A drive smartctl can't read (a card reader, a virtual disk) is skipped.
func smartctlDisks(path string) ([]SmartDisk, string) {
	res, err := execx.Run(30*time.Second, nil, path, "--scan", "-j")
	if err != nil {
		return nil, "smartctl --scan failed: " + err.Error()
	}
	var scan struct {
		Devices []smartctlScanDevice `json:"devices"`
	}
	if json.Unmarshal([]byte(res.Stdout), &scan) != nil {
		return nil, "smartctl didn't answer in JSON — Looksee needs smartmontools 7 or newer"
	}
	if len(scan.Devices) == 0 {
		return nil, "smartctl found no drives (a virtual machine usually has none it can read)"
	}
	var out []SmartDisk
	var reasons []string
	for _, d := range scan.Devices {
		why := ""
		found := false
		// Try each device type until one returns health data.
		for _, t := range smartDeviceTypes(d.Type) {
			args := []string{"-a", "-j"}
			if t != "" {
				args = append(args, "-d", t)
			}
			r, err := execx.Run(60*time.Second, nil, path, append(args, d.Name)...)
			if err != nil {
				why = err.Error()
				continue
			}
			sd, err := ParseSmartctl(d.Name, []byte(r.Stdout))
			if err == nil && (sd.Passed != nil || sd.TempC != nil) {
				out = append(out, sd)
				found = true
				break
			}
			if m := SmartctlMessage([]byte(r.Stdout)); m != "" {
				why = m
			} else if why == "" {
				why = "no health data"
			}
		}
		if !found {
			reasons = append(reasons, d.Name+": "+why)
		}
	}
	if len(out) > 0 {
		return out, ""
	}
	return nil, smartHint(strings.Join(reasons, "; "))
}

// smartHint adds what to do when the reason is a permissions problem. On Linux
// that's the usual cause: the agent is its own unprivileged user, while smartctl
// typed by hand runs under sudo, so it works by hand but not for the agent.
func smartHint(reason string) string {
	if strings.Contains(strings.ToLower(reason), "permission denied") && runtime.GOOS == "linux" {
		return reason + " — the agent lacks disk access. Install its privileged drop-in (agent README → Privileges; agents installed before 5.0 or with --minimal don't have it)"
	}
	return reason
}

// windowsStorageReliability reads Windows' own view of drive health. A drive whose
// reliability counters can't be read (common for virtual disks and some RAID
// controllers) still reports its health status rather than failing the whole
// list. Returns the drives, or nil and why.
func windowsStorageReliability() ([]SmartDisk, string) {
	out, ok := ps(`ConvertTo-Json -Compress -Depth 4 -InputObject @(Get-PhysicalDisk | ForEach-Object { $r = try { $_ | Get-StorageReliabilityCounter -ErrorAction Stop } catch { $null }; [pscustomobject]@{ Name=$_.FriendlyName; Id=$_.DeviceId; Health=[string]$_.HealthStatus; Wear=$r.Wear; Temp=$r.Temperature; Errors=$r.ReadErrorsUncorrected } })`, nil, 60*time.Second)
	if !ok {
		return nil, "Get-PhysicalDisk failed or timed out"
	}
	var rows []struct {
		Name   string
		Id     string
		Health string
		Wear   *float64
		Temp   *float64
		Errors *float64
	}
	if out == "" || json.Unmarshal([]byte(out), &rows) != nil {
		return nil, "Get-PhysicalDisk returned nothing readable"
	}
	var disks []SmartDisk
	for _, r := range rows {
		d := SmartDisk{Device: "disk" + r.Id, Model: r.Name, Passed: boolp(r.Health == "Healthy"), WearPercent: r.Wear, Pending: r.Errors}
		if r.Temp != nil && *r.Temp > 0 {
			d.TempC = r.Temp
		}
		disks = append(disks, d)
	}
	if len(disks) == 0 {
		return nil, "Windows lists no physical disks"
	}
	return disks, ""
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
	ups, ok := upgradablePackages()
	if !ok {
		return
	}
	// Counts leave out Ubuntu phased updates (held back on purpose by the
	// rollout); they're counted separately so a check can include them.
	u := &Updates{CheckedAt: time.Now().Unix()}
	for _, p := range ups {
		switch {
		case p.Phased:
			u.Phased++
		default:
			u.Total++
			if p.Security {
				u.Security++
			}
		}
	}
	s.mu.Lock()
	s.updates = u
	s.upgradable = ups
	s.upgradableAt = u.CheckedAt
	s.mu.Unlock()
}

// upgradablePackages lists the packages with an update available on this
// platform. ok is false when no supported package manager answered.
func upgradablePackages() (ups []Upgradable, ok bool) {
	c := map[string]string{"LC_ALL": "C"}
	switch runtime.GOOS {
	case "linux":
		if execx.Exists("apt-get") {
			list, err := execx.Run(5*time.Minute, c, "apt", "list", "--upgradable")
			if err != nil || list.ExitCode != 0 {
				return nil, false
			}
			ups = ParseAptUpgradable(list.Stdout)
			// A simulated upgrade names the packages deferred by phasing.
			if sim, err := execx.Run(5*time.Minute, c, "apt-get", "-s", "-o", "Debug::NoLocking=true", "upgrade"); err == nil {
				phased := ParseAptPhased(sim.Stdout)
				for i := range ups {
					ups[i].Phased = phased[ups[i].Name]
				}
			}
			return ups, true
		}
		if execx.Exists("dnf") || execx.Exists("yum") {
			tool := "dnf"
			if !execx.Exists("dnf") {
				tool = "yum"
			}
			res, err := execx.Run(5*time.Minute, nil, tool, "-q", "check-update")
			// check-update exits 100 when updates are available.
			if err != nil || (res.ExitCode != 0 && res.ExitCode != 100) {
				return nil, false
			}
			sec := ""
			if r2, err := execx.Run(5*time.Minute, nil, tool, "-q", "updateinfo", "list", "--security"); err == nil {
				sec = r2.Stdout
			}
			return ParseDnfCheckUpdate(res.Stdout, sec), true
		}
		if execx.Exists("checkupdates") {
			res, err := execx.Run(5*time.Minute, nil, "checkupdates")
			if err != nil {
				return nil, false
			}
			return ParseCheckupdates(res.Stdout), true
		}
	case "windows":
		out, okPS := ps(`$r = (New-Object -ComObject Microsoft.Update.Session).CreateUpdateSearcher().Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
ConvertTo-Json -Compress -InputObject @($r.Updates | ForEach-Object { [pscustomobject]@{ name = [string]$_.Title; security = [bool]($_.Categories | Where-Object { $_.Name -eq 'Security Updates' -or $_.Name -eq 'Critical Updates' }) } })`, nil, 15*time.Minute)
		if !okPS {
			return nil, false
		}
		var rows []struct {
			Name     string `json:"name"`
			Security bool   `json:"security"`
		}
		if strings.TrimSpace(out) != "" && json.Unmarshal([]byte(out), &rows) != nil {
			return nil, false
		}
		for _, r := range rows {
			ups = append(ups, Upgradable{Name: r.Name, Security: r.Security, Source: "windows-update"})
		}
		return ups, true
	case "darwin":
		res, err := execx.Run(10*time.Minute, nil, "softwareupdate", "-l")
		if err != nil {
			return nil, false
		}
		for _, l := range strings.Split(res.Stdout+res.Stderr, "\n") {
			if i := strings.Index(l, "* Label: "); i >= 0 {
				ups = append(ups, Upgradable{Name: strings.TrimSpace(l[i+len("* Label: "):]), Source: "softwareupdate"})
			}
		}
		return ups, true
	}
	return nil, false
}

// collectSoftware gathers installed packages (and the lock files the
// engine asked for) — see software.go.
func (s *SlowCollector) collectSoftware() {
	s.mu.Lock()
	lockfiles := append([]string(nil), s.lockfiles...)
	s.mu.Unlock()
	pkgs, errs := collectPackages(lockfiles)
	s.mu.Lock()
	s.packages, s.packageErrors, s.packagesAt = pkgs, errs, time.Now().Unix()
	s.mu.Unlock()
}

// Software returns the latest software report, or nil before the first
// collection finishes.
func (s *SlowCollector) Software() *Software {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.packagesAt == 0 && s.upgradableAt == 0 {
		return nil
	}
	return &Software{CollectedAt: s.packagesAt, OS: s.osRelease, Packages: s.packages, Upgradable: s.upgradable, UpgradableAt: s.upgradableAt, Errors: s.packageErrors}
}

// SetLockfiles sets the lock files to read (from the engine's config) and,
// when the list changed, collects software again straight away.
func (s *SlowCollector) SetLockfiles(paths []string) {
	sort.Strings(paths)
	s.mu.Lock()
	changed := strings.Join(paths, "\n") != strings.Join(s.lockfiles, "\n")
	s.lockfiles = paths
	s.mu.Unlock()
	if changed {
		go s.collectSoftware()
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
	switch {
	case android.IsAndroid():
		// Android: the OS by its Android version (the Linux distribution
		// name is blank there) and the device's maker and model.
		inv["os"] = android.OSName()
		if m := android.Model(); m != "" {
			inv["model"] = m
		}
	case runtime.GOOS == "linux":
		for key, file := range map[string]string{"vendor": "sys_vendor", "model": "product_name", "serial": "product_serial", "bios": "bios_version"} {
			if v := readTrim("/sys/class/dmi/id/" + file); v != "" {
				inv[key] = v
			}
		}
	case runtime.GOOS == "windows":
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
	case runtime.GOOS == "darwin":
		if res, err := execx.Run(30*time.Second, nil, "sysctl", "-n", "hw.model"); err == nil {
			inv["model"] = strings.TrimSpace(res.Stdout)
		}
	}
	s.mu.Lock()
	s.inventory = inv
	s.mu.Unlock()
}
