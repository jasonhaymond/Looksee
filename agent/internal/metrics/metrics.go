// Package metrics collects host-level resource usage. gopsutil handles the
// per-OS syscalls; the few things it doesn't cover (pending reboot,
// firewall, SMART, ...) are read from the OS's own tools in slow.go.
package metrics

import (
	"bufio"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/shirou/gopsutil/v3/cpu"
	"github.com/shirou/gopsutil/v3/disk"
	"github.com/shirou/gopsutil/v3/host"
	"github.com/shirou/gopsutil/v3/load"
	"github.com/shirou/gopsutil/v3/mem"
	gnet "github.com/shirou/gopsutil/v3/net"
	"github.com/shirou/gopsutil/v3/process"
)

// Snapshot is the pre-3.0 report shape (still sent, so engine widgets and
// host_cpu/memory/disk checks keep working) plus Extended for everything new.
type Snapshot struct {
	CPUPercent  float64   `json:"cpuPercent"`
	MemPercent  float64   `json:"memPercent"`
	DiskPercent float64   `json:"diskPercent"`
	NetRxBytes  uint64    `json:"netRxBytes"`
	NetTxBytes  uint64    `json:"netTxBytes"`
	Extended    *Extended `json:"extended,omitempty"`
}

type CPU struct {
	Percent float64   `json:"percent"`
	User    float64   `json:"user"`
	System  float64   `json:"system"`
	Iowait  *float64  `json:"iowait,omitempty"`
	Steal   *float64  `json:"steal,omitempty"`
	PerCore []float64 `json:"perCore,omitempty"`
}

type Load struct {
	L1    float64 `json:"l1"`
	L5    float64 `json:"l5"`
	L15   float64 `json:"l15"`
	Cores int     `json:"cores"`
}

type Mem struct {
	Total            uint64   `json:"total"`
	Available        uint64   `json:"available"`
	Percent          float64  `json:"percent"`
	SwapTotal        uint64   `json:"swapTotal"`
	SwapUsed         uint64   `json:"swapUsed"`
	SwapPercent      float64  `json:"swapPercent"`
	PageFaultsPerSec *float64 `json:"pageFaultsPerSec,omitempty"`
}

type Procs struct {
	Total   int  `json:"total"`
	Zombies *int `json:"zombies,omitempty"`
	Threads *int `json:"threads,omitempty"`
}

type FDs struct {
	Open    uint64  `json:"open"`
	Max     uint64  `json:"max"`
	Percent float64 `json:"percent"`
}

type Disk struct {
	Mount         string   `json:"mount"`
	Device        string   `json:"device,omitempty"`
	Fstype        string   `json:"fstype,omitempty"`
	Total         uint64   `json:"total"`
	Used          uint64   `json:"used"`
	Free          uint64   `json:"free"`
	Percent       float64  `json:"percent"`
	InodesPercent *float64 `json:"inodesPercent,omitempty"`
	ReadOnly      bool     `json:"readOnly"`
	Stale         bool     `json:"stale,omitempty"`
}

type DiskIO struct {
	Device           string   `json:"device"`
	ReadBytesPerSec  float64  `json:"readBytesPerSec"`
	WriteBytesPerSec float64  `json:"writeBytesPerSec"`
	ReadIops         float64  `json:"readIops"`
	WriteIops        float64  `json:"writeIops"`
	AwaitMs          *float64 `json:"awaitMs,omitempty"`
	BusyPercent      *float64 `json:"busyPercent,omitempty"`
}

type NetIf struct {
	Name           string   `json:"name"`
	RxBytesPerSec  float64  `json:"rxBytesPerSec"`
	TxBytesPerSec  float64  `json:"txBytesPerSec"`
	RxErrorsPerSec float64  `json:"rxErrorsPerSec"`
	TxErrorsPerSec float64  `json:"txErrorsPerSec"`
	RxDropsPerSec  float64  `json:"rxDropsPerSec"`
	TxDropsPerSec  float64  `json:"txDropsPerSec"`
	Up             bool     `json:"up"`
	SpeedMbps      *int     `json:"speedMbps,omitempty"`
	Mac            string   `json:"mac,omitempty"`
	Addrs          []string `json:"addrs,omitempty"`
}

type Listen struct {
	Port    uint32 `json:"port"`
	Proto   string `json:"proto"`
	Address string `json:"address,omitempty"`
	Process string `json:"process,omitempty"`
}

type Extended struct {
	CPU               *CPU           `json:"cpu,omitempty"`
	Load              *Load          `json:"load,omitempty"`
	Mem               *Mem           `json:"mem,omitempty"`
	UptimeSeconds     uint64         `json:"uptimeSeconds"`
	BootTime          uint64         `json:"bootTime"`
	Procs             *Procs         `json:"procs,omitempty"`
	FDs               *FDs           `json:"fds,omitempty"`
	CtxSwitchesPerSec *float64       `json:"ctxSwitchesPerSec,omitempty"`
	InterruptsPerSec  *float64       `json:"interruptsPerSec,omitempty"`
	Temps             []Temp         `json:"temps,omitempty"`
	Fans              []Fan          `json:"fans,omitempty"`
	Battery           *Battery       `json:"battery,omitempty"`
	Disks             []Disk         `json:"disks,omitempty"`
	DiskIO            []DiskIO       `json:"diskIO,omitempty"`
	Net               []NetIf        `json:"net,omitempty"`
	TCP               map[string]int `json:"tcp,omitempty"`
	Listening         []Listen       `json:"listening,omitempty"`
	Users             *Users         `json:"users,omitempty"`
	PendingReboot     *bool          `json:"pendingReboot,omitempty"`
	Time              *TimeSync      `json:"time,omitempty"`
	Updates           *Updates       `json:"updates,omitempty"`
	Defender          *Defender      `json:"defender,omitempty"`
	Firewall          *Toggle        `json:"firewall,omitempty"`
	Encryption        *Toggle        `json:"encryption,omitempty"`
	FailedLogins      *int           `json:"failedLogins,omitempty"`
	Smart             []SmartDisk    `json:"smart,omitempty"`
	Raid              []RaidArray    `json:"raid,omitempty"`
}

// Counters from the previous Collect, for turning cumulative counters into
// per-second rates over the report interval.
type prevState struct {
	at         time.Time
	cpuTotal   cpu.TimesStat
	cpuCores   []cpu.TimesStat
	diskIO     map[string]disk.IOCountersStat
	netIO      map[string]gnet.IOCountersStat
	ctxt       uint64
	intr       uint64
	pgmajfault uint64
}

type Collector struct {
	DiskPath string
	Slow     *SlowCollector
	prev     *prevState

	// Mounts whose statfs is still hanging from an earlier cycle (a dead
	// NFS server). They're reported stale and not re-queried, so one bad
	// mount can't pile up blocked goroutines.
	hungMu sync.Mutex
	hung   map[string]bool
}

func NewCollector(diskPath string, slow *SlowCollector) *Collector {
	return &Collector{DiskPath: diskPath, Slow: slow, hung: map[string]bool{}}
}

func pct(part, total float64) float64 {
	if total <= 0 {
		return 0
	}
	return part / total * 100
}

func busyPct(a, b cpu.TimesStat) (total, user, system, iowait, steal float64) {
	dt := b.Total() - a.Total()
	if dt <= 0 {
		return 0, 0, 0, 0, 0
	}
	idle := (b.Idle - a.Idle) + (b.Iowait - a.Iowait)
	return pct(dt-idle, dt), pct(b.User-a.User+b.Nice-a.Nice, dt), pct(b.System-a.System+b.Irq-a.Irq+b.Softirq-a.Softirq, dt), pct(b.Iowait-a.Iowait, dt), pct(b.Steal-a.Steal, dt)
}

func round2(f float64) float64 { return float64(int64(f*100+0.5)) / 100 }
func fp(f float64) *float64    { v := round2(f); return &v }

// Collect takes one snapshot. The first call has no previous counters, so
// rates (CPU breakdown, disk/net throughput) start on the second report.
func (c *Collector) Collect() Snapshot {
	now := time.Now()
	snap := Snapshot{}
	ext := &Extended{}
	prev := c.prev
	next := &prevState{at: now, diskIO: map[string]disk.IOCountersStat{}, netIO: map[string]gnet.IOCountersStat{}}
	elapsed := 0.0
	if prev != nil {
		elapsed = now.Sub(prev.at).Seconds()
	}

	// CPU
	if t, err := cpu.Times(false); err == nil && len(t) > 0 {
		next.cpuTotal = t[0]
		if prev != nil {
			total, user, system, iowait, steal := busyPct(prev.cpuTotal, t[0])
			ext.CPU = &CPU{Percent: round2(total), User: round2(user), System: round2(system)}
			if runtime.GOOS == "linux" {
				ext.CPU.Iowait = fp(iowait)
				ext.CPU.Steal = fp(steal)
			}
			snap.CPUPercent = round2(total)
		}
	}
	if cores, err := cpu.Times(true); err == nil {
		next.cpuCores = cores
		if prev != nil && ext.CPU != nil && len(prev.cpuCores) == len(cores) {
			for i := range cores {
				total, _, _, _, _ := busyPct(prev.cpuCores[i], cores[i])
				ext.CPU.PerCore = append(ext.CPU.PerCore, round2(total))
			}
		}
	}
	if prev == nil {
		// First report: no delta yet, so sample one second directly.
		if p, err := cpu.Percent(time.Second, false); err == nil && len(p) > 0 {
			snap.CPUPercent = round2(p[0])
			ext.CPU = &CPU{Percent: round2(p[0])}
		}
	}

	if l, err := load.Avg(); err == nil && runtime.GOOS != "windows" {
		ext.Load = &Load{L1: l.Load1, L5: l.Load5, L15: l.Load15, Cores: runtime.NumCPU()}
	}

	if vm, err := mem.VirtualMemory(); err == nil {
		snap.MemPercent = round2(vm.UsedPercent)
		ext.Mem = &Mem{Total: vm.Total, Available: vm.Available, Percent: round2(vm.UsedPercent)}
		if sw, err := mem.SwapMemory(); err == nil {
			ext.Mem.SwapTotal, ext.Mem.SwapUsed, ext.Mem.SwapPercent = sw.Total, sw.Used, round2(sw.UsedPercent)
		}
	}

	if info, err := host.Info(); err == nil {
		ext.UptimeSeconds = info.Uptime
		ext.BootTime = info.BootTime
	}

	// Linux kernel counters: context switches, interrupts, major faults,
	// open file handles, thread count.
	if runtime.GOOS == "linux" {
		ctxt, intr := readProcStat()
		pgmaj := readVmstat("pgmajfault")
		next.ctxt, next.intr, next.pgmajfault = ctxt, intr, pgmaj
		if prev != nil && elapsed > 0 {
			if ctxt >= prev.ctxt {
				ext.CtxSwitchesPerSec = fp(float64(ctxt-prev.ctxt) / elapsed)
			}
			if intr >= prev.intr {
				ext.InterruptsPerSec = fp(float64(intr-prev.intr) / elapsed)
			}
			if ext.Mem != nil && pgmaj >= prev.pgmajfault {
				ext.Mem.PageFaultsPerSec = fp(float64(pgmaj-prev.pgmajfault) / elapsed)
			}
		}
		ext.FDs = readFileNr()
	}

	ext.Procs = collectProcs()
	if c.Slow != nil {
		c.Slow.Apply(ext)
	}

	ext.Disks = c.collectDisks()
	for _, d := range ext.Disks {
		if d.Mount == c.DiskPath {
			snap.DiskPercent = d.Percent
		}
	}
	if snap.DiskPercent == 0 {
		if du, err := disk.Usage(c.DiskPath); err == nil {
			snap.DiskPercent = round2(du.UsedPercent)
		}
	}

	if io, err := disk.IOCounters(); err == nil {
		for name, cur := range io {
			if strings.HasPrefix(name, "loop") || strings.HasPrefix(name, "ram") {
				continue
			}
			next.diskIO[name] = cur
			var p disk.IOCountersStat
			ok := false
			if prev != nil {
				p, ok = prev.diskIO[name]
			}
			if !ok || elapsed <= 0 || cur.ReadBytes < p.ReadBytes || cur.WriteBytes < p.WriteBytes {
				continue
			}
			d := DiskIO{
				Device:           name,
				ReadBytesPerSec:  round2(float64(cur.ReadBytes-p.ReadBytes) / elapsed),
				WriteBytesPerSec: round2(float64(cur.WriteBytes-p.WriteBytes) / elapsed),
				ReadIops:         round2(float64(cur.ReadCount-p.ReadCount) / elapsed),
				WriteIops:        round2(float64(cur.WriteCount-p.WriteCount) / elapsed),
			}
			if runtime.GOOS == "linux" {
				ops := float64(cur.ReadCount - p.ReadCount + cur.WriteCount - p.WriteCount)
				if ops > 0 {
					d.AwaitMs = fp(float64(cur.ReadTime-p.ReadTime+cur.WriteTime-p.WriteTime) / ops)
				} else {
					d.AwaitMs = fp(0)
				}
				busy := float64(cur.IoTime-p.IoTime) / (elapsed * 1000) * 100
				if busy > 100 {
					busy = 100
				}
				d.BusyPercent = fp(busy)
			}
			ext.DiskIO = append(ext.DiskIO, d)
		}
	}

	if total, err := gnet.IOCounters(false); err == nil && len(total) > 0 {
		snap.NetRxBytes = total[0].BytesRecv
		snap.NetTxBytes = total[0].BytesSent
	}
	ext.Net = c.collectNet(prev, next, elapsed)
	ext.TCP, ext.Listening = collectConnections()

	c.prev = next
	snap.Extended = ext
	return snap
}

func (c *Collector) collectNet(prev, next *prevState, elapsed float64) []NetIf {
	ifaces, err := gnet.Interfaces()
	if err != nil {
		return nil
	}
	counters, _ := gnet.IOCounters(true)
	byName := map[string]gnet.IOCountersStat{}
	for _, ctr := range counters {
		byName[ctr.Name] = ctr
	}
	var speeds map[string]int
	if c.Slow != nil {
		speeds = c.Slow.LinkSpeeds()
	}
	out := []NetIf{}
	for _, ifc := range ifaces {
		up := false
		loopback := false
		for _, f := range ifc.Flags {
			if f == "up" {
				up = true
			}
			if f == "loopback" {
				loopback = true
			}
		}
		if loopback {
			continue
		}
		n := NetIf{Name: ifc.Name, Up: up, Mac: ifc.HardwareAddr}
		for _, a := range ifc.Addrs {
			n.Addrs = append(n.Addrs, a.Addr)
		}
		if s, ok := speeds[ifc.Name]; ok {
			sp := s
			n.SpeedMbps = &sp
		} else if s := linuxLinkSpeed(ifc.Name); s > 0 {
			n.SpeedMbps = &s
		}
		if cur, ok := byName[ifc.Name]; ok {
			next.netIO[ifc.Name] = cur
			if prev != nil && elapsed > 0 {
				if p, ok := prev.netIO[ifc.Name]; ok && cur.BytesRecv >= p.BytesRecv && cur.BytesSent >= p.BytesSent {
					n.RxBytesPerSec = round2(float64(cur.BytesRecv-p.BytesRecv) / elapsed)
					n.TxBytesPerSec = round2(float64(cur.BytesSent-p.BytesSent) / elapsed)
					n.RxErrorsPerSec = round2(float64(sub(cur.Errin, p.Errin)) / elapsed)
					n.TxErrorsPerSec = round2(float64(sub(cur.Errout, p.Errout)) / elapsed)
					n.RxDropsPerSec = round2(float64(sub(cur.Dropin, p.Dropin)) / elapsed)
					n.TxDropsPerSec = round2(float64(sub(cur.Dropout, p.Dropout)) / elapsed)
				}
			}
		}
		out = append(out, n)
	}
	return out
}

func sub(a, b uint64) uint64 {
	if a < b {
		return 0
	}
	return a - b
}

func linuxLinkSpeed(name string) int {
	if runtime.GOOS != "linux" {
		return 0
	}
	b, err := os.ReadFile("/sys/class/net/" + name + "/speed")
	if err != nil {
		return 0
	}
	n, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || n <= 0 {
		return 0
	}
	return n
}

var pseudoFS = map[string]bool{
	"tmpfs": true, "devtmpfs": true, "proc": true, "sysfs": true, "cgroup": true, "cgroup2": true, "overlay": true, "squashfs": true,
	"devpts": true, "mqueue": true, "debugfs": true, "tracefs": true, "securityfs": true, "pstore": true, "bpf": true, "autofs": true,
	"hugetlbfs": true, "configfs": true, "fusectl": true, "binfmt_misc": true, "nsfs": true, "efivarfs": true, "ramfs": true, "rpc_pipefs": true,
	"fuse.gvfsd-fuse": true, "fuse.portal": true, "fuse.snapfuse": true, "nfsd": true, "selinuxfs": true, "devfs": true, "fdescfs": true,
}

var networkFS = map[string]bool{"nfs": true, "nfs4": true, "cifs": true, "smb3": true, "smbfs": true, "fuse.sshfs": true, "9p": true}

// Every real filesystem, including network mounts (so a stale NFS share
// can be noticed). Usage is fetched with a timeout because statfs on a dead
// NFS server blocks indefinitely.
func (c *Collector) collectDisks() []Disk {
	parts, err := disk.Partitions(true)
	if err != nil {
		return nil
	}
	seen := map[string]bool{}
	out := []Disk{}
	for _, p := range parts {
		if pseudoFS[p.Fstype] || seen[p.Mountpoint] || strings.HasPrefix(p.Mountpoint, "/snap/") || strings.HasPrefix(p.Mountpoint, "/var/lib/docker/") || strings.HasPrefix(p.Mountpoint, "/run/") {
			continue
		}
		if runtime.GOOS != "windows" && !strings.HasPrefix(p.Device, "/") && !networkFS[p.Fstype] && p.Fstype != "zfs" && p.Fstype != "btrfs" {
			continue
		}
		seen[p.Mountpoint] = true
		d := Disk{Mount: p.Mountpoint, Device: p.Device, Fstype: p.Fstype}
		for _, o := range p.Opts {
			if o == "ro" {
				d.ReadOnly = true
			}
		}
		u, stale := c.usageWithTimeout(p.Mountpoint, 3*time.Second)
		if stale {
			d.Stale = true
		} else if u != nil {
			if u.Total == 0 {
				continue
			}
			d.Total, d.Used, d.Free, d.Percent = u.Total, u.Used, u.Free, round2(u.UsedPercent)
			if u.InodesTotal > 0 {
				d.InodesPercent = fp(u.InodesUsedPercent)
			}
		}
		out = append(out, d)
	}
	return out
}

func (c *Collector) usageWithTimeout(mount string, timeout time.Duration) (*disk.UsageStat, bool) {
	c.hungMu.Lock()
	if c.hung[mount] {
		c.hungMu.Unlock()
		return nil, true
	}
	c.hungMu.Unlock()
	ch := make(chan *disk.UsageStat, 1)
	go func() {
		u, err := disk.Usage(mount)
		c.hungMu.Lock()
		delete(c.hung, mount)
		c.hungMu.Unlock()
		if err != nil {
			ch <- nil
			return
		}
		ch <- u
	}()
	select {
	case u := <-ch:
		return u, false
	case <-time.After(timeout):
		c.hungMu.Lock()
		c.hung[mount] = true
		c.hungMu.Unlock()
		return nil, true
	}
}

func collectProcs() *Procs {
	pids, err := process.Pids()
	if err != nil {
		return nil
	}
	p := &Procs{Total: len(pids)}
	if runtime.GOOS == "linux" {
		zombies := 0
		for _, pid := range pids {
			b, err := os.ReadFile("/proc/" + strconv.Itoa(int(pid)) + "/stat")
			if err != nil {
				continue
			}
			// Field 3 (state) follows the parenthesised command name, which
			// may itself contain spaces or parentheses.
			s := string(b)
			if i := strings.LastIndex(s, ")"); i >= 0 && i+2 < len(s) && s[i+2] == 'Z' {
				zombies++
			}
		}
		p.Zombies = &zombies
		if b, err := os.ReadFile("/proc/loadavg"); err == nil {
			f := strings.Fields(string(b))
			if len(f) >= 4 {
				if parts := strings.Split(f[3], "/"); len(parts) == 2 {
					if n, err := strconv.Atoi(parts[1]); err == nil {
						p.Threads = &n
					}
				}
			}
		}
	}
	return p
}

func collectConnections() (map[string]int, []Listen) {
	conns, err := gnet.Connections("inet")
	if err != nil {
		return nil, nil
	}
	states := map[string]int{}
	seen := map[string]bool{}
	listening := []Listen{}
	names := map[int32]string{}
	for _, cn := range conns {
		proto := "tcp"
		if cn.Type == 2 { // SOCK_DGRAM
			proto = "udp"
		}
		if proto == "tcp" {
			states[cn.Status]++
		}
		isListen := (proto == "tcp" && cn.Status == "LISTEN") || (proto == "udp" && cn.Raddr.Port == 0)
		if !isListen {
			continue
		}
		key := proto + "/" + strconv.Itoa(int(cn.Laddr.Port))
		if seen[key] {
			continue
		}
		seen[key] = true
		l := Listen{Port: cn.Laddr.Port, Proto: proto, Address: cn.Laddr.IP}
		if cn.Pid > 0 {
			if n, ok := names[cn.Pid]; ok {
				l.Process = n
			} else if pr, err := process.NewProcess(cn.Pid); err == nil {
				if n, err := pr.Name(); err == nil {
					names[cn.Pid] = n
					l.Process = n
				}
			}
		}
		listening = append(listening, l)
	}
	return states, listening
}

func readProcStat() (ctxt, intr uint64) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return 0, 0
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1024*1024), 1024*1024)
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) < 2 {
			continue
		}
		switch fields[0] {
		case "ctxt":
			ctxt, _ = strconv.ParseUint(fields[1], 10, 64)
		case "intr":
			intr, _ = strconv.ParseUint(fields[1], 10, 64)
		}
	}
	return
}

func readVmstat(key string) uint64 {
	b, err := os.ReadFile("/proc/vmstat")
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && f[0] == key {
			n, _ := strconv.ParseUint(f[1], 10, 64)
			return n
		}
	}
	return 0
}

func readFileNr() *FDs {
	b, err := os.ReadFile("/proc/sys/fs/file-nr")
	if err != nil {
		return nil
	}
	f := strings.Fields(string(b))
	if len(f) < 3 {
		return nil
	}
	alloc, _ := strconv.ParseUint(f[0], 10, 64)
	free, _ := strconv.ParseUint(f[1], 10, 64)
	max, _ := strconv.ParseUint(f[2], 10, 64)
	open := alloc - free
	return &FDs{Open: open, Max: max, Percent: round2(pct(float64(open), float64(max)))}
}
