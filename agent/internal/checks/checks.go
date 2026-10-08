// Package checks runs the per-host checks the engine assigns to this agent
// (GET /api/agent/config) and turns each into one Result. The agent only
// measures; thresholds (warn/critical) are applied by the engine so they
// mean the same thing for every check type.
package checks

import (
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Check struct {
	ID              string         `json:"id"`
	Type            string         `json:"type"`
	Config          map[string]any `json:"config"`
	IntervalSeconds int            `json:"intervalSeconds"`
}

type Result struct {
	CheckID   string   `json:"checkId"`
	Status    string   `json:"status"`
	Message   string   `json:"message,omitempty"`
	Value     *float64 `json:"value,omitempty"`
	Details   any      `json:"details,omitempty"`
	LatencyMs *int64   `json:"latencyMs,omitempty"`
}

type Options struct {
	ScriptDir    string
	DockerSocket string
}

// Runner keeps per-check memory between cycles (log file offsets, watchdog
// directory snapshots, previous counters) and remembers when each check last
// ran so a check's own interval is honoured even though the agent reports
// more often.
type Runner struct {
	Opts    Options
	mu      sync.Mutex
	state   map[string]map[string]any
	lastRun map[string]time.Time
}

func NewRunner(opts Options) *Runner {
	return &Runner{Opts: opts, state: map[string]map[string]any{}, lastRun: map[string]time.Time{}}
}

func (r *Runner) stateFor(id string) map[string]any {
	r.mu.Lock()
	defer r.mu.Unlock()
	s, ok := r.state[id]
	if !ok {
		s = map[string]any{}
		r.state[id] = s
	}
	return s
}

// Due reports whether a check's interval has elapsed. Checks run at most
// once per agent cycle, and no more often than their own interval.
func (r *Runner) Due(c Check, now time.Time) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	last, ok := r.lastRun[c.ID]
	interval := time.Duration(c.IntervalSeconds) * time.Second
	return !ok || now.Sub(last) >= interval-2*time.Second
}

// Forget drops state for checks the engine no longer sends.
func (r *Runner) Forget(active map[string]bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id := range r.state {
		if !active[id] {
			delete(r.state, id)
			delete(r.lastRun, id)
		}
	}
}

func (r *Runner) Run(c Check) (res Result) {
	r.mu.Lock()
	r.lastRun[c.ID] = time.Now()
	r.mu.Unlock()
	defer func() {
		if p := recover(); p != nil {
			res = Result{Status: "unknown", Message: fmt.Sprintf("agent error running %s: %v", c.Type, p)}
		}
		res.CheckID = c.ID
		if len(res.Message) > 2000 {
			res.Message = res.Message[:2000]
		}
	}()
	cfg := Cfg(c.Config)
	st := r.stateFor(c.ID)
	switch c.Type {
	case "agent_service":
		return runService(cfg)
	case "agent_process":
		return runProcess(cfg, st)
	case "agent_services_overview":
		return runServicesOverview(cfg)
	case "agent_file":
		return runFile(cfg, st)
	case "agent_log":
		return runLog(cfg, st)
	case "agent_journal":
		return runJournal(cfg, st)
	case "agent_eventlog":
		return runEventLog(cfg, st)
	case "agent_script":
		return runScript(cfg, r.Opts.ScriptDir)
	case "agent_scheduled_task":
		return runScheduledTask(cfg)
	case "agent_docker":
		return runDocker(cfg, st, r.Opts.DockerSocket)
	case "agent_hyperv":
		return runHyperV(cfg)
	case "agent_perfcounter":
		return runPerfCounter(cfg)
	case "agent_vpn":
		return runVPN(cfg)
	case "agent_ups":
		return runUPS(cfg)
	case "agent_backup":
		return runBackup(cfg)
	case "ping":
		return probePing(cfg)
	case "tcp":
		return probeTCP(cfg)
	case "http":
		return probeHTTP(cfg)
	case "dns":
		return probeDNS(cfg)
	case "ssl_cert":
		return probeSSL(cfg)
	default:
		return Result{Status: "unknown", Message: fmt.Sprintf("this agent doesn't know check type %q — update it from the Hosts page", c.Type)}
	}
}

// Cfg is a check's config with typed accessors; the dashboard sends some
// numbers as strings, so every getter accepts either.
type Cfg map[string]any

func (c Cfg) Str(k, def string) string {
	v, ok := c[k]
	if !ok || v == nil {
		return def
	}
	s := strings.TrimSpace(fmt.Sprint(v))
	if s == "" {
		return def
	}
	return s
}

func (c Cfg) Num(k string, def float64) float64 {
	v, ok := c[k]
	if !ok || v == nil {
		return def
	}
	switch n := v.(type) {
	case float64:
		return n
	case int:
		return float64(n)
	case string:
		if f, err := strconv.ParseFloat(strings.TrimSpace(n), 64); err == nil {
			return f
		}
	}
	return def
}

func (c Cfg) Bool(k string, def bool) bool {
	v, ok := c[k]
	if !ok || v == nil {
		return def
	}
	switch b := v.(type) {
	case bool:
		return b
	case string:
		return b == "true" || b == "1" || b == "yes"
	}
	return def
}

// HasThresholds: when the user set warn/critical levels, the agent reports
// "up" plus the value and lets the engine judge, instead of applying its
// own default "anything > 0 is bad" rule.
func (c Cfg) HasThresholds() bool {
	for _, k := range []string{"warnAbove", "criticalAbove", "warnBelow", "criticalBelow"} {
		if c.Str(k, "") != "" {
			return true
		}
	}
	return false
}

func val(f float64) *float64 {
	v := float64(int64(f*100+0.5)) / 100
	if f < 0 {
		v = float64(int64(f*100-0.5)) / 100
	}
	return &v
}

func up(msg string, v *float64) Result     { return Result{Status: "up", Message: msg, Value: v} }
func down(msg string) Result               { return Result{Status: "down", Message: msg} }
func unknown(msg string) Result            { return Result{Status: "unknown", Message: msg} }
func failf(format string, a ...any) Result { return down(fmt.Sprintf(format, a...)) }
func severity(c Cfg, def string) string {
	if s := c.Str("severity", def); s == "warn" || s == "down" {
		return s
	}
	return def
}

func countOrFail(c Cfg, count int, msg string, details any) Result {
	r := Result{Status: "up", Message: msg, Value: val(float64(count)), Details: details}
	if count > 0 && !c.HasThresholds() {
		r.Status = severity(c, "down")
	}
	return r
}

func humanAge(d time.Duration) string {
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%.1fh", d.Hours())
	default:
		return fmt.Sprintf("%.1fd", d.Hours()/24)
	}
}
