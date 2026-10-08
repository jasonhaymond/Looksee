# User Guide

Day-to-day usage of Looksee once it's running — adding things to monitor, managing many
of them at once, building dashboards, and getting notified when something breaks. For
getting a server running in the first place, see [deployment-guide.md](deployment-guide.md);
for moving one to a new server, [migration-guide.md](migration-guide.md); for the agent
itself, [agent/README.md](../agent/README.md); for local development, the
[README](../README.md).

## Contents

1. [How Looksee is organized](#how-looksee-is-organized)
2. [Getting around](#getting-around)
3. [Checks](#checks)
   - [Adding a check](#adding-a-check)
   - [Thresholds: warn and critical](#thresholds-warn-and-critical)
   - [Finding and filtering checks](#finding-and-filtering-checks)
   - [Working with many checks at once](#working-with-many-checks-at-once)
   - [A check's detail panel](#a-checks-detail-panel)
   - [Check type reference](#check-type-reference)
4. [Hosts](#hosts)
5. [Endpoints](#endpoints)
6. [Multiple sites](#multiple-sites)
   - [Set up a site collector](#set-up-a-site-collector)
   - [What runs where](#what-runs-where)
   - [When a collector goes offline](#when-a-collector-goes-offline)
   - [Direct push without a collector](#direct-push-without-a-collector)
7. [Discovery](#discovery)
8. [Heartbeats and pushed values](#heartbeats-and-pushed-values)
9. [Alerts, escalation, and dependencies](#alerts-escalation-and-dependencies)
10. [Maintenance](#maintenance)
11. [SLA reports](#sla-reports)
12. [Traps and syslog](#traps-and-syslog)
13. [Top talkers](#top-talkers)
14. [Status pages](#status-pages)
15. [Dashboards and widgets](#dashboards-and-widgets)
16. [Backups and logs](#backups-and-logs)

## How Looksee is organized

- An **endpoint** is a group — usually a location or network ("Home lab", "Office",
  "Client A").
- A **host** is a machine running the Looksee agent. Hosts belong to an endpoint.
- A **check** is one thing being monitored. Every check belongs to an endpoint, and
  optionally to a host. A check is run by one of three things:
  - the **engine** itself (ping, HTTP, DNS, SNMP, databases, Proxmox, …) — no agent
    needed;
  - the **agent** on a host (services, files, logs, Docker, backups, …);
  - **report evaluation** — the engine judges the metrics every agent report already
    carries (CPU, disks, SMART, updates, …).
- Every result is **up**, **warn**, **down**, or **unknown**. A check in a maintenance
  window shows **maintenance**; a turned-off check shows **disabled**.

## Getting around

The top bar groups the pages:

| Menu | Pages |
|---|---|
| Dashboards | Your widget dashboards (the home page) |
| Monitoring | Checks, Hosts, Endpoints, Discovery |
| Alerting | Channels, Maintenance |
| Insights | SLA reports, Traps & syslog, Top talkers, Status pages |
| System | Backups, Logs |

On a phone the same groups are behind the **Menu** button. Each page starts with a
one-line explanation and a **Learn more** link to the matching section of this guide.

## Checks

### Adding a check

1. Open **Monitoring → Checks** and click **+ Add check**.
2. Pick what you want to monitor. Type in the search box (`disk`, `ssl`, `backup`,
   `printer`, …) or browse the categories. Each card says what the check does.
3. Fill in **Basics**:
   - **Name** — how it appears everywhere.
   - **Endpoint** — the group it belongs to.
   - **Host** — required for agent checks (the machine that runs it); optional for
     everything else, where it's just for grouping.
   - **Run from** (ping, TCP, HTTP, DNS, TLS only) — the engine, or a host's agent.
     Choose an agent to test something only reachable from inside that host's network.
   - **Check every** — the interval in seconds.
4. Fill in **Settings**. Required fields are marked `*`; hover the `?` icons for help.
   For agent checks, fields like service, process, container, mount and interface
   names offer suggestions from what the agent found on the chosen host.
5. Optionally set **Thresholds** (next section) and open **Advanced** for the retry
   interval, tags, dependencies, and less common options.
6. Optionally tick channels under **Alert me** to add an alert rule straight away.
7. Click **Create check**. The new check opens in the list; its first result appears
   within one interval (or click **Run now**).

**What success looks like:** the check shows **UP** (or a deliberate WARN/DOWN) with a
"Last result" message, and "Checked" counts up from a few seconds ago.

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
- The dropdowns filter by **endpoint**, **host**, **kind** (category) and **tag**.
- **Group by** sorts the list into sections by endpoint, host, kind, status, or nothing.
  Click a section header to collapse it. Your choice is remembered in this browser.
- Within each section, failing checks sort to the top.

### Working with many checks at once

1. Tick the checkbox on each check you want — or the checkbox on a **section header**
   to take the whole group, or **Select all N shown** to take everything the current
   filters show.
2. A bar appears at the bottom of the screen with the actions:

| Action | What it does |
|---|---|
| Enable / Disable | Turn checks on or off |
| Run now | Run engine checks immediately (agent checks update on the agent's next report) |
| Maintenance… | Start a maintenance window for N minutes on just these checks |
| Add tags… / Remove tags… | Comma-separated tags |
| Move to endpoint… | Re-home the checks |
| Set host… | Change which host they belong to |
| Run from… | Run ping/TCP/HTTP/DNS/TLS checks from the engine or a chosen agent |
| Interval… / Retry interval… | Change how often they run (retry: how often while failing; 0 clears) |
| Add alert rule… | Add the same rule (channels, results-in-a-row, reminders) to each |
| Remove alert rules | Remove every rule from them |
| Depends on… | Set which checks they depend on (empty clears) |
| Duplicate | Copy them (copies start disabled so you can edit first) |
| Delete… | Delete — you must type `delete` to confirm |

3. A message confirms how many changed. If any were skipped (for example, a type that
   can't run on an agent), the message names the first one and why.

Combine this with filters: e.g. filter by tag `wan`, **Select all**, then **Add alert
rule…** to alert on every WAN check at once.

### A check's detail panel

Click any check row to open it:

- **Overview** — status and how long it's been that way, last checked time and response
  time, recent uptime, the latest message, structured details where the check has them
  (an interface table, traceroute hops, container list, matched log lines), and recent
  results. **Run now** and **Disable/Enable** are here too. Heartbeat and push checks
  show their URL and ready-to-paste `curl` commands.
- **Edit** — the same form used to create it (the type can't be changed). Saved
  passwords and tokens are never shown; leave the field as it is to keep them.
- **Alerts** — the check's alert rules (see [Alerts](#alerts-escalation-and-dependencies)).

### Check type reference

**Reachability & web** (engine)

| Type | Use it for |
|---|---|
| Ping | Is it up; packet loss %, jitter and round-trip time |
| TCP port | Is a port open (SSH, databases, any TCP service) |
| UDP port | Send a payload, require a reply (UDP has no handshake) |
| HTTP(S) | Status codes/ranges, body must (not) contain, regex, JSON field checks, redirect chain and final URL, response time |
| Real browser | Loads the page in headless Chrome: rendered text, an element appearing, JavaScript errors |
| DNS | Any record type, a specific DNS server, expected answer, DNSSEC validation |
| TLS certificate | Days to expiry, trusted chain, hostname match, warns if TLS 1.0/1.1 still accepted |
| Domain registration expiry | Registrar expiry date via RDAP |
| WebSocket | Handshake, optional send-and-expect |

**Network services** (engine)

| Type | Use it for |
|---|---|
| Mail / SSH / FTP / LDAP / RDP | SMTP (with STARTTLS), IMAP, POP3, FTP, SSH banner, LDAP bind, RDP |
| Email round-trip | Sends a message by SMTP and confirms it arrives over IMAP |
| NTP server | Stratum and clock offset |
| DHCP server | A DHCP offer arrives; set the expected server to catch rogue DHCP |
| gRPC health, MQTT broker, Container registry | Protocol-level health |
| Traceroute / path change | Warns when the route changes or stops reaching |
| Public IP change | Flags when the engine's public IP changes |
| Device present (ARP) | Is a device on the engine's LAN at all (even if it ignores ping); verifies its MAC |

**Databases & apps** (engine)

| Type | Use it for |
|---|---|
| Database | PostgreSQL, MySQL/MariaDB, SQL Server, Redis, MongoDB: login + query, connections %, replication lag, size, long queries, memory |
| Prometheus metric | Any metric from any `/metrics` endpoint, optionally as a per-second rate |
| Web server status page | nginx stub_status, Apache mod_status, Caddy metrics |
| App integration | Nextcloud, Home Assistant, Plex, Jellyfin, Pi-hole, or any JSON API |

**Network devices & hardware** (engine)

| Type | Use it for |
|---|---|
| SNMP value / template | One OID, a walked subtree, or templates: printer toner, UPS battery/runtime/on-battery, CPU, memory, fullest disk, hottest sensor, reboot detection |
| SNMP interfaces | Every port on a switch/router: down ports, utilization, errors |
| SNMP trap / Syslog received | Alert on matching traps or syslog lines (see [Traps and syslog](#traps-and-syslog)) |
| Server hardware | iDRAC/iLO/Supermicro over Redfish, or IPMI via ipmitool: PSUs, fans, temperatures |

**Virtualization & containers**

| Type | Use it for |
|---|---|
| Proxmox VE | Node load, cluster quorum, guest state, storage, age of last backup |
| VMware ESXi / vCenter | VM power, datastore space, host health |
| Hyper-V VMs (agent) | VM state on a Hyper-V host |
| Docker containers (agent) | Running/healthy, restarts, CPU/memory |

**Host metrics** (agent reports)

| Type | Use it for |
|---|---|
| Host metric | 60+ metrics — CPU (user/system/iowait/steal/per-core), load, memory/swap/page faults, every disk (% used, free GB, inodes, read-only, mounted), disk I/O, every interface (throughput, errors, drops, up, link speed), TCP states, listening ports, temperatures, fans, battery, SMART, RAID/ZFS, pending updates, reboot pending, clock sync, Defender, firewall, disk encryption, failed logins |
| Disk full forecast | Days until a disk fills at its recent growth rate |
| Reboot detection | Any reboot, held as warn for a while so it's noticed |
| Change detection | New login sessions, listening ports, inventory, interfaces, mounts |
| Agent online | The agent stopped reporting |

**Services, files and OS** (agent)

| Type | Use it for |
|---|---|
| OS service | A systemd unit / Windows service is running (and restarts per hour on Linux) |
| Process | Running, how many, CPU %, memory |
| Failed / stopped services | Any failed systemd unit / stopped automatic Windows service |
| Scheduled task / timer | Last result and age of a Windows scheduled task or systemd timer |
| Custom script | Your script, Nagios-style exit codes (see the agent README for setup) |
| File / folder | Exists, age of newest file, size, count, folder size, checksum drift, **folder watchdog** (created/modified/deleted files) |
| Log file pattern | New lines matching a pattern; follows rotation |
| systemd journal / Windows Event Log | New entries by unit/priority or log/ID/level/source |
| Windows performance counter | Any counter path |
| VPN tunnel | WireGuard handshake age, or any tunnel interface up |
| UPS | NUT or apcupsd: on battery = warn, low battery = down |
| Backup job | Borg, restic, or Veeam: age (and result) of the newest backup |

**Push & smart**

| Type | Use it for |
|---|---|
| Heartbeat / Push a value | See [Heartbeats and pushed values](#heartbeats-and-pushed-values) |
| Anomaly | Flags a check's value that's unusually far from its normal for that hour |

## Hosts

**Monitoring → Hosts** lists every host: online/offline (from its last report), address
and OS, agent version (with "update available" when the engine has a newer build), how
many checks it has and how many have problems.

**Adding a host and installing the agent:**

1. Click **+ Add host**, enter a name (and optionally address, OS, MAC address), choose
   the endpoint, and click **Add host**.
2. The host opens. Go to its **Agent** tab and click **Generate install command**.
3. Copy the command for the host's OS — it's shown **once** — and run it on that machine
   in an elevated terminal (`sudo` on Linux/macOS, Administrator PowerShell on Windows).
4. Within about 30 seconds the host shows **online** and its **Overview** tab fills in.

**A host's tabs:**

- **Overview** — live CPU, memory, load, uptime, every filesystem (with free space and
  read-only/stale flags), every network interface with throughput, firewall/encryption/
  update/clock/Defender state, drives (SMART), RAID/pools, temperatures, and inventory.
- **Checks** — the checks on this host and their status.
- **Suggested checks** — checks recommended from what the agent found (each disk, each
  physical interface, SMART drives, RAID arrays, well-known services, Docker, security
  posture). Untick anything you don't want and click **Add N checks**. Already-added
  suggestions disappear from the list.
- **Agent** — version, **Update agent** (it updates itself on its next check-in), and
  regenerating the install command.
- **Edit** — name, endpoint, address, OS, MAC address, tags.
- **Wake (WoL)** — shown when a MAC address is set; sends a Wake-on-LAN packet from the
  engine (which must be on the same LAN segment, or broadcasts must be forwarded).

**Bulk actions** (tick hosts, then use the bottom bar): add suggested checks to all of
them, update their agents, maintenance, move to an endpoint (their checks move too), add
or remove tags, enable or disable all their checks, wake, or delete.

## Endpoints

**Monitoring → Endpoints** lists every endpoint with its host and check counts and
current status breakdown. Use **+ Add endpoint** or **Edit** to name and describe them.

Bulk actions: **Maintenance…**, **Enable/Disable all checks**, **Merge into…** (moves
every host and check into another endpoint, then removes the emptied ones), and
**Delete…** (deletes their hosts and checks too — type `delete` to confirm; use Merge
if you want to keep them).

An endpoint at another location can have a **site collector** and **public IPs** — see
the next section. Its row then shows the collector's state ("online", "offline",
"waiting to start") and the IPs it accepts direct pushes from.

## Multiple sites

Network checks (ping, SNMP, HTTP, …) run from wherever Looksee runs them, so on their own
they only reach the Looksee server's network. For another location — a branch office, a
client site, a relative's house — you have two options, and you can use both:

- **A site collector (recommended).** Pick one always-on machine at the site that runs
  the Looksee agent. Its agent also runs a *site collector*: it runs that endpoint's
  network checks from inside the site, receives the site's syslog, SNMP traps and flows,
  and runs its discovery scans and Wake-on-LAN. Everything goes back to your Looksee
  server as outbound HTTPS — **no port forwarding or VPN at the site**.
- **Direct push.** Devices at the site send syslog/traps/flows straight to your Looksee
  server over the internet. Needs ports forwarded at the *Looksee server's* location and
  only covers received events, not checks.

### Set up a site collector

1. **Install the agent (3.2.0 or newer) on a machine at the site** that stays on — a
   small Linux box, a NAS that runs containers, a Windows PC. Use the normal install
   command from **Monitoring → Hosts** (see [agent/README.md](../agent/README.md)); put
   the host in the site's endpoint. The machine only needs outbound HTTPS to your Looksee
   server. **Check:** the host shows **online** on the Hosts page with agent v3.2.0+.
2. Open **Monitoring → Endpoints**, click **Edit** on the site's endpoint, choose the
   host under **Site collector**, and **Save**.
3. Within about 30 seconds the agent downloads the collector — a Node.js runtime (about
   45 MB, once) and the collector itself (13 MB) — from *your* Looksee server, checks
   each file's SHA-256, and starts it. **Check:** the endpoint row reads
   `Site collector: <host> — online (v3.2.0)`, and the host's row on the Hosts page reads
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
6. **Discovery and Wake-on-LAN** follow automatically: on **Monitoring → Discovery**,
   choose the site under **Scan from**; **Wake (WoL)** on a host in that endpoint sends
   the magic packet from the collector.

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
| Every network check type: ping, TCP, HTTP, DNS, certificates, SNMP, interfaces, UDP, protocols, email round-trip, databases, traceroute, real browser, NTP, DHCP, gRPC, MQTT, WebSocket, registries, ARP presence, domain expiry, public IP, IPMI/Redfish, Proxmox, VMware, Prometheus, web-server status, app integrations | **Trap/Syslog received** checks (they match the events the collector forwards), heartbeats and pushed values, anomaly, agent heartbeat, disk forecast |
| Receiving syslog, traps, NetFlow/IPFIX/sFlow | Alerting, history, dashboards, reports |
| Discovery scans and Wake-on-LAN for that endpoint | |

Agent checks (services, files, logs, …) always run on their own host's agent, wherever
it is. **Real browser** checks on a collector need Chrome/Chromium on the collector host;
**traceroute** needs `traceroute`/`tracert` there.

Trap/Syslog received checks in a remote endpoint count only that site's events; checks
in an endpoint without a collector or public IPs count events received by the Looksee
server itself.

### When a collector goes offline

- If the Looksee server is unreachable, the collector keeps running from its last
  configuration (it survives a restart too) and buffers up to 5,000 results and 20,000
  events, sending them when the connection returns.
- If the server hears nothing from a collector for 3 minutes (or 3 check intervals,
  whichever is longer), that endpoint's collector-run checks turn **Unknown** with
  "Site collector on … is offline since …" — so a dead site doesn't look healthy. Add an
  **Agent heartbeat** check on the collector host to be alerted when that happens.
- If the collector process crashes, the agent restarts it after 5 seconds (backing off
  to a minute if it keeps failing); the reason shows on the Endpoints and Hosts pages.

### Direct push without a collector

For a site where you can't (or don't want to) run an agent, its devices can send
syslog/traps/flows straight to your Looksee server:

1. **Monitoring → Endpoints → Edit** the site's endpoint and enter its public (WAN)
   IP address(es) under **Public IPs**, comma-separated. Save.
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
   ignore ping. It then looks up names, MAC addresses and SNMP descriptions.
3. For each device, tick **Create host** and whichever suggested checks you want (ping,
   HTTPS + certificate, SSH, RDP, SNMP interfaces, printer toner, Proxmox…). Devices
   already in Looksee are labelled and start unticked.
4. Choose the endpoint at the bottom and click **Add selected**.

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

## Alerts, escalation, and dependencies

**Channels** (Alerting → Channels) are where alerts go: email (SMTP), webhooks
(Discord/Slack/ntfy/Telegram) and Web Push to this dashboard installed as an app. Use
"Send test email" to confirm SMTP works before relying on it.

**Alert rules** live on each check's **Alerts** tab (or add one to many checks with the
bulk action). A rule has:

- **Results in a row** — how many consecutive failing results before notifying (2 is a
  good default; it ignores single blips).
- **Failing means** — *Down only*, or *Warn or down*.
- **Remind every (min)** — re-send while it's still failing (blank = once).
- **Escalate after (min)** + **Escalate to** — if it's still failing that long, also
  notify these channels (e.g. SMS/push after 30 minutes of email).

Each alert names the check and the reason, e.g. "[Looksee] Disk queue is WARN: 30 is
above warn threshold 10". A recovery message follows when it's healthy again.

Looksee also holds alerts back automatically when:

- **The check is flapping** — it changed state many times recently. The check shows
  "Flapping" until it settles.
- **A parent is down** — under a check's **Advanced → Depends on** (or the bulk
  **Depends on…** action), pick the checks it sits behind (e.g. the router). While any
  parent is down, the child's alerts wait; the list shows "Parent … down".
- **It's in maintenance** — see below.

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
Endpoints page — it starts a window right now for N minutes. **End now** closes a
one-time window early; weekly windows can be turned off and on.

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
   source IP, severity, or text; **Live** refreshes every 10 seconds). Messages from a
   remote site show the site's name under the sender's IP; the site filter appears once
   an endpoint has a site collector or public IPs.
3. To be alerted, add an **SNMP trap received** or **Syslog message received** check with
   a pattern (e.g. `link down|failed`) and, for syslog, a minimum severity. With no
   thresholds, any match in the window is a failure; set thresholds to alert only above
   a count.

Devices at a remote site send to that site's collector instead — see
[Multiple sites](#multiple-sites). Received events are kept for 30 days.

## Top talkers

**Insights → Top talkers** shows who is using the network, from NetFlow v5/v9 or IPFIX
(UDP **2055**) and sFlow (UDP **6343**) sent to the engine — e.g. pfSense's *softflowd*
package or a managed switch.

Remote sites send flows to their site collector (see [Multiple sites](#multiple-sites));
pick the site in the filter to see just its traffic. Choose a time range, then view by
conversation (source → destination), source,
destination, or service (protocol/port). The **Top talkers** dashboard widget shows the
same thing in a tile. Flow totals are kept per minute for 7 days.

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

Widget types:

- **Status tile** — one check's status, latest problem message and recent history, with
  quick access to its alert rules.
- **Status summary** — counts by status for one endpoint (or everything) plus a list of
  what's down or warning right now.
- **Group summary** — a whole endpoint's checks at a glance.
- **Uptime history** — one check's uptime % and latency over a chosen range.
- **Host metrics** / **Network bandwidth** — a host's CPU/RAM/disk or RX/TX sparklines.
- **All hosts grid** — every host's online/offline state.
- **Top talkers** — the busiest network conversations (needs flow data).
- **Alert history**, **Backup status**, **Clock**, **Note**, **Section header**.

Widgets with a time-range control remember their own range.

## Backups and logs

**System → Backups** configures and runs encrypted, deduplicated backups (Borg) of the
database and secrets. "Back up now" runs one on demand; a schedule runs them
automatically. Restoring discards anything created after the chosen backup — read the
confirmation carefully.

**System → Logs** shows the engine's own activity — what it did, what failed and why —
filterable by level. Every entry above debug includes a plain-language explanation.
