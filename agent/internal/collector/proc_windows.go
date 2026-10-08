package collector

import (
	"os/exec"
	"syscall"
)

// No console window flashing up when the agent runs interactively.
func hideWindow(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000} // CREATE_NO_WINDOW
}
