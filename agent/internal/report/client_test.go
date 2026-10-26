// Tests for the engine client (client.go). Each test says what it proves.
package report

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"looksee-agent/internal/metrics"
)

// Proves NULs inside any string of an outgoing report are removed — the
// last safety net for values the agent reads from the OS — while a string
// that really contains the text \u0000 (an escaped backslash) is left
// intact, and the result is still valid JSON.
func TestStripNulEscapes(t *testing.T) {
	in := map[string]any{
		"name":    "SHARP Driver Uninstall Tool\x00\x00\x00",
		"key\x00": "v",
		"literal": `C:\u0000folder`,
		"quote":   "say \"hi\"\x00",
		"accent":  "café",
	}
	raw, _ := json.Marshal(in)
	if !strings.Contains(string(raw), `\u0000`) {
		t.Fatal("test setup: expected the encoder to escape NULs")
	}
	out := StripNulEscapes(raw)
	var back map[string]string
	if err := json.Unmarshal(out, &back); err != nil {
		t.Fatalf("result isn't valid JSON: %v\n%s", err, out)
	}
	want := map[string]string{"name": "SHARP Driver Uninstall Tool", "key": "v", "literal": `C:\u0000folder`, "quote": `say "hi"`, "accent": "café"}
	for k, v := range want {
		if back[k] != v {
			t.Errorf("%s: got %q want %q", k, back[k], v)
		}
	}
	// Input with no NUL comes back unchanged (same bytes).
	plain := []byte(`{"a":"b\\u0000c"}`)
	if string(StripNulEscapes(plain)) != string(plain) {
		t.Fatal("changed JSON with no encoded NUL")
	}
}

// Proves the engine's status codes reach the caller as *StatusError, so
// main.go can back off on 401/403 and resend smaller on 413, and that a
// report with NULs arrives at the engine without them.
func TestStatusErrorsAndCleanBody(t *testing.T) {
	var got string
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer k" {
			t.Errorf("missing bearer key")
		}
		b, _ := io.ReadAll(r.Body)
		got = string(b)
		w.WriteHeader(status)
		w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	c := NewClient(srv.URL, "k")

	snap := metrics.Snapshot{}
	sw := &metrics.Software{Packages: []metrics.Package{{Name: "Tool\x00\x00", Version: "1", Source: "windows"}}}
	if err := c.SendReport(snap, nil, Discovery{}, nil, "5.1.0", "", nil, sw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(got, `\u0000`) || !strings.Contains(got, `"n":"Tool"`) {
		t.Fatalf("body still has NULs or lost the name: %s", got)
	}

	for _, code := range []int{401, 403, 413, 500} {
		status = code
		err := c.SendReport(snap, nil, Discovery{}, nil, "5.1.0", "", nil, nil)
		var se *StatusError
		if !errors.As(err, &se) || StatusCode(err) != code {
			t.Fatalf("status %d: got %v", code, err)
		}
		if _, err := c.FetchConfig(); StatusCode(err) != code {
			t.Fatalf("config status %d: got %v", code, err)
		}
	}
	if StatusCode(errors.New("network down")) != 0 {
		t.Fatal("a non-HTTP error should have no status")
	}
}
