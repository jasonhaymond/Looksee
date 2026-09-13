// Looksee agent: a single cross-platform binary that reports host metrics
// and named-service status back to a Looksee engine on an interval. No
// runtime dependency beyond the OS itself — see README.md for build/install.
package main

import (
	"flag"
	"log"
	"runtime"
	"time"

	"looksee-agent/internal/config"
	"looksee-agent/internal/metrics"
	"looksee-agent/internal/report"
)

func main() {
	configPath := flag.String("config", "looksee-agent.yaml", "path to the agent's config file")
	diskPath := flag.String("disk-path", defaultDiskPath(), "filesystem path to report disk usage for")
	flag.Parse()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("looksee-agent: %v", err)
	}

	client := report.NewClient(cfg.EngineURL, cfg.AgentKey)
	interval := time.Duration(cfg.IntervalSeconds) * time.Second
	log.Printf("looksee-agent starting, reporting to %s every %s", cfg.EngineURL, interval)

	for {
		runOnce(client, *diskPath)
		time.Sleep(interval)
	}
}

func runOnce(client *report.Client, diskPath string) {
	snap, err := metrics.Collect(diskPath)
	if err != nil {
		log.Printf("collecting metrics: %v", err)
	}

	serviceChecks, err := client.FetchServiceChecks()
	if err != nil {
		log.Printf("fetching service checks: %v", err)
		serviceChecks = nil
	}

	results := make([]report.ServiceResult, 0, len(serviceChecks))
	for _, sc := range serviceChecks {
		name, _ := sc.Config["serviceName"].(string)
		running, err := metrics.IsProcessRunning(name)
		result := report.ServiceResult{CheckID: sc.ID, Running: running}
		if err != nil {
			result.Message = err.Error()
		}
		results = append(results, result)
	}

	if err := client.SendReport(snap, results); err != nil {
		log.Printf("sending report: %v", err)
	}
}

func defaultDiskPath() string {
	if runtime.GOOS == "windows" {
		return "C:\\"
	}
	return "/"
}
