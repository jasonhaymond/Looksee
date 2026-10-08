// Package report is the agent's HTTP client for talking to the Looksee
// engine: fetching which checks this host owns, and posting back metrics +
// check results each cycle.
package report

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"looksee-agent/internal/checks"
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
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
}

// UpdateAvailable is a one-shot flag: the engine flips it back to false as
// soon as it's included in a response (see engine/src/routes/agent.ts), so
// it means "an update was requested since the last time you asked" rather
// than "a newer build currently exists" — the caller acts on it once, not
// on every poll.
type Config struct {
	Checks          []checks.Check `json:"checks"`
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
}

type reportBody struct {
	Metrics             metrics.Snapshot `json:"metrics"`
	Results             []checks.Result  `json:"results,omitempty"`
	AvailableProcesses  []string         `json:"availableProcesses,omitempty"`
	AvailableServices   []string         `json:"availableServices,omitempty"`
	AvailableContainers []string         `json:"availableContainers,omitempty"`
	Inventory           map[string]any   `json:"inventory,omitempty"`
	Version             string           `json:"version,omitempty"`
}

func (c *Client) SendReport(snap metrics.Snapshot, results []checks.Result, discovery Discovery, inventory map[string]any, version string) error {
	body, err := json.Marshal(reportBody{
		Metrics:             snap,
		Results:             results,
		AvailableProcesses:  discovery.Processes,
		AvailableServices:   discovery.Services,
		AvailableContainers: discovery.Containers,
		Inventory:           inventory,
		Version:             version,
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
