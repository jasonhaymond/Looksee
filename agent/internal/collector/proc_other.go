//go:build !windows

package collector

import "os/exec"

func hideWindow(*exec.Cmd) {}
