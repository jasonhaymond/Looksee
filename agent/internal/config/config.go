// Package config loads the agent's small YAML config file. Kept
// deliberately flat (no nested profiles/environments) — this agent runs
// once per host with one engine to report to.
package config

import (
	"fmt"
	"os"

	"gopkg.in/yaml.v3"
)

type Config struct {
	// Base URL of the Looksee engine, e.g. "https://looksee.example.com".
	EngineURL string `yaml:"engine_url"`
	// Per-host bearer token issued by the engine (Hosts > this host > Agent key).
	AgentKey string `yaml:"agent_key"`
	// How often to collect metrics and report in.
	IntervalSeconds int `yaml:"interval_seconds"`
	// Folder of scripts that "Custom script" checks may run, by file name.
	// Empty (the default) disables script checks on this host entirely —
	// the engine can pick which approved script runs, never what it does.
	ScriptDir string `yaml:"script_dir"`
	// NTP server the clock-offset metric compares against.
	NTPServer string `yaml:"ntp_server"`
	// Docker Engine socket; defaults to /var/run/docker.sock or the
	// Windows named pipe.
	DockerSocket string `yaml:"docker_socket"`
}

func defaults() Config {
	return Config{IntervalSeconds: 30, NTPServer: "pool.ntp.org"}
}

func Load(path string) (Config, error) {
	cfg := defaults()
	data, err := os.ReadFile(path)
	if err != nil {
		return cfg, fmt.Errorf("reading config file %s: %w", path, err)
	}
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("parsing config file %s: %w", path, err)
	}
	if cfg.EngineURL == "" {
		return cfg, fmt.Errorf("config: engine_url is required")
	}
	if cfg.AgentKey == "" {
		return cfg, fmt.Errorf("config: agent_key is required")
	}
	if cfg.IntervalSeconds <= 0 {
		cfg.IntervalSeconds = 30
	}
	return cfg, nil
}
