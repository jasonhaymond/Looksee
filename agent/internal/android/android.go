// Package android lets the Linux agent run on Android phones and tablets.
//
// The Android agent is the normal static linux-arm64 (or linux-amd64) build,
// run inside Termux (a Linux terminal app for Android) — Android's kernel is
// Linux, so the same binary works without a separate build. What differs is
// the environment around it, handled here:
//
//   - DNS: Android has no /etc/resolv.conf, so Go's built-in resolver (used
//     by a static build) would only try a DNS server on the phone itself and
//     fail to find the engine's address. ConfigureDNS points it at a real
//     server instead.
//   - Identity: the OS shows as "Android 15" (from Android's system
//     properties) instead of a blank Linux distribution name.
//   - Battery: read through Termux:API when Android hides the kernel's
//     battery files from apps.
//
// Many Linux checks don't apply on Android (no systemd, no journal, no local
// user accounts, CPU totals hidden from apps since Android 8); they report
// "unknown" with a reason rather than failing. See agent/README.md → Android.
package android

import (
	"bufio"
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"time"
)

var (
	detectOnce sync.Once
	isAndroid  bool
)

// IsAndroid reports whether the agent is running on Android: a build for
// GOOS=android, or a Linux build that finds Android's system partition
// (/system/bin/app_process is the program every Android app starts from) or
// the ANDROID_ROOT variable Android sets for every process.
func IsAndroid() bool {
	detectOnce.Do(func() {
		if runtime.GOOS == "android" {
			isAndroid = true
			return
		}
		if runtime.GOOS != "linux" {
			return
		}
		if os.Getenv("ANDROID_ROOT") != "" {
			isAndroid = true
			return
		}
		if _, err := os.Stat("/system/bin/app_process"); err == nil {
			isAndroid = true
		}
	})
	return isAndroid
}

// Prop reads one Android system property with getprop (e.g.
// "ro.build.version.release" → "15"); "" when unavailable.
func Prop(name string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "getprop", name).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// OSName is how the endpoint's OS is shown: "Android 15".
func OSName() string {
	if v := Prop("ro.build.version.release"); v != "" {
		return "Android " + v
	}
	return "Android"
}

// Model is the device's maker and model ("Google Pixel 8"), "" if unknown.
func Model() string {
	return strings.TrimSpace(Prop("ro.product.manufacturer") + " " + Prop("ro.product.model"))
}

// nameserverFrom returns the first "nameserver" address in resolv.conf-style
// text, or "".
func nameserverFrom(text string) string {
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) >= 2 && f[0] == "nameserver" && net.ParseIP(f[1]) != nil {
			return f[1]
		}
	}
	return ""
}

// DNSServer picks the DNS server to use on Android: the agent config's
// dns_server if set, else Termux's own resolv.conf (Termux keeps one under
// its $PREFIX), else the network's server from Android's properties (older
// Android versions only). "" when none is found.
func DNSServer(configured string) string {
	if configured != "" {
		return configured
	}
	prefix := os.Getenv("PREFIX")
	if prefix == "" {
		prefix = "/data/data/com.termux/files/usr"
	}
	if text, err := os.ReadFile(prefix + "/etc/resolv.conf"); err == nil {
		if ns := nameserverFrom(string(text)); ns != "" {
			return ns
		}
	}
	return Prop("net.dns1")
}

// ConfigureDNS makes Go's resolver use the chosen DNS server for every
// lookup, when running on Android or when /etc/resolv.conf is missing (some
// minimal containers). Returns the server used, or "" when nothing changed.
func ConfigureDNS(configured string) string {
	if !IsAndroid() && configured == "" {
		if _, err := os.Stat("/etc/resolv.conf"); err == nil || runtime.GOOS != "linux" {
			return ""
		}
	}
	server := DNSServer(configured)
	if server == "" {
		return ""
	}
	// "1.1.1.1" → "1.1.1.1:53"; "[::1]:53" and "10.0.0.1:5353" stay as they are.
	if _, _, err := net.SplitHostPort(server); err != nil {
		server = net.JoinHostPort(server, "53")
	}
	net.DefaultResolver = &net.Resolver{
		PreferGo: true,
		// Every lookup dials this server, whatever address Go would
		// otherwise have tried.
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, network, server)
		},
	}
	return server
}

// Battery reads the battery through Termux:API's termux-battery-status
// (installed with `pkg install termux-api` plus the Termux:API app). ok is
// false when it isn't available.
func Battery() (percent float64, charging bool, ok bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "termux-battery-status").Output()
	if err != nil {
		return 0, false, false
	}
	var s struct {
		Percentage float64 `json:"percentage"`
		Plugged    string  `json:"plugged"`
		Status     string  `json:"status"`
	}
	if json.Unmarshal(out, &s) != nil {
		return 0, false, false
	}
	return s.Percentage, s.Plugged != "UNPLUGGED" || s.Status == "CHARGING", true
}
