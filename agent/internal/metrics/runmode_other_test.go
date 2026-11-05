//go:build !windows

// Tests how Linux and macOS agents decide whether the system started them.

package metrics

import "testing"

// Proves each way of being started by the system counts, and that being started
// from a terminal doesn't.
func TestStartedBySystem(t *testing.T) {
	cases := []struct {
		name         string
		invocationID string
		ppid, pid    int
		want         bool
	}{
		{"systemd service", "abc123", 900, 1000, true},
		{"launchd or another init", "", 1, 1000, true},
		{"container's main process", "", 0, 1, true},
		{"started from a terminal", "", 900, 1000, false},
	}
	for _, c := range cases {
		if got := startedBySystem(c.invocationID, c.ppid, c.pid); got != c.want {
			t.Errorf("%s: got %v", c.name, got)
		}
	}
}
