package metrics

import (
	"strings"

	"github.com/shirou/gopsutil/v3/process"
)

// IsProcessRunning matches by process name substring rather than requiring
// an exact/full-path match — the same service often shows up as "nginx" on
// Linux and "nginx.exe" on Windows, and asking the user to know the exact
// binary name per platform would undercut "simple to configure."
func IsProcessRunning(name string) (bool, error) {
	if name == "" {
		return false, nil
	}
	procs, err := process.Processes()
	if err != nil {
		return false, err
	}
	target := strings.ToLower(name)
	for _, p := range procs {
		procName, err := p.Name()
		if err != nil {
			continue
		}
		if strings.Contains(strings.ToLower(procName), target) {
			return true, nil
		}
	}
	return false, nil
}
