# Looksee Agent

A single static binary that reports host metrics (CPU/RAM/disk) and named-service status
to a Looksee engine on an interval. No runtime dependency — Go compiles to one
self-contained executable per platform.

## The fast path: one command on the target host

1. In the Looksee dashboard, create a Host under the right Site.
2. Click "Generate agent key" — it shows a ready-to-run command like:
   ```sh
   curl -fsSL https://your-looksee-domain/install/agent.sh | sudo bash -s -- <key>
   ```
   Copy it now — the key is shown exactly once and can't be retrieved again afterward
   (only reset).
3. Run that exact command **on the host you want to monitor** (as a user who can
   `sudo`). It detects the host's OS/arch, downloads the matching pre-built binary from
   this engine, writes its config with the key already filled in, and — on Linux —
   installs and starts it as a systemd service in one shot. Windows/macOS download the
   binary + config but don't auto-install as a service yet (see below).

This only works once binaries actually exist on the engine to serve — see "Build" below.
If you'd rather not run a one-liner from the dashboard site, or want to inspect the script
first: it's the exact content served at `/install/agent.sh`, `/install/install.sh`, and
`/install/looksee-agent.service` on your engine, or just follow the manual steps below.

## Configure manually

1. Generate a host's agent key in the dashboard as above.
2. Copy `looksee-agent.example.yaml` to `looksee-agent.yaml` next to the binary and fill
   in `engine_url` and `agent_key`.
3. To monitor a named process/service, add an "agent_service" check on that host in the
   dashboard with `config: { "serviceName": "nginx" }` (matched by substring, so
   `nginx` matches both `nginx` on Linux and `nginx.exe` on Windows) — the agent picks
   it up automatically on its next `/api/agent/config` poll, no agent restart needed.

## Build

Requires Go 1.22+. From this directory, for every supported platform in one command:

```sh
./build-all.sh
```

Outputs to `bin/looksee-agent-<os>-<arch>[.exe]` — the exact filenames the engine's
`/install/agent/:platform` route serves (`linux-amd64`, `linux-arm64`, `windows-amd64`,
`darwin-amd64`, `darwin-arm64`). Run this on the engine's own server after cloning/
updating so the one-liner install command above has something to actually download —
otherwise it 404s with a reminder to do exactly this.

No local Go install? `build-all.sh` detects that automatically and builds inside the
`golang` Docker image instead — no flag needed.

For a single platform without the full matrix:

```sh
go build -o bin/looksee-agent .                                    # this platform
GOOS=linux GOARCH=amd64 go build -o bin/looksee-agent-linux-amd64 . # cross-compile
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

The one-liner at the top of this file does this automatically. To run it by hand instead
(e.g. the binary/config are already on the host some other way):

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
(`NRestarts=1`), then uninstalled both without and with `--purge`. The one-liner
(`curl ... | sudo bash -s -- <key>`) was separately verified the same way in a fresh
container — a real agent key generated via the dashboard's API, the exact command run
verbatim, and the resulting host's `lastSeenAt` confirmed updating on the engine
afterward, proving the whole chain rather than just its individual pieces.

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
