package checks

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Watched folders are capped so a mistakenly huge path (/) can't make every
// cycle walk the whole filesystem.
const maxWalkFiles = 50000

type fileInfo struct {
	path    string
	size    int64
	modTime time.Time
}

func matchesPattern(name, pattern string) bool {
	if pattern == "" {
		return true
	}
	for _, p := range strings.Split(pattern, ",") {
		if ok, _ := filepath.Match(strings.TrimSpace(p), name); ok {
			return true
		}
	}
	return false
}

// listFiles returns regular files under dir (optionally recursive),
// filtered by a comma-separated glob list on the base name.
func listFiles(dir string, recursive bool, pattern string) ([]fileInfo, bool, error) {
	var out []fileInfo
	truncated := false
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			if path == dir {
				return err
			}
			return nil
		}
		if d.IsDir() {
			if path != dir && !recursive {
				return filepath.SkipDir
			}
			return nil
		}
		if !matchesPattern(d.Name(), pattern) {
			return nil
		}
		info, err := d.Info()
		if err != nil || !info.Mode().IsRegular() {
			return nil
		}
		out = append(out, fileInfo{path: path, size: info.Size(), modTime: info.ModTime()})
		if len(out) >= maxWalkFiles {
			truncated = true
			return errors.New("limit")
		}
		return nil
	})
	if err != nil && !truncated {
		return nil, false, err
	}
	return out, truncated, nil
}

func permissionHint(err error) string {
	if errors.Is(err, fs.ErrPermission) {
		return err.Error() + " — the agent's service account can't read this path (see agent README → Privileges)"
	}
	return err.Error()
}

// D1-D6 + folder watchdog. One check type, with the mode choosing what
// about the path is measured.
func runFile(c Cfg, st map[string]any) Result {
	path := c.Str("path", "")
	if path == "" {
		return unknown("no path configured")
	}
	mode := c.Str("mode", "exists")
	pattern := c.Str("pattern", "")
	recursive := c.Bool("recursive", false)
	info, statErr := os.Stat(path)

	switch mode {
	case "exists":
		if statErr != nil {
			if errors.Is(statErr, fs.ErrNotExist) {
				return down(path + " does not exist")
			}
			return down(permissionHint(statErr))
		}
		return up(path+" exists", nil)
	case "not_exists":
		if statErr == nil {
			return Result{Status: severity(c, "down"), Message: path + " exists but shouldn't"}
		}
		if errors.Is(statErr, fs.ErrNotExist) {
			return up(path+" is absent", nil)
		}
		return down(permissionHint(statErr))
	}

	if statErr != nil {
		return down(permissionHint(statErr))
	}

	switch mode {
	case "age":
		// For a folder: age of the newest matching file — the classic
		// "did last night's backup land" check.
		newest := info.ModTime()
		name := path
		if info.IsDir() {
			files, _, err := listFiles(path, recursive, pattern)
			if err != nil {
				return down(permissionHint(err))
			}
			if len(files) == 0 {
				return down("no matching files in " + path)
			}
			sort.Slice(files, func(i, j int) bool { return files[i].modTime.After(files[j].modTime) })
			newest, name = files[0].modTime, files[0].path
		}
		age := time.Since(newest)
		r := up(fmt.Sprintf("%s modified %s ago", filepath.Base(name), humanAge(age)), val(age.Minutes()))
		if max := c.Num("maxAgeMinutes", -1); max >= 0 && age.Minutes() > max {
			r.Status = "down"
		}
		return r
	case "size":
		size := info.Size()
		if info.IsDir() {
			return unknown("size mode needs a file; use folder_size for a folder")
		}
		return up(fmt.Sprintf("%s is %s", filepath.Base(path), humanBytes(size)), val(float64(size)/1048576))
	case "count", "folder_size":
		if !info.IsDir() {
			return unknown(mode + " needs a folder path")
		}
		files, truncated, err := listFiles(path, recursive, pattern)
		if err != nil {
			return down(permissionHint(err))
		}
		suffix := ""
		if truncated {
			suffix = fmt.Sprintf(" (stopped at %d files)", maxWalkFiles)
		}
		if mode == "count" {
			return up(fmt.Sprintf("%d matching file(s)%s", len(files), suffix), val(float64(len(files))))
		}
		var total int64
		for _, f := range files {
			total += f.size
		}
		return up(fmt.Sprintf("%s in %d file(s)%s", humanBytes(total), len(files), suffix), val(float64(total)/1048576))
	case "checksum":
		if info.IsDir() {
			return unknown("checksum mode needs a file")
		}
		f, err := os.Open(path)
		if err != nil {
			return down(permissionHint(err))
		}
		defer f.Close()
		h := sha256.New()
		if _, err := io.Copy(h, f); err != nil {
			return down(err.Error())
		}
		sum := hex.EncodeToString(h.Sum(nil))
		// The engine compares against the stored baseline / expected value.
		return Result{Status: "up", Message: "sha256 " + sum[:16] + "…", Details: map[string]any{"sha256": sum}}
	case "watchdog":
		return runWatchdog(c, st, path, info, pattern, recursive)
	default:
		return unknown("unknown file mode: " + mode)
	}
}

// Folder watchdog: reports files created, modified, or deleted since the
// previous cycle. The first cycle only records a baseline.
func runWatchdog(c Cfg, st map[string]any, path string, info fs.FileInfo, pattern string, recursive bool) Result {
	if !info.IsDir() {
		return unknown("watchdog needs a folder path")
	}
	files, truncated, err := listFiles(path, recursive, pattern)
	if err != nil {
		return down(permissionHint(err))
	}
	current := make(map[string]string, len(files))
	for _, f := range files {
		current[f.path] = fmt.Sprintf("%d|%d", f.size, f.modTime.UnixNano())
	}
	prev, hadPrev := st["snapshot"].(map[string]string)
	st["snapshot"] = current
	if !hadPrev {
		return up(fmt.Sprintf("Watching %d file(s) — baseline recorded", len(files)), val(0))
	}
	var created, modified, deleted []string
	for p, sig := range current {
		old, ok := prev[p]
		if !ok {
			created = append(created, p)
		} else if old != sig {
			modified = append(modified, p)
		}
	}
	for p := range prev {
		if _, ok := current[p]; !ok {
			deleted = append(deleted, p)
		}
	}
	sort.Strings(created)
	sort.Strings(modified)
	sort.Strings(deleted)
	watch := splitList(c.Str("events", "created,modified,deleted"))
	var parts []string
	relevant := 0
	add := func(kind string, items []string) {
		if len(items) == 0 || !watch[kind] {
			return
		}
		relevant += len(items)
		names := items
		if len(names) > 5 {
			names = names[:5]
		}
		rel := make([]string, len(names))
		for i, n := range names {
			if r, err := filepath.Rel(path, n); err == nil {
				rel[i] = r
			} else {
				rel[i] = n
			}
		}
		more := ""
		if len(items) > 5 {
			more = fmt.Sprintf(" +%d more", len(items)-5)
		}
		parts = append(parts, fmt.Sprintf("%d %s: %s%s", len(items), kind, strings.Join(rel, ", "), more))
	}
	add("created", created)
	add("modified", modified)
	add("deleted", deleted)
	details := map[string]any{"created": capList(created), "modified": capList(modified), "deleted": capList(deleted), "truncated": truncated}
	if relevant == 0 {
		return Result{Status: "up", Message: fmt.Sprintf("No changes in %d file(s)", len(files)), Value: val(0), Details: details}
	}
	details["event"] = true
	return Result{Status: severity(c, "warn"), Message: strings.Join(parts, "; "), Value: val(float64(relevant)), Details: details}
}

func capList(items []string) []string {
	if len(items) > 50 {
		return items[:50]
	}
	return items
}

func humanBytes(n int64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := int64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}
