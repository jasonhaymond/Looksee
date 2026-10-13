# User Guide

Day-to-day usage of Looksee once it's running — adding things to monitor, managing many
of them at once, building dashboards, and getting notified when something breaks. The
same guide is built into the app: click **Help** in the top bar, or **Learn more** at
the top of any page.

Related guides: [check-reference.md](check-reference.md) (what every check type does and
how to check the same thing by hand), [security-guide.md](security-guide.md) (sign-in,
two-factor, IP restriction, attack alerts), [windows-agent-security.md](windows-agent-security.md)
(running the agent alongside Smart App Control, Defender and other Windows security),
[deployment-guide.md](deployment-guide.md) (getting a server running),
[migration-guide.md](migration-guide.md) (moving one), [agent/README.md](../agent/README.md)
(the agent itself), and the [README](../README.md) (local development).

## Contents

1. [How Looksee is organized](#how-looksee-is-organized)
2. [Getting around](#getting-around)
3. [Checks](#checks)
   - [Adding a check](#adding-a-check)
   - [Adding the same check to many hosts or endpoints](#adding-the-same-check-to-many-hosts-or-endpoints)
   - [Picking from what the agent found](#picking-from-what-the-agent-found)
   - [Thresholds: warn and critical](#thresholds-warn-and-critical)
   - [Finding and filtering checks](#finding-and-filtering-checks)
   - [Working with many checks at once](#working-with-many-checks-at-once)
   - [Duplicating checks](#duplicating-checks)
   - [A check's page: history, charts and incidents](#a-checks-page-history-charts-and-incidents)
   - [When a check fails: things to check](#when-a-check-fails-things-to-check)
   - [Custom scripts with expected output](#custom-scripts-with-expected-output)
   - [SNMP: walks, counters and the walk browser](#snmp-walks-counters-and-the-walk-browser)
   - [Printers](#printers)
   - [Check type reference](#check-type-reference)
4. [Hosts](#hosts)
   - [Processes and services](#processes-and-services)
   - [MAC addresses and IP changes](#mac-addresses-and-ip-changes)
   - [Suggested checks](#suggested-checks)
5. [Locations and endpoints](#endpoints)
6. [Multiple sites](#multiple-sites)
7. [Discovery](#discovery)
8. [Heartbeats and pushed values](#heartbeats-and-pushed-values)
9. [Channels and message templates](#channels)
10. [Alerts, escalation, and dependencies](#alerts-escalation-and-dependencies)
11. [Alert history](#alert-history)
12. [Maintenance](#maintenance)
13. [SLA reports](#sla-reports)
14. [Traps and syslog](#traps-and-syslog)
15. [Top talkers](#top-talkers)
16. [Status pages](#status-pages)
17. [Dashboards and widgets](#dashboards-and-widgets)
18. [Security](#security)
19. [Light and dark theme](#light-and-dark-theme)
20. [Backups and logs](#backups-and-logs)

## How Looksee is organized

- A **location** is a physical place — "Home", "Main office", "Church". It's optional:
  it groups endpoints so you can filter, summarize and silence a whole place at once.
- An **endpoint** is a network at a location ("Home LAN", "Office VLAN 20", "Client A").
- A **host** is a machine running the Looksee agent. Hosts belong to an endpoint (and so
  to its location).
- A **check** is one thing being monitored. Every check belongs to an endpoint, and
  optionally to a host. A check is run by one of three things:
  - the **engine** itself (ping, HTTP, DNS, SNMP, databases, Proxmox, …) — no agent
    needed;
  - the **agent** on a host (services, files, logs, Docker, backups, scripts, …);
  - **report evaluation** — the engine judges the metrics every agent report already
    carries (CPU, disks, SMART, updates, …).
- Every result is **up**, **warn**, **down**, or **unknown**. A check in a maintenance
  window shows **maintenance**; a turned-off check shows **disabled**. Status is always
  written out as well as colored.

## Getting around

The top bar groups the pages:

| Menu | Pages |
|---|---|
| Dashboards | Your widget dashboards (the home page) |
| Monitoring | Checks, Hosts, Endpoints & locations, Discovery |
| Alerting | Alert history, Channels, Maintenance |
| Insights | SLA reports, Traps & syslog, Top talkers, Status pages |
| System | Security, Backups, Logs |
| Help | This guide, the check reference, and the security guides |

On a phone the same groups are behind the **Menu** button. The theme button (◐ ☀ ☾)
switches between system, light and dark. Each page starts with a one-line explanation
and a **Learn more** link to the matching section of this guide.

## Checks

### Adding a check

1. Open **Monitoring → Checks** and click **+ Add check**.
2. Pick what you want to monitor. Type in the search box (`disk`, `ssl`, `backup`,
   `printer`, …) or browse the categories. Each card says what the check does; once
   picked, **How this check works** opens its entry in the
   [check reference](check-reference.md).
3. Fill in **Basics & where**:
   - **Name** — how it appears everywhere.
   - **Hosts** — for agent checks, the machine(s) whose agent runs it. For everything
     else this is optional; picking hosts creates one check per host.
   - **Endpoints** — when no host is picked, the endpoint(s) the check belongs to (one
     check each).
   - **Run from** (ping, TCP, HTTP, DNS, TLS only) — the engine, or a host's agent.
     Choose an agent to test something only reachable from inside that host's network.
   - **Check every** — the interval in seconds.
4. Fill in **Settings**. Required fields are marked `*`; hover the `?` icons for help.
   Fields that name something on a host (service, process, container, script, mount,
   interface) have a **Browse** button — see
   [Picking from what the agent found](#picking-from-what-the-agent-found).
5. Optionally set **Thresholds** (below) and open **Advanced** for the retry interval,
   tags, dependencies, and less common options.
6. Under **Alerts**, tick the channels to notify and set the same options an alert rule
   has (failures in a row, warn or down, reminders, escalation). Leave everything
   unticked for no alerts.
7. Click **Create check**. The new check opens in the list; its first result appears
   within one interval (or click **Run now**).

**What success looks like:** the check shows **UP** (or a deliberate WARN/DOWN) with a
"Last result" message, and "Checked" counts up from a few seconds ago.

### Adding the same check to many hosts or endpoints

In the add form, tick several **Hosts** (or, for checks that don't need a host, several
**Endpoints**). One check is created for each, with the same settings and alert rule.

- Use `{{host}}`, `{{address}}` (the host's hostname/IP, or its name) and `{{endpoint}}`
  in the **Name** or any text setting; they're filled in per target. For example, a
  Ping check named `Ping {{host}}` with Host `{{address}}` pings each host at its own
  address.
- For engine checks with an address field, **Target each host's own address** fills
  those fields with `{{address}}` for you.
- If a name has no placeholder, the target's name is appended so the checks stay
  distinguishable.
- Targets that don't fit (e.g. a host-only check type with no host) are skipped and
  listed; the rest are still created.

### Picking from what the agent found

Settings that name something on a host — a service, process, Docker container, script,
mount, network interface, drive or sensor — show what that host's agent last reported:

1. Pick the host first (the first picked host's inventory is used when several are).
2. Click **Browse (N)** next to the field. Services show whether they're running and
   how they start; processes show how many are running, their memory and their user.
3. Search or filter, then tick one item — or, while creating, **several** to make one
   check per item (e.g. tick five services → five service checks, each named
   `<name> — <service>`). Click **Done**.

You can always type a name instead. The list refreshes every few minutes from the agent.

### Thresholds: warn and critical

Most checks produce a **value** (latency, % used, days left, queue depth, …). Under
**Thresholds** you can set any of:

- **Warn above / Critical above** — for things that are bad when high (temperature, CPU).
- **Warn below / Critical below** — for things that are bad when low (free space, battery,
  days until expiry).

Leave a box empty to ignore that direction. Checks with a response time also accept
**Warn if slower than / Critical if slower than** (ms). Thresholds only ever make a
result worse — a check that already failed stays down.

### Finding and filtering checks

On the Checks page:

- The **status chips** (All, Problems, Down, Warn, …) show counts and filter with one
  click. **Problems** = down or warn.
- The **search box** matches names, types, hosts, endpoints, last messages, tags and
  configuration (so searching an IP finds every check pointing at it).
- The dropdowns filter by **location**, **endpoint**, **host**, **kind** (category) and
  **tag**.
- **Group by** sorts the list into sections by location, endpoint, host, kind, status,
  or nothing. Click a section header to collapse it. Your choice is remembered in this
  browser.
- Within each section, failing checks sort to the top.

### Working with many checks at once

1. Tick the checkbox on each check you want — or the checkbox on a **section header**
   to take the whole group, or **Select all N shown** to take everything the current
   filters show.
2. A bar appears at the bottom of the screen. Click **Actions ▴** to open the menu:

| Group | Action | What it does |
|---|---|---|
| State | Enable / Disable | Turn checks on or off |
| State | Run now | Run engine checks immediately (agent checks update on the agent's next report) |
| State | Maintenance… | Start a maintenance window for N minutes on just these checks |
| Alerts | Add alert rule… | Add the same rule (channels, failures in a row, reminders, escalation) to each |
| Alerts | Remove alert rules | Remove every rule from them |
| Alerts | Depends on… | Set which checks they depend on (empty clears) |
| Organize | Add tags… / Remove tags… | Comma-separated tags |
| Organize | Move to endpoint… / Set host… | Re-home the checks |
| Organize | Duplicate… | Copy them — see [Duplicating checks](#duplicating-checks) |
| Schedule | Run from… | Run ping/TCP/HTTP/DNS/TLS checks from the engine or a chosen agent |
| Schedule | Interval… / Retry interval… | Change how often they run (retry: how often while failing; 0 clears) |
| — | Delete… | Delete — you must type `delete` to confirm |

3. A message confirms how many changed. If any were skipped (for example, a type that
   can't run on an agent), the message names the first one and why.

Combine this with filters: e.g. filter by tag `wan`, **Select all**, then **Add alert
rule…** to alert on every WAN check at once.

### Duplicating checks

Select checks, then **Actions → Duplicate…** and choose where the copies go:

- **Same place** — a copy next to each original, named `… (copy)`.
- **To other endpoints** — one copy per picked endpoint. A check tied to a host keeps
  it only if that host is in the destination; agent checks that need a host are
  skipped there (copy them to hosts instead).
- **To other hosts** — one copy per picked host, placed in that host's endpoint. Ideal
  for "monitor this service on these five servers too".

Copies stay **enabled** and keep each original's **alert rules** (with their channels)
and **dependencies**, so they start monitoring and alerting straight away.

### A check's page: history, charts and incidents

Click a check row to open its quick panel (Overview / Edit / Alerts). For everything
about it, click **Full history, charts & incidents →** (or the check's name anywhere it's
a link) to open its own page at `/checks/<id>` — bookmarkable and shareable:

- **Range** — 1 hour, 24 hours, 7, 30 or 90 days; everything below follows it.
- **Numbers** — uptime % (warn counts as up; maintenance is left out), down/warn result
  counts, state changes, incidents (and how many are open), response time (average,
  95th percentile, maximum) and value (average, min, max).
- **Status strip** — one cell per time slice, colored by the worst status in it; hover
  for the time and status.
- **Response time** and **value** charts — hover anywhere for the exact reading. The
  value chart shades the min–max range within each slice.
- **History & incidents** — every alert incident in the range with how long it lasted,
  the latest structured details (interface tables, walk results, matched lines), and
  every result (tick **Only problems** to hide the ups).
- **Settings** and **Alert rules** tabs — the same editors as the quick panel.

### When a check fails: things to check

A failing check shows a **Things to check** box on its quick panel and its page: a few
concrete next steps worked out from the failure message and the check type — e.g.
"Nothing is listening on that port — is the service running?" for a refused
connection, or the exact command to see why a service stopped. The same list is
included in alert messages through the `{{remediation}}` template variable (it's in the
default templates). They're starting points, not a diagnosis.

### Custom scripts with expected output

The **Custom script** check runs a script that already sits in the agent's `script_dir`
on that host and checks what it prints. Looksee never sends commands to run — you put
the scripts on the host (see [agent/README.md](../agent/README.md#custom-scripts)), and
the check form's **Browse** lists the ones the agent found there.

- **Without an expected output**, the exit code decides: 0 = up, 1 = warn, 2 = down
  (the Nagios convention), and a number in the output becomes the value.
- **With an expected output**, the output decides: choose *Contains*, *Does not contain*,
  *Equals* or *Matches regex*, enter the text, and optionally an **expected exit code**.
  A mismatch is down (or warn, if you choose) and the message shows what it got.

To check the output of an existing command, put a one-line wrapper in `script_dir`,
e.g. `zpool-health.sh` containing `zpool status -x`, then expect it to *contain*
`all pools are healthy`. Expected-output matching needs agent 4.0.0 or newer.

### SNMP: walks, counters and the walk browser

The **SNMP value / template** check reads a custom OID in one of these ways:

- **Single value** — one OID (e.g. `1.3.6.1.2.1.1.3.0`).
- **Walk: average / sum / min / max / count** — every value under an OID, combined.
- **Full walk: keep every value** — every OID and value under the subtree is kept in
  the result (shown on the check's page under *Latest details*); the check's value is
  the row count, or a sum/average/min/max you choose.

Tick **Counter — report per-second rate** for counters (octets, packets, errors). On a
walk each row's rate is worked out separately against that row's previous reading and
then combined, so *max* is the busiest row and a counter that resets doesn't produce a
spike. 64-bit counters (Counter64, e.g. `ifHCInOctets`) are fully supported.

**Walk this device…** (in the form, once Host is filled in) shows every value the device
exposes under an OID — `1.3.6.1.2.1` (standard MIB-2) by default, `1.3.6.1.4.1` for
vendor values. Search the list and click a row to use its OID; counters switch on
"report per-second rate" automatically. For an endpoint with a site collector, the walk
runs from the collector.

### Printers

Three SNMP templates cover printers:

- **Printer: lowest toner/ink %** — supply levels from the Printer MIB.
- **Printer: errors** — paper jams, no paper, door open, offline, no toner, service
  requested (down); low paper/toner and nearly-full output (warn). Includes the
  printer's own alert text (e.g. "Paper jam in tray 2").
- **Printer: failed / aborted print jobs** — jobs that ended *aborted* or *stopped*
  (optionally *canceled*), counted once each and held as a failure for the hold period
  so an alert rule catches them. **Needs the printer to support the Job Monitoring MIB
  (RFC 2707)** — many business printers do, many home printers don't; the check says
  so if yours doesn't. For printers without it, the Windows print server's event log
  (*Microsoft-Windows-PrintService/Operational*, event IDs 372 and 805) can be watched
  with a **Windows Event Log** check on the print server.

### Check type reference

What every type does, how it works, and the commands to check the same thing yourself
are in the **[check reference](check-reference.md)** (Help → Check reference). In
brief:

| Category | Types |
|---|---|
| Reachability & web | Ping, TCP, UDP, HTTP(S), real browser, DNS, TLS certificate, domain expiry, WebSocket |
| Network services | Mail/SSH/FTP/LDAP/RDP, email round-trip, NTP, DHCP, gRPC, MQTT, container registry, traceroute, public IP change, device present (ARP), IP address change (by MAC) |
| Databases & apps | Database (PostgreSQL, MySQL/MariaDB, SQL Server, Redis, MongoDB), Prometheus metric, web server status page, app integrations |
| Network devices & hardware | SNMP value/template (incl. printers, UPS), SNMP interfaces, trap/syslog received, server hardware (Redfish/IPMI) |
| Virtualization & containers | Proxmox VE, VMware, Hyper-V (agent), Docker (agent) |
| Host metrics (agent) | Host metric (60+), disk forecast, reboot detection, change detection, agent online |
| Services, files and OS (agent) | OS service, process, failed/stopped services, scheduled task/timer, custom script, file/folder, log file, journal, Windows Event Log, perf counter, VPN tunnel, UPS, backup job |
| Push & smart | Heartbeat, push a value, anomaly |

## Hosts

**Monitoring → Hosts** lists every host: online/offline (from its last report), address,
MAC and OS, agent version (with "update available" when the engine has a newer build),
how many checks it has and how many have problems. Filter by location, endpoint or text
(name, IP, MAC, OS, tag).

**Adding a host and installing the agent:**

1. Click **+ Add host**, enter a name (and optionally address, OS, MAC address), choose
   the endpoint, and click **Add host**.
2. The host opens. Go to its **Agent** tab and click **Generate install command**.
3. Copy the command for the host's OS — it's shown **once** — and run it on that machine
   in an elevated terminal (`sudo` on Linux/macOS, Administrator PowerShell on Windows).
   On Windows, see [windows-agent-security.md](windows-agent-security.md) if Smart App
   Control, SmartScreen or antivirus blocks it.
4. Within about 30 seconds the host shows **online** and its **Overview** tab fills in.

**A host's tabs:**

- **Overview** — live CPU, memory, load, uptime, every filesystem, every network
  interface (link, speed, traffic, **MAC address**, addresses), firewall/encryption/
  update/clock/Defender state, drives (SMART), RAID/pools, temperatures, and hardware
  inventory.
- **Checks** — the checks on this host and their status (click one for its page).
- **Suggested checks** — see [Suggested checks](#suggested-checks).
- **Processes** and **Services** — see below.
- **IP history** — see [MAC addresses and IP changes](#mac-addresses-and-ip-changes).
- **Agent** — version, **Update agent** (it updates itself on its next check-in), and
  regenerating the install command.
- **Edit** — name, endpoint, address, OS, MAC address, tags.
- **Wake (WoL)** — shown when a MAC address is set; sends a Wake-on-LAN packet from the
  engine (or the site collector for a remote site).

**Bulk actions** (tick hosts, then **Actions ▴**): add suggested checks (with an alert
rule if you like), enable/disable their checks, maintenance, update agents, wake, move
to an endpoint (their checks move too), add or remove tags, or delete.

### Processes and services

Agent 4.0+ keeps a full inventory of each host, refreshed about every 5 minutes:

- **Processes** — every running process with PID, user, CPU %, memory and command line.
  Search, and sort by memory, CPU or name.
- **Services** — every systemd unit (Linux), Windows service, or launchd job (macOS)
  with its state and start type. Filter to *running*, *not running*, or **automatic but
  stopped** — usually the interesting ones.

The same lists feed **Browse** in the check form, so any of them is one click from being
a check. Older agents report names only; update them from the Agent tab.

### MAC addresses and IP changes

Looksee records which IP address each MAC address was seen with, from three sources: the
agent's own interface list, discovery scans, and ARP checks. On a host:

- The **Overview** interface table shows each interface's MAC.
- **IP history** lists every IP each of the host's MACs has had, when it was first and
  last seen, and where the sighting came from.
- The host's **MAC address** is filled in automatically from the agent the first time
  (never overwriting one you entered), which also enables Wake-on-LAN.

To be **alerted when an IP changes**, add an **IP address change (by MAC)** check: pick
the host (it watches all of the host's MACs) or enter a MAC. When a MAC appears at a new
address the check goes warn (or down) for the hold period — long enough for an alert
rule to fire — with a message like `IP changed: aa:bb:… changed from 10.0.0.23 to
10.0.0.57`. Its value is the number of changes in the last 24 hours. IPv6 is ignored
unless you tick it (IPv6 privacy addresses change by design). Discovery also recognizes
a known device by its MAC even after its IP changed.

### Suggested checks

A host's **Suggested checks** tab recommends checks from everything the agent found,
grouped:

- **Health & resources** — CPU, memory, swap, load, each real disk (usage, inodes,
  read-only, forecast), each physical interface, SMART, RAID/ZFS, updates, reboot
  pending, clock, firewall, encryption, Defender, temperatures, battery.
- **Services & software** — every well-known server service that's running and set to
  start automatically (web servers, databases, Docker, SSH, DNS, file sharing, VPNs,
  backup agents, Plex/Jellyfin, Home Assistant, …), processes of known software not run
  as a service, and memory checks on database processes.
- **Containers** — every Docker container (up to 25 by name) plus restart loops.
- **Logs** — unexpected shutdowns, service crashes and disk errors (Windows), critical
  journal entries (Linux).
- **Network reachability** — for each well-known port the host listens on, a check from
  Looksee that the service answers over the network (HTTP/HTTPS + certificate, SSH,
  database ports, RDP, SMB, MQTT, Proxmox, …), plus ping.

Untick anything you don't want, optionally choose **Alerts for the new checks** (the
same options as any alert rule), and click **Add N checks**. Already-added suggestions
disappear from the list.

## Endpoints

**Monitoring → Endpoints & locations** shows endpoints grouped by **location**, each
location with a status summary.

**Locations:**

1. Click **+ Add location**, enter a name (and optionally an address and notes), tick
   the endpoints (networks) at that place, and **Save**.
2. From a location's **Location** menu: edit it and its endpoints, start **maintenance
   for the whole location** (every check in every endpoint there), view its checks, or
   delete it (its endpoints stay, just without a location).
3. Filter the Checks, Hosts and Alert history pages by location, and group the Checks
   page by location.

**Endpoints:** **+ Add endpoint** or **Edit** to name, describe and place them (pick a
**Location**). Bulk actions: **Maintenance…**, **Enable/Disable all checks**, **Set
location…**, **Merge into…** (moves every host and check into another endpoint, then
removes the emptied ones), and **Delete…** (deletes their hosts and checks too — type
`delete` to confirm; use Merge if you want to keep them).

An endpoint at another site can have a **site collector** and **public IPs** — see the
next section. Its row then shows the collector's state and the IPs it accepts direct
pushes from.

## Multiple sites

Network checks (ping, SNMP, HTTP, …) run from wherever Looksee runs them, so on their own
they only reach the Looksee server's network. For another location — a branch office, a
client site, a relative's house — you have two options, and you can use both:

- **A site collector (recommended).** Pick one always-on machine at the site that runs
  the Looksee agent. Its agent also runs a *site collector*: it runs that endpoint's
  network checks from inside the site, receives the site's syslog, SNMP traps and flows,
  and runs its discovery scans, SNMP walks and Wake-on-LAN. Everything goes back to your
  Looksee server as outbound HTTPS — **no port forwarding or VPN at the site**.
- **Direct push.** Devices at the site send syslog/traps/flows straight to your Looksee
  server over the internet. Needs ports forwarded at the *Looksee server's* location and
  only covers received events, not checks.

### Set up a site collector

1. **Install the agent (3.2.0 or newer) on a machine at the site** that stays on — a
   small Linux box, a NAS that runs containers, a Windows PC. Use the normal install
   command from **Monitoring → Hosts** (see [agent/README.md](../agent/README.md)); put
   the host in the site's endpoint. The machine only needs outbound HTTPS to your Looksee
   server. **Check:** the host shows **online** on the Hosts page with agent v3.2.0+.
2. Open **Monitoring → Endpoints & locations**, click **Edit** on the site's endpoint,
   choose the host under **Site collector**, and **Save**.
3. Within about 30 seconds the agent downloads the collector — a Node.js runtime (about
   45 MB, once) and the collector itself (13 MB) — from *your* Looksee server, checks
   each file's SHA-256, and starts it. **Check:** the endpoint row reads
   `Site collector: <host> — online (v4.0.0)`, and the host's row on the Hosts page reads
   `Site collector for <endpoint> — online`. "Waiting to start" means the agent is older
   than 3.2.0 or hasn't polled yet; "not running — …" shows the reason (e.g. the
   collector hasn't been built on the server — see the deployment guide).
4. **Add checks to that endpoint as usual.** Ping, TCP, HTTP, SNMP, DNS, certificates and
   every other network type now run from the site. In **Monitoring → Checks** they read
   `via site collector <host>`. **Run now** queues the run on the collector; the result
   appears within about 15 seconds.
5. **Point the site's devices at the collector host's LAN address** for anything they
   push: syslog to UDP/TCP **1514**, SNMP traps to UDP **1162**, NetFlow/IPFIX to UDP
   **2055**, sFlow to UDP **6343**. Allow those from the LAN in the collector host's
   firewall, e.g. on Linux with ufw (replace the range with the site's LAN):

   ```bash
   sudo ufw allow from 192.168.10.0/24 to any port 1514
   sudo ufw allow from 192.168.10.0/24 to any port 1162 proto udp
   sudo ufw allow from 192.168.10.0/24 to any port 2055 proto udp
   sudo ufw allow from 192.168.10.0/24 to any port 6343 proto udp
   ```

   or on Windows (elevated PowerShell):

   ```powershell
   New-NetFirewallRule -DisplayName "Looksee collector (UDP)" -Direction Inbound -Protocol UDP -LocalPort 1514,1162,2055,6343 -RemoteAddress LocalSubnet -Action Allow
   New-NetFirewallRule -DisplayName "Looksee collector (TCP)" -Direction Inbound -Protocol TCP -LocalPort 1514 -RemoteAddress LocalSubnet -Action Allow
   ```

   **Check:** send a test message and look for it under **Insights → Traps & syslog**
   with the site's name under the sender's IP. From a Linux machine at the site:
   `logger -n <collector-ip> -P 1514 -d "looksee test"`.
6. **Discovery, SNMP walks and Wake-on-LAN** follow automatically: on **Monitoring →
   Discovery**, choose the site under **Scan from**; **Walk this device…** and **Wake
   (WoL)** for that endpoint run on the collector.

To stop using a collector, set **Site collector** back to **Looksee server**; the agent
stops the collector within about 15 seconds and the endpoint's checks run from the
server again. A collector host can serve several endpoints at the same physical site.

**Standard ports 514/162 on a Linux collector.** The Linux agent runs as an unprivileged
user, so by default the collector listens on 1514/1162. Most devices let you set the
port. If one can't, set `COLLECTOR_SYSLOG_PORT=514` and/or `COLLECTOR_TRAP_PORT=162` in
`engine/.env` on the Looksee server (applies to every collector) and, on each Linux
collector host, allow binding low ports:

```bash
sudo mkdir -p /etc/systemd/system/looksee-agent.service.d
printf '[Service]\nAmbientCapabilities=CAP_NET_BIND_SERVICE CAP_NET_RAW\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE CAP_NET_RAW\n' \
  | sudo tee /etc/systemd/system/looksee-agent.service.d/collector-ports.conf
sudo systemctl daemon-reload && sudo systemctl restart looksee-agent
```

The same drop-in is what DHCP server checks need on a Linux collector. Windows and macOS
collectors run as SYSTEM/root and need nothing extra.

### What runs where

| Runs on the site collector | Stays on the Looksee server |
|---|---|
| Every network check type: ping, TCP, HTTP, DNS, certificates, SNMP, interfaces, UDP, protocols, email round-trip, databases, traceroute, real browser, NTP, DHCP, gRPC, MQTT, WebSocket, registries, ARP presence, domain expiry, public IP, IPMI/Redfish, Proxmox, VMware, Prometheus, web-server status, app integrations | **Trap/Syslog received** checks (they match the events the collector forwards), heartbeats and pushed values, anomaly, agent heartbeat, disk forecast, IP address change |
| Receiving syslog, traps, NetFlow/IPFIX/sFlow | Alerting, history, dashboards, reports |
| Discovery scans, SNMP walks and Wake-on-LAN for that endpoint | |

Agent checks (services, files, logs, …) always run on their own host's agent, wherever
it is. **Real browser** checks on a collector need Chrome/Chromium on the collector host;
**traceroute** needs `traceroute`/`tracert` there.

### When a collector goes offline

- If the Looksee server is unreachable, the collector keeps running from its last
  configuration (it survives a restart too) and buffers up to 5,000 results and 20,000
  events, sending them when the connection returns.
- If the server hears nothing from a collector for 3 minutes (or 3 check intervals,
  whichever is longer), that endpoint's collector-run checks turn **Unknown** with
  "Site collector on … is offline since …" — so a dead site doesn't look healthy. Add an
  **Agent online** check on the collector host to be alerted when that happens.
- If the collector process crashes, the agent restarts it after 5 seconds (backing off
  to a minute if it keeps failing); the reason shows on the Endpoints and Hosts pages.

### Direct push without a collector

For a site where you can't (or don't want to) run an agent, its devices can send
syslog/traps/flows straight to your Looksee server:

1. **Monitoring → Endpoints & locations → Edit** the site's endpoint and enter its
   public (WAN) IP address(es) under **Public IPs**, comma-separated. Save.
2. At the **Looksee server's** location, forward UDP 1514, 1162, 2055, 6343 and TCP 1514
   from your router to the Looksee server, and allow them in the server's firewall *from
   those public IPs only* — see [deployment guide §5](deployment-guide.md#5-firewall).
3. Point the site's devices at your Looksee server's public address on those ports.

**Check:** messages appear under **Insights → Traps & syslog** with the endpoint's name
under the sender's IP. Know the trade-offs: the traffic crosses the internet
unencrypted, and devices behind the site's NAT all appear as the site's public IP (the
syslog hostname still tells them apart). A site collector avoids both.

## Discovery

**Monitoring → Discovery** finds devices on a subnet so you don't have to add them one by
one.

1. Under **Scan from**, keep **Looksee server**, or pick a remote site that has a site
   collector (see [Multiple sites](#multiple-sites)) to scan from inside that site. Enter
   a subnet (up to a /22, e.g. `192.168.1.0/24`) and, if your devices use a different
   one, the SNMP community. Click **Scan**. A collector picks the scan up within about
   15 seconds.
2. Devices appear as they're found. Looksee pings every address *and* tries a short list
   of ports (SSH, HTTP(S), SMB, RDP, printers, Proxmox, databases), because many devices
   ignore ping. It then looks up names, MAC addresses and SNMP descriptions. Every
   MAC/IP pair found is recorded for [IP change tracking](#mac-addresses-and-ip-changes).
3. For each device, tick **Create host** and whichever suggested checks you want (ping,
   HTTPS + certificate, SSH, RDP, SNMP interfaces, printer toner, Proxmox…). Devices
   already in Looksee — matched by MAC address, hostname or IP — are labelled and start
   unticked.
4. Choose the endpoint at the bottom, click **Alerts:** to attach an alert rule to the
   checks you add (optional), and click **Add selected**.

A scan only sees networks reachable from where it runs. MAC addresses are only available
for devices on the scanning machine's own LAN segment.

## Heartbeats and pushed values

Some things can't be probed — a nightly backup script, a cron job. Instead, they check
in with Looksee:

1. Add a **Heartbeat** check. Set **Expect a ping every** to how often the job runs
   (e.g. 86400 for daily) and a grace period for how late it may be.
2. Open the check: its **Overview** shows a unique URL and a ready-made command, e.g.
   `curl -fsS --retry 3 "https://looksee.example.com/api/hb/AbC123…"`.
3. Add that command to the end of your job, e.g. in crontab:
   `0 2 * * * /usr/local/bin/backup.sh && curl -fsS --retry 3 "https://…/api/hb/AbC123…"`.
4. Each call records **up**. If no call arrives within the interval plus grace, the
   check goes **down** — which is exactly the "the job silently stopped running" case.

To report failure explicitly, add `?status=down&msg=why` (also accepted: `fail`,
`error`, `warn`, or exit-code style `0`/`1`/`2`).

**Push a value** works the same way but sends a number: `…/api/hb/<token>?value=42`.
Thresholds then apply, so a script can monitor anything it can count (queue length,
licenses left, a sensor). The URL is the only credential — keep it private, or use
**Regenerate URL** on the check if it leaks.

## Channels

**Alerting → Channels** is where alerts go. Types:

| Type | Setup |
|---|---|
| Email | Set the SMTP server once at the top of the page (**Send test email** to confirm), then a channel per recipient list (comma-separated addresses). |
| Slack | Slack → Apps → *Incoming Webhooks* → Add to Slack → pick the channel → copy the `https://hooks.slack.com/services/…` URL. |
| Microsoft Teams | In the Teams channel: ••• → **Workflows** → *Post to a channel when a webhook request is received* → copy the URL. Alerts arrive as cards with an **Open in Looksee** button. |
| Telegram | Message **@BotFather**: `/newbot`, copy the bot token. Add the bot to your group (or message it), open `https://api.telegram.org/bot<token>/getUpdates` and copy the `chat.id` (groups start with `-100`). For a forum topic also enter its topic ID. |
| Webhook | Any service that takes a JSON POST: Discord (default body), ntfy, Gotify, Home Assistant, your own. `{{message}}` in the body is replaced with the alert text; `{{title}}`, `{{check}}`, `{{status}}` and `{{url}}` work too. |
| Browser / phone push | Click **Enable push notifications** in the top bar on each browser/phone (install the dashboard as an app on phones). |

Each channel's **Manage** menu has **Send a test alert** (sends a sample alert through
exactly the path a real one takes — do this after adding any channel), **Edit message
templates…**, **Replace settings…** (saved URLs and tokens are never shown again, so
this replaces them), rename, disable/enable, and delete.

**Message templates.** Every channel sends four kinds of message — *triggered*,
*resolved*, *reminder*, *escalated* — each with a title (email subject) and body. Leave
a field blank to use the default. Insert any of these variables:

| Variable | Holds |
|---|---|
| `{{check}}` | Check name |
| `{{status}}` | UP, DOWN, WARN or UNKNOWN |
| `{{message}}` | The check's latest result message |
| `{{event}}` | triggered, resolved, reminder or escalated |
| `{{host}}`, `{{endpoint}}`, `{{location}}` | Where it is (blank if none) |
| `{{type}}` | Check type |
| `{{time}}` | When it happened |
| `{{duration}}` | How long the incident has been open |
| `{{remediation}}` | Things to check, one per line |
| `{{url}}` | Link to the check's page in Looksee |

The editor shows a live preview with sample data. Empty variables disappear cleanly
(no dangling "Host: ·").

## Alerts, escalation, and dependencies

**Alert rules** live on each check's **Alerts** tab, in the **Alerts** section when
adding checks (also on suggested checks and discovery), or are added to many checks with
the bulk action. A rule has:

- **Notify** — which channels.
- **Failures in a row** — how many consecutive failing results before notifying (2 is a
  good default; it ignores single blips).
- **Failing means** — *Down only*, or *Warn or down*.
- **Remind every (min)** — re-send while it's still failing (blank = once).
- **Escalate after (min)** + **Escalate to** — if it's still failing that long, also
  notify these channels (e.g. Teams + SMS after 30 minutes of email).

Each alert uses the channel's templates; by default it names the check, the reason, where
it is, things to check, and a link. A recovery message follows when it's healthy again.

Looksee also holds alerts back automatically when:

- **The check is flapping** — it changed state many times recently. The check shows
  "Flapping" until it settles.
- **A parent is down** — under a check's **Advanced → Depends on** (or the bulk
  **Depends on…** action), pick the checks it sits behind (e.g. the router). While any
  parent is down, the child's alerts wait; the list shows "Parent … down".
- **It's in maintenance** — see below.

## Alert history

**Alerting → Alert history** lists every incident — each time an alert rule fired, until
its check recovered:

- Range chips (24 hours to 1 year) and **All / Open / Resolved**.
- Filters for **location**, **endpoint**, **host**, and a search over check names and
  messages.
- A summary line: how many incidents, how many still open, and total problem time.
- Each row: status, the check (click for its page), where it is, when it started, how
  long it lasted, and the alert message.

A single check's incidents are also on its own page. Incidents only exist for checks with
an alert rule.

## Maintenance

**Alerting → Maintenance** schedules quiet periods. During one, checks keep running and
recording results, but no alerts are sent and SLA reports leave that time out.

1. Click **+ Schedule maintenance** and name it.
2. Choose **One time** (start and end) or **Every week** (days, start time in the
   engine's local time, duration in minutes).
3. Choose what it applies to: everything, chosen endpoints, chosen hosts (including
   checks their agents run), or chosen checks.
4. Click **Schedule**. While active it's marked **active now**, and affected checks show
   **MAINTENANCE**.

For an unplanned job, use the **Maintenance…** bulk action on the Checks, Hosts or
Endpoints page, or a location's **Maintenance for this location…** — it starts a window
right now for N minutes. **End now** closes a one-time window early; weekly windows can
be turned off and on.

## SLA reports

**Insights → SLA reports** shows each check's uptime over the last 1, 7, 30, 90 or 365
days, optionally for one endpoint.

- **Uptime** is time-weighted: each result counts for the time until the next one, so a
  check that's down for 10 minutes loses 10 minutes whatever its interval.
- **Degraded** is time spent in warn, **Maintenance** the excluded time, **Incidents**
  how many times it went down.
- Set an **SLA target** to highlight checks below it. Click column headers to sort.
- **Download CSV** exports the same table.

## Traps and syslog

The engine listens for SNMP traps (UDP **1162**) and syslog (UDP and TCP **1514**). By
default only private-network addresses may send (see the deployment guide to change
ports or allowed sources).

1. Point your devices at the engine: trap destination `<engine-ip>:1162` (v1/v2c), and
   remote syslog `<engine-ip>:1514`. On pfSense: *Status → System Logs → Settings →
   Remote Logging*.
2. Open **Insights → Traps & syslog** — received messages appear (filter by site, type,
   source IP, severity, or text; **Live** refreshes every 10 seconds).
3. To be alerted, add an **SNMP trap received** or **Syslog message received** check with
   a pattern (e.g. `link down|failed`) and, for syslog, a minimum severity. With no
   thresholds, any match in the window is a failure; set thresholds to alert only above
   a count.

Devices at a remote site send to that site's collector instead — see
[Multiple sites](#multiple-sites). Received events are kept for 30 days.

## Top talkers

**Insights → Top talkers** shows who is using the network, from NetFlow v5/v9 or IPFIX
(UDP **2055**) and sFlow (UDP **6343**) sent to the engine — e.g. pfSense's *softflowd*
package or a managed switch. Remote sites send flows to their site collector; pick the
site in the filter to see just its traffic. View by conversation, source, destination,
or service. Flow totals are kept per minute for 7 days.

## Status pages

**Insights → Status pages** creates public pages anyone can open without signing in — for
family, clients, or colleagues.

1. Click **+ New status page**, give it a title and (optionally) a URL slug and
   description.
2. Click checks on the left to add them; reorder with ↑ ↓ on the right. **Their names are
   shown publicly**, so name them accordingly.
3. Save, then **Open public page**. The page lives at `https://<your-looksee>/status/<slug>`.

Visitors see only an overall banner, each check's name and current state, and 90 days
of daily uptime bars — never hosts, addresses, or messages. Untick **Published** to take
a page offline without deleting it.

## Dashboards and widgets

The home page holds one or more **dashboards**, each a grid of widgets you can rearrange
(desktop only — click **Edit layout** to drag/resize) and duplicate. Each dashboard has
its own auto-refresh interval.

**Adding widgets:** click **+ Add widget**, pick the widget type from the cards, then
pick what it shows from a searchable list (filter by endpoint; checks also match by type
and host). For status tiles, uptime history and host widgets you can tick **several** —
one widget is added for each. The list doesn't move or refresh while you're choosing.

Widget types:

- **Status tile** — one check's status, latest problem message and recent history.
- **Problems right now** — counts by status for one endpoint (or everything) plus what's
  down or warning.
- **Endpoint summary** — a whole endpoint's checks at a glance.
- **Uptime history** — one check's uptime % and latency over a chosen range.
- **Host metrics** / **Network bandwidth** — a host's CPU/RAM/disk or RX/TX sparklines.
- **All hosts** — every host's online/offline state.
- **Top talkers** — the busiest network conversations (needs flow data).
- **Alert history**, **Backup status**, **Clock**, **Note**, **Section header**.

## Security

**System → Security** controls how Looksee protects itself — important once it's
reachable from the internet. Full details, recommendations and recovery steps are in the
[security guide](security-guide.md). In short:

- **Two-factor sign-in is required.** The first sign-in after installing (or upgrading
  to 4.0) walks you through scanning a QR code with an authenticator app and saving ten
  recovery codes. Change your password, make new recovery codes, move to a new phone,
  and see/sign out other sessions under **Your account & 2FA**.
- **Sign-in safeguards** — lockout after repeated failures, session length, idle
  sign-out, minimum password length, and (optional) an **emailed code for sign-ins from
  a new IP**.
- **IP access** — an optional allowlist of IPs/networks allowed to use the dashboard,
  and the list of blocked IPs (blocked by rules or by hand).
- **Attack detection** — rules that watch for password guessing, vulnerability scanners,
  agent-key guessing and new-IP sign-ins, then email you (and/or notify channels) and
  block the IP. Edit the built-in rules or add your own.
- **Security log** — every sign-in, failure, block and probe, searchable.

Locked out? On the server, run `npm run security:reset` in the `engine` folder — see the
security guide.

## Light and dark theme

The theme button in the top bar cycles **System → Light → Dark**. *System* follows your
device's setting. The choice is remembered per browser. Both themes use the same
status colors (always shown with a text label too), checked for contrast.

## Backups and logs

**System → Backups** configures and runs encrypted, deduplicated backups (Borg) of the
database and secrets. "Back up now" runs one on demand; a schedule runs them
automatically. Restoring discards anything created after the chosen backup — read the
confirmation carefully.

**System → Logs** shows the engine's own activity — what it did, what failed and why —
filterable by level. Every entry above debug includes a plain-language explanation.
