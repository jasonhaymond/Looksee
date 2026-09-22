// Looksee agent: a single cross-platform binary that reports host metrics
// and named-service status back to a Looksee engine on an interval. No
// runtime dependency beyond the OS itself — see README.md for build/install.
package main

import (
	"flag"
	"fmt"
	"log"
	"os"
	"runtime"
	"time"

	"looksee-agent/internal/config"
	"looksee-agent/internal/metrics"
	"looksee-agent/internal/report"
	"looksee-agent/internal/selfupdate"
)

// Set via -ldflags "-X main.version=..." in build-all.sh, from the single
// source of truth at agent/VERSION. Empty ("dev") for a manual `go build`
// without that flag.
var version = "dev"

func main() {
	configPath := flag.String("config", "looksee-agent.yaml", "path to the agent's config file")
	diskPath := flag.String("disk-path", defaultDiskPath(), "filesystem path to report disk usage for")
	showVersion := flag.Bool("version", false, "print the agent's version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	// Leftover from a Windows update that hasn't been cleaned up yet — the
	// process that renamed it aside has already exited by the time a fresh
	// one starts. No-op on every other platform and on a normal (non-
	// post-update) start.
	selfupdate.CleanupPrevious()

	cfg, err := config.Load(*configPath)
	if err != nil {
		log.Fatalf("looksee-agent: %v", err)
	}

	client := report.NewClient(cfg.EngineURL, cfg.AgentKey)
	interval := time.Duration(cfg.IntervalSeconds) * time.Second
	log.Printf("looksee-agent %s starting, reporting to %s every %s", version, cfg.EngineURL, interval)

	for {
		runOnce(client, *diskPath, cfg.EngineURL)
		time.Sleep(interval)
	}
}

func runOnce(client *report.Client, diskPath string, engineURL string) {
	snap, err := metrics.Collect(diskPath)
	if err != nil {
		log.Printf("collecting metrics: %v", err)
	}

	cfgResp, err := client.FetchConfig()
	if err != nil {
		log.Printf("fetching agent config: %v", err)
	}
	serviceChecks := cfgResp.Checks

	if cfgResp.UpdateAvailable {
		log.Printf("update requested — downloading and installing looksee-agent for %s", selfupdate.Platform())
		if err := selfupdate.Apply(engineURL); err != nil {
			log.Printf("self-update failed, continuing on the current version: %v", err)
		} else if err := selfupdate.Relaunch(); err != nil {
			log.Printf("update installed but failed to relaunch — restart the service manually: %v", err)
		} else {
			log.Printf("update installed, relaunching")
			os.Exit(0)
		}
	}

	results := make([]report.ServiceResult, 0, len(serviceChecks))
	for _, sc := range serviceChecks {
		name, _ := sc.Config["serviceName"].(string)
		var running bool
		var checkErr error
		switch sc.Type {
		case "agent_process":
			running, checkErr = metrics.IsProcessRunning(name)
		case "agent_service":
			running, checkErr = metrics.IsServiceActive(name)
		default:
			checkErr = fmt.Errorf("unknown check type %q", sc.Type)
		}
		result := report.ServiceResult{CheckID: sc.ID, Running: running}
		if checkErr != nil {
			result.Message = checkErr.Error()
		}
		results = append(results, result)
	}

	discovery := report.Discovery{}
	if names, err := metrics.ListProcessNames(); err != nil {
		log.Printf("listing processes: %v", err)
	} else {
		discovery.Processes = names
	}
	if names, err := metrics.ListServiceNames(); err != nil {
		log.Printf("listing services: %v", err)
	} else {
		discovery.Services = names
	}

	if err := client.SendReport(snap, results, discovery, version); err != nil {
		log.Printf("sending report: %v", err)
	}
}

func defaultDiskPath() string {
	if runtime.GOOS == "windows" {
		return "C:\\"
	}
	return "/"
}
