//go:build !windows

// The non-Windows half of session listing: collectSessions (slow.go) uses the
// operating system's list of signed-in users there, so this is never called.

package metrics

import "errors"

// windowsSessions exists so slow.go builds on every platform.
func windowsSessions() ([]Session, error) {
	return nil, errors.New("Windows only")
}
