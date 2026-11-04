// Windows Event Log check (type agent_eventlog — "disk errors", "unexpected
// shutdowns", blue screens and anything else in an event log): counts new events
// matching the check's log, IDs, levels and provider.
//
// Where this sits: runEventLog is called from checks.go each time the engine
// schedules this check. Matching and thresholds on the result are shared with
// the other log checks (logs.go) and the engine.
//
// Why wevtutil and not PowerShell: wevtutil.exe is the small tool built into
// Windows for reading event logs. It starts in milliseconds, where a PowerShell
// process can take many seconds on a busy machine, and those slow starts made
// this check time out now and then. It uses the same query engine underneath, so
// the results are the same.
//
// Why a failed read isn't a failed check: the check only looks for events after
// the last successful read. A read that fails or times out reports "unknown" and
// the next run covers the missed time, so a slow moment neither raises a false
// alarm nor loses a real disk error.
//
// Security: the engine chooses the log name, IDs and provider, and they end up
// in a query. Arguments go to wevtutil directly (no shell is involved), event IDs
// must be digits, and a provider or log name that could break out of the query or
// be read as a wevtutil option is refused.

package checks

import (
	"encoding/xml"
	"fmt"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"looksee-agent/internal/execx"
)

// maxEvents caps how many events one run reads (newest first).
const maxEvents = 500

// eventLogSkew is how far behind the clock each read stops. Windows can write an
// event a moment after its timestamp, so reading right up to "now" could step
// past one that hadn't landed yet; the next run reads this part instead.
const eventLogSkew = 2 * time.Second

// eventLevelNumbers maps a check's level names to Windows' level numbers.
// "information" includes level 0 ("always log"), which is what Security-log audit
// events such as 4625 use.
var eventLevelNumbers = map[string][]string{"critical": {"1"}, "error": {"2"}, "warning": {"3"}, "information": {"4", "0"}}

// eventLevelNames names a level number when Windows didn't supply the text.
var eventLevelNames = map[string]string{"0": "Information", "1": "Critical", "2": "Error", "3": "Warning", "4": "Information", "5": "Verbose"}

// xmlControlChars matches control characters that aren't allowed in XML (all
// below space except tab, newline and carriage return). Some drivers put them in
// event messages, and one would otherwise make the whole answer unreadable.
var xmlControlChars = regexp.MustCompile(`[\x00-\x08\x0b\x0c\x0e-\x1f]`)

// LogEvent is one event, reduced to what a check reports.
type LogEvent struct {
	ID       int
	Level    string
	Provider string
	Message  string
}

// eventFilter is what one read asks for.
type eventFilter struct {
	IDs      string // comma-separated event IDs; blank = any
	Levels   string // comma-separated level names; blank = any
	Provider string // one provider name; blank = any
	Since    time.Time
	Until    time.Time
}

// BuildEventQuery turns a filter into the XPath query wevtutil takes, e.g.
//
//	*[System[TimeCreated[@SystemTime>='2026-11-04T10:00:00.000Z' and
//	@SystemTime<'2026-11-04T10:01:00.000Z'] and (EventID=7 or EventID=51) and
//	(Level=1 or Level=2) and Provider[@Name='disk']]]
//
// Times are absolute UTC rather than "the last N seconds", so two runs never
// overlap or leave a gap, however long each one took.
//
// It returns an error for an event ID that isn't a number or a provider
// containing an apostrophe: XPath has no way to escape one, so it could change
// the meaning of the query.
func BuildEventQuery(f eventFilter) (string, error) {
	const timeFormat = "2006-01-02T15:04:05.000Z"
	parts := []string{fmt.Sprintf("TimeCreated[@SystemTime>='%s' and @SystemTime<'%s']", f.Since.UTC().Format(timeFormat), f.Until.UTC().Format(timeFormat))}

	var ids []string
	for _, raw := range strings.Split(f.IDs, ",") {
		id := strings.TrimSpace(raw)
		if id == "" {
			continue
		}
		if !isDigits(id) {
			return "", fmt.Errorf("event ID %q isn't a number", id)
		}
		ids = append(ids, "EventID="+id)
	}
	if len(ids) > 0 {
		parts = append(parts, "("+strings.Join(ids, " or ")+")")
	}

	var levels []string
	for _, raw := range strings.Split(f.Levels, ",") {
		for _, n := range eventLevelNumbers[strings.ToLower(strings.TrimSpace(raw))] {
			levels = append(levels, "Level="+n)
		}
	}
	if len(levels) > 0 {
		parts = append(parts, "("+strings.Join(levels, " or ")+")")
	}

	if f.Provider != "" {
		if strings.Contains(f.Provider, "'") {
			return "", fmt.Errorf("provider name can't contain an apostrophe")
		}
		parts = append(parts, "Provider[@Name='"+f.Provider+"']")
	}
	return "*[System[" + strings.Join(parts, " and ") + "]]", nil
}

// xmlEvent is the part of wevtutil's XML this check reads. RenderingInfo (the
// readable message) is only there when the event's provider could format it.
type xmlEvent struct {
	System struct {
		Provider struct {
			Name string `xml:"Name,attr"`
		} `xml:"Provider"`
		EventID string `xml:"EventID"`
		Level   string `xml:"Level"`
	} `xml:"System"`
	EventData struct {
		Data []string `xml:"Data"`
	} `xml:"EventData"`
	RenderingInfo struct {
		Message string `xml:"Message"`
		Level   string `xml:"Level"`
	} `xml:"RenderingInfo"`
}

// ParseEvents reads wevtutil's XML output (one <Event> after another, wrapped in
// the <Events> root the query asks for). Each event is decoded on its own, so one
// unreadable event is skipped rather than losing the others. An event with no
// readable message falls back to its raw data values.
func ParseEvents(out string) []LogEvent {
	// Bytes that aren't valid UTF-8 (a non-English system's code page) and stray
	// control characters would make the XML reader refuse the event.
	clean := xmlControlChars.ReplaceAllString(strings.ToValidUTF8(out, "?"), " ")
	var events []LogEvent
	for _, chunk := range strings.SplitAfter(clean, "</Event>") {
		start := strings.Index(chunk, "<Event")
		// "<Events>" is the wrapper, not an event: skip past it.
		if start >= 0 && strings.HasPrefix(chunk[start:], "<Events>") {
			next := strings.Index(chunk[start+len("<Events>"):], "<Event")
			if next < 0 {
				continue
			}
			start += len("<Events>") + next
		}
		if start < 0 {
			continue
		}
		var e xmlEvent
		if xml.Unmarshal([]byte(chunk[start:]), &e) != nil {
			continue
		}
		id, err := strconv.Atoi(strings.TrimSpace(e.System.EventID))
		if err != nil {
			continue
		}
		level := strings.TrimSpace(e.RenderingInfo.Level)
		if level == "" {
			level = eventLevelNames[strings.TrimSpace(e.System.Level)]
		}
		// Only the first line: the rest of a long message is too much for a
		// status line, and the event itself is in Windows' Event Viewer.
		message, _, _ := strings.Cut(strings.TrimSpace(e.RenderingInfo.Message), "\n")
		if message == "" {
			message = strings.Join(e.EventData.Data, " ")
		}
		events = append(events, LogEvent{ID: id, Level: level, Provider: e.System.Provider.Name, Message: strings.TrimSpace(message)})
	}
	return events
}

// readEvents runs the query against one log, newest first. It asks for readable
// messages, and if that fails (a provider whose message files were uninstalled
// can make formatting fail) asks again for the raw events, since knowing an event
// happened matters more than its wording.
func readEvents(logName, query string, timeout time.Duration) ([]LogEvent, error) {
	args := func(format string) []string {
		return []string{"qe", logName, "/q:" + query, "/c:" + strconv.Itoa(maxEvents), "/rd:true", "/f:" + format, "/e:Events"}
	}
	res, err := execx.Run(timeout, nil, "wevtutil", args("RenderedXml")...)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		res, err = execx.Run(timeout, nil, "wevtutil", args("xml")...)
		if err != nil {
			return nil, err
		}
		if res.ExitCode != 0 {
			return nil, fmt.Errorf("wevtutil: %s", execx.FirstLine(res.Stderr+"\n"+res.Stdout))
		}
	}
	return ParseEvents(res.Stdout), nil
}

// runEventLog is the agent_eventlog check.
//
// st is this check's memory between runs ("since": the end of the last successful
// read). The first run only records where to start: history already in the log
// isn't reported as new.
//
// Config: logName, eventIds, levels, provider, pattern, ignoreCase, exclude.
// Returns "up" with no matches, the usual count-or-fail result with matches, and
// "unknown" when the log couldn't be read or the settings aren't valid.
func runEventLog(c Cfg, st map[string]any) Result {
	if runtime.GOOS != "windows" {
		return unknown("Event Log checks are Windows-only")
	}
	re, err := compilePattern(c)
	if err != nil {
		return unknown("invalid pattern: " + err.Error())
	}
	logName := c.Str("logName", "System")
	// A leading "/" or "-" would be read by wevtutil as an option, not a log name.
	if strings.HasPrefix(logName, "/") || strings.HasPrefix(logName, "-") {
		return unknown("invalid log name: " + logName)
	}
	until := time.Now().Add(-eventLogSkew)
	since, ok := st["since"].(time.Time)
	if !ok {
		st["since"] = until
		return up("Watching the event log — baseline recorded", val(0))
	}
	query, err := BuildEventQuery(eventFilter{IDs: c.Str("eventIds", ""), Levels: c.Str("levels", ""), Provider: c.Str("provider", ""), Since: since, Until: until})
	if err != nil {
		return unknown("invalid filter: " + err.Error())
	}
	events, err := readEvents(logName, query, 60*time.Second)
	if err != nil {
		// "since" stays put, so the next run covers this time as well.
		return unknown(fmt.Sprintf("Couldn't read the %s log this time, will catch up on the next run: %v", logName, err))
	}
	st["since"] = until

	// Exclusions: an all-digits item is an event ID to skip; anything else is a
	// text that, found in the event's line, skips it.
	var ids, texts []string
	for _, x := range c.Excludes(false) {
		if isDigits(x) {
			ids = append(ids, x)
		} else {
			texts = append(texts, x)
		}
	}
	var lines []string
	for _, e := range events {
		if nameExcluded(strconv.Itoa(e.ID), ids) {
			continue
		}
		lines = append(lines, fmt.Sprintf("[%s %d] %s: %s", e.Level, e.ID, e.Provider, e.Message))
	}
	return matchResult(c, matchLines(withoutExcluded(lines, texts), re, false), logName+" log")
}
