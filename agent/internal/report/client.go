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
	"looksee-agent/internal/collector"
	"looksee-agent/internal/metrics"
	"looksee-agent/internal/watchdog"
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
