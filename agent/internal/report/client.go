// Package report is the agent's HTTP client for talking to the Looksee
// engine: fetching which checks this host owns, and posting back metrics +
// check results each cycle.
//
// Every request carries the endpoint's agent key as a bearer token (the
// engine's requireAgentAuth). HTTP errors come back as *StatusError so the
// main loop can react to the status code — back off on 401/403 (the key is
// wrong or the address is blocked) and resend a smaller report on 413.
// Requests go through Go's default HTTP transport, so a proxy set with the
// proxy_url config key (main.go) applies here too.
package report

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"looksee-agent/internal/checks"
	"looksee-agent/internal/collector"
	"looksee-agent/internal/metrics"
	"looksee-agent/internal/watchdog"
)

// Client talks to one engine with one agent key.
type Client struct {
	baseURL    string
	agentKey   string
	httpClient *http.Client
}

// NewClient returns a client for the engine at baseURL (e.g.
// "https://looksee.example.com") using agentKey. Each request times out
// after 30 seconds.
func NewClient(baseURL, agentKey string) *Client {
	return &Client{
		baseURL:    baseURL,
		agentKey:   agentKey,
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
}

// StatusError is an answer from the engine other than 200 OK. Its message
// is just the status; callers add what they were doing ("sending report: …").
type StatusError struct {
	// The HTTP status code: 401 = key not accepted, 403 = this address is
	// blocked or not allowlisted, 413 = report too large, 500 = server error.
	Code int
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("unexpected status %d", e.Code)
}

// StatusCode returns the HTTP status code inside err if it is (or wraps) a
// *StatusError, and 0 otherwise (a network error, a timeout…).
func StatusCode(err error) int {
	var se *StatusError
	if errors.As(err, &se) {
		return se.Code
	}
	return 0
}

// UpdateAvailable is a one-shot flag: the engine flips it back to false as
// soon as it's included in a response (see engine/src/routes/agent.ts), so
// it means "an update was requested since the last time you asked" rather
// than "a newer build currently exists" — the caller acts on it once, not
// on every poll.
type Config struct {
	Checks          []checks.Check `json:"checks"`
	UpdateAvailable bool           `json:"updateAvailable"`
	// Non-nil while this host is a site collector (engine 3.2.0+).
	Collector *collector.Spec `json:"collector"`
	// Non-nil while this endpoint is a watchdog agent (engine 5.0+): how
	// to alert when the engine can't be reached.
	Watchdog *watchdog.Spec `json:"watchdog"`
	// Lock files whose dependencies to include in the software report
	// (engine 5.0+; from the endpoint's software checks).
	SoftwareScan *struct {
		Lockfiles []string `json:"lockfiles"`
	} `json:"softwareScan"`
}

// FetchConfig asks the engine which checks this endpoint runs, plus update,
// collector, watchdog and software-scan instructions (GET /api/agent/config).
// Returns a *StatusError for any status other than 200.
func (c *Client) FetchConfig() (Config, error) {
	req, err := http.NewRequest(http.MethodGet, c.baseURL+"/api/agent/config", nil)
	if err != nil {
		return Config{}, err
	}
	req.Header.Set("Authorization", "Bearer "+c.agentKey)

	res, err := c.httpClient.Do(req)
	if err != nil {
		return Config{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return Config{}, &StatusError{Code: res.StatusCode}
	}

	var parsed Config
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return Config{}, err
	}
	return parsed, nil
}

// Discovery is a snapshot of what's actually on this host (process,
// service and container names) for the dashboard's check-form suggestions.
// Optional/best-effort: empty slices just aren't sent.
type Discovery struct {
	Processes  []string
	Services   []string
	Containers []string
	// Full inventory (4.0+): resource use per process, state and start type
	// per service, and the scripts available to custom script checks.
	ProcessInventory []metrics.ProcessInfo
	ServiceInventory []metrics.ServiceInfo
	Scripts          []string
	ScriptsListed    bool
}

type reportBody struct {
	Metrics             metrics.Snapshot      `json:"metrics"`
	Results             []checks.Result       `json:"results,omitempty"`
	AvailableProcesses  []string              `json:"availableProcesses,omitempty"`
	AvailableServices   []string              `json:"availableServices,omitempty"`
	AvailableContainers []string              `json:"availableContainers,omitempty"`
	ProcessInventory    []metrics.ProcessInfo `json:"processInventory,omitempty"`
	ServiceInventory    []metrics.ServiceInfo `json:"serviceInventory,omitempty"`
	AvailableScripts    []string              `json:"availableScripts,omitempty"`
	Inventory           map[string]any        `json:"inventory,omitempty"`
	Version             string                `json:"version,omitempty"`
	CollectorError      string                `json:"collectorError,omitempty"`
	WatchdogStatus      *watchdog.Status      `json:"watchdogStatus,omitempty"`
	Software            *metrics.Software     `json:"software,omitempty"`
}

// An empty script_dir is still worth reporting (it clears an old list),
// but only on cycles that actually listed it.
func scriptsOrEmpty(d Discovery) []string {
	if d.ScriptsListed && d.Scripts == nil {
		return []string{}
	}
	return d.Scripts
}

// SendReport posts one cycle's report (POST /api/agent/report): metrics,
// finished check results, and — when they're due — discovery lists,
// inventory and the software report (pass empty/nil to leave them out).
// Returns a *StatusError for any status other than 200; on 413 (too large)
// the caller can resend with the optional parts left out.
func (c *Client) SendReport(snap metrics.Snapshot, results []checks.Result, discovery Discovery, inventory map[string]any, version, collectorError string, watchdogStatus *watchdog.Status, software *metrics.Software) error {
	body, err := json.Marshal(reportBody{
		Metrics:             snap,
		Results:             results,
		AvailableProcesses:  discovery.Processes,
		AvailableServices:   discovery.Services,
		AvailableContainers: discovery.Containers,
		ProcessInventory:    discovery.ProcessInventory,
		ServiceInventory:    discovery.ServiceInventory,
		AvailableScripts:    scriptsOrEmpty(discovery),
		Inventory:           inventory,
		Version:             version,
		CollectorError:      collectorError,
		WatchdogStatus:      watchdogStatus,
		Software:            software,
	})
	if err != nil {
		return err
	}
	body = StripNulEscapes(body)

	req, err := http.NewRequest(http.MethodPost, c.baseURL+"/api/agent/report", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.agentKey)
	req.Header.Set("Content-Type", "application/json")

	res, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return &StatusError{Code: res.StatusCode}
	}
	return nil
}

// StripNulEscapes removes every "\u0000" escape (an encoded NUL character)
// from JSON text produced by json.Marshal, as a last safety net: any value
// read from the OS — a registry name, an event message, a service
// description — could carry a NUL, and the engine's database can't store
// one. Go's encoder writes a NUL inside a string as exactly \u0000.
//
// It walks the bytes rather than doing a plain text replace, because a
// string that really contains a backslash followed by "u0000" is encoded
// as \\u0000 (an escaped backslash, then plain text) and must be left alone.
// In JSON a backslash only ever appears inside a string, always starting a
// two-character escape (or a six-character \uXXXX one), so stepping over
// each escape as a unit is enough to tell the two apart.
func StripNulEscapes(b []byte) []byte {
	nul := []byte(`\u0000`)
	if !bytes.Contains(b, nul) {
		return b
	}
	out := make([]byte, 0, len(b))
	for i := 0; i < len(b); i++ {
		if b[i] != '\\' || i+1 >= len(b) {
			out = append(out, b[i])
			continue
		}
		if bytes.HasPrefix(b[i:], nul) {
			i += len(nul) - 1 // skip the whole escape
			continue
		}
		// Any other escape (\\, \", \n, é…): copy its first two bytes
		// together so the second one is never mistaken for the start of an
		// escape; the rest of a \uXXXX escape is plain hex digits.
		out = append(out, b[i], b[i+1])
		i++
	}
	return out
}
