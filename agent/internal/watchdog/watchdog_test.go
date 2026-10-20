// Tests for the watchdog agent: when it alerts, that it retries a failed
// delivery, sends one recovery and one test message, survives a restart
// without alerting twice, keeps its file private, and formats webhook
// bodies safely. Each test says what it proves.
package watchdog

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// recorder is a fake Sender that remembers subjects and can be told to fail.
type recorder struct {
	subjects []string
	fail     bool
}

func (r *recorder) send(_ *Spec, subject, _ string) error {
	if r.fail {
		return errors.New("smtp: connection refused")
	}
	r.subjects = append(r.subjects, subject)
	return nil
}

func spec() *Spec {
	return &Spec{AfterSeconds: 300, EndpointName: "edge-01", DashboardURL: "https://looksee.example", Chats: []Chat{{Type: "webhook", Name: "hook", Config: map[string]string{"url": "http://x"}}}}
}

// Proves nothing is sent before the configured time, the alert goes out
// once after it, a recovery message follows when the engine is back, and
// the status reflects each step.
func TestAlertAndRecovery(t *testing.T) {
	start := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	w := New(filepath.Join(t.TempDir(), "wd.json"), start)
	r := &recorder{}
	w.SetSender(r.send)
	w.Reachable(spec(), start)
	w.Unreachable(errors.New("dial tcp: refused"), start.Add(2*time.Minute))
	if len(r.subjects) != 0 {
		t.Fatalf("alerted too early: %v", r.subjects)
	}
	w.Unreachable(errors.New("dial tcp: refused"), start.Add(6*time.Minute))
	w.Unreachable(errors.New("dial tcp: refused"), start.Add(7*time.Minute))
	if len(r.subjects) != 1 || !strings.Contains(r.subjects[0], "unreachable") {
		t.Fatalf("want one alert, got %v", r.subjects)
	}
	if s := w.Status(); !s.Alerting || s.LastAlertAt == "" || s.UnreachableSince == "" {
		t.Fatalf("status after alert: %+v", s)
	}
	w.Reachable(spec(), start.Add(9*time.Minute))
	if len(r.subjects) != 2 || !strings.Contains(r.subjects[1], "reachable again") {
		t.Fatalf("want a recovery message, got %v", r.subjects)
	}
	if s := w.Status(); s.Alerting || s.LastRecoveryAt == "" || s.UnreachableSince != "" {
		t.Fatalf("status after recovery: %+v", s)
	}
}

// Proves a failed delivery is recorded and retried on the next failed poll
// rather than given up on.
func TestRetriesFailedDelivery(t *testing.T) {
	start := time.Now()
	w := New(filepath.Join(t.TempDir(), "wd.json"), start)
	r := &recorder{fail: true}
	w.SetSender(r.send)
	w.Reachable(spec(), start)
	w.Unreachable(errors.New("timeout"), start.Add(10*time.Minute))
	if s := w.Status(); s.Alerting || !strings.Contains(s.LastError, "refused") {
		t.Fatalf("failed delivery not recorded: %+v", s)
	}
	r.fail = false
	w.Unreachable(errors.New("timeout"), start.Add(11*time.Minute))
	if len(r.subjects) != 1 || !w.Status().Alerting || w.Status().LastError != "" {
		t.Fatalf("retry didn't deliver: %v %+v", r.subjects, w.Status())
	}
}

// Proves a requested test is sent once per request, not on every poll.
func TestTestMessageOncePerRequest(t *testing.T) {
	w := New(filepath.Join(t.TempDir(), "wd.json"), time.Now())
	r := &recorder{}
	w.SetSender(r.send)
	s := spec()
	s.TestID = "2026-10-20T12:00:00Z"
	w.Reachable(s, time.Now())
	w.Reachable(s, time.Now())
	s2 := spec()
	s2.TestID = "2026-10-20T12:05:00Z"
	w.Reachable(s2, time.Now())
	if len(r.subjects) != 2 || !strings.Contains(r.subjects[0], "test") {
		t.Fatalf("want two tests, got %v", r.subjects)
	}
}

// Proves the spec and the "already alerted" state survive a restart (no
// second alert for the same outage), the file is private to the agent's
// account, and turning the watchdog off deletes it.
func TestPersistence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "wd.json")
	start := time.Now()
	w := New(path, start)
	r := &recorder{}
	w.SetSender(r.send)
	w.Reachable(spec(), start)
	w.Unreachable(errors.New("down"), start.Add(10*time.Minute))
	if runtime.GOOS != "windows" {
		if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
			t.Fatalf("file mode: %v %v", info.Mode().Perm(), err)
		}
	}
	// Restarted during the outage: knows it already alerted.
	w2 := New(path, start.Add(11*time.Minute))
	r2 := &recorder{}
	w2.SetSender(r2.send)
	w2.Unreachable(errors.New("down"), start.Add(30*time.Minute))
	if len(r2.subjects) != 0 {
		t.Fatalf("alerted twice after restart: %v", r2.subjects)
	}
	w2.Reachable(nil, start.Add(31*time.Minute))
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("file not removed when watchdog was turned off")
	}
	if w2.Status() != nil {
		t.Fatalf("status should be nil when not a watchdog")
	}
}

// Proves webhook messages are delivered with the channel's body template
// and that quotes/newlines in a message can't break the JSON body.
func TestWebhookDelivery(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(data, &got); err != nil {
			w.WriteHeader(400)
			return
		}
		w.WriteHeader(204)
	}))
	defer srv.Close()
	s := &Spec{Chats: []Chat{{Type: "webhook", Name: "hook", Config: map[string]string{"url": srv.URL, "bodyTemplate": `{"text": "{{message}}", "t": "{{title}}"}`}}}}
	if err := Deliver(s, `Looksee "down"`, "line 1\nline 2"); err != nil {
		t.Fatalf("deliver: %v", err)
	}
	if got["t"] != `Looksee "down"` || !strings.Contains(got["text"].(string), "line 1\nline 2") {
		t.Fatalf("body: %v", got)
	}
	// Nowhere to send → an error, not silent success.
	if err := Deliver(&Spec{}, "x", "y"); err == nil {
		t.Fatal("expected an error with no destinations")
	}
}
