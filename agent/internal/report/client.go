// Package report is the agent's HTTP client for talking to the Looksee
// engine: fetching which service checks this host owns, and posting back
// metrics + service status each cycle.
package report

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"looksee-agent/internal/metrics"
)

type Client struct {
	baseURL    string
	agentKey   string
	httpClient *http.Client
}

func NewClient(baseURL, agentKey string) *Client {
	return &Client{
		baseURL:    baseURL,
		agentKey:   agentKey,
		httpClient: &http.Client{Timeout: 10 * time.Second},
	}
}

type ServiceCheck struct {
	ID     string         `json:"id"`
	Type   string         `json:"type"`
	Config map[string]any `json:"config"`
}

// UpdateAvailable is a one-shot flag: the engine flips it back to false as
// soon as it's included in a response (see engine/src/routes/agent.ts), so
// it means "an update was requested since the last time you asked" rather
// than "a newer build currently exists" — the caller acts on it once, not
// on every poll.
type Config struct {
	Checks          []ServiceCheck
	UpdateAvailable bool
}

type configResponse struct {
	Checks          []ServiceCheck `json:"checks"`
	UpdateAvailable bool           `json:"updateAvailable"`
}

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
		return Config{}, fmt.Errorf("fetching agent config: unexpected status %d", res.StatusCode)
	}

	var parsed configResponse
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return Config{}, err
	}
	return Config{Checks: parsed.Checks, UpdateAvailable: parsed.UpdateAvailable}, nil
}

type ServiceResult struct {
	CheckID string `json:"checkId"`
	Running bool   `json:"running"`
	Message string `json:"message,omitempty"`
}

type reportBody struct {
	Metrics            metrics.Snapshot `json:"metrics"`
	Services           []ServiceResult  `json:"services,omitempty"`
	AvailableProcesses []string         `json:"availableProcesses,omitempty"`
	AvailableServices  []string         `json:"availableServices,omitempty"`
	Version            string           `json:"version,omitempty"`
}

// Discovery is a snapshot of what's actually on this host (every running
// process name, every registered OS service name) — feeds the dashboard's
// check-form suggestions. Optional/best-effort: nil/empty slices just
// aren't sent (omitempty), so an agent build or OS that can't gather one
// doesn't block the rest of the report.
type Discovery struct {
	Processes []string
	Services  []string
}

func (c *Client) SendReport(snap metrics.Snapshot, services []ServiceResult, discovery Discovery, version string) error {
	body, err := json.Marshal(reportBody{
		Metrics:            snap,
		Services:           services,
		AvailableProcesses: discovery.Processes,
		AvailableServices:  discovery.Services,
		Version:            version,
	})
	if err != nil {
		return err
	}

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
		return fmt.Errorf("sending report: unexpected status %d", res.StatusCode)
	}
	return nil
}
