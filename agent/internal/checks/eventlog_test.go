package checks

import (
	"runtime"
	"strings"
	"testing"
	"time"
)

// The query has exactly the filters asked for, in wevtutil's XPath form, with
// absolute times so runs can't overlap or leave a gap.
func TestBuildEventQuery(t *testing.T) {
	since := time.Date(2026, 11, 4, 10, 0, 0, 0, time.UTC)
	q, err := BuildEventQuery(eventFilter{IDs: "7, 51", Levels: "critical,error", Provider: "disk", Since: since, Until: since.Add(time.Minute)})
	if err != nil {
		t.Fatal(err)
	}
	want := "*[System[TimeCreated[@SystemTime>='2026-11-04T10:00:00.000Z' and @SystemTime<'2026-11-04T10:01:00.000Z'] and (EventID=7 or EventID=51) and (Level=1 or Level=2) and Provider[@Name='disk']]]"
	if q != want {
		t.Errorf("got  %s\nwant %s", q, want)
	}
}

// Attack: a provider or event ID crafted to break out of the query and widen what
// it reads (XPath injection). Both are refused rather than passed along.
func TestBuildEventQueryRefusesInjection(t *testing.T) {
	now := time.Now()
	if _, err := BuildEventQuery(eventFilter{Provider: "x'] or *['", Since: now, Until: now}); err == nil {
		t.Error("provider with an apostrophe was accepted")
	}
	if _, err := BuildEventQuery(eventFilter{IDs: "1 or 1=1", Since: now, Until: now}); err == nil {
		t.Error("non-numeric event ID was accepted")
	}
}

// Audit events use level 0, so asking for "information" has to include it.
func TestBuildEventQueryInformationIncludesLevelZero(t *testing.T) {
	now := time.Now()
	q, _ := BuildEventQuery(eventFilter{Levels: "information", Since: now, Until: now})
	if !strings.Contains(q, "Level=4 or Level=0") {
		t.Error(q)
	}
}

// A rendered event gives its readable first line; an unrendered one falls back to
// its data; a control character or an unreadable event doesn't lose the others.
func TestParseEvents(t *testing.T) {
	ns := `xmlns='http://schemas.microsoft.com/win/2004/08/events/event'`
	out := `<Events><Event ` + ns + `><System><Provider Name='disk'/><EventID Qualifiers='49668'>7</EventID><Level>2</Level></System><RenderingInfo Culture='en-US'><Message>The device has a bad block.` + "\x01\r\n" + `second line</Message><Level>Error</Level></RenderingInfo></Event>` +
		`<Event ` + ns + `><System><Provider Name='gone'/><EventID>51</EventID><Level>3</Level></System><EventData><Data>raw</Data><Data>value</Data></EventData></Event>` +
		`<Event ` + ns + `><System><EventID>not-a-number</EventID></System></Event></Events>`
	events := ParseEvents(out)
	if len(events) != 2 {
		t.Fatalf("got %d events: %+v", len(events), events)
	}
	if e := events[0]; e.ID != 7 || e.Level != "Error" || e.Provider != "disk" || !strings.HasPrefix(e.Message, "The device has a bad block.") || strings.Contains(e.Message, "second line") {
		t.Errorf("rendered event: %+v", e)
	}
	if e := events[1]; e.ID != 51 || e.Level != "Warning" || e.Message != "raw value" {
		t.Errorf("unrendered event: %+v", e)
	}
	if got := ParseEvents("<Events></Events>"); len(got) != 0 {
		t.Errorf("empty answer: %+v", got)
	}
}

// Attack: a log name that wevtutil would read as an option (e.g. to read a log
// file off disk) is refused before anything runs.
func TestRunEventLogRefusesOptionAsLogName(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows only")
	}
	r := runEventLog(Cfg{"logName": "/lf:true"}, map[string]any{})
	if r.Status != "unknown" || !strings.Contains(r.Message, "invalid log name") {
		t.Errorf("%+v", r)
	}
}

// Against this machine's real System log: reading twice in a row works, and the
// second run starts where the first stopped.
func TestRunEventLogAgainstRealLog(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows only")
	}
	st := map[string]any{}
	if r := runEventLog(Cfg{"logName": "System"}, st); r.Status != "up" || !strings.Contains(r.Message, "baseline") {
		t.Fatalf("first run: %+v", r)
	}
	// Look back a long way so real events come through the whole path.
	st["since"] = time.Now().Add(-30 * 24 * time.Hour)
	r := runEventLog(Cfg{"logName": "System", "levels": "critical,error,warning"}, st)
	t.Logf("%s: %s", r.Status, r.Message)
	if r.Status == "unknown" {
		t.Fatalf("real read failed: %+v", r)
	}
	if since := st["since"].(time.Time); time.Since(since) > time.Minute {
		t.Errorf("window didn't advance after a good read: %v", since)
	}
}

// A log that can't be read reports "unknown" and keeps its place, so the time
// isn't skipped: this is the bug where a timeout lost real disk errors.
func TestRunEventLogFailureKeepsWindow(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows only")
	}
	before := time.Now().Add(-time.Hour)
	st := map[string]any{"since": before}
	r := runEventLog(Cfg{"logName": "No-Such-Log-Looksee"}, st)
	if r.Status != "unknown" {
		t.Errorf("status %+v", r)
	}
	if st["since"].(time.Time) != before {
		t.Errorf("window moved after a failed read: %v", st["since"])
	}
}

// Timing record for the reason this check moved off PowerShell: logs how long a
// real query takes on this machine, and fails only if it can't run at all.
func TestReadEventsTiming(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows only")
	}
	now := time.Now()
	q, _ := BuildEventQuery(eventFilter{IDs: "7,11,51,153", Since: now.Add(-24 * time.Hour), Until: now})
	start := time.Now()
	if _, err := readEvents("System", q, 60*time.Second); err != nil {
		t.Fatal(err)
	}
	t.Logf("query took %s", time.Since(start))
}
