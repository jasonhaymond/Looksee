//go:build !windows

// Unix half of the folder-tree check (tree.go): the device number of a file,
// which tells whether a folder is on the same filesystem as where the scan
// started — so a scan of / doesn't wander into /proc, other disks or
// network mounts.

package checks

import (
	"io/fs"
	"syscall"
)

// deviceOf returns the filesystem device number of a file, and whether it
// could be read (the stat details are a syscall.Stat_t on Unix systems).
func deviceOf(info fs.FileInfo) (uint64, bool) {
	st, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	// Dev is a different integer type on Linux and macOS; uint64 holds both.
	return uint64(st.Dev), true
}
