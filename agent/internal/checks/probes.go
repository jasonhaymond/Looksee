package checks

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"looksee-agent/internal/execx"
)

// Remote probes (L9/E5): the same engine-side check types, run from this
// host so they can reach targets inside its network. Behaviour mirrors the
// engine's probes/*.ts; thresholds are still applied by the engine.

var pingTime = regexp.MustCompile(`(?i)time[=<]\s*([\d.]+)\s*ms`)

func ParsePingTimes(out string) []float64 {
	var t []float64
	for _, m := range pingTime.FindAllStringSubmatch(out, -1) {
		if f, err := strconv.ParseFloat(m[1], 64); err == nil {
			t = append(t, f)
		}
	}
	return t
}

func ms(d time.Duration) *int64 {
	v := d.Milliseconds()
	return &v
}

func probePing(c Cfg) Result {
	host := c.Str("host", "")
	if host == "" {
		return unknown("missing host")
	}
	count := int(math.Max(1, math.Min(20, c.Num("count", 3))))
	var args []string
	switch runtime.GOOS {
	case "windows":
		args = []string{"-n", strconv.Itoa(count), "-w", "2000", host}
	case "darwin":
		args = []string{"-c", strconv.Itoa(count), "-W", "2000", host}
	default:
		args = []string{"-c", strconv.Itoa(count), "-i", "0.2", "-W", "2", host}
	}
	res, _ := execx.Run(time.Duration(count*2+5)*time.Second, nil, "ping", args...)
	times := ParsePingTimes(res.Stdout)
	loss := float64(count-len(times)) / float64(count) * 100
	if len(times) == 0 {
		return Result{Status: "down", Message: "No reply from " + host, Value: val(100)}
	}
	sum, jitter := 0.0, 0.0
	for i, t := range times {
		sum += t
		if i > 0 {
			jitter += math.Abs(t - times[i-1])
		}
	}
	avg := sum / float64(len(times))
	if len(times) > 1 {
		jitter /= float64(len(times) - 1)
	}
	lat := int64(math.Round(avg))
	status := "up"
	if loss >= c.Num("lossCriticalPercent", math.Inf(1)) || jitter >= c.Num("jitterCriticalMs", math.Inf(1)) {
		status = "down"
	} else if loss >= c.Num("lossWarnPercent", math.Inf(1)) || jitter >= c.Num("jitterWarnMs", math.Inf(1)) {
		status = "warn"
	}
	return Result{Status: status, Message: fmt.Sprintf("%.0f%% loss, avg %.1fms, jitter %.1fms", loss, avg, jitter), Value: val(loss), LatencyMs: &lat}
}

func probeTCP(c Cfg) Result {
	host := c.Str("host", "")
	port := int(c.Num("port", 0))
	if host == "" || port == 0 {
		return unknown("missing host or port")
	}
	start := time.Now()
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), 5*time.Second)
	if err != nil {
		return down(err.Error())
	}
	conn.Close()
	return Result{Status: "up", LatencyMs: ms(time.Since(start))}
}

func parseHeaders(raw string) http.Header {
	h := http.Header{}
	for _, line := range strings.Split(raw, "\n") {
		if k, v, ok := strings.Cut(line, ":"); ok && strings.TrimSpace(k) != "" {
			h.Set(strings.TrimSpace(k), strings.TrimSpace(v))
		}
	}
	return h
}

func statusMatches(status int, expected string) bool {
	if expected == "" {
		return status < 400
	}
	for _, part := range strings.Split(expected, ",") {
		p := strings.TrimSpace(part)
		if lo, hi, ok := strings.Cut(p, "-"); ok {
			l, _ := strconv.Atoi(strings.TrimSpace(lo))
			h, _ := strconv.Atoi(strings.TrimSpace(hi))
			if status >= l && status <= h {
				return true
			}
			continue
		}
		if len(p) == 3 && strings.HasSuffix(strings.ToLower(p), "xx") {
			if status/100 == int(p[0]-'0') {
				return true
			}
			continue
		}
		if n, err := strconv.Atoi(p); err == nil && n == status {
			return true
		}
	}
	return false
}

func jsonPath(v any, path string) any {
	path = strings.TrimPrefix(strings.TrimSpace(path), "$")
	re := regexp.MustCompile(`\[(\d+)\]|\.?([^.\[\]]+)`)
	for _, m := range re.FindAllStringSubmatch(path, -1) {
		switch cur := v.(type) {
		case map[string]any:
			v = cur[m[2]]
		case []any:
			i, err := strconv.Atoi(m[1] + strings.TrimLeft(m[2], "."))
			if err != nil || i >= len(cur) {
				return nil
			}
			v = cur[i]
		default:
			return nil
		}
	}
	return v
}

func probeHTTP(c Cfg) Result {
	url := c.Str("url", "")
	if url == "" {
		return unknown("missing url")
	}
	var redirects []string
	follow := c.Bool("followRedirects", true)
	client := &http.Client{
		Timeout:   time.Duration(c.Num("timeoutSeconds", 10)) * time.Second,
		Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: c.Bool("insecureSkipVerify", false)}},
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if !follow {
				return http.ErrUseLastResponse
			}
			if len(via) >= int(c.Num("maxRedirects", 10)) {
				return fmt.Errorf("too many redirects")
			}
			redirects = append(redirects, req.URL.String())
			return nil
		},
	}
	var body io.Reader
	if b := c.Str("body", ""); b != "" {
		body = strings.NewReader(b)
	}
	req, err := http.NewRequest(c.Str("method", "GET"), url, body)
	if err != nil {
		return down(err.Error())
	}
	req.Header = parseHeaders(c.Str("headers", ""))
	req.Header.Set("User-Agent", "Looksee-Agent")
	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return down(err.Error())
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	lat := ms(time.Since(start))
	text := string(data)
	details := map[string]any{"statusCode": resp.StatusCode, "finalUrl": resp.Request.URL.String(), "redirects": redirects}
	fail := func(msg string) Result { return Result{Status: "down", Message: msg, LatencyMs: lat, Details: details} }
	if !statusMatches(resp.StatusCode, c.Str("expectedStatus", "")) {
		return fail(fmt.Sprintf("HTTP %d", resp.StatusCode))
	}
	if s := c.Str("bodyContains", ""); s != "" && !strings.Contains(text, s) {
		return fail(fmt.Sprintf("Response didn't contain %q", s))
	}
	if s := c.Str("bodyNotContains", ""); s != "" && strings.Contains(text, s) {
		return fail(fmt.Sprintf("Response contained %q", s))
	}
	if s := c.Str("bodyRegex", ""); s != "" {
		re, err := regexp.Compile("(?m)" + s)
		if err != nil {
			return Result{Status: "warn", Message: "invalid regex: " + s, LatencyMs: lat}
		}
		if !re.MatchString(text) {
			return fail(fmt.Sprintf("Response didn't match /%s/", s))
		}
	}
	if s := c.Str("expectedFinalUrl", ""); s != "" && strings.TrimSuffix(resp.Request.URL.String(), "/") != strings.TrimSuffix(s, "/") {
		return fail("Ended at " + resp.Request.URL.String() + ", expected " + s)
	}
	var value *float64
	if p := c.Str("jsonPath", ""); p != "" {
		var doc any
		if err := json.Unmarshal(data, &doc); err != nil {
			return fail("Response isn't valid JSON")
		}
		got := jsonPath(doc, p)
		if exp := c.Str("jsonExpected", ""); exp != "" && fmt.Sprint(got) != exp {
			return fail(fmt.Sprintf("%s is %v, expected %s", p, got, exp))
		}
		if f, err := strconv.ParseFloat(fmt.Sprint(got), 64); err == nil {
			value = &f
		}
	}
	return Result{Status: "up", LatencyMs: lat, Value: value, Details: details}
}

func probeDNS(c Cfg) Result {
	name := c.Str("hostname", "")
	if name == "" {
		return unknown("missing hostname")
	}
	r := net.DefaultResolver
	if server := c.Str("server", ""); server != "" {
		if _, _, err := net.SplitHostPort(server); err != nil {
			server = net.JoinHostPort(server, "53")
		}
		r = &net.Resolver{PreferGo: true, Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, network, server)
		}}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	start := time.Now()
	var answers []string
	var err error
	switch strings.ToUpper(c.Str("recordType", "A")) {
	case "MX":
		var mx []*net.MX
		mx, err = r.LookupMX(ctx, name)
		for _, m := range mx {
			answers = append(answers, fmt.Sprintf("%d %s", m.Pref, m.Host))
		}
	case "TXT":
		answers, err = r.LookupTXT(ctx, name)
	case "CNAME":
		var cn string
		cn, err = r.LookupCNAME(ctx, name)
		answers = []string{cn}
	case "NS":
		var ns []*net.NS
		ns, err = r.LookupNS(ctx, name)
		for _, n := range ns {
			answers = append(answers, n.Host)
		}
	case "AAAA":
		var ips []net.IP
		ips, err = r.LookupIP(ctx, "ip6", name)
		for _, ip := range ips {
			answers = append(answers, ip.String())
		}
	default:
		var ips []net.IP
		ips, err = r.LookupIP(ctx, "ip4", name)
		for _, ip := range ips {
			answers = append(answers, ip.String())
		}
	}
	lat := ms(time.Since(start))
	if err != nil {
		return down(fmt.Sprintf("Failed to resolve %s: %v", name, err))
	}
	if exp := c.Str("expectedValue", ""); exp != "" {
		found := false
		for _, a := range answers {
			if strings.Contains(strings.ToLower(a), strings.ToLower(exp)) {
				found = true
			}
		}
		if !found {
			return Result{Status: "down", Message: fmt.Sprintf("Expected %q, got %s", exp, strings.Join(answers, ", ")), LatencyMs: lat}
		}
	}
	return Result{Status: "up", Message: strings.Join(answers, ", "), LatencyMs: lat}
}

func probeSSL(c Cfg) Result {
	host := c.Str("host", "")
	if host == "" {
		return unknown("missing host")
	}
	port := strconv.Itoa(int(c.Num("port", 443)))
	start := time.Now()
	conn, err := tls.DialWithDialer(&net.Dialer{Timeout: 5 * time.Second}, "tcp", net.JoinHostPort(host, port), &tls.Config{ServerName: host, InsecureSkipVerify: true})
	if err != nil {
		return down(err.Error())
	}
	defer conn.Close()
	lat := ms(time.Since(start))
	state := conn.ConnectionState()
	if len(state.PeerCertificates) == 0 {
		return Result{Status: "warn", Message: "No certificate returned", LatencyMs: lat}
	}
	leaf := state.PeerCertificates[0]
	days := math.Floor(time.Until(leaf.NotAfter).Hours() / 24)
	base := Result{LatencyMs: lat, Value: val(days)}
	if days < 0 {
		base.Status, base.Message = "down", "Certificate expired"
		return base
	}
	if c.Bool("checkChain", false) || c.Bool("checkHostname", false) {
		inter := x509.NewCertPool()
		for _, ic := range state.PeerCertificates[1:] {
			inter.AddCert(ic)
		}
		opts := x509.VerifyOptions{Intermediates: inter}
		if c.Bool("checkHostname", false) && net.ParseIP(host) == nil {
			opts.DNSName = host
		}
		if _, err := leaf.Verify(opts); err != nil {
			base.Status, base.Message = "down", err.Error()
			return base
		}
	}
	msg := fmt.Sprintf("Expires in %.0f days", days)
	switch {
	case days <= c.Num("criticalDays", 0):
		base.Status = "down"
	case days <= c.Num("warnDays", 14):
		base.Status = "warn"
	default:
		base.Status = "up"
	}
	base.Message = msg
	return base
}
