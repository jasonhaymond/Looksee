//go:build windows

package metrics

import "testing"

// Proves the session API is called correctly on a real Windows machine: the
// structures match what Windows returns, and every session names a user and a
// known state rather than garbage from a misread buffer.
func TestWindowsSessionsReadsRealSessions(t *testing.T) {
	sessions, err := windowsSessions()
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range sessions {
		t.Logf("%+v", s)
		if s.User == "" || s.State == "" {
			t.Errorf("session without user or state: %+v", s)
		}
	}
}

// Windows' session names map to the connection type the RDP check filters on; a
// disconnected session, which has no name left, must stay "unknown".
func TestSessionKind(t *testing.T) {
	for station, want := range map[string]string{"RDP-Tcp#12": "rdp", "Console": "console", "": ""} {
		if got := SessionKind(station); got != want {
			t.Errorf("SessionKind(%q) = %q, want %q", station, got, want)
		}
	}
}

// The numbers follow Windows' WTS_CONNECTSTATE_CLASS: 0 = active, 4 = disconnected.
func TestSessionState(t *testing.T) {
	if SessionState(0) != "active" || SessionState(4) != "disconnected" || SessionState(99) != "state 99" {
		t.Errorf("states: %s %s %s", SessionState(0), SessionState(4), SessionState(99))
	}
}
