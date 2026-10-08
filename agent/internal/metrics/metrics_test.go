package metrics

import (
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
