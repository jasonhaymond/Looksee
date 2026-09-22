// Package selfupdate implements the agent's push-to-update mechanism: the
// dashboard flags a host for an update, the agent notices on its next
// config poll (see main.go), downloads the matching binary the engine
// already serves at /install/agent/:platform, swaps it in for the running
// executable, and relaunches itself.
package selfupdate

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

// minBinarySize guards against swapping in a truncated/error-page download
// (a real looksee-agent binary is several MB) — anything smaller is treated
// as a failed download, not a valid update.
const minBinarySize = 1 << 20 // 1 MiB

// Platform matches exactly the PLATFORM_FILES keys in
// engine/src/routes/install.ts (linux-amd64, windows-amd64, darwin-arm64,
// ...) — Go's own GOOS/GOARCH values already line up with that naming, no
// translation table needed.
func Platform() string {
	return runtime.GOOS + "-" + runtime.GOARCH
}

// Apply downloads the current build for this platform and swaps it in for
// the running executable. On success, the caller should relaunch (Relaunch)
// and exit — this function does not restart the process itself, so a
// caller can log/report before doing so.
func Apply(engineURL string) error {
	exePath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locating running executable: %w", err)
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		return fmt.Errorf("resolving executable path: %w", err)
	}

	tmpPath := exePath + ".new"
	if err := download(engineURL+"/install/agent/"+Platform(), tmpPath); err != nil {
		return err
	}
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("setting executable bit: %w", err)
	}

	if err := swap(exePath, tmpPath); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

func download(url, dest string) error {
	client := &http.Client{Timeout: 60 * time.Second}
	res, err := client.Get(url)
	if err != nil {
		return fmt.Errorf("downloading update: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("downloading update: unexpected status %d", res.StatusCode)
	}

	out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return fmt.Errorf("creating temp file: %w", err)
	}
	defer out.Close()

	n, err := io.Copy(out, res.Body)
	if err != nil {
		return fmt.Errorf("writing update: %w", err)
	}
	if n < minBinarySize {
		return fmt.Errorf("downloaded update is only %d bytes — refusing to install a likely-truncated binary", n)
	}
	return nil
}

// swap puts the newly-downloaded binary in place of the running one.
//
// Unix: renaming directly over the running executable is safe and atomic —
// the OS keeps the old inode alive for the still-running process, and any
// new invocation of exePath gets the new file. This is the standard Unix
// self-update pattern, not something new here.
//
// Windows: renaming a file that's still mapped as a running process's own
// executable is possible (unlike overwriting it in place, which the OS
// blocks) — verified for real against a real running exe on a real Windows
// machine during development, not assumed. The old binary is kept as
// <exe>.old rather than deleted immediately, since the running process
// still holds it open; CleanupPrevious removes it on the next startup once
// nothing holds it anymore.
func swap(exePath, tmpPath string) error {
	if runtime.GOOS == "windows" {
		oldPath := exePath + ".old"
		_ = os.Remove(oldPath) // leftover from an earlier update that never got cleaned up
		if err := os.Rename(exePath, oldPath); err != nil {
			return fmt.Errorf("renaming running executable aside: %w", err)
		}
		if err := os.Rename(tmpPath, exePath); err != nil {
			_ = os.Rename(oldPath, exePath) // best-effort restore
			return fmt.Errorf("moving new binary into place: %w", err)
		}
		return nil
	}
	if err := os.Rename(tmpPath, exePath); err != nil {
		return fmt.Errorf("replacing running executable: %w", err)
	}
	return nil
}

// CleanupPrevious removes a leftover <exe>.old from a prior Windows update
// (see swap's windows case) — called once at startup, since the process
// that renamed it aside has already exited by the time a new one starts.
// A no-op if there's nothing to clean up.
func CleanupPrevious() {
	exePath, err := os.Executable()
	if err != nil {
		return
	}
	_ = os.Remove(exePath + ".old")
}

// Relaunch spawns a new, detached instance of the current executable with
// the same arguments. The caller is expected to exit right after — every
// platform's service manager (systemd/launchd/Scheduled Task) already has
// its own restart-on-exit semantics, but this way the agent restarts itself
// directly rather than depending on which specific semantics each one uses.
func Relaunch() error {
	exePath, err := os.Executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(exePath, os.Args[1:]...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Start()
}
