// Tests the agent's own warning about how it's running.

package metrics

import (
	"strings"
	"testing"
)

// Proves a properly installed agent stays quiet, including Linux's normal setup of
// a service with no root rights, which must not read as a problem.
func TestRunModeWarningQuietForServices(t *testing.T) {
	for _, r := range []RunMode{{Service: true, Elevated: true}, {Service: true, Elevated: false}} {
		for _, goos := range []string{"windows", "linux", "darwin"} {
			if w := r.Warning(goos); w != "" {
				t.Errorf("%s %+v warned: %s", goos, r, w)
			}
		}
	}
}

// Proves missing rights are only mentioned on Windows, where they lose readings.
func TestRunModeWarningByHand(t *testing.T) {
	if w := (RunMode{}).Warning("windows"); !strings.Contains(w, "administrator") {
		t.Errorf("windows without rights: %q", w)
	}
	if w := (RunMode{Elevated: true}).Warning("windows"); w == "" || strings.Contains(w, "administrator") {
		t.Errorf("windows elevated by hand: %q", w)
	}
	if w := (RunMode{}).Warning("linux"); w == "" || strings.Contains(w, "administrator") {
		t.Errorf("linux by hand: %q", w)
	}
}

// Proves this test program, started by hand, is correctly seen as not a service.
func TestCurrentRunModeByHand(t *testing.T) {
	if CurrentRunMode().Service {
		t.Skip("test process was started by the system (a CI container, say)")
	}
	if !strings.Contains(CurrentRunMode().Warning("linux"), "not running as a service") {
		t.Fatal("expected a warning")
	}
}
