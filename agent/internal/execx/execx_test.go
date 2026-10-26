// Tests for running commands (execx.go). Each test says what it proves.
package execx

import (
	"runtime"
	"strings"
	"testing"
	"time"
)

// Proves NUL characters a command prints never reach the rest of the agent
// (they used to travel all the way to the engine's database and make the
// whole report fail).
func TestRunStripsNulFromOutput(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sh's printf")
	}
	res, err := Run(5*time.Second, nil, "sh", "-c", `printf 'SHARP Tool\000\000\000'; printf 'err\000' >&2`)
	if err != nil {
		t.Fatal(err)
	}
	if res.Stdout != "SHARP Tool" || res.Stderr != "err" {
		t.Fatalf("got stdout %q stderr %q", res.Stdout, res.Stderr)
	}
}

// Proves a command that hangs is killed at its timeout and reported as
// such, instead of stalling the agent.
func TestRunTimesOut(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sleep")
	}
	start := time.Now()
	_, err := Run(300*time.Millisecond, nil, "sleep", "10")
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected a timeout, got %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("the timeout didn't stop the command")
	}
}

// Proves StripNul removes every NUL and nothing else.
func TestStripNul(t *testing.T) {
	if got := StripNul("a\x00b\x00\x00c é"); got != "abc é" {
		t.Fatalf("got %q", got)
	}
}
