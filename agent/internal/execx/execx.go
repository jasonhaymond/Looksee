// Package execx runs external commands with a timeout and an optional set
// of extra environment variables. User-supplied values (service names,
// counter paths, passphrases) are always passed as separate argv elements
// or environment variables — never spliced into a shell string.
package execx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

type Result struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

// ErrNotFound is returned when the command itself isn't installed, so
// callers can report "install X" instead of a generic failure.
var ErrNotFound = errors.New("command not found")

func Run(timeout time.Duration, env map[string]string, name string, args ...string) (Result, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	if len(env) > 0 {
		cmd.Env = os.Environ()
		for k, v := range env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	res := Result{Stdout: stdout.String(), Stderr: stderr.String()}
	if cmd.ProcessState != nil {
		res.ExitCode = cmd.ProcessState.ExitCode()
	}
	if err != nil {
		var execErr *exec.Error
		if errors.As(err, &execErr) {
			return res, fmt.Errorf("%w: %s", ErrNotFound, name)
		}
		if ctx.Err() == context.DeadlineExceeded {
			return res, fmt.Errorf("%s timed out after %s", name, timeout)
		}
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			// A non-zero exit is often a real answer (systemctl is-active,
			// grep-style tools), so it's returned as data, not an error.
			return res, nil
		}
		return res, err
	}
	return res, nil
}

// PowerShell runs a script with values passed through LOOKSEE_* environment
// variables. -Command treats trailing argv as more script text rather than
// binding it to $args, so environment variables are the injection-safe way
// to hand it user input.
func PowerShell(timeout time.Duration, env map[string]string, script string) (Result, error) {
	return Run(timeout, env, "powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
		"$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; "+script)
}

func Exists(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// FirstLine is the first non-empty line, trimmed.
func FirstLine(s string) string {
	for _, l := range strings.Split(s, "\n") {
		if t := strings.TrimSpace(l); t != "" {
			return t
		}
	}
	return ""
}
