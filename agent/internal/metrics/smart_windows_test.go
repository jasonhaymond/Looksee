//go:build windows

package metrics

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeFakeSmartctl puts a stand-in smartctl in a temp folder. It answers the scan
// with one drive of type "scsi", then gives health data only when run without -d,
// which is how a USB-attached drive behaves: the plain command typed by hand works,
// but the type the scan names doesn't. Written as a batch file so these tests run on
// any Windows machine; JSON comes from files beside it because batch quoting can't
// be relied on for it.
func writeFakeSmartctl(t *testing.T, deviceReply string) string {
	t.Helper()
	dir := t.TempDir()
	write := func(name, content string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("scan.json", `{"devices":[{"name":"/dev/sda","type":"scsi"}]}`)
	write("device.json", deviceReply)
	write("empty.json", `{"smartctl":{"messages":[{"string":"Device open failed","severity":"error"}]}}`)
	write("smartctl.bat", "@echo off\r\nif \"%1\"==\"--scan\" (type \""+dir+"\\scan.json\" & exit /b 0)\r\nif \"%3\"==\"-d\" (type \""+dir+"\\empty.json\" & exit /b 2)\r\ntype \""+dir+"\\device.json\"\r\nexit /b 0\r\n")
	return filepath.Join(dir, "smartctl.bat")
}

// The reported bug's shape: the scan's device type gives no health data, while
// smartctl's own detection does. The drive must still be read.
func TestSmartctlRetriesWithItsOwnDetection(t *testing.T) {
	fake := writeFakeSmartctl(t, `{"model_name":"Test Drive","smart_status":{"passed":true},"temperature":{"current":31}}`)
	disks, problem := smartctlDisks(fake)
	if problem != "" || len(disks) != 1 {
		t.Fatalf("disks %+v, problem %q", disks, problem)
	}
	if d := disks[0]; d.Device != "/dev/sda" || d.Model != "Test Drive" || d.Passed == nil || !*d.Passed {
		t.Errorf("%+v", d)
	}
}

// When no attempt works, the reason comes back in smartctl's own words instead of
// the drive silently disappearing.
func TestSmartctlReportsWhyItCouldntRead(t *testing.T) {
	fake := writeFakeSmartctl(t, `{"smartctl":{"messages":[{"string":"Permission denied","severity":"error"}]}}`)
	disks, problem := smartctlDisks(fake)
	if len(disks) != 0 || !strings.Contains(problem, "/dev/sda") {
		t.Fatalf("disks %+v, problem %q", disks, problem)
	}
}

// A smartctl outside the agent's PATH is still found in its usual install folder:
// a service's PATH is fixed when it starts, so one installed later would otherwise
// look missing, though it works when typed in a new terminal.
func TestFindSmartctlLooksInInstallFolders(t *testing.T) {
	dir := t.TempDir()
	bin := filepath.Join(dir, "smartmontools", "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "smartctl.exe"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", "")
	t.Setenv("ProgramFiles", dir)
	if got := findSmartctl(); got != filepath.Join(bin, "smartctl.exe") {
		t.Errorf("got %q", got)
	}
}

// Windows' own counters, the fallback, read this real machine's drives.
func TestWindowsStorageReliabilityOnThisMachine(t *testing.T) {
	disks, why := windowsStorageReliability()
	t.Logf("disks %+v, why %q", disks, why)
}
