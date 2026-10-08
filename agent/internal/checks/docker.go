package checks

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"path"
	"strings"
	"time"
)

// dockerClient talks to the Docker Engine API over its local socket
// (/var/run/docker.sock, or the npipe on Windows) — no Docker SDK needed
// for the handful of read-only calls used here.
func dockerClient(socket string) *http.Client {
	return &http.Client{
		Timeout: 20 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return dialDocker(ctx, socket)
			},
		},
	}
}

func dockerGet(cl *http.Client, p string, out any) error {
	res, err := cl.Get("http://docker" + p)
	if err != nil {
		if strings.Contains(err.Error(), "permission denied") {
			return fmt.Errorf("%v — the agent's user can't reach the Docker socket (agent README → Privileges)", err)
		}
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		b, _ := io.ReadAll(io.LimitReader(res.Body, 500))
		return fmt.Errorf("docker API %s: HTTP %d %s", p, res.StatusCode, strings.TrimSpace(string(b)))
	}
	return json.NewDecoder(res.Body).Decode(out)
}

type dockerSummary struct {
	ID     string   `json:"Id"`
	Names  []string `json:"Names"`
	State  string   `json:"State"`
	Status string   `json:"Status"`
}

func (d dockerSummary) name() string {
	if len(d.Names) == 0 {
		return d.ID[:12]
	}
	return strings.TrimPrefix(d.Names[0], "/")
}

// ListContainers returns every container name, for the check form's
// suggestions. Errors (no Docker on this host) just mean no suggestions.
func ListContainers(socket string) []string {
	var list []dockerSummary
	if err := dockerGet(dockerClient(socket), "/containers/json?all=1", &list); err != nil {
		return nil
	}
	names := make([]string, 0, len(list))
	for _, c := range list {
		names = append(names, c.name())
	}
	return names
}

type dockerInspect struct {
	RestartCount int `json:"RestartCount"`
	State        struct {
		Status   string `json:"Status"`
		ExitCode int    `json:"ExitCode"`
		Health   *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	HostConfig struct {
		RestartPolicy struct {
			Name string `json:"Name"`
		} `json:"RestartPolicy"`
	} `json:"HostConfig"`
}

type dockerStats struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs  int    `json:"online_cpus"`
	} `json:"cpu_stats"`
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
}

func matchContainer(name, filter string) bool {
	if filter == "" || filter == "*" {
		return true
	}
	for _, f := range strings.Split(filter, ",") {
		f = strings.TrimSpace(f)
		if ok, _ := path.Match(f, name); ok || f == name {
			return true
		}
	}
	return false
}

// I1: container state/health/restarts, or one container's CPU/memory.
func runDocker(c Cfg, st map[string]any, socket string) Result {
	cl := dockerClient(socket)
	var list []dockerSummary
	if err := dockerGet(cl, "/containers/json?all=1", &list); err != nil {
		return down(err.Error())
	}
	filter := c.Str("container", "*")
	measure := c.Str("measure", "status")
	ignoreStopped := c.Bool("ignoreStopped", false)
	prevRestarts, _ := st["restarts"].(map[string]int)
	restarts := map[string]int{}
	var problems []string
	matched := 0
	type row struct {
		Name     string   `json:"name"`
		State    string   `json:"state"`
		Health   string   `json:"health,omitempty"`
		Restarts int      `json:"restarts"`
		CPU      *float64 `json:"cpuPercent,omitempty"`
		Mem      *float64 `json:"memoryPercent,omitempty"`
	}
	var rows []row
	var worstValue *float64
	newRestarts := 0
	for _, s := range list {
		name := s.name()
		if !matchContainer(name, filter) {
			continue
		}
		matched++
		var ins dockerInspect
		if err := dockerGet(cl, "/containers/"+s.ID+"/json", &ins); err != nil {
			problems = append(problems, name+": "+err.Error())
			continue
		}
		r := row{Name: name, State: ins.State.Status, Restarts: ins.RestartCount}
		if ins.State.Health != nil {
			r.Health = ins.State.Health.Status
		}
		restarts[name] = ins.RestartCount
		if prev, ok := prevRestarts[name]; ok && ins.RestartCount > prev {
			newRestarts += ins.RestartCount - prev
			problems = append(problems, fmt.Sprintf("%s restarted %d time(s)", name, ins.RestartCount-prev))
		}
		switch {
		case ins.State.Status == "running" && r.Health == "unhealthy":
			problems = append(problems, name+" is unhealthy")
		case ins.State.Status == "restarting":
			problems = append(problems, name+" is in a restart loop")
		case ins.State.Status != "running":
			// A stopped container with no restart policy that exited
			// cleanly is usually a one-shot job, not an outage.
			oneShot := ins.HostConfig.RestartPolicy.Name == "no" && ins.State.ExitCode == 0 && filter == "*"
			if !ignoreStopped && !oneShot {
				problems = append(problems, fmt.Sprintf("%s is %s (exit %d)", name, ins.State.Status, ins.State.ExitCode))
			}
		}
		if (measure == "cpu_percent" || measure == "memory_percent") && ins.State.Status == "running" {
			var stats dockerStats
			if err := dockerGet(cl, "/containers/"+s.ID+"/stats?stream=false&one-shot=true", &stats); err == nil {
				key := "cpu:" + name
				prev, ok := st[key].([2]uint64)
				st[key] = [2]uint64{stats.CPUStats.CPUUsage.TotalUsage, stats.CPUStats.SystemUsage}
				if ok && stats.CPUStats.SystemUsage > prev[1] {
					cpus := stats.CPUStats.OnlineCPUs
					if cpus == 0 {
						cpus = 1
					}
					r.CPU = val(float64(stats.CPUStats.CPUUsage.TotalUsage-prev[0]) / float64(stats.CPUStats.SystemUsage-prev[1]) * float64(cpus) * 100)
				}
				if stats.MemoryStats.Limit > 0 {
					used := stats.MemoryStats.Usage - stats.MemoryStats.Stats["inactive_file"]
					r.Mem = val(float64(used) / float64(stats.MemoryStats.Limit) * 100)
				}
				pick := r.CPU
				if measure == "memory_percent" {
					pick = r.Mem
				}
				if pick != nil && (worstValue == nil || *pick > *worstValue) {
					worstValue = pick
				}
			}
		}
		rows = append(rows, r)
	}
	st["restarts"] = restarts
	if matched == 0 {
		return down("no container matches " + filter)
	}
	details := map[string]any{"containers": rows}
	if newRestarts > 0 {
		details["event"] = true
	}
	res := Result{Status: "up", Details: details}
	switch measure {
	case "restart_count":
		res.Value = val(float64(newRestarts))
	case "cpu_percent", "memory_percent":
		res.Value = worstValue
	default:
		res.Value = val(float64(len(problems)))
	}
	if len(problems) > 0 {
		res.Status = severity(c, "down")
		res.Message = strings.Join(problems, "; ")
		return res
	}
	running := 0
	for _, r := range rows {
		if r.State == "running" {
			running++
		}
	}
	res.Message = fmt.Sprintf("%d/%d container(s) running", running, len(rows))
	if worstValue != nil {
		res.Message += fmt.Sprintf(", highest %s %.1f%%", strings.TrimSuffix(measure, "_percent"), *worstValue)
	}
	return res
}
