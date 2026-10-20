// Package watchdog makes this agent alert by itself when it can't reach the
// Looksee engine — the one failure Looksee can't report on its own, because
// its server (or database) is the thing that's down.
//
// How it works: the engine includes a "watchdog spec" in this agent's config
// when an admin has made this endpoint a watchdog (Endpoints → this endpoint
// → Watchdog). The spec says how long the engine may be unreachable, and how
// to deliver an alert: SMTP settings + recipients, and/or chat channels
// (Telegram, Slack, Teams, generic webhook). The agent saves the spec to disk
// so it survives a restart during an outage. Each cycle, main.go reports
// whether the config poll worked:
//   - poll works: remember the time; if an alert went out, send "reachable
//     again"; send a test message if the admin asked for one;
//   - poll fails: once the engine has been unreachable for the spec's time,
//     send the alert (retrying every cycle until a delivery works).
//
// Security: the spec holds delivery secrets (SMTP password, bot tokens,
// webhook URLs). The file is written readable by the agent's own account
// only (mode 0600), next to the agent's config, which already holds its key.
// Nothing here is ever logged.
package watchdog

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/smtp"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Email is where and how to send alert emails.
type Email struct {
	Host     string   `json:"host"`
	Port     int      `json:"port"`
	User     string   `json:"user"`
	Password string   `json:"password"`
	From     string   `json:"from"`
	To       []string `json:"to"`
}

// Chat is one chat channel: its type ("telegram", "slack", "teams",
// "webhook") and that type's settings, as stored in Looksee.
type Chat struct {
	Type   string            `json:"type"`
	Name   string            `json:"name"`
	Config map[string]string `json:"config"`
}

// Spec is the watchdog part of the agent config (engine:
// services/watchdogAgents.ts). A nil Spec means "not a watchdog".
type Spec struct {
	AfterSeconds int    `json:"afterSeconds"`
	EndpointName string `json:"endpointName"`
	DashboardURL string `json:"dashboardUrl"`
	Email        *Email `json:"email"`
	Chats        []Chat `json:"chats"`
	TestID       string `json:"testId"`
}

// Status is what the agent reports back about its watchdog (shown on the
// endpoint's page). Times are RFC 3339 strings; empty = never.
type Status struct {
	Alerting         bool   `json:"alerting"`
	UnreachableSince string `json:"unreachableSince,omitempty"`
	LastAlertAt      string `json:"lastAlertAt,omitempty"`
	LastRecoveryAt   string `json:"lastRecoveryAt,omitempty"`
	LastTestAt       string `json:"lastTestAt,omitempty"`
	LastTestID       string `json:"lastTestId,omitempty"`
	LastError        string `json:"lastError,omitempty"`
	LastErrorAt      string `json:"lastErrorAt,omitempty"`
}

// Sender delivers one message; replaceable in tests.
type Sender func(spec *Spec, subject, body string) error

// Watchdog tracks reachability and sends alerts. Safe for one goroutine
// (main's cycle loop) plus Status() readers.
type Watchdog struct {
	path   string
	send   Sender
	mu     sync.Mutex
	spec   *Spec
	lastOK time.Time
	// When the first failed poll of the current outage happened.
	failingSince time.Time
	status       Status
}

// saved is the on-disk file: the last spec plus the status (so a restart
// mid-outage doesn't send a second alert or forget a sent one).
type saved struct {
	Spec   *Spec  `json:"spec"`
	Status Status `json:"status"`
}

// New loads any saved spec from path. now is treated as the last successful
// contact, so a freshly started agent waits the full time before alerting.
func New(path string, now time.Time) *Watchdog {
	w := &Watchdog{path: path, send: Deliver, lastOK: now}
	if data, err := os.ReadFile(path); err == nil {
		var s saved
		if json.Unmarshal(data, &s) == nil {
			w.spec, w.status = s.Spec, s.Status
		}
	}
	return w
}

// SetSender replaces how messages are delivered (tests).
func (w *Watchdog) SetSender(s Sender) { w.send = s }

// Status returns the current status for the agent's report, or nil when
// this agent isn't a watchdog.
func (w *Watchdog) Status() *Status {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.spec == nil {
		return nil
	}
	s := w.status
	return &s
}

// save writes the spec and status, readable by this account only. Written
// to a temporary file and renamed, so a crash never leaves half a file.
func (w *Watchdog) save() {
	data, err := json.Marshal(saved{Spec: w.spec, Status: w.status})
	if err != nil {
		return
	}
	tmp := w.path + ".tmp"
	if os.WriteFile(tmp, data, 0o600) == nil {
		_ = os.Rename(tmp, w.path)
	}
}

// Reachable records a successful config poll and its (possibly nil) spec:
// sends the "reachable again" message after an alert, and a test message
// when a new test was requested.
func (w *Watchdog) Reachable(spec *Spec, now time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.lastOK, w.failingSince = now, time.Time{}
	w.spec = spec
	if spec == nil {
		// No longer a watchdog: forget everything, including the file.
		w.status = Status{}
		_ = os.Remove(w.path)
		return
	}
	w.status.UnreachableSince = ""
	if w.status.Alerting {
		subject := fmt.Sprintf("Looksee is reachable again (from %s)", spec.EndpointName)
		body := fmt.Sprintf("The watchdog agent on %s can reach Looksee again at %s.\n\nIt alerted at %s.\n\nDashboard: %s", spec.EndpointName, now.Format(time.RFC1123), w.status.LastAlertAt, spec.DashboardURL)
		if w.deliver(spec, subject, body, now) {
			w.status.Alerting = false
			w.status.LastRecoveryAt = now.Format(time.RFC3339)
		}
	}
	if spec.TestID != "" && spec.TestID != w.status.LastTestID {
		subject := fmt.Sprintf("Looksee watchdog test (from %s)", spec.EndpointName)
		body := fmt.Sprintf("This is a test from the Looksee watchdog agent on %s. If Looksee becomes unreachable from there for %s, you'll get an alert like this one.\n\nDashboard: %s", spec.EndpointName, humanDuration(spec.AfterSeconds), spec.DashboardURL)
		w.status.LastTestID = spec.TestID
		if w.deliver(spec, subject, body, now) {
			w.status.LastTestAt = now.Format(time.RFC3339)
		}
	}
	w.save()
}

// Unreachable records a failed config poll (reason = the error) and sends
// the alert once the engine has been unreachable for the spec's time.
// Delivery is retried on every following failed poll until it works.
func (w *Watchdog) Unreachable(reason error, now time.Time) {
	w.mu.Lock()
	defer w.mu.Unlock()
	spec := w.spec
	if spec == nil {
		return
	}
	if w.failingSince.IsZero() {
		w.failingSince = now
	}
	if w.status.UnreachableSince == "" {
		w.status.UnreachableSince = w.failingSince.Format(time.RFC3339)
	}
	after := time.Duration(spec.AfterSeconds) * time.Second
	if after <= 0 {
		after = 5 * time.Minute
	}
	if w.status.Alerting || now.Sub(w.lastOK) < after {
		w.save()
		return
	}
	subject := fmt.Sprintf("Looksee is unreachable (from %s)", spec.EndpointName)
	body := fmt.Sprintf("The watchdog agent on %s hasn't been able to reach Looksee since %s (%s).\n\nLast error: %s\n\nMonitoring and alerting may be down until Looksee is back. You'll get another message when it is.\n\nDashboard: %s",
		spec.EndpointName, w.lastOK.Format(time.RFC1123), humanDuration(int(now.Sub(w.lastOK).Seconds())), reason, spec.DashboardURL)
	if w.deliver(spec, subject, body, now) {
		w.status.Alerting = true
		w.status.LastAlertAt = now.Format(time.RFC3339)
	}
	w.save()
}

// deliver sends through the configured sender, recording the error (or
// clearing it). Returns whether at least one destination got the message.
func (w *Watchdog) deliver(spec *Spec, subject, body string, now time.Time) bool {
	if err := w.send(spec, subject, body); err != nil {
		w.status.LastError = err.Error()
		w.status.LastErrorAt = now.Format(time.RFC3339)
		return false
	}
	w.status.LastError, w.status.LastErrorAt = "", ""
	return true
}

// humanDuration turns seconds into "5 min" / "2 h 10 min".
func humanDuration(seconds int) string {
	if seconds < 3600 {
		return fmt.Sprintf("%d min", (seconds+59)/60)
	}
	return fmt.Sprintf("%d h %d min", seconds/3600, (seconds%3600)/60)
}

// DefaultPath is where the spec is kept: the agent's state directory when
// systemd provides one ($STATE_DIRECTORY — on Linux /etc is read-only to
// the hardened service), otherwise next to the agent's config file
// (Windows and macOS, where the agent runs as SYSTEM / root).
func DefaultPath(configPath string) string {
	if dir := os.Getenv("STATE_DIRECTORY"); dir != "" {
		// systemd may list several directories separated by ":"; the first is ours.
		return filepath.Join(strings.Split(dir, ":")[0], "looksee-watchdog.json")
	}
	return filepath.Join(filepath.Dir(configPath), "looksee-watchdog.json")
}

// Deliver sends the message to every destination in the spec. It succeeds
// when at least one destination accepted it; otherwise it returns the
// errors joined together.
func Deliver(spec *Spec, subject, body string) error {
	var errs []string
	sent := 0
	if spec.Email != nil && len(spec.Email.To) > 0 {
		if err := sendEmail(spec.Email, subject, body); err != nil {
			errs = append(errs, "email: "+err.Error())
		} else {
			sent++
		}
	}
	for _, c := range spec.Chats {
		if err := sendChat(c, subject, body); err != nil {
			errs = append(errs, c.Type+" "+c.Name+": "+err.Error())
		} else {
			sent++
		}
	}
	if sent > 0 {
		return nil
	}
	if len(errs) == 0 {
		return fmt.Errorf("no email address or channel to alert")
	}
	return fmt.Errorf("%s", strings.Join(errs, "; "))
}

// sendEmail sends a plain-text email. Port 465 uses TLS from the start;
// other ports upgrade with STARTTLS when the server offers it. Go's
// smtp.PlainAuth refuses to send the password over an unencrypted
// connection (except to localhost), so credentials are never sent in clear.
func sendEmail(e *Email, subject, body string) error {
	addr := net.JoinHostPort(e.Host, strconv.Itoa(e.Port))
	var c *smtp.Client
	var err error
	// The whole conversation must finish within a minute, so a mail server
	// that stops answering can't stall the agent.
	deadline := time.Now().Add(time.Minute)
	if e.Port == 465 {
		conn, derr := tls.DialWithDialer(&net.Dialer{Timeout: 15 * time.Second}, "tcp", addr, &tls.Config{ServerName: e.Host, MinVersion: tls.VersionTLS12})
		if derr != nil {
			return derr
		}
		_ = conn.SetDeadline(deadline)
		c, err = smtp.NewClient(conn, e.Host)
	} else {
		conn, derr := net.DialTimeout("tcp", addr, 15*time.Second)
		if derr != nil {
			return derr
		}
		_ = conn.SetDeadline(deadline)
		c, err = smtp.NewClient(conn, e.Host)
		if err == nil {
			if ok, _ := c.Extension("STARTTLS"); ok {
				err = c.StartTLS(&tls.Config{ServerName: e.Host, MinVersion: tls.VersionTLS12})
			}
		}
	}
	if err != nil {
		return err
	}
	defer c.Close()
	if e.User != "" {
		if err := c.Auth(smtp.PlainAuth("", e.User, e.Password, e.Host)); err != nil {
			return err
		}
	}
	from := e.From
	// "Looksee <looksee@example.com>" → the address part for the envelope.
	envelope := from
	if i, j := strings.LastIndex(from, "<"), strings.LastIndex(from, ">"); i >= 0 && j > i {
		envelope = from[i+1 : j]
	}
	if err := c.Mail(envelope); err != nil {
		return err
	}
	for _, to := range e.To {
		if err := c.Rcpt(to); err != nil {
			return err
		}
	}
	wc, err := c.Data()
	if err != nil {
		return err
	}
	// Header lines can't contain line breaks (no header injection from a
	// subject); the body uses CRLF line endings as SMTP requires.
	clean := func(s string) string { return strings.NewReplacer("\r", " ", "\n", " ").Replace(s) }
	msg := "From: " + clean(from) + "\r\nTo: " + clean(strings.Join(e.To, ", ")) + "\r\nSubject: " + clean("Looksee: "+subject) +
		"\r\nDate: " + time.Now().Format(time.RFC1123Z) + "\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" +
		strings.ReplaceAll(strings.ReplaceAll(body, "\r\n", "\n"), "\n", "\r\n") + "\r\n"
	if _, err := wc.Write([]byte(msg)); err != nil {
		return err
	}
	if err := wc.Close(); err != nil {
		return err
	}
	return c.Quit()
}

// httpClient times out so a hung chat service can't stall the agent.
var httpClient = &http.Client{Timeout: 15 * time.Second}

// postJSON sends a JSON body and treats any non-2xx answer as a failure.
func postJSON(url string, payload any) error {
	data, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	res, err := httpClient.Post(url, "application/json", bytes.NewReader(data))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("rejected with status %d", res.StatusCode)
	}
	return nil
}

// sendChat posts to one chat channel, in that service's own message format
// (mirroring engine/src/services/notifications/chat.ts and webhook.ts).
func sendChat(c Chat, subject, body string) error {
	switch c.Type {
	case "telegram":
		token, chat := c.Config["botToken"], c.Config["chatId"]
		if token == "" || chat == "" {
			return fmt.Errorf("needs a bot token and chat ID")
		}
		payload := map[string]any{"chat_id": chat, "text": subject + "\n\n" + body, "disable_web_page_preview": true}
		if t := c.Config["threadId"]; t != "" {
			if n, err := strconv.Atoi(t); err == nil {
				payload["message_thread_id"] = n
			}
		}
		return postJSON("https://api.telegram.org/bot"+token+"/sendMessage", payload)
	case "slack":
		if c.Config["webhookUrl"] == "" {
			return fmt.Errorf("needs a webhook URL")
		}
		return postJSON(c.Config["webhookUrl"], map[string]any{"text": "*" + subject + "*\n" + body})
	case "teams":
		if c.Config["webhookUrl"] == "" {
			return fmt.Errorf("needs a webhook URL")
		}
		card := map[string]any{
			"$schema": "http://adaptivecards.io/schemas/adaptive-card.json", "type": "AdaptiveCard", "version": "1.4",
			"body": []any{
				map[string]any{"type": "TextBlock", "text": subject, "weight": "Bolder", "size": "Medium", "wrap": true},
				map[string]any{"type": "TextBlock", "text": body, "wrap": true},
			},
		}
		return postJSON(c.Config["webhookUrl"], map[string]any{"type": "message", "attachments": []any{map[string]any{"contentType": "application/vnd.microsoft.card.adaptive", "content": card}}})
	case "webhook":
		url := c.Config["url"]
		if url == "" {
			return fmt.Errorf("needs a URL")
		}
		template := c.Config["bodyTemplate"]
		if template == "" {
			template = `{"content": "{{message}}"}`
		}
		return postRaw(url, fillTemplate(template, map[string]string{"message": subject + "\n\n" + body, "title": subject, "status": "DOWN"}))
	default:
		return fmt.Errorf("unsupported channel type %q", c.Type)
	}
}

// fillTemplate replaces {{name}} with JSON-escaped values (so a newline or
// quote in the message can't break the JSON body); unknown names become "".
func fillTemplate(t string, values map[string]string) string {
	var out strings.Builder
	for {
		i := strings.Index(t, "{{")
		if i < 0 {
			out.WriteString(t)
			return out.String()
		}
		j := strings.Index(t[i:], "}}")
		if j < 0 {
			out.WriteString(t)
			return out.String()
		}
		out.WriteString(t[:i])
		name := strings.TrimSpace(t[i+2 : i+j])
		quoted, _ := json.Marshal(values[name])
		out.WriteString(string(quoted[1 : len(quoted)-1]))
		t = t[i+j+2:]
	}
}

// postRaw sends an already-built JSON body.
func postRaw(url, body string) error {
	res, err := httpClient.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("rejected with status %d", res.StatusCode)
	}
	return nil
}
