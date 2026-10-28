//go:build windows

// Windows half of the folder-tree check (tree.go). Windows has no device
// numbers in a file's details; a scan stays on its drive anyway because
// junctions and mount points (the only way into another volume) are never
// followed — tree.go skips every reparse point.

package checks

import "io/fs"

// deviceOf reports that no device number is available on Windows.
func deviceOf(fs.FileInfo) (uint64, bool) { return 0, false }
