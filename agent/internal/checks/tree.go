// Largest folders and files (check type agent_disk_tree): walks each local
// disk — or one chosen folder — and reports the largest folders and the
// largest files, so "what's filling this disk?" is answered from the
// dashboard instead of by logging in and running du / WizTree.
//
// How it works: every file's size is added to each of its parent folders up
// to `depth` levels below the starting point, so a folder's size includes
// everything under it; the `top` largest folders (at any of those levels) and
// the `top` largest files are kept. The walk stays on the starting
// filesystem (it doesn't wander into other mounts, network shares, /proc),
// never follows symbolic links or Windows junctions, skips folders it may not
// read, and stops after `maxSeconds`, reporting what it saw so far as
// partial. The engine adds how much each entry grew since the previous scan
// (routes/agent.ts).
//
// Cost: a full scan reads every folder entry on the disk, which takes
// seconds to minutes and some disk I/O — the dashboard defaults this check to
// every 6 hours, and agent checks run in the background, so a long scan never
// delays the agent's regular reports.

package checks

import (
	"container/heap"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/disk"
)

// TreeRow is one line of the result table: a folder or file on one disk.
type TreeRow struct {
	Disk   string  `json:"disk"`
	Kind   string  `json:"kind"` // "folder" or "file"
	Path   string  `json:"path"`
	SizeGB float64 `json:"sizeGb"`
}

// TreeDisk summarises the scan of one disk (or folder).
type TreeDisk struct {
	Root      string  `json:"root"`
	ScannedGB float64 `json:"scannedGb"`
	Files     int64   `json:"files"`
	Seconds   float64 `json:"seconds"`
	Partial   bool    `json:"partial,omitempty"`
	Skipped   int     `json:"unreadable,omitempty"`
}

// fileHeap keeps the N largest files seen so far: a min-heap, so the
// smallest of the kept files is on top and is what a bigger file replaces.
type fileHeap []TreeRow

func (h fileHeap) Len() int           { return len(h) }
func (h fileHeap) Less(i, j int) bool { return h[i].SizeGB < h[j].SizeGB }
func (h fileHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *fileHeap) Push(x any)        { *h = append(*h, x.(TreeRow)) }
func (h *fileHeap) Pop() any {
	old := *h
	x := old[len(old)-1]
	*h = old[:len(old)-1]
	return x
}

const bytesPerGB = 1 << 30

// gb converts bytes to GB rounded to 2 decimals.
func gb(b int64) float64 { return float64(int64(float64(b)/bytesPerGB*100+0.5)) / 100 }

// ScanTree walks one tree and returns its largest folders and files.
//
// root: where to start. depth: how many folder levels below root are ranked.
// top: how many folders and files to keep. deadline: stop walking at this
// time (the result is marked partial). skip: folders not to enter (exact
// paths, case-insensitive on Windows).
func ScanTree(root string, depth, top int, deadline time.Time, skip []string) (folders []TreeRow, files []TreeRow, summary TreeDisk) {
	start := time.Now()
	summary.Root = root
	rootInfo, err := os.Lstat(root)
	if err != nil {
		summary.Skipped = 1
		return nil, nil, summary
	}
	rootDev, hasDev := deviceOf(rootInfo)
	folderSize := map[string]int64{}
	largest := &fileHeap{}
	var total int64
	skipSet := map[string]bool{}
	for _, s := range skip {
		skipSet[normPath(filepath.Clean(s))] = true
	}
	cleanRoot := filepath.Clean(root)

	// filepath.WalkDir visits every entry under root; returning
	// filepath.SkipDir from the callback skips a folder's contents, and
	// filepath.SkipAll stops the walk.
	_ = filepath.WalkDir(cleanRoot, func(path string, d fs.DirEntry, err error) error {
		if time.Now().After(deadline) {
			summary.Partial = true
			return filepath.SkipAll
		}
		if err != nil {
			// A folder we may not read (permissions, vanished mid-scan):
			// count it and carry on rather than failing the whole scan.
			summary.Skipped++
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		// Never follow links: symlinks and (on Windows) junctions show up as
		// non-regular entries; following them could count a tree twice or
		// leave the disk.
		if d.Type()&fs.ModeSymlink != 0 || d.Type()&fs.ModeIrregular != 0 {
			return nil
		}
		if d.IsDir() {
			if path != cleanRoot && skipSet[normPath(path)] {
				return filepath.SkipDir
			}
			// Stay on the starting filesystem (Unix: same device number).
			if path != cleanRoot && hasDev {
				if info, err := d.Info(); err == nil {
					if dev, ok := deviceOf(info); ok && dev != rootDev {
						return filepath.SkipDir
					}
				}
			}
			return nil
		}
		info, err := d.Info()
		if err != nil || !info.Mode().IsRegular() {
			return nil
		}
		size := info.Size()
		total += size
		summary.Files++
		// Add the file's size to each parent folder down to `depth` levels
		// below root (root itself is the disk's total, not ranked).
		rel, err := filepath.Rel(cleanRoot, filepath.Dir(path))
		if err == nil && rel != "." {
			parts := strings.Split(rel, string(filepath.Separator))
			for i := 1; i <= len(parts) && i <= depth; i++ {
				folderSize[filepath.Join(append([]string{cleanRoot}, parts[:i]...)...)] += size
			}
		}
		// Keep the file if it's among the largest so far.
		row := TreeRow{Disk: root, Kind: "file", Path: path, SizeGB: float64(size) / bytesPerGB}
		if largest.Len() < top {
			heap.Push(largest, row)
		} else if (*largest)[0].SizeGB < row.SizeGB {
			(*largest)[0] = row
			heap.Fix(largest, 0)
		}
		return nil
	})

	// The `top` largest folders.
	for p, s := range folderSize {
		folders = append(folders, TreeRow{Disk: root, Kind: "folder", Path: p, SizeGB: float64(s) / bytesPerGB})
	}
	sort.Slice(folders, func(i, j int) bool { return folders[i].SizeGB > folders[j].SizeGB })
	if len(folders) > top {
		folders = folders[:top]
	}
	files = append(files, (*largest)...)
	sort.Slice(files, func(i, j int) bool { return files[i].SizeGB > files[j].SizeGB })
	for i := range folders {
		folders[i].SizeGB = round2(folders[i].SizeGB)
	}
	for i := range files {
		files[i].SizeGB = round2(files[i].SizeGB)
	}
	summary.ScannedGB = gb(total)
	summary.Seconds = round2(time.Since(start).Seconds())
	return folders, files, summary
}

func round2(f float64) float64 { return float64(int64(f*100+0.5)) / 100 }

// normPath makes paths comparable: Windows paths ignore case.
func normPath(p string) string {
	if runtime.GOOS == "windows" {
		return strings.ToLower(p)
	}
	return p
}

// pseudoFS are filesystem types that aren't real disks (kernel views,
// in-memory, container layers) — never scanned as "every local disk".
var pseudoFS = map[string]bool{"proc": true, "sysfs": true, "devtmpfs": true, "devpts": true, "tmpfs": true, "cgroup": true, "cgroup2": true, "overlay": true, "squashfs": true, "autofs": true, "mqueue": true, "debugfs": true, "tracefs": true, "securityfs": true, "pstore": true, "bpf": true, "configfs": true, "fusectl": true, "hugetlbfs": true, "nsfs": true, "ramfs": true, "binfmt_misc": true, "efivarfs": true, "devfs": true, "nullfs": true}

// localDisks lists the mount points (or drive letters) of real local disks:
// network filesystems, optical drives and pseudo filesystems are left out.
func localDisks() []string {
	parts, err := disk.Partitions(false)
	if err != nil {
		return nil
	}
	var out []string
	seen := map[string]bool{}
	for _, p := range parts {
		fsType := strings.ToLower(p.Fstype)
		if pseudoFS[fsType] || strings.HasPrefix(fsType, "fuse") || strings.Contains(fsType, "nfs") || strings.Contains(fsType, "cifs") || strings.Contains(fsType, "smb") || fsType == "cdfs" || fsType == "udf" || fsType == "iso9660" {
			continue
		}
		if strings.HasPrefix(p.Mountpoint, "/snap/") || strings.HasPrefix(p.Mountpoint, "/boot/efi") || seen[p.Mountpoint] {
			continue
		}
		seen[p.Mountpoint] = true
		out = append(out, p.Mountpoint)
	}
	sort.Strings(out)
	return out
}

// runDiskTree is the agent_disk_tree check. Settings: path (blank = every
// local disk), top (25), depth (4), maxSeconds (300, shared by all disks),
// skip (folders not to enter, one per line). Value: total GB scanned.
func runDiskTree(c Cfg) Result {
	top := int(c.Num("top", 25))
	if top < 1 || top > 200 {
		top = 25
	}
	depth := int(c.Num("depth", 4))
	if depth < 1 || depth > 20 {
		depth = 4
	}
	maxSeconds := c.Num("maxSeconds", 300)
	if maxSeconds < 5 || maxSeconds > 3600 {
		maxSeconds = 300
	}
	var skip []string
	for _, s := range strings.Split(c.Str("skip", ""), "\n") {
		if s = strings.TrimSpace(s); s != "" {
			skip = append(skip, s)
		}
	}
	roots := localDisks()
	if p := c.Str("path", ""); p != "" {
		roots = []string{p}
	}
	// No real disk listed (e.g. the agent runs in a container whose root is
	// an overlay filesystem): scan the root folder instead.
	if len(roots) == 0 {
		if runtime.GOOS == "windows" {
			roots = []string{os.Getenv("SystemDrive") + `\`}
		} else {
			roots = []string{"/"}
		}
	}
	deadline := time.Now().Add(time.Duration(maxSeconds) * time.Second)
	var rows []TreeRow
	var disks []TreeDisk
	var total float64
	partial := false
	for _, root := range roots {
		if _, err := os.Stat(root); err != nil {
			if len(roots) == 1 {
				return down(fmt.Sprintf("can't read %s: %v", root, err))
			}
			continue
		}
		folders, files, sum := ScanTree(root, depth, top, deadline, skip)
		rows = append(rows, folders...)
		rows = append(rows, files...)
		disks = append(disks, sum)
		total += sum.ScannedGB
		partial = partial || sum.Partial
	}
	msg := fmt.Sprintf("%.1f GB scanned on %d disk(s)", total, len(disks))
	if biggest := largestFolder(rows); biggest != nil {
		msg += fmt.Sprintf("; largest folder %s (%.1f GB)", biggest.Path, biggest.SizeGB)
	}
	if partial {
		msg += fmt.Sprintf(" — partial: stopped after %.0fs", maxSeconds)
	}
	return Result{Status: "up", Message: msg, Value: val(total), Details: treeDetails{Rows: rows, Disks: disks}}
}

// treeDetails is the check's details. A struct rather than a map so "rows"
// is sent first: the dashboard shows the first list in a result's details
// (Go writes a map's keys in alphabetical order, which would put "disks"
// first).
type treeDetails struct {
	Rows  []TreeRow  `json:"rows"`
	Disks []TreeDisk `json:"disks"`
}

func largestFolder(rows []TreeRow) *TreeRow {
	var best *TreeRow
	for i := range rows {
		if rows[i].Kind == "folder" && (best == nil || rows[i].SizeGB > best.SizeGB) {
			best = &rows[i]
		}
	}
	return best
}
