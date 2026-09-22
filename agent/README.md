# Looksee Agent

A single static binary that reports host metrics (CPU/RAM/disk) and named-service status
to a Looksee engine on an interval. No runtime dependency — Go compiles to one
self-contained executable per platform.

## The fast path: one command on the target host

1. In the Looksee dashboard, create a Host under the right Site.
2. Click "Generate agent key" — it shows two ready-to-run commands, one for Linux/macOS
   and one for Windows (a small toggle switches between them):
   ```sh
   curl -fsSL https://your-looksee-domain/install/agent.sh | sudo bash -s -- <key>
   ```
   ```powershell
   $env:LOOKSEE_ENGINE_URL='https://your-looksee-domain'; $env:LOOKSEE_AGENT_KEY='<key>'; iex (irm https://your-looksee-domain/install/agent.ps1)
   ```
   Copy the one for the target host's OS now — the key is shown exactly once and can't
   be retrieved again afterward (only reset).
3. Run that exact command **on the host you want to monitor**, elevated (a user who can
   `sudo` on Linux/macOS; an Administrator PowerShell on Windows). It detects the host's
   OS/arch, downloads the matching pre-built binary from this engine, writes its config
   with the key already filled in, and installs and starts it as a real service —
   systemd on Linux, launchd on macOS, a Scheduled Task on Windows — in one shot.

This only works once binaries actually exist on the engine to serve — see "Build" below.
If you'd rather not run a one-liner from the dashboard site, or want to inspect the script
first: it's the exact content served at `/install/agent.sh` (Linux/macOS bootstrap),
`/install/install.sh` + `/install/looksee-agent.service` (Linux), `/install/install-macos.sh`
+ `/install/com.looksee.agent.plist` (macOS), and `/install/agent.ps1` (Windows) on your
engine, or just follow the manual steps below.

## Configure manually

1. Generate a host's agent key in the dashboard as above.
2. Copy `looksee-agent.example.yaml` to `looksee-agent.yaml` next to the binary and fill
   in `engine_url` and `agent_key`.
3. To monitor a service or process, add a check on that host in the dashboard — the
   agent picks it up automatically on its next `/api/agent/config` poll, no agent
   restart needed. Two types, both taking `config: { "serviceName": "nginx" }`:
   - **"Service (via agent)"** (`agent_service`) queries the real OS service manager —
     `systemctl is-active` on Linux, the Windows service manager via PowerShell on
     Windows. Not yet implemented on macOS (returns a clear error, not a silent no-op).
   - **"Process (via agent)"** (`agent_process`) matches by substring against the
     running process list instead — `nginx` matches both `nginx` on Linux and
     `nginx.exe` on Windows — for anything that isn't a registered OS service.

   Either type's config field also accepts real names the agent has actually
   discovered on that host — every report cycle includes every running process name
   and every registered service name, which the check form offers as suggestions once
   a host is selected (`hosts.availableProcesses`/`availableServices`).

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

### Windows (Scheduled Task) — scripted, and actually tested

The one-liner at the top of this file does this automatically, using only built-in
`Register-ScheduledTask` cmdlets — no NSSM or other third-party service wrapper. To run
it by hand instead (needs `$env:LOOKSEE_ENGINE_URL`/`$env:LOOKSEE_AGENT_KEY` set first,
since PowerShell's `-Command`/`iex` don't bind trailing arguments the way `-File` does):

```powershell
$env:LOOKSEE_ENGINE_URL = "https://your-looksee-domain"
$env:LOOKSEE_AGENT_KEY = "<key>"
.\install-windows.ps1   # run elevated
```

Downloads the binary to `C:\ProgramData\LookseeAgent\looksee-agent.exe`, writes the
config next to it, and registers a Scheduled Task ("LookseeAgent") — startup trigger,
runs as `SYSTEM`, restart-on-failure. Idempotent — re-run to update (unregisters and
re-registers the task).

Verified for real on a real Windows host during development: the exact served
`/install/agent.ps1` content run via the real `$env:...; iex (irm ...)` one-liner
against a real running engine (correctly downloaded the actual binary and stopped
cleanly at the admin-elevation check when run unelevated, exactly as designed); the
Scheduled Task registration itself needs elevation this dev sandbox didn't have, so that
specific step is verified by cmdlet correctness + a clean script parse rather than an
actual elevated run — worth a first real elevated run before trusting it in production.

```powershell
Get-ScheduledTask -TaskName LookseeAgent          # confirm it's registered/running
.\uninstall-windows.ps1                            # stops the task, leaves binary/config
.\uninstall-windows.ps1 -Purge                     # also removes C:\ProgramData\LookseeAgent
```

### macOS (launchd) — scripted, not yet run on a real Mac

```sh
sudo ./install-macos.sh /path/to/looksee-agent-darwin-amd64 /path/to/looksee-agent.yaml
```

Installs the binary to `/usr/local/bin/looksee-agent`, config to
`/usr/local/etc/looksee-agent/looksee-agent.yaml` (mode 600), and a system-wide launchd
daemon (`/Library/LaunchDaemons/com.looksee.agent.plist`, `KeepAlive=true`). Idempotent —
re-run after rebuilding to update and reload it.

**Honestly**: unlike Linux and Windows above, this hasn't been run on an actual Mac
during this project — no macOS host was available. The launchd mechanism and plist shape
are standard and well-documented, but treat this the way any project should treat an
unverified path: worth a first real run before trusting it.

```sh
launchctl list | grep com.looksee.agent    # confirm it's loaded
sudo ./uninstall-macos.sh                  # stops the daemon, leaves binary/config
sudo ./uninstall-macos.sh --purge          # also removes the binary and config
```

## Updating

**Push from the dashboard** (recommended): the Hosts page shows each host's running
agent version next to the engine's current buildable version, and an "Update agent"
button once a host has reported at least once. Clicking it flags that host; the agent
downloads the current build for its own platform and swaps itself in on its next
check-in (usually within its polling interval), then restarts itself — no re-running
the install script, no touching the host by hand. Verified for real: an old build
running in a real container, flagged for update via the real API, autonomously
downloaded the new binary, swapped it in, relaunched, and reported the new version back
— all without any manual step on the host itself. On Windows specifically, the
file-swap-while-running behavior (rename the running exe aside, move the new one into
its place) was verified against a real running exe on a real Windows host before relying
on it, not assumed.

This only updates the binary — config (the agent key, engine URL, interval) is
untouched. There's no way to downgrade from the dashboard; re-run the install one-liner
with an older binary if you ever need to.

**Manually**: re-run the platform's install script (`install.sh`/`install-macos.sh`/
`install-windows.ps1`) with a newer binary — all three are idempotent and overwrite the
running installation.
