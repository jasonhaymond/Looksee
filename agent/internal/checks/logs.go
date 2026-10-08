package checks

import (
	"bufio"
	"encoding/json"
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
	return matchResult(c, matchLines(lines, re, c.Bool("invert", false)), filepath.Base(path))
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
	return matchResult(c, matchLines(lines, re, false), "the journal")
}

// D8: Windows Event Log entries since the previous cycle. Filter values go
// through environment variables, never into the script text.
func runEventLog(c Cfg, st map[string]any) Result {
	if runtime.GOOS != "windows" {
		return unknown("Event Log checks are Windows-only")
	}
	re, err := compilePattern(c)
	if err != nil {
		return unknown("invalid pattern: " + err.Error())
	}
	since, ok := st["since"].(time.Time)
	now := time.Now()
	st["since"] = now
	if !ok {
		return up("Watching the event log — baseline recorded", val(0))
	}
	levels := map[string]string{"critical": "1", "error": "2", "warning": "3", "information": "4"}
	levelList := []string{}
	for _, l := range strings.Split(c.Str("levels", ""), ",") {
		if n, ok := levels[strings.ToLower(strings.TrimSpace(l))]; ok {
			levelList = append(levelList, n)
		}
	}
	env := map[string]string{
		"LOOKSEE_LOG":       c.Str("logName", "System"),
		"LOOKSEE_IDS":       c.Str("eventIds", ""),
		"LOOKSEE_LEVELS":    strings.Join(levelList, ","),
		"LOOKSEE_PROVIDER":  c.Str("provider", ""),
		"LOOKSEE_SINCE_SEC": strconv.FormatInt(int64(now.Sub(since).Seconds())+1, 10),
	}
	script := `$f = @{ LogName = $env:LOOKSEE_LOG; StartTime = (Get-Date).AddSeconds(-[int]$env:LOOKSEE_SINCE_SEC) }
if ($env:LOOKSEE_IDS) { $f.Id = @($env:LOOKSEE_IDS -split ',' | ForEach-Object { [int]$_.Trim() }) }
if ($env:LOOKSEE_LEVELS) { $f.Level = @($env:LOOKSEE_LEVELS -split ',' | ForEach-Object { [int]$_ }) }
if ($env:LOOKSEE_PROVIDER) { $f.ProviderName = $env:LOOKSEE_PROVIDER }
try { ConvertTo-Json -Compress -Depth 4 -InputObject @(Get-WinEvent -FilterHashtable $f -MaxEvents 500 -ErrorAction Stop | Select-Object TimeCreated,Id,LevelDisplayName,ProviderName,@{n='Message';e={($_.Message -split "` + "`" + `n")[0]}}) }
catch { if ($_.FullyQualifiedErrorId -like 'NoMatchingEventsFound*') { '[]' } else { throw } }`
	res, err := execx.PowerShell(60*time.Second, env, script)
	if err != nil {
		return down(err.Error())
	}
	if res.ExitCode != 0 {
		return down("Get-WinEvent failed: " + execx.FirstLine(res.Stderr))
	}
	var events []struct {
		Id               int
		LevelDisplayName string
		ProviderName     string
		Message          string
	}
	out := strings.TrimSpace(res.Stdout)
	if out != "" && out != "[]" {
		if err := json.Unmarshal([]byte(out), &events); err != nil {
			var one struct {
				Id               int
				LevelDisplayName string
				ProviderName     string
				Message          string
			}
			if json.Unmarshal([]byte(out), &one) == nil {
				events = append(events, one)
			}
		}
	}
	var lines []string
	for _, e := range events {
		lines = append(lines, fmt.Sprintf("[%s %d] %s: %s", e.LevelDisplayName, e.Id, e.ProviderName, strings.TrimSpace(e.Message)))
	}
	return matchResult(c, matchLines(lines, re, false), c.Str("logName", "System")+" log")
}
