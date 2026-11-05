//go:build windows

// Works out how the agent is running on Windows. See runmode.go for why.
//
// Security: only reads the agent's own access token, and changes nothing.

package metrics

import (
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

// detectRunMode reads the agent's own access token, which records its account and
// rights. The installer uses a scheduled task running as SYSTEM rather than a
// Windows service, so running as SYSTEM counts as a service as well as really being
// one (a manual setup with NSSM, say). Asking only "is this a Windows service?"
// would wrongly warn on every normal install.
func detectRunMode() RunMode {
	token := windows.GetCurrentProcessToken()
	system := false
	if user, err := token.GetTokenUser(); err == nil {
		system = user.User.Sid.IsWellKnown(windows.WinLocalSystemSid)
	}
	// If Windows can't answer, this counts as not a service: the warning is advice,
	// so a rare false one costs less than hiding a real problem.
	realService, _ := svc.IsWindowsService()
	return RunMode{Service: system || realService, Elevated: system || token.IsElevated()}
}
