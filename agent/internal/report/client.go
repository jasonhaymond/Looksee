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
	Config map[string]any `json:"config"`
}

type configResponse struct {
	Checks []ServiceCheck `json:"checks"`
}

func (c *Client) FetchServiceChecks() ([]ServiceCheck, error) {
	req, err := http.NewRequest(http.MethodGet, c.baseURL+"/api/agent/config", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.agentKey)

	res, err := c.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("fetching agent config: unexpected status %d", res.StatusCode)
	}

	var parsed configResponse
	if err := json.NewDecoder(res.Body).Decode(&parsed); err != nil {
		return nil, err
	}
	return parsed.Checks, nil
}

type ServiceResult struct {
	CheckID string `json:"checkId"`
	Running bool   `json:"running"`
	Message string `json:"message,omitempty"`
}

type reportBody struct {
	Metrics  metrics.Snapshot `json:"metrics"`
	Services []ServiceResult  `json:"services,omitempty"`
}

func (c *Client) SendReport(snap metrics.Snapshot, services []ServiceResult) error {
	body, err := json.Marshal(reportBody{Metrics: snap, Services: services})
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
