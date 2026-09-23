# User Guide

Day-to-day usage of Looksee once it's running — adding things to monitor, building
dashboards, and getting notified when something breaks. For getting a server running in
the first place, see [deployment-guide.md](deployment-guide.md); for local development,
see the [README](../README.md).

## Endpoints, hosts, and checks

Everything in Looksee starts with an **endpoint** — a logical group, usually a physical
location or network (e.g. "Home", "Office", "Client A"). Endpoints live on the **Manage**
page, where you also add and edit checks.

A **host** is a specific machine you've installed the Looksee agent on (see Hosts
below) — some check types need one, most don't.

### Check types

Agentless checks — the engine probes these directly, no agent required:

- **Ping** — ICMP ping to a host/IP.
- **TCP port** — opens a connection to host:port.
- **HTTP(S)** — requests a URL; can check status code, method, custom headers, response
  body content, and skip TLS verification for self-signed certs.
- **DNS resolution** — resolves a hostname.
- **SSL certificate expiry** — warns before a certificate expires.
- **SNMP/OID** — reads a single OID from an SNMP-speaking device (a UPS, switch,
  printer) and optionally alerts on its value. Supports v1, v2c, and v3 (auth/priv). The
  config form includes a preset dropdown for common UPS-MIB OIDs (battery charge,
  status, load, minutes remaining) so you don't need to know raw OIDs to get started —
  the free-text OID field still works for anything else. Four independent thresholds
  (warn/critical, above/below) cover both "alert when this drops" (battery %) and
  "alert when this rises" (temperature, load) cases.

Agent-driven checks — need the Looksee agent installed on the target host (see Hosts):

- **Service (via agent)** — checks a real OS service (systemd unit on Linux, a Windows
  service) is active.
- **Process (via agent)** — checks a process matching a name (substring match) is
  running.
- **CPU / Memory / Disk usage (via agent)** — alerts on resource usage the agent already
  reports every cycle. Leave both thresholds blank to just track history with no
  alerting.

Disabled checks are hidden everywhere except the Manage page, where you can re-enable
them.

## Hosts

The Hosts page lists every host with the agent installed, its last-seen time, and
reported agent version. Click a host to get a copy-pasteable install command for Linux,
macOS, or Windows — each bakes in a per-host API key and installs the agent as a real
background service (systemd/launchd/a Scheduled Task), so it starts on boot and survives
a restart.

Once a host has reported at least once, its discovered services and processes appear as
suggestions when adding a Service or Process check for it — no need to know the exact
systemd unit name in advance.

**Updating an agent**: click "Update agent" on a host to flag it for a self-update on
its next check-in — no need to re-run the install command. The host's reported agent
version updates once it's done.

## Dashboards and widgets

The home page holds one or more **dashboards**, each a grid of widgets you can
rearrange (desktop only — click "Edit layout" to drag/resize) and duplicate. Each
dashboard has its own auto-refresh interval.

Widget types:

- **Status tile** — one check's current status, with an inline sparkline of recent
  history.
- **Group summary** — a whole endpoint's checks at a glance.
- **Uptime history** — a bigger view of one check's uptime % and latency sparkline, with
  its own time-range control (1 hour to 30 days).
- **Host metrics** — a host's CPU/RAM/disk sparklines, with its own time-range control.
- **Network bandwidth** — a host's RX/TX sparklines.
- **All hosts grid** — every host's online/offline status (based on last-seen recency)
  and last-seen time in one compact list.
- **Alert history** — recent alerts, filterable to one endpoint or all, with its own
  time-range control.
- **Backup status** — the most recent backup run's status and time.
- **Clock / date** — a plain current time/date tile.
- **Note** — free text, click to edit in layout-edit mode.
- **Section header** — a full-width labeled divider for grouping other widgets
  visually within one dashboard (e.g. "Network", "Backups") — not itself a data tile,
  and not collapsible; just a way to organize a busy dashboard without splitting it
  into several. Click to name it, the same way a note is edited.

Any widget with a time-range control remembers its own chosen range — two uptime-history
widgets on the same dashboard can show different windows independently.

## Channels and notifications (alerts)

**Channels** (the Channels page) are where alerts get sent — currently email, via SMTP.
Configure your SMTP server there and use "Send test email" to confirm it actually
works before relying on it.

**Alert rules**, configured per-check from the Manage page, decide when a channel gets
notified — e.g. after 2 consecutive failures. Alert history for a rule shows up in the
alert-history widget and the check's own history.

## Backups

The Backups page configures and runs encrypted, deduplicated backups (via Borg) of the
database and secrets. "Back up now" runs one on demand; a schedule can run them
automatically. Restoring is also done from this page — read the confirmation prompt
carefully, since it discards data created after the backup being restored.

## Logs

The Logs page shows the engine's own activity — what it's doing, what failed, and why —
filterable by level (debug through error). Every entry above debug includes a
human-readable translation, not just a raw internal message.
