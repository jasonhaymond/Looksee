// How the agent itself is running: as a proper background service or started by
// hand, and with or without administrator rights. An agent started by hand stops
// when its window or session closes, and one without rights silently misses some
// readings, so the agent reports this and the endpoint page warns about it
// (dashboard/app/lib/agentRun.ts).
//
// Where this sits: Collect (metrics.go) adds it to every report and main.go logs it
// at startup. The OS-specific detection is in runmode_windows.go and runmode_other.go.
//
// Security: read-only, and only reports two yes/no answers.

package metrics

import "sync"

// RunMode is how this agent was started. Neither answer changes while it runs.
type RunMode struct {
	// Service: started by the system (Windows task or service running as SYSTEM,
	// systemd, launchd), so it survives sign-outs and starts at boot.
	Service bool `json:"service"`
	// Elevated: has administrator or root rights. Only Windows warns about this:
	// on Linux the installer runs the agent unprivileged on purpose.
	Elevated bool `json:"elevated"`
}

// CurrentRunMode returns how this agent is running, working it out only once.
var CurrentRunMode = sync.OnceValue(detectRunMode)

// Warning says what's wrong with how the agent is running, for the agent's log, or
// returns "" when it's running properly. The dashboard words its own version.
func (r RunMode) Warning(goos string) string {
	if r.Service {
		return ""
	}
	if goos == "windows" && !r.Elevated {
		return "not running as a service and no administrator rights: this agent stops when this session closes, and some readings will be missing"
	}
	return "not running as a service: this agent stops when this window or session closes"
}
