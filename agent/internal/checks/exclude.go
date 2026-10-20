// Exclusions: items a check should ignore. The engine sends each check's
// `exclude` setting already merged with any reusable exclusion lists (see
// engine/src/services/exclusions.ts), as text with one item per line. The
// matching rules here mirror engine/src/services/probes/exclude.ts so an
// item means the same thing wherever the check runs:
//   - names (services, containers, VMs, event IDs): the whole name, ignoring
//     upper/lower case, where * stands for any run of characters and ? for
//     one character — "veth*" matches "veth3a2f", "*-migrate" matches
//     "app-migrate";
//   - texts (log, journal and event messages): the text appears anywhere in
//     the line, ignoring case.
package checks

import (
	"regexp"
	"strings"
)

// Excludes returns the check's exclusion items: from a list, or from text
// with one item per line. With splitCommas, commas also separate items (name
// settings were often written "a, b"); message texts keep their commas.
func (c Cfg) Excludes(splitCommas bool) []string {
	var parts []string
	switch v := c["exclude"].(type) {
	case []any:
		for _, x := range v {
			if s, ok := x.(string); ok {
				parts = append(parts, s)
			}
		}
	case string:
		sep := func(r rune) bool { return r == '\n' || r == '\r' }
		if splitCommas {
			sep = func(r rune) bool { return r == '\n' || r == '\r' || r == ',' }
		}
		parts = strings.FieldsFunc(v, sep)
	}
	out := []string{}
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// namePattern turns a name pattern into an anchored, case-insensitive
// regular expression in which only * and ? have a meaning: everything else
// is quoted literally (regexp.QuoteMeta), so an item can never act as a
// regular expression of its own.
func namePattern(p string) *regexp.Regexp {
	q := regexp.QuoteMeta(p)
	q = strings.ReplaceAll(q, `\*`, ".*")
	q = strings.ReplaceAll(q, `\?`, ".")
	return regexp.MustCompile("(?i)^" + q + "$")
}

// nameExcluded reports whether a name matches any of the patterns (whole
// name, case ignored, * and ? as wildcards). Empty names never match.
func nameExcluded(name string, patterns []string) bool {
	if name == "" {
		return false
	}
	for _, p := range patterns {
		if strings.ContainsAny(p, "*?") {
			if namePattern(p).MatchString(name) {
				return true
			}
		} else if strings.EqualFold(p, name) {
			return true
		}
	}
	return false
}

// textExcluded reports whether a line contains any of the texts (case
// ignored).
func textExcluded(line string, items []string) bool {
	lower := strings.ToLower(line)
	for _, i := range items {
		if strings.Contains(lower, strings.ToLower(i)) {
			return true
		}
	}
	return false
}

// withoutExcluded drops the lines that contain an excluded text.
func withoutExcluded(lines []string, items []string) []string {
	if len(items) == 0 {
		return lines
	}
	out := lines[:0:0]
	for _, l := range lines {
		if !textExcluded(l, items) {
			out = append(out, l)
		}
	}
	return out
}

// isDigits reports whether s is a non-empty run of 0-9 — an event ID rather
// than a message text in an event-log check's exclusions.
func isDigits(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
