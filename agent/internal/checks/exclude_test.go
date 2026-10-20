// Tests for the agent's exclusion matching (exclude.go): each test says what
// behaviour it proves. The rules must match the engine's
// (engine/src/services/probes/exclude.ts), since the same exclusion lists
// are used on both sides.
package checks

import (
	"reflect"
	"testing"
)

// Proves names match whole and case-insensitively, * and ? are wildcards,
// and every other character is literal — an item can't act as a regular
// expression.
func TestNameExcluded(t *testing.T) {
	cases := []struct {
		name    string
		pattern string
		want    bool
	}{
		{"veth3a2f", "veth*", true},
		{"VETH1", "veth*", true},
		{"eth0", "eth?", true},
		{"eth10", "eth?", false},
		{"app-migrate", "*-migrate", true},
		{"a.b", "a.b", true},
		{"axb", "a.b", false},
		{"aaaaaaaaaaaaaaaaaaaaaaaaa!", "(a+)+$", false},
		{"", "*", false},
		{"Spooler", "spooler", true},
	}
	for _, c := range cases {
		if got := nameExcluded(c.name, []string{c.pattern}); got != c.want {
			t.Errorf("nameExcluded(%q, %q) = %v, want %v", c.name, c.pattern, got, c.want)
		}
	}
}

// Proves the setting is read from text (one per line) or a list, and that
// commas only split name items.
func TestExcludesParsing(t *testing.T) {
	if got := (Cfg{"exclude": "a, b\nc\r\n "}).Excludes(false); !reflect.DeepEqual(got, []string{"a, b", "c"}) {
		t.Errorf("texts: got %v", got)
	}
	if got := (Cfg{"exclude": "a, b\nc"}).Excludes(true); !reflect.DeepEqual(got, []string{"a", "b", "c"}) {
		t.Errorf("names: got %v", got)
	}
	if got := (Cfg{"exclude": []any{"x", " y "}}).Excludes(false); !reflect.DeepEqual(got, []string{"x", "y"}) {
		t.Errorf("list: got %v", got)
	}
	if got := (Cfg{}).Excludes(true); len(got) != 0 {
		t.Errorf("missing: got %v", got)
	}
}

// Proves log lines containing an excluded text are dropped (case ignored)
// and others kept, and that event IDs are recognised by being all digits.
func TestWithoutExcluded(t *testing.T) {
	lines := []string{"auth failure from scanner-01", "disk error on sda", "AUTH FAILURE FROM SCANNER-02"}
	got := withoutExcluded(lines, []string{"Scanner"})
	if !reflect.DeepEqual(got, []string{"disk error on sda"}) {
		t.Errorf("got %v", got)
	}
	if !isDigits("10016") || isDigits("10016a") || isDigits("") {
		t.Error("isDigits")
	}
}
