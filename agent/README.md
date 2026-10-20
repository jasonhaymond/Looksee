# Looksee Agent

A single static binary that reports a machine's metrics and runs the on-machine checks a
Looksee engine assigns to it. No runtime dependency — Go compiles to one self-contained
executable per platform. Version 4.1.0 (versioned in lockstep with the engine and
dashboard; see [CHANGELOG.md](../CHANGELOG.md)). Running it on Windows alongside Smart
App Control, Defender, ASR, WDAC/AppLocker or an EDR, and signing it, are covered in
[windows-agent-security.md](../docs/windows-agent-security.md).

## Contents

1. [The fast path: one command on the target machine](#the-fast-path-one-command-on-the-target-machine)
2. [Configure manually](#configure-manually)
3. [What the agent collects and checks](#what-the-agent-collects-and-checks)
4. [Privileges](#privileges)
5. [Custom scripts](#custom-scripts)
6. [Build](#build)
7. [Run](#run)
8. [Running as a service](#running-as-a-service)
9. [Updating](#updating)
10. [Site collector](#site-collector)

Related: [user guide](../docs/user-guide.md) · [check reference](../docs/check-reference.md) · [Windows agent & security software](../docs/windows-agent-security.md) · [deployment guide](../docs/deployment-guide.md) · [README](../README.md)

## The fast path: one command on the target machine

1. In the Looksee dashboard, add an Endpoint (Monitoring → Endpoints → **+ Add
   endpoint**) in the right Site.
2. On its **Agent** tab click **Generate install command** — it shows two ready-to-run
   commands, one for Linux/macOS and one for Windows (a small toggle switches between
   them):
   ```sh
   curl -fsSL https://your-looksee-domain/install/agent.sh | sudo bash -s -- <key>
   ```
   ```powershell
   $env:LOOKSEE_ENGINE_URL='https://your-looksee-domain'; $env:LOOKSEE_AGENT_KEY='<key>'; iex (irm https://your-looksee-domain/install/agent.ps1)
   ```
   Copy the one for the target machine's OS now — the key is shown exactly once and
   can't be retrieved again afterward (only reset).
3. Run that exact command **on the machine you want to monitor**, elevated (a user who
   can `sudo` on Linux/macOS; an Administrator PowerShell on Windows). It detects the
   machine's OS/arch, downloads the matching pre-built binary from this engine, writes
   its config with the key already filled in, and installs and starts it as a real
   service — systemd on Linux, launchd on macOS, a Scheduled Task on Windows — in one
   shot. On Linux it also grants the read access most checks need (see
   [Privileges](#privileges)); add `--minimal` or `--no-docker` after the key to grant
   less:

   ```sh
   curl -fsSL https://your-looksee-domain/install/agent.sh | sudo bash -s -- <key> --no-docker
   ```

This only works once binaries actually exist on the engine to serve — see "Build" below.
If you'd rather not run a one-liner from the dashboard site, or want to inspect the script
first: it's the exact content served at `/install/agent.sh` (Linux/macOS bootstrap),
`/install/install.sh` + `/install/looksee-agent.service` (Linux), `/install/install-macos.sh`
+ `/install/com.looksee.agent.plist` (macOS), and `/install/agent.ps1` (Windows) on your
engine, or just follow the manual steps below.

## Configure manually

1. Generate an endpoint's agent key in the dashboard (Endpoints → the endpoint → Agent
   tab).
2. Copy `looksee-agent.example.yaml` to `looksee-agent.yaml` next to the binary and fill
   in `engine_url` and `agent_key`. The other settings are optional:

   | Key | Default | Purpose |
   |---|---|---|
   | `interval_seconds` | `30` | How often metrics are collected and reported |
   | `script_dir` | *(empty — scripts disabled)* | Folder whose scripts "Custom script" checks may run (see [Custom scripts](#custom-scripts)) |
   | `ntp_server` | `pool.ntp.org` | Server the clock-offset metric compares against |
   | `docker_socket` | `/var/run/docker.sock` or `\\.\pipe\docker_engine` | Docker Engine API socket for container checks |

3. Add checks for the endpoint in the dashboard. The agent picks them up on its next
   `/api/agent/config` poll — no restart needed — and runs each no more often than its
   own interval. A slow check (a large folder walk, a remote backup repository listing)
   runs in the background; its result goes out with whichever report follows it, so it
   never delays metrics.

## What the agent collects and checks

**Every report** (default 30 s): CPU (total, user/system, iowait and steal on Linux,
per-core), load average, memory/swap and major page faults, uptime and boot time, process
and thread counts and zombies, open file handles, context switches and interrupts,
every real filesystem (including NFS/SMB mounts — a mount whose `statfs` hangs is
reported as **stale** instead of blocking the agent) with free space, inodes and
read-only state, per-disk I/O (throughput, IOPS, latency, % busy), per-interface
throughput/errors/drops/link state/speed, TCP connection states and listening ports.

**In the background**, on their own schedules so they never slow a report:

| Every | What | Linux | Windows | macOS |
|---|---|---|---|---|
| 1 min | Login sessions | utmp | `quser` | utmp |
| 1 min | Temperatures, fans, battery | hwmon, power_supply | WMI | `pmset` |
| 1 min | Failed logins (last 5 min) | sshd in the journal | Security event 4625 | — |
| 10 min | Pending reboot | `/var/run/reboot-required`, `needs-restarting` | registry flags | — |
| 10 min | Firewall | ufw / firewalld / nftables | all firewall profiles | application firewall |
| 10 min | Disk encryption (system volume) | LUKS via `lsblk` | BitLocker | FileVault |
| 10 min | Antivirus | — | Defender status + signature age | — |
| 10 min | Clock sync + offset | `timedatectl` + SNTP | `w32tm` + SNTP | SNTP |
| 10 min | RAID / pools | mdadm, ZFS, storcli | Storage Spaces | — |
| 30 min | Drive health | `smartctl` (smartmontools 7+) | `smartctl`, else Storage reliability counters | `smartctl` |
| 6 h | Pending updates (with security and Ubuntu *phased* flags, and the package list) | apt, dnf/yum, pacman | Windows Update | `softwareupdate` |
| 6 h | Installed software — sent when it changes, and at least daily | dpkg, rpm, apk, pacman, global npm/pip, Node/Python/PHP versions, lock files listed in checks | installed programs (registry Uninstall keys) | applications |
| 6 h | Inventory (model, serial, CPU, RAM, OS) | DMI | WMI | `sysctl` |
| ~5 min | Process inventory (PID, user, CPU, memory, command line) | /proc | process API | process API |
| ~5 min | Service inventory (state, start type) | `systemctl list-units` + `list-unit-files` | `Win32_Service` | `launchctl list` |
| ~5 min | Scripts available to custom script checks | `script_dir` | `script_dir` | `script_dir` |

Process command lines are **masked before they leave the machine**: values after arguments
that look like credentials (`--password=…`, `-token …`, `--api-key …`, `--passphrase …`,
mysql-style `-pSECRET`) and passwords in URLs (`https://user:pass@…`) become `***`.
Inventory is sent every 10th report (about every 5 minutes at the default interval).

**Checks it runs on request**: OS service (with systemd restart count), process (count,
CPU, memory), failed systemd units / stopped automatic Windows services, scheduled task
or systemd timer result, custom scripts, files and folders (exists, age, size, count,
folder size, checksum, folder watchdog), log file patterns (rotation-aware), the systemd
journal, the Windows Event Log, Windows performance counters, Docker containers, Hyper-V
VMs, WireGuard/tunnel interfaces, UPS via NUT or apcupsd, Borg/restic/Veeam backup age —
plus ping/TCP/HTTP/DNS/TLS probes when a check is set to **Run from** this agent.
Exclusions set in Looksee (services, containers, VMs, event IDs, message texts) are
applied on the agent, so excluded items never count.

**Watchdog (5.0+).** When an endpoint's **Watchdog** tab is turned on, the agent also
alerts by email and/or a chat channel *on its own* when it can't reach Looksee for the
chosen number of minutes, and again when it's back. The settings it needs to do that
(SMTP server and password, channel URLs) are stored in the agent's state directory with
permissions `0600` — readable only by the agent's own account — and deleted when the
watchdog is turned off.

Agents older than 3.0.0 keep working: they still report CPU/memory/disk and run service
and process checks. Checks that need 3.0 show "Needs agent 3.0.0+" until the endpoint
is updated (Endpoints → the endpoint → Agent → Update agent). The software checks, the
watchdog and *Should be: Stopped* service checks need agent 5.0.

## Privileges

On **Windows** the agent runs as SYSTEM and on **macOS** as root, so everything above
works out of the box.

On **Linux** the agent never runs as root: it runs as its own unprivileged
`looksee-agent` user under a hardened systemd unit (`ProtectSystem=strict`,
`ProtectHome=yes`, `NoNewPrivileges=yes`). Some checks need read access that user
doesn't have on its own. **By default (5.0+) the installer grants it:**

| Feature | What it needs | Granted by default by | Left out with |
|---|---|---|---|
| journal checks, failed-login count | read the journal | `systemd-journal` group | `--minimal` |
| log files under `/var/log` | read them | `adm` group (Debian/Ubuntu) | `--minimal` |
| SMART drive health | raw disk access | the drop-in below (`disk` group, `CAP_SYS_RAWIO`, `CAP_SYS_ADMIN`) | `--minimal` |
| files, folders and lock files under `/home` | see `/home`, read-only | the drop-in below (`ProtectHome=read-only`) | `--minimal` |
| Docker containers | the Docker socket | `docker` group, **only if Docker is installed** | `--no-docker` or `--minimal` |
| backups (Borg/restic) | read the repository + its key | *not granted* — run with the same user/permissions as the backup, or grant read access to the repo | — |

**Know what you're granting.** Membership of the `docker` group is effectively root
access on that machine (anyone who can talk to the Docker socket can start a container
that mounts the whole disk). It's on by default because container checks are among the
most used; if this agent's machine is sensitive and you don't need container checks,
install with `--no-docker`. `CAP_SYS_ADMIN` (for NVMe SMART) is a broad capability; the
agent only uses it through `smartctl`. `--minimal` grants none of the above — most
checks still work, and those that can't report "permission denied — see agent README →
Privileges" rather than failing silently.

To change your mind later, re-run the installer with different options (re-running with
`--minimal` removes the drop-in), or remove a group by hand:

```sh
sudo gpasswd -d looksee-agent docker      # or adm / systemd-journal
sudo systemctl restart looksee-agent
```

Agents installed before 5.0 keep their old, narrower access when they update
themselves. `agent/looksee-agent-privileged.conf` is the drop-in the installer uses;
to grant the 5.0 defaults to an existing agent by hand:

```sh
sudo usermod -aG adm,systemd-journal looksee-agent
getent group docker >/dev/null && sudo usermod -aG docker looksee-agent   # optional — see above
```

The engine serves the drop-in, so on the monitored machine:

```sh
sudo mkdir -p /etc/systemd/system/looksee-agent.service.d
curl -fsSL https://your-looksee-domain/install/looksee-agent-privileged.conf   | sudo tee /etc/systemd/system/looksee-agent.service.d/privileged.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl restart looksee-agent
```

Group changes take effect after `sudo systemctl restart looksee-agent`. **Check:**
`id looksee-agent` lists the groups, and
`systemctl show looksee-agent -p SupplementaryGroups -p AmbientCapabilities -p ProtectHome`
shows `disk`, `cap_sys_rawio cap_sys_admin` and `read-only` when the drop-in is active.

## Custom scripts

"Custom script" checks run a script on the endpoint and read its result the Nagios way: exit
`0` = up, `1` = warn, `2` = down, anything else = unknown; the first output line is the
message; `| label=value` performance data (or the first number in the message) becomes
the value, so thresholds and graphs work.

For safety the engine can only choose **which approved script** runs, never its
contents:

1. Pick a folder only an administrator can write to, e.g.
   `sudo install -d -m 755 -o root -g root /etc/looksee-agent/scripts`.
2. Put your scripts there and make them executable
   (`sudo install -m 755 check_queue.sh /etc/looksee-agent/scripts/`).
   On Windows, `.ps1` scripts run through PowerShell.
3. Add `script_dir: /etc/looksee-agent/scripts` to `looksee-agent.yaml` and restart the
   agent.
4. In the dashboard, add a **Custom script** check: **Browse** lists the scripts the
   agent found in `script_dir` (agent 4.0+), or type the file name (`check_queue.sh`).
   Add any arguments.

**Checking output instead of exit codes (agent 4.0+).** Set *Expected output* on the
check — contains, doesn't contain, equals, or a regex — and optionally an *expected exit
code*. The agent sends the script's output (first 4 KB) and exit code; the engine judges
it, and a mismatch is down (or warn). To check an existing command's output, put a
one-line wrapper in `script_dir`, e.g. `/etc/looksee-agent/scripts/zpool-health.sh`:

```bash
#!/bin/sh
exec zpool status -x
```

then expect it to *contain* `all pools are healthy`. On Windows, a `.ps1` wrapper
(e.g. `Get-Service Spooler | Select-Object -ExpandProperty Status`) works the same way.
Scripts run as the agent's user (`looksee-agent` on Linux, `SYSTEM` on Windows).

Without `script_dir` set, script checks are refused on that endpoint. Names containing a
path (`../`) are always refused.

## Build

Requires Go 1.26+. From this directory, for every supported platform in one command:

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

**Signing.** `build-all.sh` finishes by running `sign-windows.sh`, which
Authenticode-signs the Windows binaries when `signing.env` is configured (Azure Artifact
Signing, an HSM/cloud key via jsign, or a `.pfx`) and does nothing otherwise. Setup and
certificate options: [windows-agent-security.md → Signing the agent](../docs/windows-agent-security.md#signing-the-agent).

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
`/var/lib/looksee-agent/looksee-agent` (owned by that user so "Update agent" can replace
it — the hardened unit leaves the rest of the system read-only to the agent) with a
`/usr/local/bin/looksee-agent` symlink, the config to
`/etc/looksee-agent/looksee-agent.yaml` (mode 600, since it holds a real credential),
and a `systemd` unit (`looksee-agent.service`) with `Restart=always`. Idempotent — re-run
it any time (new binary, new key): it always restarts the agent so the new binary and
config take effect.

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

**Push from the dashboard** (recommended): the Endpoints page shows each endpoint's
running agent version next to the engine's current buildable version, and an "Update
agent" button once it has reported at least once (or tick several and use **Actions →
Update agents**). Clicking it flags that endpoint; the agent
downloads the current build for its own platform and swaps itself in on its next
check-in (usually within its polling interval), then restarts itself — no re-running
the install script, no touching the machine by hand. Verified for real: an old build
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

## Site collector

When an endpoint is chosen as a site's **site collector** (Sites & locations page — see
the user guide's *Multiple sites*), the engine says so in the agent's config response and the
agent (3.2.0+):

1. downloads `manifest.json`, then a Node.js runtime for its platform and the collector
   bundle from `<engine>/install/collector/…`, checking each file's SHA-256 against the
   manifest — a mismatch is refused and reported;
2. keeps them in a `collector` folder next to its own binary
   (`/var/lib/looksee-agent/collector` on Linux, so the hardened unit can write it);
3. runs `node --use-system-ca collector.cjs` as a child process with the engine URL and
   this endpoint's agent key, logging its output with a `[collector]` prefix;
4. restarts it if it exits (5 s, backing off to 60 s), replaces it when the engine
   publishes a new bundle or Node version, and stops it when the endpoint is no longer a
   collector. Closing the collector's stdin is the stop signal on every OS, so it can't
   outlive the agent and hold the receiver ports.

The collector runs with the agent's privileges: SYSTEM on Windows, root on macOS, the
unprivileged `looksee-agent` user on Linux — where binding ports below 1024 or running
DHCP checks needs the drop-in shown in the user guide.

