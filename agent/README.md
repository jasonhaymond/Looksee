# Looksee Agent

A single static binary that reports host metrics (CPU/RAM/disk) and named-service status
to a Looksee engine on an interval. No runtime dependency — Go compiles to one
self-contained executable per platform.

## Configure

1. In the Looksee dashboard, create a Host under the right Site.
2. Click "Generate agent key" on that host — the key is shown exactly once and can't be
   retrieved again afterward (only reset), so copy it now.
3. Copy `looksee-agent.example.yaml` to `looksee-agent.yaml` next to the binary and fill
   in `engine_url` and `agent_key`.
4. To monitor a named process/service, add an "agent_service" check on that host in the
   dashboard with `config: { "serviceName": "nginx" }` (matched by substring, so
   `nginx` matches both `nginx` on Linux and `nginx.exe` on Windows) — the agent picks
   it up automatically on its next `/api/agent/config` poll, no agent restart needed.

## Build

Requires Go 1.22+. From this directory:

```sh
go build -o bin/looksee-agent .
```

Cross-compile for another platform by setting `GOOS`/`GOARCH` (no separate toolchain
needed):

```sh
GOOS=linux   GOARCH=amd64 go build -o bin/looksee-agent-linux-amd64   .
GOOS=windows GOARCH=amd64 go build -o bin/looksee-agent-windows-amd64.exe .
GOOS=darwin  GOARCH=arm64 go build -o bin/looksee-agent-darwin-arm64 .
```

Don't have Go installed locally? Build inside a container instead:

```sh
docker run --rm -v "$(pwd):/agent" -w /agent golang:1.22 go build -o bin/looksee-agent .
```

## Run

```sh
./looksee-agent -config looksee-agent.yaml
```

Flags:
- `-config` — path to the YAML config (default `looksee-agent.yaml`, same directory).
- `-disk-path` — filesystem path to report disk usage for (default `/` on Linux/macOS,
  `C:\` on Windows).

## Running as a service

### Linux (systemd) — scripted, and actually tested

```sh
sudo ./install.sh /path/to/looksee-agent-linux-amd64 /path/to/looksee-agent.yaml
```

Creates a dedicated unprivileged `looksee-agent` system user, installs the binary to
`/usr/local/bin/looksee-agent`, the config to `/etc/looksee-agent/looksee-agent.yaml`
(mode 600, since it holds a real credential), and a `systemd` unit
(`looksee-agent.service`) with `Restart=on-failure`. Idempotent — re-run after rebuilding
the binary to update and restart it.

This was verified end-to-end in a real systemd container during development, not just
written and assumed to work: installed, confirmed `active (running)` and `enabled`,
confirmed the process actually runs as the unprivileged `looksee-agent` user (not root),
killed it with `systemctl kill -s SIGKILL` and confirmed systemd auto-restarted it
(`NRestarts=1`), then uninstalled both without and with `--purge`.

```sh
systemctl status looksee-agent      # confirm it's active
journalctl -u looksee-agent -f      # tail logs
sudo ./uninstall.sh                 # stops the service, leaves the binary/config in place
sudo ./uninstall.sh --purge         # also removes the binary, config, and system user
```

### Windows

No install script yet — register it with either:

- **NSSM** (simplest): `nssm install LookseeAgent "C:\looksee\looksee-agent.exe" "-config C:\looksee\looksee-agent.yaml"`, then `nssm start LookseeAgent`.
- **Task Scheduler**: create a task that runs at startup as SYSTEM (or a dedicated
  service account), action = the binary with `-config <path>`, with "Restart on failure"
  configured under Settings.

### macOS (launchd)

No install script yet — create `~/Library/LaunchAgents/com.looksee.agent.plist` (or
`/Library/LaunchDaemons/` for a system-wide install) with `ProgramArguments` pointing at
the binary + `-config <path>`, `KeepAlive` set to `true` for auto-restart, then
`launchctl load` it.

**Honestly**: the Windows and macOS paths above are standard, well-documented mechanisms
but haven't been run on an actual Windows/macOS host during this project — only the Linux
systemd path has been. A scripted installer for either is a reasonable follow-up once
someone actually deploys the agent to one.
