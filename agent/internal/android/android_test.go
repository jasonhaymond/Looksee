// Tests for the Android support helpers (android.go). Each test says what it
// proves.
package android

import "testing"

// Proves the first valid nameserver in resolv.conf text is used, and that
// junk lines and non-addresses are skipped.
func TestNameserverFrom(t *testing.T) {
	text := "# Termux resolv.conf\nsearch lan\nnameserver not-an-ip\nnameserver 192.168.1.1\nnameserver 8.8.8.8\n"
	if got := nameserverFrom(text); got != "192.168.1.1" {
		t.Fatalf("got %q", got)
	}
	if got := nameserverFrom(""); got != "" {
		t.Fatalf("empty text: got %q", got)
	}
}

// Proves a configured dns_server always wins over anything detected.
func TestDNSServerConfiguredWins(t *testing.T) {
	if got := DNSServer("10.0.0.53"); got != "10.0.0.53" {
		t.Fatalf("got %q", got)
	}
}
