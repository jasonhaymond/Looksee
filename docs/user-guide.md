# User Guide

Day-to-day usage of Looksee once it's running — adding things to monitor, managing many
of them at once, building dashboards, and getting notified when something breaks. The
same guide is built into the app: click **Help & user guide** in the sidebar, or
**Learn more** at the top of any page.

> **Coming from 4.x?** 5.0 renamed things to match how people talk about them. What 4.x
> called an **endpoint** (a network) is now a **site**; what it called a **host** (a
> machine) is now an **endpoint**. Nothing was lost — the upgrade renames your data in
> place. Alert templates using `{{endpoint}}` and `{{host}}` were updated automatically.

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
   - [Adding the same check to many endpoints or sites](#adding-the-same-check-to-many-endpoints-or-sites)
   - [Picking from what the agent found](#picking-from-what-the-agent-found)
   - [Thresholds: warn and critical](#thresholds-warn-and-critical)
   - [Finding and filtering checks](#finding-and-filtering-checks)
   - [Working with many checks at once](#working-with-many-checks-at-once)
   - [Duplicating checks](#duplicating-checks)
   - [A check's page: history, charts and incidents](#a-checks-page-history-charts-and-incidents)
   - [Leaving results out of statistics](#leaving-results-out-of-statistics)
   - [Resolving and recovery](#resolving-and-recovery)
   - [When a check fails: things to check](#when-a-check-fails-things-to-check)
   - [Custom scripts with expected output](#custom-scripts-with-expected-output)
   - [DNS zone history](#dns-zone-history)
   - [SNMP: walks, counters and the walk browser](#snmp-walks-counters-and-the-walk-browser)
   - [SNMP: calculating a value](#snmp-calculating-a-value)
   - [Printers](#printers)
   - [Software and security checks](#software-and-security-checks)
   - [Calculated values](#calculated-values)
   - [Check type reference](#check-type-reference)
4. [Endpoints](#endpoints)
   - [Processes and services](#processes-and-services)
   - [MAC addresses and IP changes](#mac-addresses-and-ip-changes)
   - [Suggested checks and templates](#suggested-checks)
5. [Sites and locations](#sites)
6. [Groups](#groups)
7. [Exclusions](#exclusions)
8. [SNMP templates](#snmp-templates)
9. [Multiple sites](#multiple-sites)
10. [Discovery](#discovery)
11. [Heartbeats and pushed values](#heartbeats-and-pushed-values)
12. [Channels and message templates](#channels)
13. [Alerts, escalation, and dependencies](#alerts-escalation-and-dependencies)
14. [Alert history](#alert-history)
15. [Maintenance](#maintenance)
16. [SLA reports](#sla-reports)
17. [Traps and syslog](#traps-and-syslog)
18. [Top talkers](#top-talkers)
19. [Status pages](#status-pages)
20. [Dashboards and widgets](#dashboards-and-widgets)
21. [Security](#security)
22. [Watchdog](#watchdog) (including [watchdog agents](#watchdog-agents))
23. [Times and time zones](#times-and-time-zones)
24. [Light and dark theme](#light-and-dark-theme)
25. [Backups and logs](#backups-and-logs)

## How Looksee is organized

Everything sits in one tree: **Location → Site → Endpoint → Check.**

- A **location** is a physical place — "Home", "Main office", "Church". It's optional:
  it groups sites so you can filter, summarize and silence a whole place at once.
- A **site** is a network at a location ("Home LAN", "Office VLAN 20", "Client A").
- An **endpoint** is one device on a site — a server, PC, switch, printer, UPS. It may
  run the Looksee agent, but doesn't have to: a printer watched over SNMP is an endpoint
  too. Any endpoint with an agent can also be its site's
  [site collector](#multiple-sites).
- A **check** is one thing being monitored. Every check belongs to a site, and
  optionally to an endpoint. A check is run by one of three things:
  - the **engine** itself (ping, HTTP, DNS, SNMP, databases, Proxmox, …) — no agent
    needed;
  - the **agent** on an endpoint (services, files, logs, Docker, backups, scripts, …);
  - **report evaluation** — the engine judges the metrics every agent report already
    carries (CPU, disks, SMART, updates, installed software, …).
- A **group** is your own set of things that cuts across the tree — "Domain
  controllers", "Everything tagged `client-a`", "All printers". See [Groups](#groups).
- Every result is **up**, **warn**, **down**, or **unknown**. A check in a maintenance
  window shows **maintenance**; a turned-off check shows **disabled**. Status is always
  written out as well as colored.

## Getting around

The **sidebar** on the left has two parts. The top lists the pages:

| Section | Pages |
|---|---|
| Overview | Dashboards (the home page) |
| Monitoring | Checks, Endpoints, Sites & locations, Groups, Discovery, SNMP templates |
| Alerting | Alert history, Channels, Maintenance, Exclusions |
| Insights | SLA reports, Traps & syslog, Top talkers, Status pages |
| System | Security, Watchdog, Backups, Logs, Help & user guide |

Click a section name to fold it away; the sidebar remembers what you opened.

Below the pages is the **tree** of everything monitored: locations, their sites, each
site's endpoints, and each endpoint's checks, then your groups. Every row shows a status
symbol and how many problems are under it. Click the arrow to open a level, or the name
to open its page — a location, site, endpoint or group page lists everything under it
with its status. Type in **Find a site, endpoint or check…** to narrow the tree.

On a phone or narrow window the sidebar is behind the **☰ Menu** button at the top. The
theme button (◐ ☀ ☾), **Enable push notifications** and **Sign out** are at the bottom
of the sidebar. **Help & user guide** holds this guide, the check reference and the
security guides. Each page starts with a one-line explanation and a
**Learn more** link to the matching section of this guide.

## Checks

### Adding a check

1. Open **Monitoring → Checks** and click **+ Add check**.
2. Pick what you want to monitor. Type in the search box (`disk`, `ssl`, `backup`,
   `printer`, …) or browse the categories. Each card says what the check does; once
   picked, **How this check works** opens its entry in the
   [check reference](check-reference.md).
3. Fill in **Basics & where**:
   - **Name** — how it appears everywhere.
   - **Endpoints** — for agent checks, the device(s) whose agent runs it. For everything
     else this is optional; picking endpoints creates one check per endpoint.
   - **Sites** — when no endpoint is picked, the site(s) the check belongs to (one
     check each).
   - **Run from** (ping, TCP, HTTP, DNS, TLS only) — the engine, or an endpoint's agent.
     Choose an agent to test something only reachable from inside that endpoint's
     network.
   - **Check every** — the interval in seconds.
4. Fill in **Settings**. Required fields are marked `*`; hover the `?` icons for help.
   Fields that name something on an endpoint (service, process, container, script, mount,
   interface) have a **Browse** button — see
   [Picking from what the agent found](#picking-from-what-the-agent-found).
5. Optionally set **Thresholds** (below). Every type works with its defaults; the
   **Advanced** section holds the less common options (timeouts, retries, text to send
   and expect, exclusions, calculations), plus the retry interval, tags, dependencies
   and **Recovers together with** (see [Resolving and recovery](#resolving-and-recovery)).
6. Under **Alerts**, tick the channels to notify and set the same options an alert rule
   has (failures in a row, warn or down, reminders, escalation). Leave everything
   unticked for no alerts.
7. Click **Create check**. The new check opens in the list; its first result appears
   within one interval (or click **Run now**).

**What success looks like:** the check shows **UP** (or a deliberate WARN/DOWN) with a
"Last result" message, and "Checked" counts up from a few seconds ago.

### Adding the same check to many endpoints or sites

In the add form, tick several **Endpoints** (or, for checks that don't need one, several
**Sites**). One check is created for each, with the same settings and alert rule.

- Use `{{endpoint}}`, `{{address}}` (the endpoint's hostname/IP, or its name) and
  `{{site}}` in the **Name** or any text setting; they're filled in per target. For
  example, a Ping check named `Ping {{endpoint}}` with Host `{{address}}` pings each
  endpoint at its own address. (`{{host}}` still works and means the same as
  `{{endpoint}}`.)
- For engine checks with an address field, **Target each endpoint's own address** fills
  those fields with `{{address}}` for you.
- If a name has no placeholder, the target's name is appended so the checks stay
  distinguishable.
- Targets that don't fit (e.g. an agent check type for an endpoint with no agent) are
  skipped and listed; the rest are still created.

To add a whole *set* of checks at once, use a template instead: role and security
templates on an endpoint's **Suggested checks** tab (see
[Suggested checks and templates](#suggested-checks)), or an
[SNMP template](#snmp-templates) for a network device.

### Picking from what the agent found

Settings that name something on an endpoint — a service, process, Docker container,
script, mount, network interface, drive or sensor — show what that endpoint's agent last
reported:

1. Pick the endpoint first (the first picked endpoint's inventory is used when several
   are).
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
  click. **Problems** = down or warn. The counts follow the other filters.
- The **search box** matches names, types, endpoints, sites, last messages, tags and
  configuration (so searching an IP finds every check pointing at it).
- The dropdowns filter by **location**, **site**, **endpoint**, **kind** (category) and
  **tag**. Tick as many values in each as you like: ticking two sites shows checks in
  either; different dropdowns must all match. Long lists have a search box, and
  **Clear** in a dropdown unticks everything in it.
- The dropdowns **cascade** — each only offers what's inside the ones before it. Tick a
  location and the site list shows only that location's sites; tick sites and the
  endpoint list shows only their endpoints; the kind and tag lists show only what the
  remaining checks have. A value you ticked earlier that a bigger filter now hides
  stops counting until you widen that filter again.
- **Group by** sorts the list into sections by location, site, endpoint, kind, status,
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
| State | Resolve… | Mark failing checks recovered now — see [Resolving and recovery](#resolving-and-recovery) |
| Alerts | Add alert rule… | Add the same rule (channels, failures in a row, reminders, escalation) to each |
| Alerts | Remove alert rules | Remove every rule from them |
| Alerts | Depends on… | Set which checks they depend on (empty clears) |
| Organize | Add tags… / Remove tags… | Comma-separated tags |
| Organize | Move to site… / Set endpoint… | Re-home the checks |
| Organize | Add to group… | Put them in a [group](#groups) (or start a new one) |
| Organize | Duplicate… | Copy them — see [Duplicating checks](#duplicating-checks) |
| Schedule | Run from… | Run ping/TCP/HTTP/DNS/TLS checks from the engine or a chosen agent |
| Schedule | Interval… / Retry interval… | Change how often they run (retry: how often while failing; 0 clears) |
| — | Delete… | Delete — asks once to confirm |

3. Once you confirm, the dialog closes straight away and the action **runs in the
   background** — a **Working:** note in the bottom-right corner shows what's still
   running, so you can carry on (even move to another page) meanwhile. When it
   finishes, a message confirms how many changed. If any were skipped (for example, a
   type that can't run on an agent), the message names the first one and why. If the
   action fails, the corner note turns into **Failed:** with the reason.

Deleting asks for one confirming click everywhere except **locations, sites and
endpoints** — deleting one of those takes everything inside it along (or, for a
location, unlinks its sites), so you must type `delete` to confirm.

Combine this with filters: e.g. filter by tag `wan`, **Select all**, then **Add alert
rule…** to alert on every WAN check at once.

### Duplicating checks

Select checks, then **Actions → Duplicate…** and choose where the copies go:

- **Same place** — a copy next to each original, named `… (copy)`.
- **To other sites** — one copy per picked site. A check tied to an endpoint keeps it
  only if that endpoint is in the destination site; agent checks that need an endpoint
  are skipped there (copy them to endpoints instead).
- **To other endpoints** — one copy per picked endpoint, placed in that endpoint's site.
  Ideal for "monitor this service on these five servers too".

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
- **Settings** and **Alert rules** tabs — the same editors as the quick panel. Every
  part of an existing alert rule can be changed with its **Edit** button.
- **Exclusions applied** — the exclusion lists and own exclusions this check currently
  uses (see [Exclusions](#exclusions)).

### Leaving results out of statistics

Sometimes a failure wasn't real — a planned outage you forgot to schedule, a
misconfigured check, a test. On the check's page you can leave results out of uptime %,
SLA reports and status pages without deleting them:

- **One result** — click **Exclude** at the end of its row in the result list. It's
  dimmed and labelled *Excluded from statistics*. **Count again** undoes it.
- **A time range** — click **Exclude a time range…**, enter the start, end and a reason
  (shown next to the excluded results), then **Exclude**. Tick the option to count a
  range again to reverse it.

**Check:** the uptime % at the top of the page changes after the next refresh, and the
SLA report for that period no longer counts the excluded time. Excluded results are
still listed (and still in the history) so nothing is hidden.

### Resolving and recovery

A check normally recovers when its next result is healthy. You can also recover it
yourself, or let something else do it:

- **Resolve… (by hand).** On a failing check's page, its quick panel, or the **Alert
  history** row, click **Resolve…**, optionally add a note, and click **Resolve**. On
  the Checks page, tick several and use **Actions → Resolve…**. This records an *up*
  result now (with who did it and your note), closes the alert incident and sends the
  usual recovery message. A check that polls (ping, HTTP…) reports its real status again
  on its next run; a trap/syslog check ignores events from before the moment you
  resolved it.
- **A clearing event.** On an **SNMP trap received** or **Syslog message received**
  check, **Clears when text matches** recovers it straight away when a matching event
  arrives — e.g. `linkUp` after `linkDown`, or `on line power` after `on battery`.
- **No new events for a while.** On the same check types (and **Push a value**),
  **Recover on its own after (minutes)** marks it recovered once no new matching event
  has arrived for that long.
- **Another check recovering.** Under **Advanced → Recovers together with**, pick a
  check; when that one recovers, this one is marked recovered too — e.g. a trap check
  that should clear when the device's ping check is up again. These can chain.
- **The recovery URL.** Every check that isn't a heartbeat/push check can have a
  **Recovery URL** (on its page, under the Overview): another system — a ticketing tool,
  a repair script — calls it to mark the check recovered:

  ```bash
  curl -fsS "https://looksee.example.com/api/hb/<token>?status=up&msg=fixed+by+script"
  ```

  It only accepts *up* — it can't report a failure. The URL is the only credential:
  **Regenerate** if it leaks (the old one stops working at once) or **Turn off**.
  Heartbeat and push checks already accept `?status=up` on their own URL.

**Check:** after resolving, the check shows **UP** with your note in the message, its
incident on **Alert history** shows as resolved, and the channels received a recovery
message.

### When a check fails: things to check

A failing check shows a **Things to check** box on its quick panel and its page: a few
concrete next steps worked out from the failure message and the check type — e.g.
"Nothing is listening on that port — is the service running?" for a refused
connection, or the exact command to see why a service stopped. The same list is
included in alert messages through the `{{remediation}}` template variable (it's in the
default templates). They're starting points, not a diagnosis.

### Custom scripts with expected output

The **Custom script** check runs a script that already sits in the agent's `script_dir`
on that endpoint and checks what it prints. Looksee never sends commands to run — you
put the scripts on the endpoint (see [agent/README.md](../agent/README.md#custom-scripts)), and
the check form's **Browse** lists the ones the agent found there.

- **Without an expected output**, the exit code decides: 0 = up, 1 = warn, 2 = down
  (the Nagios convention), and a number in the output becomes the value.
- **With an expected output**, the output decides: choose *Contains*, *Does not contain*,
  *Equals* or *Matches regex*, enter the text, and optionally an **expected exit code**.
  A mismatch is down (or warn, if you choose) and the message shows what it got.

- **Warn / down if the output contains** — for scripts that *print* a problem rather
  than confirm success: enter text (or, with *Warn/down text is → A regular expression*,
  a pattern) under **Warn if the output contains** and/or **Down if the output contains**.
  The down text is checked first. These work with or without an expected output; when
  both are set, the worse result wins.

To check the output of an existing command, put a one-line wrapper in `script_dir`,
e.g. `zpool-health.sh` containing `zpool status -x`, then expect it to *contain*
`all pools are healthy`. Output matching needs agent 4.0.0 or newer.

**Running the script from another endpoint.** For a device that can't run the agent
(a printer, a NAS, a UPS card), add the check to *that device's* endpoint and choose
another endpoint under **Run by** — a machine nearby whose agent has the script in its
`script_dir`. **Browse** then lists *that* agent's scripts. The result belongs to the
device's endpoint (its page, its alerts), and only the chosen agent can report it.

### DNS zone history

The **DNS zone history** check keeps an inventory of every record in a zone and a
history of what changed, so an unexpected edit — a hijacked MX record, a stray A record,
a deleted SPF record — raises an alert and stays on record.

1. **Allow zone transfers to Looksee** on the zone's DNS server (only the server Looksee
   asks from — the Looksee server's address, or the site collector's for a remote site):
   - BIND: in the zone's block, `allow-transfer { 10.0.0.10; };` (or `{ key
     looksee-transfer; };` with a TSIG key), then `sudo rndc reload`.
   - Windows DNS: **DNS Manager →** the zone **→ Properties → Zone Transfers →** tick
     *Allow zone transfers*, choose *Only to the following servers*, add the address.
   - **Check** from that machine: `dig @<dns-server> example.com AXFR` lists the zone
     instead of "Transfer failed".
   Can't allow transfers (a public DNS host)? Choose *Reading a list of names* in step 2
   instead and list the names to watch.
2. **Add the check:** **+ Add check → DNS zone history**, enter the zone and the DNS
   server, and **Save**. It runs hourly by default.
3. **Check:** the first result reads *Baseline recorded: N record(s), serial …*. From
   then on, an edit shows as e.g. *changed www A 192.0.2.1 → 192.0.2.66* with the
   chosen status (warn), held for an hour. The check's page lists the changes, the
   history (last 500 changes) and the current records.

Records that change on their own (certificate-renewal `_acme-challenge` records,
DHCP-registered hosts) go under **Ignore names** (Advanced).

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
"report per-second rate" automatically. For a site with a site collector, the walk runs
from the collector.

Looksee has a built-in dictionary of about 170 common OIDs — the standard system,
interface, storage and UPS values, the Printer MIB, and the counters printers from HP,
Brother, Canon, Ricoh, Xerox, Kyocera, Lexmark and Konica Minolta keep in their own
part of the tree. In the walk results:

- **Name** shows what a known OID is (e.g. `ifHCInOctets`, `prtMarkerSuppliesLevel`),
  and for other vendor OIDs which company they belong to (e.g. *Brother (enterprise
  2435)*).
- **Value** is shown readably where Looksee knows how: uptime as days and hours, sizes
  with units, status numbers as words (`1` → *up*, `3` → *on battery*).
- **Look up an OID by name** searches the dictionary without walking — type
  `ifHCInOctets`, `battery`, `toner` or `sysUpTime` and click **Search**. If the name
  isn't there, walk the device and look for the value instead.
- **Add to Extra OIDs** (the **+ extra** button on a row) adds that OID to the check's
  *Extra OIDs* list for the calculation below, instead of making it the main OID.

### SNMP: calculating a value

Under **Advanced** on an SNMP value check:

- **Calculate** does maths on the value read, after *Multiply by*: `value / 10`,
  `value * 8 / 1e6` (bytes/s to Mbit/s), `round(value / 1024, 1)`. Allowed: `+ - * / %
  ^`, brackets, and `min max abs round floor ceil sqrt log10`. Nothing else is accepted
  — it's a calculator, not code.
- **Extra OIDs (name = OID)** reads more values from the same device in the same poll,
  one per line, for **Calculate** to use by name. `rate(…)` turns a counter into a
  per-second rate. With extra OIDs, the main OID is optional. Example — a disk's
  percentage used from two values:

  ```text
  used = 1.3.6.1.2.1.25.2.3.1.6.1
  size = 1.3.6.1.2.1.25.2.3.1.5.1
  ```

  with **Calculate** `used / size * 100` and a **Unit label** of ` %`.
- **ref** in the expression stands for another check's latest value, picked under
  **ref = this check's latest value** — e.g. a counter as a percentage of a capacity
  another check reads.

The calculated number becomes the check's value, so thresholds, charts and SLA reports
all use it. **Check:** click **Run now**; the result's value is the calculated number,
and a mistake (an unknown name, division by zero) shows as **unknown** with the reason.
To combine values from *different* devices or check types, use a
[Calculated value](#calculated-values) check instead.

### Printers

Apply the **Printer** [SNMP template](#snmp-templates) for your brand to get all of the
checks below at once, plus page counts. Individually, three presets cover printers:

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

### Software and security checks

Agent 5.0 reports the software installed on each endpoint — Debian/Ubuntu, RPM, Alpine
and Arch packages, Windows programs, macOS apps, global npm and pip packages, and the
Node.js/Python/PHP runtimes — about once a day, or sooner when it changes. Three check
types use it:

- **Upgradable packages** — the packages with updates waiting. **Fail when** a security
  update is waiting (the default), any update is, or never (just report). The result
  lists the packages. Ubuntu **phased updates** — updates Ubuntu holds back from most
  machines while it rolls them out gradually, which `apt` won't install yet anyway — are
  left out unless you tick **Advanced → Include Ubuntu phased updates**. Packages you
  exclude (e.g. `linux-image-*`) aren't counted or shown.
- **Installed software changed** — alerts when software is installed, removed or changes
  version, with the list of what changed. Limit it to some sources with **Only watch**,
  and add **lock files** under Advanced to watch an application's own dependencies.
- **Vulnerable or unsupported software** — looks every package up on
  [OSV.dev](https://osv.dev) (known vulnerabilities) and the OS and runtimes on
  [endoflife.date](https://endoflife.date) (support end dates). Set the severity that
  warns and the one that's down, and whether an unsupported OS or runtime is warn or
  down (and how many days before its end of life to start warning). **Accepted risks**
  takes one item per line — a package name or an advisory ID, then `#` and why:

  ```text
  libssl1.1 # needed by the old ERP client until it's replaced in March
  CVE-2024-1234 # the vulnerable feature isn't used here
  ```

  Reasons are shown with every result, so the next person sees why it was accepted.
  **Also check lock files** adds `package-lock.json`, `npm-shrinkwrap.json`,
  `Pipfile.lock`, `requirements.txt` or `composer.lock` files on that endpoint (only
  files with those names are read).

  **Privacy:** this check sends package names and versions (never hostnames or
  addresses) from the Looksee server to OSV.dev and endoflife.date. Untick both lookups
  under Advanced to keep everything local. Results are cached (vulnerabilities for 7
  days, end-of-life dates for 1 day), so the lookups are light.

Two more checks (agent 5.2) round this out:

- **Local user accounts** — alerts on new, removed and changed local accounts (enabled
  or disabled, locked, password changed, full name, shell) and, at a higher status
  (down by default), on anyone **gaining admin rights** — a new admin account, or an
  existing one added to Administrators / sudo / wheel / admin. The first report records
  a baseline; built-in and service accounts are left out unless you include them, and
  **Exclude accounts** skips ones whose changes are expected (a service account whose
  password rotates). Windows, Linux and macOS; details of how each is read are in the
  [check reference](check-reference.md#agent_users).
- **Largest folders and files** (under *Files & logs*) — walks each disk, or one folder,
  and lists the largest folders and files, with how much each grew since the last scan.
  It runs every 6 hours by default and never slows the agent's reports.

**Check:** on an endpoint running agent 5.0, add **Upgradable packages**; the result
names the waiting packages within a few minutes. On Ubuntu, compare with
`apt list --upgradable` — phased ones show there as *deferred due to phasing* when you
run `sudo apt-get -s upgrade`.

There are also ready-made **security baselines** for Windows, Linux and macOS (antivirus,
firewall, disk encryption, security updates, vulnerable software, failed and new
sign-ins, and on Windows audit-log clearing and new admin accounts) — see
[Suggested checks and templates](#suggested-checks). The **OS service** check's
**Advanced → Should be: Stopped** makes a check that a risky or unneeded service (Telnet,
Remote Registry) stays off.

### Calculated values

A **Calculated value** check works out a number from up to four other checks' latest
values — UPS load in watts from load % and capacity, two disks' combined free space,
the difference between two temperature sensors.

1. Add a check of type **Calculated value**.
2. Pick the checks under **a =**, **b =**, **c =** and **d =** (only the ones you use).
3. Enter the **Expression**, e.g. `a / 100 * b`. The same operators and functions as SNMP
   **Calculate** are allowed.
4. Optionally set a **Unit label** and thresholds.

If an input is older than **Inputs must be newer than (minutes)** (15 by default), the
result is **unknown** instead of a number worked out from stale data.

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
| Endpoint metrics (agent) | Endpoint metric (60+), disk forecast, reboot detection, change detection, agent online |
| Software & security (agent) | Upgradable packages, installed software changed, vulnerable or unsupported software |
| Services, files and OS (agent) | OS service, process, failed/stopped services, scheduled task/timer, custom script, file/folder, log file, journal, Windows Event Log, perf counter, VPN tunnel, UPS, backup job |
| Push & smart | Heartbeat, push a value, calculated value, anomaly |

## Endpoints

An **endpoint** is one device: a server, PC, switch, printer, UPS, camera. **Monitoring →
Endpoints** lists every one: online/offline (from its agent's last report, for endpoints
with an agent), address, MAC and OS, agent version (with "update available" when the
engine has a newer build), how many checks it has and how many have problems. Filter by
location, site or text (name, IP, MAC, OS, tag). Click a name to open the endpoint's own
page (also reachable from the sidebar tree) with everything under it.

An endpoint doesn't need the agent. A printer, switch or UPS is an endpoint with SNMP,
ping or HTTP checks against its address; the agent adds everything that has to be read
from inside the machine.

**Adding an endpoint and installing the agent:**

1. Click **+ Add endpoint**, enter a name (and optionally hostname/IP, OS, MAC address),
   choose the site, and click **Add endpoint**.
2. For a device without the agent, you're done — add checks to it. To install the agent,
   open the endpoint, go to its **Agent** tab and click **Generate install command**.
3. Copy the command for the endpoint's OS — it's shown **once** — and run it on that machine
   in an elevated terminal (`sudo` on Linux/macOS, Administrator PowerShell on Windows).
   On Windows, see [windows-agent-security.md](windows-agent-security.md) if Smart App
   Control, SmartScreen or antivirus blocks it.
   On Linux the installer gives the agent the read access it needs by default (system
   logs, the journal, Docker, SMART) while it still runs as its own unprivileged user —
   see [agent/README.md](../agent/README.md#privileges) for what that means and the
   `--minimal` option.
4. Within about 30 seconds the endpoint shows **online** and its **Overview** tab fills
   in.

**An endpoint's tabs:**

- **Overview** — live CPU, memory, load, uptime, every filesystem, every network
  interface (link, speed, traffic, **MAC address**, addresses), firewall/encryption/
  update/clock/Defender state, drives (SMART), RAID/pools, temperatures, and hardware
  inventory.
- **Checks** — the checks on this endpoint and their status (click one for its page).
- **Suggested checks** — suggestions and templates; see
  [Suggested checks and templates](#suggested-checks).
- **Processes** and **Services** — see below.
- **IP history** — see [MAC addresses and IP changes](#mac-addresses-and-ip-changes).
- **Agent** — version, **Update agent** (it updates itself on its next check-in), and
  regenerating the install command.
- **Watchdog** — have this endpoint's agent tell you when *Looksee itself* is
  unreachable; see [Watchdog agents](#watchdog-agents).
- **Edit** — name, site, address, OS, MAC address, tags.
- **Wake (WoL)** — shown when a MAC address is set; sends a Wake-on-LAN packet from the
  engine (or the site collector for a remote site).

**Bulk actions** (tick endpoints, then **Actions ▴**): add suggested checks (with an
alert rule if you like), enable/disable their checks, maintenance, update agents, wake,
move to a site (their checks move too), add to a group, add or remove tags, or delete.

### Processes and services

Agent 4.0+ keeps a full inventory of each endpoint, refreshed about every 5 minutes:

- **Processes** — every running process with PID, user, CPU %, memory and command line.
  Search, and sort by memory, CPU or name.
- **Services** — every systemd unit (Linux), Windows service, or launchd job (macOS)
  with its state and start type. Filter to *running*, *not running*, or **automatic but
  stopped** — usually the interesting ones.

The same lists feed **Browse** in the check form, so any of them is one click from being
a check. Older agents report names only; update them from the Agent tab.

The **Agent** tab also shows the agent's connection at a glance: when it last fetched its
settings (*last config poll*), when its last report was stored, and the address it
connects from. If part of a report couldn't be saved, a **Warning** line there (and under
the endpoint's name) gives the reason — the endpoint still counts as online. An agent
that never shows a config poll has never reached Looksee with its key; the agent guide's
[troubleshooting section](../agent/README.md#troubleshooting-an-endpoint-never-checks-in)
goes through the rest. On the **Logs** page, entries about an endpoint link to it, and
*only this endpoint* narrows the log to that one.

### MAC addresses and IP changes

Looksee records which IP address each MAC address was seen with, from three sources: the
agent's own interface list, discovery scans, and ARP checks. On an endpoint:

- The **Overview** interface table shows each interface's MAC.
- **IP history** lists every IP each of the endpoint's MACs has had, when it was first and
  last seen, and where the sighting came from.
- The endpoint's **MAC address** is filled in automatically from the agent the first time
  (never overwriting one you entered), which also enables Wake-on-LAN.

To be **alerted when an IP changes**, add an **IP address change (by MAC)** check: pick
the endpoint (it watches all of its MACs) or enter a MAC. When a MAC appears at a new
address the check goes warn (or down) for the hold period — long enough for an alert
rule to fire — with a message like `IP changed: aa:bb:… changed from 10.0.0.23 to
10.0.0.57`. Its value is the number of changes in the last 24 hours. IPv6 is ignored
unless you tick it (IPv6 privacy addresses change by design). Discovery also recognizes
a known device by its MAC even after its IP changed.

### Suggested checks

An endpoint's **Suggested checks** tab recommends checks from everything the agent found
— running services, processes, installed packages, listening ports — and leaves out
what's already monitored there. Grouped:

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
- **Network reachability** — for each well-known port the endpoint listens on, a check
  from Looksee that the service answers over the network (HTTP/HTTPS + certificate, SSH,
  database ports, RDP, SMB, MQTT, Proxmox, …), plus ping. An existing HTTPS check gets a
  matching certificate-expiry suggestion.
- **Software** — upgradable packages, software changes and vulnerable software, for
  agents that report installed software.

Untick anything you don't want, optionally choose **Alerts for the new checks** (the
same options as any alert rule), and click **Add N checks**. Already-added suggestions
disappear from the list.

**Templates.** Below the suggestions are ready-made sets of checks for what a machine
*does*:

- **Server roles** — web server, database server, DNS, mail, file server, domain
  controller, hypervisor, Docker host, backup server, print server.
- **Security baselines** — Windows, Linux and macOS (see
  [Software and security checks](#software-and-security-checks)).

A template marked **✓ looks like this** matches software the agent found running (only
running, enabled services count); any template can be applied anyway. Each shows how many
checks it would add and how many are already there; open **What it adds** to see them,
then click **Apply**. Checks the endpoint already has are skipped. **Check:** the endpoint's **Checks** tab lists the new checks, and they report
within one interval.

For network devices without an agent, use an [SNMP template](#snmp-templates) instead.

## Sites

**Monitoring → Sites & locations** shows sites grouped by **location**, each location
with a status summary. A site is a network at a place ("Home LAN", "Office VLAN 20",
"Client A"); endpoints and checks belong to a site, and through it to its location.

**Locations:**

1. Click **+ Add location**, enter a name (and optionally an address and notes), tick
   the sites (networks) at that place, and **Save**.
2. From a location's **Location** menu: **Edit / choose sites…**, start **Maintenance for
   this location…** (every check in every site there), view its checks, or **Delete
   location…** (its sites stay, just without a location).
3. Filter the Checks, Endpoints and Alert history pages by location, and group the
   Checks page by location.

**Sites:** **+ Add site** or **Edit** to name, describe and place them (pick a
**Location**). Bulk actions: **Maintenance…**, **Enable/Disable all checks**, **Set
location…**, **Merge into…** (moves every endpoint and check into another site, then
removes the emptied ones), and **Delete…** (deletes their endpoints and checks too — type
`delete` to confirm; use Merge if you want to keep them).

A site at another place can have a **site collector** and **public IPs** — see
[Multiple sites](#multiple-sites). Its row then shows the collector's state and the IPs
it accepts direct pushes from.

**A site's page** (click it in the sidebar tree) lists its endpoints and checks with
their status, and **Suggested checks** — checks worked out from the site's name
and description, its endpoints and the checks it already has (for example a gateway ping
and DNS check for a site with none, or certificate checks for its web servers). Untick
anything you don't want and click **Add N checks**.

## Groups

A **group** is your own set of things, across the whole tree — "Domain controllers",
"Client A's printers", "Everything tagged `backup`". **Monitoring → Groups** lists them;
they also appear at the bottom of the sidebar tree with their status.

1. Click **+ New group**, enter a name (and optionally a description) and choose a kind:
   - **Manual — I'll pick the members.** Any mix of locations, sites, endpoints and
     checks. Add members on the group's page (**Add members**), or with **Add to group**
     on any location, site, endpoint or check page, or **Actions → Add to group…** on
     the Checks and Endpoints lists. A member that's a location, site or endpoint brings
     everything under it.
   - **Filter — members match rules, automatically.** Choose what the group selects
     (locations, sites, endpoints or checks), whether **all of** or **any of** the
     conditions must match, and add conditions such as *Tag is `backup`*, *Operating
     system contains `Windows`*, *Check type is `ping`*, *Site name starts with
     `Client A`*, *Status is `down`*. Comparisons ignore case. **Matching now** shows
     what the rules select as you edit; membership is worked out again every time it's
     used, so new endpoints that match join automatically.
2. Click **Create group**. **Check:** the group's page lists its members and **Covers** the
   checks under them.

On a group's page:

- **Maintenance…** — a window for N minutes covering whatever is in the group *while it
  runs*. Scheduled windows on the Maintenance page can target groups too.
- **Add alert rule…**, **Run now**, **Enable**, **Disable** — applied to every check the
  group covers.
- **Rename…** and **Delete group** — deleting removes only the group; its members are
  not touched, and maintenance windows aimed at it stop applying.

[Exclusion lists](#exclusions) can apply to the checks of chosen groups.

## Exclusions

Some things a check sees are noise you never want to hear about — a `/snap/*` mount, a
`veth*` Docker interface, Windows event 10016, a `*-migrate` container that exits on
purpose. Exclusions make checks ignore them.

**Inside one check:** most checks that look at several items have an **Exclude …**
field under Advanced (mounts, interfaces, disk devices, sensors, services, containers,
VMs, packages, user accounts, SNMP rows/values, event IDs, message texts), one item per
line.

**Reusable lists:** **Alerting → Exclusions** holds lists you write once and apply to
many checks.

1. Click **+ New exclusion list** and name it.
2. Choose **What the items are**: message texts, Windows event IDs, mount points /
   drives, network interfaces, disk devices, sensors and fans, services, Docker
   containers, Hyper-V virtual machines, packages, user accounts, or SNMP rows and
   values. The kind decides which check types the list affects — e.g. *SNMP rows and
   values* applies to every SNMP check: `Virtual Memory` leaves that storage row out of
   every device's disk template, `Waste*` every printer's waste-toner box.
3. Enter the **Items (one per line)**. Names are whole names with case ignored; `*`
   matches anything and `?` one character (`veth*`, `loop?`). Message texts match
   anywhere in the message.
4. Choose where it applies: **All checks that use this kind of item**, or only the checks
   of chosen **groups**.
5. Click **Create list**. Lists can be turned off and on without deleting them.

**Check:** open an affected check — its page shows **Exclusions applied** with each list
and item it's using. The next result leaves those items out (agent checks pick the change
up within about a minute, on the agent's next configuration refresh).

Exclusions affect what a check *sees*. To leave a whole result out of uptime and SLA
figures after the fact, see [Leaving results out of statistics](#leaving-results-out-of-statistics).

## SNMP templates

An SNMP template is a set of SNMP checks for one kind of device — "everything I check on
a Brother printer", "the usual UPS checks". Apply it to a device and Looksee creates
every check at once, with your thresholds. **Monitoring → SNMP templates** has:

- **Built-in** templates: printers (any brand, plus HP, Brother, Canon, Ricoh, Xerox,
  Kyocera, Lexmark, Epson, Konica Minolta, Sharp, OKI, Samsung and Toshiba with their own
  page counters), UPS (standard and APC), Synology NAS, Linux and other Net-SNMP
  machines, Cisco, Dell iDRAC, and any switch (every port). They're read-only; **Copy**
  one to change it.
- **Your templates** — click **+ New template** (or **Copy** a built-in one). For each
  check give a name and choose what it reads — a single OID, a walk, a preset, or every
  port — with optional calculation, extra OIDs, unit and thresholds (the same options as
  an [SNMP check](#snmp-calculating-a-value)). **Suggest for devices whose sysObjectID
  starts with** takes a vendor's OID prefix (e.g. `1.3.6.1.4.1.2435` for Brother) so
  Discovery suggests the template for matching devices.

**Applying a template:**

1. Click **Apply to a device…** on a template.
2. Choose the **Site**, optionally the **Endpoint** the device is (its checks then show
   on its page and its hostname is used), the **Address**, and the SNMP version and
   credentials (community for v1/v2c; user, auth and privacy settings for v3).
3. Under **Create these checks**, untick any you don't want, and confirm.

**Check:** the new checks appear on the Checks page and report within one interval. A
check that reads something the device doesn't have turns **unknown** with "no such
object" — delete it or fix the OID in your own copy of the template.

**From Discovery:** a scanned device whose SNMP sysObjectID matches a template shows
**SNMP template: …** — click it to open that template's Apply dialog with the address
filled in.

## Multiple sites

Network checks (ping, SNMP, HTTP, …) run from wherever Looksee runs them, so on their own
they only reach the Looksee server's network. For another location — a branch office, a
client site, a relative's house — you have two options, and you can use both:

- **A site collector (recommended).** Pick one always-on machine at the site that runs
  the Looksee agent. Its agent also runs a *site collector*: it runs that site's
  network checks from inside the site, receives the site's syslog, SNMP traps and flows,
  and runs its discovery scans, SNMP walks and Wake-on-LAN. Everything goes back to your
  Looksee server as outbound HTTPS — **no port forwarding or VPN at the site**.
- **Direct push.** Devices at the site send syslog/traps/flows straight to your Looksee
  server over the internet. Needs ports forwarded at the *Looksee server's* location and
  only covers received events, not checks.

### Set up a site collector

1. **Install the agent (3.2.0 or newer) on a machine at the site** that stays on — a
   small Linux box, a NAS that runs containers, a Windows PC. Use the normal install
   command from **Monitoring → Endpoints** (see [agent/README.md](../agent/README.md));
   put the endpoint in that site. The machine only needs outbound HTTPS to your Looksee
   server. **Check:** the endpoint shows **online** on the Endpoints page with agent
   v3.2.0+.
2. Open **Monitoring → Sites & locations**, click **Edit** on the site, choose the
   endpoint under **Site collector**, and **Save**.
3. Within about 30 seconds the agent downloads the collector — a Node.js runtime (about
   45 MB, once) and the collector itself (13 MB) — from *your* Looksee server, checks
   each file's SHA-256, and starts it. **Check:** the site row reads
   `Site collector: <endpoint> — online (v5.0.0)`, and the endpoint's row on the Endpoints
   page reads `Site collector for <site> — online`. "Waiting to start" means the agent is older
   than 3.2.0 or hasn't polled yet; "not running — …" shows the reason (e.g. the
   collector hasn't been built on the server — see the deployment guide).
4. **Add checks to that site as usual.** Ping, TCP, HTTP, SNMP, DNS, certificates and
   every other network type now run from the site. In **Monitoring → Checks** they read
   `via site collector <endpoint>`. **Run now** queues the run on the collector; the result
   appears within about 15 seconds.
5. **Point the site's devices at the collector machine's LAN address** for anything they
   push: syslog to UDP/TCP **1514**, SNMP traps to UDP **1162**, NetFlow/IPFIX to UDP
   **2055**, sFlow to UDP **6343**. Allow those from the LAN in the collector machine's
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
   (WoL)** for that site run on the collector.

To stop using a collector, set **Site collector** back to **Looksee server**; the agent
stops the collector within about 15 seconds and the site's checks run from the server
again.

### One collector for several networks

One machine can be the collector for several sites — e.g. a box on a trunk port that
reaches several VLANs, or a firewall-adjacent server that can route to each network.

1. Open the collector machine's endpoint → **Agent** tab. Under **Site collector for**,
   tick every site (network) it should collect for and click **Save collector sites**.
   (Choosing the same endpoint as **Site collector** on each site's Edit form does the
   same thing.) A site that had another collector moves to this one; sites you untick go
   back to the Looksee server. **Check:** each site's row on **Sites & locations** reads
   `Site collector: <endpoint> — online`.
2. **Give each site its address ranges** (**Sites & locations → Edit → Address
   ranges**, CIDR form: `10.20.0.0/24, 10.20.10.0/24`). A collector receives syslog,
   traps and flows for all its sites on the same ports; Looksee files each message under
   the site whose range holds the sender's address (the most specific range wins when
   ranges overlap). A sender in none of the ranges is filed under the collector's oldest
   site. **Check:** send a test message from a device in each network (`logger -n
   <collector-ip> -P 1514 -d "looksee test"`) and confirm under **Insights → Traps &
   syslog** that each shows its own site's name.
3. Checks, discovery scans, SNMP walks and Wake-on-LAN need nothing extra: each runs
   from the collector for whichever of its sites it belongs to.

Address ranges also work without a collector: for sites whose devices send straight to
the Looksee server from its own networks, events are filed by range the same way.

**Standard ports 514/162 on a Linux collector.** The Linux agent runs as an unprivileged
user, so by default the collector listens on 1514/1162. Most devices let you set the
port. If one can't, set `COLLECTOR_SYSLOG_PORT=514` and/or `COLLECTOR_TRAP_PORT=162` in
`engine/.env` on the Looksee server (applies to every collector) and, on each Linux
collector machine, allow binding low ports:

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
| Discovery scans, SNMP walks and Wake-on-LAN for that site | |

Agent checks (services, files, logs, …) always run on their own endpoint's agent,
wherever it is. **Real browser** checks on a collector need Chrome/Chromium on the collector machine;
**traceroute** needs `traceroute`/`tracert` there.

### When a collector goes offline

- If the Looksee server is unreachable, the collector keeps running from its last
  configuration (it survives a restart too) and buffers up to 5,000 results and 20,000
  events, sending them when the connection returns.
- If the server hears nothing from a collector for 3 minutes (or 3 check intervals,
  whichever is longer), that site's collector-run checks turn **Unknown** with
  "Site collector on … is offline since …" — so a dead site doesn't look healthy. Add an
  **Agent online** check on the collector machine to be alerted when that happens.
- If the collector process crashes, the agent restarts it after 5 seconds (backing off
  to a minute if it keeps failing); the reason shows on the Sites and Endpoints pages.

### Direct push without a collector

For a site where you can't (or don't want to) run an agent, its devices can send
syslog/traps/flows straight to your Looksee server:

1. **Monitoring → Sites & locations → Edit** the site and enter its public (WAN) IP
   address(es) under **Public IPs (direct push)**, comma-separated. Save.
2. At the **Looksee server's** location, forward UDP 1514, 1162, 2055, 6343 and TCP 1514
   from your router to the Looksee server, and allow them in the server's firewall *from
   those public IPs only* — see [deployment guide §5](deployment-guide.md#5-firewall).
3. Point the site's devices at your Looksee server's public address on those ports.

**Check:** messages appear under **Insights → Traps & syslog** with the site's name
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
3. For each device, tick **Create endpoint** and whichever suggested checks you want
   (ping, HTTPS + certificate, SSH, RDP, SNMP interfaces, printer toner, Proxmox…).
   Devices already in Looksee — matched by MAC address, hostname or IP — are labelled
   *already an endpoint* and start unticked. A device whose SNMP identity matches an
   [SNMP template](#snmp-templates) shows **SNMP template: …** — click it to apply the
   whole set.
4. Choose the site at the bottom, click **Alerts:** to attach an alert rule to the
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
| `{{endpoint}}`, `{{site}}`, `{{location}}` | Where it is (blank if none). `{{host}}` is the same as `{{endpoint}}` |
| `{{type}}` | Check type |
| `{{time}}` | When it happened |
| `{{duration}}` | How long the incident has been open |
| `{{remediation}}` | Things to check, one per line |
| `{{url}}` | Link to the check's page in Looksee |

The editor shows a live preview with sample data. Empty variables disappear cleanly
(no dangling "Endpoint: ·").

## Alerts, escalation, and dependencies

**Alert rules** live on each check's **Alerts** tab (click **Edit** on a rule to change
any part of it), in the **Alerts** section when
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
- Filters for **location**, **site**, **endpoint** (tick several in each; they cascade
  like the Checks page's), and a search over check names and messages.
- A summary line: how many incidents, how many still open, and total problem time.
- Each row: status, the check (click for its page), where it is, when it started, how
  long it lasted, and the alert message. An open incident has **Resolve** — see
  [Resolving and recovery](#resolving-and-recovery).

A single check's incidents are also on its own page. Incidents only exist for checks with
an alert rule.

## Maintenance

**Alerting → Maintenance** schedules quiet periods. During one, checks keep running and
recording results, but no alerts are sent and SLA reports leave that time out.

1. Click **+ Schedule maintenance** and name it.
2. Choose **One time** (start and end) or **Every week** (days, start time, duration in
   minutes). Times are in your own time zone: a weekly window remembers the zone of the
   browser that scheduled it, so "Sunday 02:00" stays 02:00 where you are whatever the
   server's clock is set to. A weekly window from another zone shows that zone's name
   next to its time; one created before 4.2 says *(server's time)*.
3. Choose what it applies to: everything, chosen sites, chosen endpoints (including
   checks their agents run), chosen [groups](#groups) (whatever is in them while the
   window runs), or chosen checks.
4. Click **Schedule**. While active it's marked **active now**, and affected checks show
   **MAINTENANCE**.

For an unplanned job, use the **Maintenance…** bulk action on the Checks, Endpoints or
Sites page, a group's **Maintenance…**, or a location's **Maintenance for this
location…** — it starts a window
right now for N minutes. **End now** closes a one-time window early; weekly windows can
be turned off and on.

## SLA reports

**Insights → SLA reports** shows each check's uptime over the last 1, 7, 30, 90 or 365
days, optionally for one site. Results you
[left out of statistics](#leaving-results-out-of-statistics) don't count.

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
of daily uptime bars — never endpoints, addresses, or messages. Untick **Published** to take
a page offline without deleting it.

## Dashboards and widgets

The home page holds one or more **dashboards**, each a grid of widgets you can rearrange
(desktop only — click **Edit layout** to drag/resize) and duplicate. Each dashboard has
its own auto-refresh interval.

**Adding widgets:** click **+ Add widget**, pick the widget type from the cards, then
pick what it shows from a searchable list (filter by site; checks also match by type
and endpoint). For status tiles, uptime history and endpoint widgets you can tick
**several** —
one widget is added for each. The list doesn't move or refresh while you're choosing.

Widget types:

- **Status tile** — one check's status, latest problem message and recent history.
- **Problems right now** — counts by status for one site (or everything) plus what's
  down or warning.
- **Site summary** — a whole site's checks at a glance.
- **Uptime history** — one check's uptime % and latency over a chosen range.
- **Endpoint metrics** / **Network bandwidth** — an endpoint's CPU/RAM/disk or RX/TX
  sparklines.
- **All endpoints** — every agent endpoint's online/offline state.
- **Top talkers** — the busiest network conversations (needs flow data).
- **Alert history**, **Backup status**, **Clock**, **Note**, **Section header**.

## Security

**System → Security** controls how Looksee protects itself — important once it's
reachable from the internet. Full details, recommendations and recovery steps are in the
[security guide](security-guide.md). In short:

- **Two-factor sign-in is required.** The first sign-in after installing (or upgrading
  to 4.0) walks you through scanning a QR code with an authenticator app and saving ten
  recovery codes. Change your password, make new recovery codes, move to a new phone,
  add **passkeys or security keys** (a YubiKey, your phone, Windows Hello) to use
  instead of the code, and see/sign out other sessions under **Your account & 2FA**.
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

## Watchdog

Looksee can alert on everything except its own outage. **System → Watchdog** sets up a
"dead man's switch": while Looksee is healthy it pings an outside service every minute,
and that service alerts you when the pings stop — the server died, the power or internet
went out at home, or Looksee is stuck.

1. Create a check at an outside service. Healthchecks.io's free tier is built for this:
   **Add Check**, period 1 minute, grace 5 minutes, then choose how it tells you
   (email, Telegram, push…). Uptime Kuma's *Push* monitor works too, if it runs somewhere
   other than your homelab.
2. Paste its ping URL into **Ping URL** (and, for Healthchecks.io, the same URL plus
   `/fail` into **Failure URL**), **Save**, **Turn on**, then **Send a ping now**.
   **Check:** the outside service shows Looksee as up.

Before each ping Looksee checks itself — the database answers and the check scheduler has
run in the last two minutes. If that self-check fails it calls the failure URL instead
(or nothing, if there isn't one), so you hear about a Looksee that's running but broken.
The URLs contain the service's secret token, so they're never shown again once saved.

Prefer a service that polls you instead (UptimeRobot, Better Stack)? Point an HTTPS
monitor at `https://<your-looksee>/api/health` with the keyword `"status":"ok"`.

### Watchdog agents

The watchdog above needs an outside service. **Watchdog agents** use your own machines
instead: the agent on an endpoint (ideally at a *different* place from the Looksee
server — a relative's PC, an office server) checks every minute that it can reach
Looksee, and if it can't for a while, it sends the alert itself, straight from that
machine.

1. Open an endpoint with agent 5.0 or newer and go to its **Watchdog** tab.
2. Tick **Make this endpoint's agent a watchdog** and set **Alert after (minutes)** — 5 is a
   good start.
3. Choose how it tells you (one or both):
   - **Email to** — comma-separated addresses, sent through the SMTP server set on the
     Channels page.
   - **Also post to:** any of your Telegram, Slack, Teams or webhook channels.
4. **Save**, then **Send test** — the agent sends a test message on its next check-in
   (within a minute).

**Check:** the test arrives, and **What the agent last reported** shows **✓ Reaching
Looksee** with a recent time (**✕ Alerting** while it can't). **System → Watchdog** lists every watchdog agent and its state.

The agent sends one message when Looksee becomes unreachable and one when it's back.
To do this the agent stores the email server's settings and channel URLs on that machine
(readable only by the agent's own account) — choose endpoints you trust. Turning the
watchdog off removes them from the agent at its next check-in.

## Times and time zones

Every date and time in the dashboard is shown in **your device's time zone** — result
times, alert history, logs, charts, and times inside check messages (for example
"Rebooted at …" or "last report …"). The engine stores everything in UTC, so the
same moment shows correctly for anyone, wherever they are.

- **Weekly maintenance windows** run in the time zone of the browser that scheduled them
  (see [Maintenance](#maintenance)).
- **Public status pages** cut each daily uptime bar at the visitor's own midnight; the
  footer says *Days in your time zone*.
- **Alerts sent by email or chat** are written by the server, which doesn't know your
  zone. A time inside a check's message is in UTC and marked as such
  (`2026-10-13 14:05 UTC` or `2026-10-13T14:05:00.000Z`). A template's `{{time}}`
  variable uses the server's own clock setting.

**Check:** on a check whose message contains a time, compare it with your clock — it
should match your local time, not UTC.

## Light and dark theme

The theme button at the bottom of the sidebar cycles **System → Light → Dark**. *System* follows your
device's setting. The choice is remembered per browser. Both themes use the same
status colors (always shown with a text label too), checked for contrast.

## Backups and logs

**System → Backups** configures and runs encrypted, deduplicated backups (Borg) of the
database and secrets. "Back up now" runs one on demand; a schedule runs them
automatically. Restoring discards anything created after the chosen backup — read the
confirmation carefully.

**System → Logs** shows the engine's own activity — what it did, what failed and why —
filterable by level. Every entry above debug includes a plain-language explanation.
