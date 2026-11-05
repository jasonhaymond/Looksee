//go:build !windows

// Works out how the agent is running on Linux and macOS. See runmode.go for why.

package metrics

import (
	"os"

	"looksee-agent/internal/android"
)

// startedBySystem decides whether a process was started by the service manager.
//
//	invocationID: the INVOCATION_ID environment variable, which systemd sets for
//	              everything it starts
//	ppid, pid:    the parent's and this process's IDs. A parent of 1 means started by
//	              the init system (launchd on macOS, or another init on Linux), and
//	              being 1 means this is a container's main process.
//
// A program left running with nohup also ends up with parent 1 and so counts as a
// service. That's a missed warning rather than a false one, which is the better error.
func startedBySystem(invocationID string, ppid, pid int) bool {
	return invocationID != "" || ppid == 1 || pid == 1
}

// detectRunMode reports how the agent is running. Android has no service manager
// for an app to use, so there's nothing better to tell its owner to do, and it
// doesn't warn.
func detectRunMode() RunMode {
	return RunMode{
		Service:  android.IsAndroid() || startedBySystem(os.Getenv("INVOCATION_ID"), os.Getppid(), os.Getpid()),
		Elevated: os.Geteuid() == 0,
	}
}
