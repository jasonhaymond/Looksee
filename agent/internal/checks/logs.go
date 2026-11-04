// Log checks: new lines in a log file (follows rotation) and new systemd journal
// entries, counted when they match the check's pattern (Go's RE2 engine — no
// catastrophic backtracking). Lines containing an excluded text are dropped
// first. The Windows Event Log check is in eventlog.go and shares the matching
// helpers here.

package checks

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"time"

	"looksee-agent/internal/execx"
)

// Read at most this much new log data per cycle, so a log that suddenly
// grows by gigabytes can't stall the agent.
const maxLogReadBytes = 16 << 20

func compilePattern(c Cfg) (*regexp.Regexp, error) {
	p := c.Str("pattern", "")
	if p == "" {
		return nil, nil
	}
	if c.Bool("ignoreCase", true) {
		p = "(?i)" + p
	}
	return regexp.Compile(p)
}

// Newest file matching a glob, so "/var/log/app/*.log" follows rotation to
// date-stamped names.
func resolveLogPath(path string) (string, error) {
	if !strings.ContainsAny(path, "*?[") {
		return path, nil
	}
	matches, err := filepath.Glob(path)
	if err != nil {
		return "", err
	}
	if len(matches) == 0 {
		return "", fmt.Errorf("no file matches %s", path)
	}
	sort.Slice(matches, func(i, j int) bool {
		a, _ := os.Stat(matches[i])
		b, _ := os.Stat(matches[j])
		return a != nil && b != nil && a.ModTime().After(b.ModTime())
	})
	return matches[0], nil
}

// TailNew reads whatever was appended since the remembered offset. A file
// that shrank (rotated/truncated) or was replaced is read from the start.
// The first run only records the end of the file — existing history isn't
// reported as new matches.
func TailNew(path string, st map[string]any, fromStart bool) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := info.Size()
	offset, seen := st["offset"].(int64)
	prevPath, _ := st["path"].(string)
	prevMod, _ := st["mod"].(time.Time)
	if !seen && !fromStart {
		st["offset"], st["path"], st["mod"] = size, path, info.ModTime()
		return nil, nil
	}
	if prevPath != path || size < offset || (size == offset && info.ModTime().After(prevMod) && size == 0) {
		offset = 0
	}
	if size-offset > maxLogReadBytes {
		offset = size - maxLogReadBytes
	}
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return nil, err
	}
	var lines []string
	reader := bufio.NewReaderSize(f, 64*1024)
	read := offset
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			// A trailing partial line is left for the next cycle.
			break
		}
		read += int64(len(line))
		lines = append(lines, strings.TrimRight(line, "\r\n"))
	}
	st["offset"], st["path"], st["mod"] = read, path, info.ModTime()
	return lines, nil
}

func matchLines(lines []string, re *regexp.Regexp, invert bool) []string {
	var out []string
	for _, l := range lines {
		hit := re == nil || re.MatchString(l)
		if invert {
			hit = !hit
		}
		if hit {
			out = append(out, l)
		}
	}
	return out
}

func sample(lines []string) []string {
	out := []string{}
	for i, l := range lines {
		if i >= 10 {
			break
		}
		if len(l) > 300 {
			l = l[:300] + "…"
		}
		out = append(out, l)
	}
	return out
}

func matchResult(c Cfg, matches []string, where string) Result {
	details := map[string]any{"lines": sample(matches)}
	if len(matches) == 0 {
		return Result{Status: "up", Message: "No new matching lines in " + where, Value: val(0), Details: details}
	}
	msg := fmt.Sprintf("%d new matching line(s) in %s — latest: %s", len(matches), where, sample(matches[len(matches)-1:])[0])
	return countOrFail(c, len(matches), msg, details)
}

// D7.
func runLog(c Cfg, st map[string]any) Result {
	path, err := resolveLogPath(c.Str("path", ""))
	if err != nil {
		return down(err.Error())
	}
	if path == "" {
		return unknown("no log path configured")
	}
	re, err := compilePattern(c)
	if err != nil {
		return unknown("invalid pattern: " + err.Error())
	}
	lines, err := TailNew(path, st, c.Bool("fromStart", false))
	if err != nil {
		return down(permissionHint(err))
	}
	// Lines containing an excluded text are dropped before matching.
	return matchResult(c, matchLines(withoutExcluded(lines, c.Excludes(false)), re, c.Bool("invert", false)), filepath.Base(path))
}

// D9: journal entries since the previous cycle, optionally for one unit and
// at or above a priority.
func runJournal(c Cfg, st map[string]any) Result {
	if runtime.GOOS != "linux" {
		return unknown("journal checks need Linux/systemd")
	}
	re, err := compilePattern(c)
	if err != nil {
		return unknown("invalid pattern: " + err.Error())
	}
	since, ok := st["since"].(time.Time)
	now := time.Now()
	st["since"] = now
	if !ok {
		return up("Watching the journal — baseline recorded", val(0))
	}
	args := []string{"-q", "--no-pager", "-o", "cat", "--since", "@" + strconv.FormatInt(since.Unix(), 10), "--until", "@" + strconv.FormatInt(now.Unix(), 10)}
	if unit := c.Str("unit", ""); unit != "" {
		args = append(args, "-u", unit)
	}
	if p := c.Str("priority", ""); p != "" {
		args = append(args, "-p", p)
	}
	res, err := execx.Run(30*time.Second, nil, "journalctl", args...)
	if err != nil {
		return down(err.Error())
	}
	if res.ExitCode != 0 {
		msg := execx.FirstLine(res.Stderr)
		if strings.Contains(msg, "insufficient permissions") || strings.Contains(msg, "No journal files") {
			msg += " — add the agent's user to the systemd-journal group (agent README → Privileges)"
		}
		return down(msg)
	}
	var lines []string
	for _, l := range strings.Split(res.Stdout, "\n") {
		if strings.TrimSpace(l) != "" {
			lines = append(lines, l)
		}
	}
	return matchResult(c, matchLines(withoutExcluded(lines, c.Excludes(false)), re, false), "the journal")
}
