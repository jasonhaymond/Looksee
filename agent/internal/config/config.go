// Package config loads the agent's small YAML config file. Kept
// deliberately flat (no nested profiles/environments) — this agent runs
// once per host with one engine to report to.
package config

import (
	"fmt"
	"net"
	"net/url"
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
	// Optional HTTP(S) proxy for reaching the engine, e.g.
	// "http://proxy.example.com:8080". Needed where the network only allows
	// web traffic through a proxy: the agent runs as a system account
	// (SYSTEM on Windows), which doesn't use the proxy configured for signed-in
	// users. Used for reports, config polls, agent updates, the site
	// collector's download and engine traffic, and watchdog webhook alerts —
	// not for checks, which probe the local network directly. Empty: the
	// standard HTTPS_PROXY / HTTP_PROXY / NO_PROXY environment variables
	// apply, as before.
	ProxyURL string `yaml:"proxy_url"`
	// DNS server for every lookup the agent makes, e.g. "192.168.1.1".
	// Only needed on Android (which has no /etc/resolv.conf for the agent to
	// read) when Termux's own DNS setting isn't found; ignored elsewhere
	// unless /etc/resolv.conf is missing. See internal/android.
	DNSServer string `yaml:"dns_server"`
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
	if cfg.DNSServer != "" {
		// An IP address, optionally with a port ("10.0.0.53" or
		// "10.0.0.53:53"); a hostname can't be used to find the DNS server.
		host := cfg.DNSServer
		if h, _, err := net.SplitHostPort(cfg.DNSServer); err == nil {
			host = h
		}
		if net.ParseIP(host) == nil {
			return cfg, fmt.Errorf("config: dns_server must be an IP address, optionally with :port (got %q)", cfg.DNSServer)
		}
	}
	if cfg.ProxyURL != "" {
		// Only a full http:// or https:// URL with a host is accepted, so a
		// typo stops the agent with a clear message instead of every request
		// failing later with a confusing one.
		u, err := url.Parse(cfg.ProxyURL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return cfg, fmt.Errorf("config: proxy_url must look like http://proxy.example.com:8080 (got %q)", cfg.ProxyURL)
		}
	}
	return cfg, nil
}
