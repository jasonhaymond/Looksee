//go:build !windows

package metrics

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// writeFakeSmartctl puts a stand-in smartctl script in a temp folder. Its scan lists
// one drive, and reading that drive gives the reply passed in, in the JSON shape real
// smartctl 7.4 prints when an unprivileged user can't open a device.
func writeFakeSmartctl(t *testing.T, deviceReply string, exit string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "device.json"), []byte(deviceReply), 0o644); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nif [ \"$1\" = \"--scan\" ]; then echo '{\"devices\":[{\"name\":\"/dev/sda\",\"type\":\"scsi\"}]}'; exit 0; fi\ncat '" + dir + "/device.json'\nexit " + exit + "\n"
	path := filepath.Join(dir, "smartctl")
	if err := os.WriteFile(path, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// The reported Linux bug: smartctl works under sudo, but the agent is an unprivileged
// user and can't open the drive. The reason must come back, with what to do on Linux,
// instead of the drive silently disappearing from the report.
func TestSmartctlPermissionDeniedSaysWhatToDo(t *testing.T) {
	fake := writeFakeSmartctl(t, `{"smartctl":{"messages":[{"string":"Smartctl open device: /dev/sda failed: Permission denied","severity":"error"}],"exit_status":2}}`, "2")
	disks, problem := smartctlDisks(fake)
	if len(disks) != 0 || !strings.Contains(problem, "Permission denied") {
		t.Fatalf("disks %+v, problem %q", disks, problem)
	}
	if runtime.GOOS == "linux" && !strings.Contains(problem, "drop-in") {
		t.Errorf("no advice in %q", problem)
	}
}

// With access, the same path reads the drive.
func TestSmartctlReadsADrive(t *testing.T) {
	fake := writeFakeSmartctl(t, `{"model_name":"Test Drive","smart_status":{"passed":true}}`, "0")
	disks, problem := smartctlDisks(fake)
	if problem != "" || len(disks) != 1 || disks[0].Passed == nil || !*disks[0].Passed {
		t.Fatalf("disks %+v, problem %q", disks, problem)
	}
}

// Against real smartctl where it's installed, this logs what the agent sees as the
// user running the test. It's for checking by hand on a real machine, since whether a
// drive can be read depends on that machine, so only a crash can fail it.
func TestSmartctlOnThisMachine(t *testing.T) {
	path := findSmartctl()
	if path == "" {
		t.Skip("smartctl isn't installed")
	}
	disks, problem := smartctlDisks(path)
	t.Logf("found %s; disks %+v; problem %q", path, disks, problem)
}
