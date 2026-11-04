package metrics

import (
	"strings"
	"testing"
	"time"
)

func TestParseMdstat(t *testing.T) {
	text := `Personalities : [raid1]
md0 : active raid1 sdb1[1] sda1[0]
      976630464 blocks super 1.2 [2/2] [UU]

md1 : active raid1 sdd1[1](F) sdc1[0]
      976630464 blocks super 1.2 [2/1] [U_]
      [=>...................]  recovery =  5.0% (48831523/976630464) finish=80.1min

unused devices: <none>`
	arrays := ParseMdstat(text)
	if len(arrays) != 2 || !arrays[0].Healthy || arrays[1].Healthy {
		t.Fatalf("%+v", arrays)
	}
}

func TestParseZpool(t *testing.T) {
	a := ParseZpoolList("tank\tONLINE\nbackup\tDEGRADED\n")
	if len(a) != 2 || !a[0].Healthy || a[1].Healthy || a[1].State != "DEGRADED" {
		t.Fatalf("%+v", a)
	}
}

func TestParseSmartctl(t *testing.T) {
	ata := `{"model_name":"WDC WD40","smart_status":{"passed":true},"temperature":{"current":38},
	"ata_smart_attributes":{"table":[{"id":5,"value":100,"raw":{"value":8}},{"id":197,"value":100,"raw":{"value":2}},{"id":177,"value":93,"raw":{"value":120}}]}}`
	d, err := ParseSmartctl("/dev/sda", []byte(ata))
	if err != nil || !*d.Passed || *d.Reallocated != 8 || *d.Pending != 2 || *d.WearPercent != 7 || *d.TempC != 38 {
		t.Fatalf("%+v %v", d, err)
	}
	nvme := `{"model_name":"Samsung 980","smart_status":{"passed":false},"nvme_smart_health_information_log":{"percentage_used":12,"media_errors":0}}`
	d, _ = ParseSmartctl("/dev/nvme0", []byte(nvme))
	if *d.Passed || *d.WearPercent != 12 {
		t.Fatalf("%+v", d)
	}
}

func TestParseApt(t *testing.T) {
	out := "Inst libssl3 [3.0.2] (3.0.2-0ubuntu1.15 Ubuntu:22.04/jammy-security [amd64])\nInst vim [2:8.2] (2:8.2.3995 Ubuntu:22.04/jammy-updates [amd64])\nConf libssl3"
	total, sec := ParseAptSimulate(out)
	if total != 2 || sec != 1 {
		t.Fatal(total, sec)
	}
}

func TestCollectorRates(t *testing.T) {
	c := NewCollector("/", nil)
	first := c.Collect()
	if first.Extended == nil || first.Extended.Mem == nil || first.Extended.BootTime == 0 {
		t.Fatalf("first snapshot incomplete: %+v", first.Extended)
	}
	time.Sleep(1100 * time.Millisecond)
	second := c.Collect()
	if second.Extended.CPU == nil || len(second.Extended.CPU.PerCore) == 0 {
		t.Fatalf("per-core CPU should appear on the second collection: %+v", second.Extended.CPU)
	}
	if len(second.Extended.Disks) == 0 {
		t.Fatal("expected at least one disk")
	}
}

func TestRedactCommand(t *testing.T) {
	cases := map[string]string{
		`mysqld --user=mysql --password=hunter2 --port=3306`: `mysqld --user=mysql --password=*** --port=3306`,
		`app -token abc123 -v`:                               `app -token *** -v`,
		`node server.js --api-key "s3cret value" --x`:        `node server.js --api-key *** --x`,
		`curl https://bob:pa55@example.com/x`:                `curl https://bob:***@example.com/x`,
		`mysql -uroot -pSup3r`:                               `mysql -uroot -p***`,
		`ssh -p 22 host`:                                     `ssh -p 22 host`,
		`C:\Windows\system32\svchost.exe -k netsvcs -p`:      `C:\Windows\system32\svchost.exe -k netsvcs -p`,
		`backup --passphrase-file /etc/pass.txt`:             `backup --passphrase-file /etc/pass.txt`,
		`borg --passphrase hunter2 list`:                     `borg --passphrase *** list`,
		`/usr/sbin/sshd -D`:                                  `/usr/sbin/sshd -D`,
	}
	for in, want := range cases {
		if got := RedactCommand(in); got != want {
			t.Errorf("RedactCommand(%q) = %q, want %q", in, got, want)
		}
	}
}

// smartctl's reason for failing is read out of its JSON, so the dashboard can say
// "Permission denied" instead of only "isn't reported".
func TestSmartctlMessage(t *testing.T) {
	out := `{"smartctl":{"messages":[{"string":"note","severity":"information"},{"string":"Smartctl open device: /dev/sda failed: Permission denied","severity":"error"}]}}`
	if got := SmartctlMessage([]byte(out)); got != "Smartctl open device: /dev/sda failed: Permission denied" {
		t.Errorf("got %q", got)
	}
	if got := SmartctlMessage([]byte("not json")); got != "" {
		t.Errorf("got %q", got)
	}
}

// Attack: malware running as the Mac user who installed Homebrew plants a "smartctl" in
// a Homebrew folder and waits for the root agent to run it. The agent must never look
// in a folder that user can write to, on any non-Windows system.
func TestSmartctlSearchPathsAvoidUserWritableFolders(t *testing.T) {
	for _, goos := range []string{"darwin", "linux"} {
		for _, p := range smartctlSearchPaths(goos) {
			if strings.Contains(p, "homebrew") {
				t.Errorf("%s searches %s", goos, p)
			}
			// Termux's folder is only safe on Android, which this test machine isn't.
			if strings.Contains(p, "termux") {
				t.Errorf("%s searches %s outside Android", goos, p)
			}
		}
	}
	// On Intel Macs Homebrew owns /usr/local too.
	for _, p := range smartctlSearchPaths("darwin") {
		if strings.HasPrefix(p, "/usr/local") {
			t.Errorf("darwin searches %s", p)
		}
	}
}

// A drive the scan calls "scsi" is retried with smartctl's own detection and as
// SATA-behind-USB, which is what makes the plain command work by hand.
func TestSmartDeviceTypes(t *testing.T) {
	got := smartDeviceTypes("scsi")
	if len(got) != 3 || got[0] != "scsi" || got[1] != "" || got[2] != "sat" {
		t.Errorf("scsi: %q", got)
	}
	got = smartDeviceTypes("sat")
	if len(got) != 2 || got[0] != "sat" || got[1] != "" {
		t.Errorf("sat: %q", got)
	}
	got = smartDeviceTypes("")
	if len(got) != 2 || got[0] != "" || got[1] != "sat" {
		t.Errorf("no type: %q", got)
	}
}
