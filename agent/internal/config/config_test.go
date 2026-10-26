// Tests for loading the agent's config file (config.go). Each test says
// what it proves.
package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// write puts a config file with the given body in a temporary folder.
func write(t *testing.T, body string) string {
	p := filepath.Join(t.TempDir(), "looksee-agent.yaml")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

// Proves proxy_url is read, and that a malformed one stops the agent with a
// clear message instead of every later request failing confusingly.
func TestProxyURL(t *testing.T) {
	base := "engine_url: https://looksee.example.com\nagent_key: k\n"
	cfg, err := Load(write(t, base+"proxy_url: http://proxy.example.com:8080\n"))
	if err != nil || cfg.ProxyURL != "http://proxy.example.com:8080" {
		t.Fatalf("got %+v, %v", cfg, err)
	}
	for _, bad := range []string{"proxy.example.com:8080", "ftp://proxy", "http://"} {
		if _, err := Load(write(t, base+"proxy_url: "+bad+"\n")); err == nil || !strings.Contains(err.Error(), "proxy_url") {
			t.Fatalf("%q: expected a proxy_url error, got %v", bad, err)
		}
	}
	// No proxy configured: still valid (environment variables apply).
	if cfg, err := Load(write(t, base)); err != nil || cfg.ProxyURL != "" {
		t.Fatalf("got %+v, %v", cfg, err)
	}
}
