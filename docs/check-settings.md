# Check Settings

Every setting of every check type, as the check form shows it — generated from the
form's own definitions, so it always matches the app. `*` marks a required setting;
*(Advanced)* settings are in the form's **Advanced** section and can be left alone.
What each check does and how to check the same thing by hand is in the
[check reference](check-reference.md); using checks in general is in the
[user guide](user-guide.md).

Every check also has the common settings — name, endpoint/site, **Run from** (for
ping, TCP, HTTP, DNS and TLS), interval, retry interval, tags, **Depends on**,
**Recovers together with**, thresholds and alert rules — described in the user guide.

This file is generated: edit `dashboard/app/lib/checkTypes.ts`, then run
`../engine/node_modules/.bin/tsx scripts/check-settings-doc.ts` in `dashboard/`.

## Contents

1. Reachability & web: [Ping](#ping), [TCP port](#tcp), [UDP port](#udp), [HTTP(S)](#http), [Real browser (headless Chrome)](#browser), [DNS](#dns), [TLS certificate](#ssl-cert), [Domain registration expiry](#domain-expiry), [WebSocket](#websocket)
2. Network services: [Mail / SSH / FTP / LDAP / RDP](#protocol), [Email round-trip](#email-roundtrip), [NTP server](#ntp), [DHCP server](#dhcp), [gRPC health](#grpc), [MQTT broker](#mqtt), [Container registry](#docker-registry), [Traceroute / path change](#traceroute), [Public IP change](#public-ip), [Device present (ARP)](#arp-presence), [IP address change (by MAC)](#ip-change)
3. Databases & apps: [Database](#database), [Prometheus metric](#prometheus), [Web server status page](#webserver-status), [App integration](#app-integration)
4. Network devices & hardware: [SNMP value / template](#snmp), [SNMP interfaces (switch / router ports)](#snmp-interfaces), [SNMP trap received](#trap-match), [Syslog message received](#syslog-match), [Server hardware (iDRAC / iLO / IPMI)](#bmc)
5. Virtualization & containers: [Proxmox VE](#proxmox), [VMware ESXi / vCenter](#vmware), [Hyper-V VMs](#agent-hyperv), [Docker containers](#agent-docker)
6. Endpoint metrics (agent): [Endpoint metric](#host-metric), [Disk full forecast](#disk-forecast), [Reboot detection](#host-reboot), [Change detection](#host-change), [Agent online](#agent-heartbeat)
7. Services & processes (agent): [OS service](#agent-service), [Process](#agent-process), [Failed / stopped services](#agent-services-overview), [Scheduled task / timer](#agent-scheduled-task), [Custom script](#agent-script)
8. Files & logs (agent): [File / folder](#agent-file), [Log file pattern](#agent-log), [systemd journal](#agent-journal), [Windows Event Log](#agent-eventlog)
9. OS & hardware (agent): [Windows performance counter](#agent-perfcounter), [VPN tunnel](#agent-vpn), [UPS (NUT / apcupsd)](#agent-ups), [Backup job (Borg / restic / Veeam)](#agent-backup)
10. Software & security (agent): [Upgradable packages](#host-packages), [Installed software changed](#host-software), [Vulnerable or unsupported software](#host-vulnerable)
11. Push & smart: [Heartbeat (cron / job check-in)](#heartbeat), [Push a value](#push-value), [Calculated value](#calculated), [Anomaly (unusual value)](#anomaly)

## Reachability & web

<a id="ping"></a>

### Ping

Type ID `ping`. ICMP ping with packet loss, jitter and round-trip time.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Address * | text | — | Hostname or IP address of what to check. Example: `8.8.8.8`. |
| Pings per check | number | 3 | — |
| Warn at loss % | number | — | Example: `20`. |
| Critical at loss % | number | — | Example: `50`. |
| Warn at jitter (ms) *(Advanced)* | number | — | — |
| Critical at jitter (ms) *(Advanced)* | number | — | — |

<a id="tcp"></a>

### TCP port

Type ID `tcp`. Opens a TCP connection to host:port. Optionally sends text and checks the reply (a banner, or an answer to a simple command).

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Address * | text | — | Hostname or IP address of what to check. Example: `10.0.0.5`. |
| Port * | number | — | Example: `5432`. |
| Timeout (seconds) *(Advanced)* | number | 5 | How long to wait for the connection (and the reply, when one is expected). |
| Send after connecting *(Advanced)* | text | — | Optional. Type \r and \n for line breaks. Example: `PING\r\n`. |
| Reply must contain *(Advanced)* | text | — | Optional. Without it, connecting is enough. With it, the service must answer — catches a port that's open but hung. Example: `+PONG`. |

<a id="udp"></a>

### UDP port

Type ID `udp`. Sends a UDP payload and expects a reply (UDP has no handshake, so a reply is the only proof).

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Address * | text | — | Hostname or IP address of what to check. Example: `10.0.0.5`. |
| Port * | number | — | Example: `161`. |
| Payload | text | ping | — |
| Payload is hex | on/off | — | — |
| Reply must contain | text | — | — |
| Timeout (seconds) *(Advanced)* | number | 5 | — |

<a id="http"></a>

### HTTP(S)

Type ID `http`. Requests a URL; checks status, body text/regex, JSON fields, redirects and response time.

**Value:** the number at the JSON path, if it's numeric. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| URL * | text | — | Example: `https://example.com/health`. |
| Method | choice | GET | Options: GET; POST; HEAD; PUT; DELETE; OPTIONS. |
| Expected status | text | — | Blank accepts anything under 400. Example: `200 or 200-299,301 or 2xx`. |
| Body must contain | text | — | — |
| Body must NOT contain | text | — | Example: `error`. |
| Body must match regex *(Advanced)* | text | — | — |
| JSON path *(Advanced)* | text | — | Example: `$.status`. |
| JSON comparison *(Advanced)* | choice | equals | Options: equals; does not equal (`not_equals`); contains; greater than (`gt`); less than (`lt`); exists. Shown only for some choices of the settings above. |
| JSON expected value *(Advanced)* | text | — | Shown only for some choices of the settings above. |
| Extra headers *(Advanced)* | text (several lines) | — | One "Name: value" per line. Example: `Authorization: Bearer ...`. |
| Request body *(Advanced)* | text (several lines) | — | Shown only for some choices of the settings above. |
| Follow redirects *(Advanced)* | on/off | on | — |
| Must end at URL *(Advanced)* | text | — | — |
| Warn above N redirects *(Advanced)* | number | — | — |
| Timeout (seconds) *(Advanced)* | number | 10 | — |
| Skip TLS certificate verification *(Advanced)* | on/off | — | For self-signed or internal certificates only — weakens security for anything public-facing. |

<a id="browser"></a>

### Real browser (headless Chrome)

Type ID `browser`. Loads the page in headless Chrome: checks it renders, waits for an element, catches JavaScript errors. Needs Chrome/Chromium on the engine host.

**Value:** page load time (ms). Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| URL * | text | — | — |
| Wait for element (CSS selector) | text | — | Example: `#app`. |
| Rendered text must contain | text | — | — |
| Warn on JavaScript errors | on/off | on | — |
| Timeout (seconds) *(Advanced)* | number | 30 | — |
| Skip TLS certificate verification *(Advanced)* | on/off | — | For self-signed or internal certificates only — weakens security for anything public-facing. |

<a id="dns"></a>

### DNS

Type ID `dns`. Resolves a name (any record type), optionally via a specific server, checks the answer and DNSSEC.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Name to resolve * | text | — | Example: `example.com`. |
| Record type | choice | A | Options: A; AAAA; MX; TXT; CNAME; NS; SOA; SRV; PTR; CAA. |
| DNS server | text | — | e.g. 10.0.0.53 or 1.1.1.1:53 Example: `system resolver`. |
| Answer must contain | text | — | — |
| Require DNSSEC validation (AD flag) | on/off | — | Needs a validating resolver. Engine only — not available on remote agent probes. |
| Timeout (seconds) *(Advanced)* | number | 5 | How long to wait for each try. |
| Tries *(Advanced)* | number | 2 | How many times to ask before giving up (1–5). |

<a id="ssl-cert"></a>

### TLS certificate

Type ID `ssl_cert`. Days to expiry, chain trust, hostname match, and whether TLS 1.0/1.1 is still accepted.

**Value:** days until expiry (days). Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Address * | text | — | Hostname or IP address of what to check. Example: `example.com`. |
| Port | number | — | Example: `443`. |
| Warn within (days) | number | 14 | — |
| Critical within (days) | number | 3 | — |
| Require a trusted chain | on/off | on | — |
| Require hostname match | on/off | on | — |
| Warn if TLS 1.0/1.1 is accepted | on/off | on | — |
| Certificate name (SNI) *(Advanced)* | text | — | The name to ask the server for and check the certificate against — for checking by IP address or one name behind a shared address. Blank = the host above. Example: `www.example.com`. |
| Timeout (seconds) *(Advanced)* | number | 5 | How long to wait for the TLS connection. |

<a id="domain-expiry"></a>

### Domain registration expiry

Type ID `domain_expiry`. Reads the domain's expiry date from its registry over RDAP.

**Value:** days until the registration expires (days). Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Domain * | text | — | Example: `example.com`. |
| Warn within (days) | number | 30 | — |
| Critical within (days) | number | 7 | — |
| RDAP server override *(Advanced)* | text | — | — |

<a id="websocket"></a>

### WebSocket

Type ID `websocket`. Opens a ws:// or wss:// connection, optionally sends a message and waits for a reply.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| URL * | text | — | Example: `wss://example.com/socket`. |
| Send on connect | text | — | — |
| Wait for a message containing | text | — | — |
| Timeout (seconds) *(Advanced)* | number | 10 | — |
| Skip TLS certificate verification *(Advanced)* | on/off | — | For self-signed or internal certificates only — weakens security for anything public-facing. |

## Network services

<a id="protocol"></a>

### Mail / SSH / FTP / LDAP / RDP

Type ID `protocol`. Speaks just enough of the protocol to prove the service answers: SMTP (with STARTTLS), IMAP, POP3, FTP, SSH, LDAP bind, RDP.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Protocol | choice | smtp | Options: smtp; submission; smtps; imap; imaps; pop3; pop3s; ftp; ftps; ssh; sftp; ldap; ldaps; rdp. |
| Address * | text | — | Hostname or IP address of what to check. Example: `mail.example.com`. |
| Port | number | — | Example: `protocol default`. |
| Require STARTTLS | on/off | — | Shown only for some choices of the settings above. |
| Bind DN | text | — | Example: `anonymous`. Shown only for some choices of the settings above. |
| Bind password | secret (write-only) | — | Shown only for some choices of the settings above. |
| Response must match (regex) *(Advanced)* | text | — | Example: `OpenSSH_9`. |
| Timeout (seconds) *(Advanced)* | number | 8 | — |
| Skip TLS certificate verification *(Advanced)* | on/off | — | For self-signed or internal certificates only — weakens security for anything public-facing. |

<a id="email-roundtrip"></a>

### Email round-trip

Type ID `email_roundtrip`. Sends a tagged message by SMTP and waits for it to arrive over IMAP — proves mail actually flows end to end.

**Value:** delivery time in seconds (s). Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| SMTP host * | text | — | — |
| SMTP port | number | 587 | — |
| SMTP user | text | — | — |
| SMTP password | secret (write-only) | — | — |
| From | text | — | — |
| To (mailbox to watch) * | text | — | — |
| IMAP host * | text | — | — |
| IMAP port | number | 993 | — |
| IMAP user | text | — | Example: `same as To`. |
| IMAP password | secret (write-only) | — | — |
| Mailbox *(Advanced)* | text | INBOX | — |
| Delete the test message *(Advanced)* | on/off | on | — |
| Timeout (seconds) *(Advanced)* | number | 120 | — |
| Skip TLS certificate verification *(Advanced)* | on/off | — | For self-signed or internal certificates only — weakens security for anything public-facing. |

<a id="ntp"></a>

### NTP server

Type ID `ntp`. Queries an NTP server: is it synchronized (stratum) and how far off is its time.

**Value:** absolute clock offset (ms). Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Address * | text | — | Hostname or IP address of what to check. Example: `pool.ntp.org`. |
| Port | number | — | Example: `123`. |
| Warn at offset (ms) | number | — | Example: `100`. |
| Critical at offset (ms) | number | — | Example: `1000`. |
| Max stratum *(Advanced)* | number | — | — |

<a id="dhcp"></a>

### DHCP server

Type ID `dhcp`. Broadcasts a DHCP DISCOVER and expects an offer (no lease is taken). Set the expected server to detect rogue DHCP. Needs the engine to bind UDP 68 — see the deployment guide.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Send to | text | — | Example: `255.255.255.255 (broadcast)`. |
| Expected server IP | text | — | An offer from any other server is reported as a possible rogue DHCP server. |
| Timeout (seconds) *(Advanced)* | number | 5 | — |

<a id="grpc"></a>

### gRPC health

Type ID `grpc`. Calls the standard grpc.health.v1 Health/Check.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Address * | text | — | Hostname or IP address of what to check. Example: `10.0.0.5`. |
| Port * | number | — | Example: `50051`. |
| Service name | text | — | Example: `(whole server)`. |
| Use TLS | on/off | — | — |
| Skip TLS certificate verification *(Advanced)* | on/off | — | For self-signed or internal certificates only — weakens security for anything public-facing. |
| Timeout (seconds) *(Advanced)* | number | 8 | — |

<a id="mqtt"></a>

### MQTT broker

Type ID `mqtt`. Connects to an MQTT broker and checks the CONNACK.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Address * | text | — | Hostname or IP address of what to check. Example: `10.0.0.5`. |
| Port | number | — | Example: `1883 / 8883`. |
| Use TLS | on/off | — | — |
| Username | text | — | — |
| Password | secret (write-only) | — | — |
| Skip TLS certificate verification *(Advanced)* | on/off | — | For self-signed or internal certificates only — weakens security for anything public-facing. |

<a id="docker-registry"></a>

### Container registry

Type ID `docker_registry`. Checks a Docker/OCI registry answers, and optionally that an image tag exists.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Registry URL * | text | — | Example: `https://registry.example.com`. |
| Image | text | — | Example: `library/nginx`. |
| Tag | text | latest | — |
| Username *(Advanced)* | text | — | — |
| Password / token *(Advanced)* | secret (write-only) | — | — |
| Skip TLS certificate verification *(Advanced)* | on/off | — | For self-signed or internal certificates only — weakens security for anything public-facing. |

<a id="traceroute"></a>

### Traceroute / path change

Type ID `traceroute`. Traces the route to a host and warns when the path changes or stops reaching it.

**Value:** hop count (hops). Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Address * | text | — | Hostname or IP address of what to check. Example: `1.1.1.1`. |
| Max hops *(Advanced)* | number | 30 | — |
| Path must pass through | text | — | Example: `10.0.0.1`. |
| Fail if the destination isn't reached | on/off | on | — |
| Status on path change | choice | warn | Options: warn; down. |

<a id="public-ip"></a>

### Public IP change

Type ID `public_ip`. Tracks the engine's public IP address and flags when it changes.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| IP lookup URL | text | https://api.ipify.org | — |
| Expected IP | text | — | Down whenever the IP isn't this one. |
| Status on change | choice | warn | Options: warn; down. |
| Hold the alert status for (minutes) *(Advanced)* | number | 15 | One-time events stay failing this long so a normal 2-in-a-row alert rule still catches them. |

<a id="arp-presence"></a>

### Device present (ARP)

Type ID `arp_presence`. Is a device on the engine's own LAN segment? Works even for devices that ignore ping. Optionally verifies its MAC (spots IP conflicts and swapped hardware).

| Setting | Kind | Default | Notes |
|---|---|---|---|
| IP address | text | — | — |
| MAC address | text | — | Example: `aa:bb:cc:dd:ee:ff`. |

<a id="ip-change"></a>

### IP address change (by MAC)

Type ID `ip_change`. Flags when a device's MAC address shows up at a new IP — from agent reports, discovery scans and ARP checks. Catches DHCP lease changes that break checks targeting the old address.

**Value:** IP changes in the last 24 hours. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| MAC address | text | — | Leave blank and pick an endpoint to watch every MAC the agent reports for it. Example: `blank = the endpoint's own MAC(s)`. |
| Status when triggered | choice | Warn | Options: Down (critical) (`down`); Warn (`warn`). |
| Hold the alert status for (minutes) *(Advanced)* | number | 60 | How long the check stays failing after a change, so an alert rule catches it. |
| Also watch IPv6 addresses *(Advanced)* | on/off | — | Off by default: IPv6 privacy addresses change by design. |

## Databases & apps

<a id="database"></a>

### Database

Type ID `database`. Logs in to PostgreSQL, MySQL/MariaDB, SQL Server, Redis or MongoDB and checks it works — or reads connections, replication lag, size, or long-running queries.

**Value:** the selected metric. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Engine | choice | PostgreSQL | Options: PostgreSQL (`postgres`); MySQL / MariaDB (`mysql`); SQL Server (`mssql`); Redis (`redis`); MongoDB (`mongodb`). |
| Address * | text | — | Hostname or IP address of what to check. Example: `db.lan`. |
| Port | number | — | Example: `engine default`. |
| Username | text | — | — |
| Password | secret (write-only) | — | — |
| Database | text | — | Shown only for some choices of the settings above. |
| What to check | choice | Can connect and query | Options: Can connect and query (`connect`); Value returned by a query (`query_value`); Connections (% of max) (`connections_percent`); Replication lag (s) (`replication_lag_seconds`); Database size (MB) (`database_size_mb`); Long-running queries (`long_queries`); Memory used (MB, Redis/Mongo) (`memory_mb`). |
| Query | text (several lines) | — | Example: `SELECT 1`. Shown only for some choices of the settings above. |
| Long = running longer than (s) | number | 60 | Shown only for some choices of the settings above. |
| Use TLS *(Advanced)* | on/off | — | — |
| Skip TLS certificate verification *(Advanced)* | on/off | — | For self-signed or internal certificates only — weakens security for anything public-facing. |
| Connection URI (overrides the fields above) *(Advanced)* | secret (write-only) | — | Shown only for some choices of the settings above. |

<a id="prometheus"></a>

### Prometheus metric

Type ID `prometheus`. Scrapes any Prometheus /metrics site (node_exporter, cAdvisor, Caddy, Traefik, …) and puts thresholds on one metric.

**Value:** the aggregated metric (per second if 'rate' is on). Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Metrics URL * | text | — | Example: `http://host:9100/metrics`. |
| Metric name * | text | — | Example: `node_filesystem_avail_bytes`. |
| Label filter | text | — | Example: `mountpoint="/", fstype!="tmpfs"`. |
| Combine series by | choice | sum | Options: sum; avg; min; max; count. |
| It's a counter — show per-second rate | on/off | — | — |
| Bearer token *(Advanced)* | secret (write-only) | — | — |
| Extra headers *(Advanced)* | text (several lines) | — | — |
| Skip TLS certificate verification *(Advanced)* | on/off | — | For self-signed or internal certificates only — weakens security for anything public-facing. |

<a id="webserver-status"></a>

### Web server status page

Type ID `webserver_status`. Reads nginx stub_status, Apache mod_status, or Caddy's metrics: connections, request rate, busy workers.

**Value:** the selected metric. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Server | choice | nginx (stub_status) | Options: nginx (stub_status) (`nginx`); Apache (mod_status) (`apache`); Caddy (metrics) (`caddy`). |
| Status URL * | text | — | Example: `http://127.0.0.1/nginx_status`. |
| Metric | choice | Requests / sec | Options: Requests / sec (`requests_per_sec`); Active connections (`active_connections`); Waiting (keep-alive) — nginx (`waiting`); Dropped connections / sec — nginx (`dropped_per_sec`); Busy workers — Apache (`busy_workers`); Busy workers % — Apache (`busy_percent`); Errors / sec — Caddy (`errors_per_sec`). |
| Skip TLS certificate verification *(Advanced)* | on/off | — | For self-signed or internal certificates only — weakens security for anything public-facing. |

<a id="app-integration"></a>

### App integration

Type ID `app_integration`. First-party APIs of Nextcloud, Home Assistant, Plex, Jellyfin and Pi-hole, or any JSON API.

**Value:** the selected metric. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| App | choice | Nextcloud | Options: Nextcloud (`nextcloud`); Home Assistant (`home_assistant`); Plex (`plex`); Jellyfin (`jellyfin`); Pi-hole (`pihole`); Any JSON API (`custom_json`). |
| Base URL * | text | — | Example: `https://cloud.example.com`. |
| Token / password | secret (write-only) | — | Nextcloud: serverinfo NC-Token. Home Assistant: long-lived token. Plex: X-Plex-Token. Jellyfin: API key. Pi-hole: app password. |
| Metric | choice | Up / healthy | Options: Up / healthy (`status`); Free space GB (Nextcloud) (`free_space_gb`); Active users (Nextcloud) (`active_users`); App updates (Nextcloud) (`updates_available`); Active streams (Plex/Jellyfin) (`active_streams`); % blocked (Pi-hole) (`percent_blocked`); Queries today (Pi-hole) (`queries_today`). Shown only for some choices of the settings above. |
| Entity | text | — | Example: `sensor.outdoor_temp`. Shown only for some choices of the settings above. |
| Expected state | text | — | Example: `on`. Shown only for some choices of the settings above. |
| Path | text | — | Example: `/api/health`. Shown only for some choices of the settings above. |
| JSON path | text | — | Example: `$.data.count`. Shown only for some choices of the settings above. |
| Skip TLS certificate verification *(Advanced)* | on/off | — | For self-signed or internal certificates only — weakens security for anything public-facing. |

## Network devices & hardware

<a id="snmp"></a>

### SNMP value / template

Type ID `snmp`. Reads one OID, a walked subtree, or a ready-made template (printer toner, UPS, CPU, storage, reboot detection, temperatures).

**Value:** the value read (or computed by the template). Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Address * | text | — | Hostname or IP address of what to check. Example: `10.0.0.20`. |
| Port | number | — | Example: `161`. |
| SNMP version | choice | 2c | Options: 1; 2c; 3. |
| Community | text | public | Shown only for some choices of the settings above. |
| v3 username | text | — | Shown only for some choices of the settings above. |
| Security level | choice | authPriv | Options: noAuthNoPriv; authNoPriv; authPriv. Shown only for some choices of the settings above. |
| Auth protocol | choice | sha | Options: md5; sha; sha224; sha256; sha384; sha512. Shown only for some choices of the settings above. |
| Auth key | secret (write-only) | — | Shown only for some choices of the settings above. |
| Privacy protocol | choice | aes | Options: des; aes; aes256b; aes256r. Shown only for some choices of the settings above. |
| Privacy key | secret (write-only) | — | Shown only for some choices of the settings above. |
| Template | choice | — | Options: Custom OID (``); Printer: lowest toner/ink % (`printer_supplies`); Printer: errors (jam, paper, offline…) (`printer_status`); Printer: failed / aborted print jobs (`printer_jobs`); UPS: battery % (`ups_battery`); UPS: minutes remaining (`ups_runtime`); UPS: on battery? (`ups_on_battery`); CPU % (HOST-RESOURCES) (`hr_cpu`); Memory % (HOST-RESOURCES) (`hr_memory`); Fullest disk % (HOST-RESOURCES) (`hr_storage`); Hottest sensor °C (ENTITY-SENSOR) (`sensor_temp_max`); Reboot detection (sysUpTime) (`uptime_reboot`). |
| OID | text | — | Leave blank when the result is calculated from Extra OIDs alone (Advanced). Example: `1.3.6.1.2.1.1.3.0`. Shown only for some choices of the settings above. |
| Read as | choice | Single value | Walk modes read every value under the OID. Full walk records all of them in the result (the check page shows the table). Options: Single value (`get`); Walk: average (`walk_avg`); Walk: sum (`walk_sum`); Walk: minimum (`walk_min`); Walk: maximum (`walk_max`); Walk: count (`walk_count`); Full walk: keep every value (`walk_all`). Shown only for some choices of the settings above. |
| Value of a full walk | choice | Number of rows | Options: Number of rows (`count`); Sum (`sum`); Average (`avg`); Minimum (`min`); Maximum (`max`). Shown only for some choices of the settings above. |
| Counter — report per-second rate | on/off | — | For counters (octets, packets, errors). On a walk each row's rate is worked out separately, then combined — so "max" is the busiest row's rate. Shown only for some choices of the settings above. |
| Only rows whose index matches (regex) *(Advanced)* | text | — | Example: `^(1\|2\|3)$`. Shown only for some choices of the settings above. |
| Keep at most N rows *(Advanced)* | number | 2000 | Shown only for some choices of the settings above. |
| Multiply by *(Advanced)* | number | — | Shown only for some choices of the settings above. |
| Unit label *(Advanced)* | text | — | Shown only for some choices of the settings above. |
| Text value must contain *(Advanced)* | text | — | Shown only for some choices of the settings above. |
| Calculate *(Advanced)* | text | — | Optional maths on the value read, after “Multiply by”: value / 10, value * 8 / 1e6, round(value / 1024, 1). Use the names of Extra OIDs (below) to combine several values from this device, and ref for another check's latest value. + - * / % ^, brackets, min max abs round floor ceil sqrt log10. Example: `value / 10`. |
| Extra OIDs (name = OID) *(Advanced)* | text (several lines) | — | More values read from this device in the same poll, one per line, for Calculate to use by name — e.g. used / size * 100. rate(…) turns a counter into a per-second rate. With these, the main OID is optional. Example: `used = 1.3.6.1.2.1.25.2.3.1.6.1 ⏎ size = 1.3.6.1.2.1.25.2.3.1.5.1 ⏎ inb = rate(1.3.6.1.2.1.31.1.1.1.6.1)`. |
| ref = this check's latest value *(Advanced)* | another check | — | For a value worked out from another check — e.g. this counter as a % of a capacity another check reads. Shown only for some choices of the settings above. |
| Disk name filter | text | — | Shown only for some choices of the settings above. |
| Count canceled jobs as failures too | on/off | — | Shown only for some choices of the settings above. |
| Status when triggered | choice | Warn | Options: Down (critical) (`down`); Warn (`warn`). Shown only for some choices of the settings above. |
| Hold the alert status for (minutes) *(Advanced)* | number | 15 | One-time events stay failing this long so a normal 2-in-a-row alert rule still catches them. Shown only for some choices of the settings above. |

<a id="snmp-interfaces"></a>

### SNMP interfaces (switch / router ports)

Type ID `snmp_interfaces`. Walks the whole interface table: ports that went down, utilization, and error rates — one check per device.

**Value:** busiest port's utilization (%). Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Address * | text | — | Hostname or IP address of what to check. Example: `10.0.0.2`. |
| Port | number | — | Example: `161`. |
| SNMP version | choice | 2c | Options: 1; 2c; 3. |
| Community | text | public | Shown only for some choices of the settings above. |
| v3 username | text | — | Shown only for some choices of the settings above. |
| Security level | choice | authPriv | Options: noAuthNoPriv; authNoPriv; authPriv. Shown only for some choices of the settings above. |
| Auth protocol | choice | sha | Options: md5; sha; sha224; sha256; sha384; sha512. Shown only for some choices of the settings above. |
| Auth key | secret (write-only) | — | Shown only for some choices of the settings above. |
| Privacy protocol | choice | aes | Options: des; aes; aes256b; aes256r. Shown only for some choices of the settings above. |
| Privacy key | secret (write-only) | — | Shown only for some choices of the settings above. |
| Only interfaces matching (regex) | text | — | Example: `^(Gi\|eth\|port)`. |
| Fail when an enabled port is down | on/off | on | — |
| Status for a down port | choice | down | Options: down; warn. |
| Warn at utilization % | number | — | Example: `80`. |
| Critical at utilization % | number | — | Example: `95`. |
| Warn at errors+discards / sec | number | — | Example: `1`. |
| Exclude interfaces *(Advanced)* | text (several lines) | — | One per line; whole names, case ignored, * matches anything. Reusable lists for many checks: the Exclusions page. Example: `Vlan1 ⏎ Null0 ⏎ loopback*`. |

<a id="trap-match"></a>

### SNMP trap received

Type ID `trap_match`. Fails when matching SNMP traps arrive (point devices' trap destination at the engine, UDP 1162 by default).

**Value:** matching traps in the window. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| From IP | text | — | Example: `any`. |
| Text matches (regex) | text | — | Example: `linkDown`. |
| Window (minutes) | number | 5 | — |
| Clears when text matches (regex) | text | — | A matching event arriving after a failure recovers the check straight away — e.g. linkUp after linkDown. Same sender/site filters apply. Example: `linkUp`. |
| Recover on its own after (minutes) | number | — | With no thresholds, the check stays failing until this long after the newest matching event. Blank = the window length. Example: `same as window`. |
| Ignore messages containing *(Advanced)* | text (several lines) | — | Events whose message contains any of these (case-insensitive) are ignored entirely. Example: `one text per line`. |
| Status when triggered | choice | Down (critical) | Options: Down (critical) (`down`); Warn (`warn`). |

<a id="syslog-match"></a>

### Syslog message received

Type ID `syslog_match`. Fails when matching syslog lines arrive (send syslog to the engine, UDP/TCP 1514 by default).

**Value:** matching messages in the window. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| From IP | text | — | Example: `any`. |
| Text matches (regex) | text | — | Example: `link down\|failed`. |
| Severity at or above | choice | error | Options: any (``); emergency (`0`); alert (`1`); critical (`2`); error (`3`); warning (`4`); notice (`5`); info (`6`). |
| Window (minutes) | number | 5 | — |
| Clears when text matches (regex) | text | — | A matching event arriving after a failure recovers the check straight away — e.g. linkUp after linkDown. Same sender/site filters apply. Example: `linkUp`. |
| Recover on its own after (minutes) | number | — | With no thresholds, the check stays failing until this long after the newest matching event. Blank = the window length. Example: `same as window`. |
| Ignore messages containing *(Advanced)* | text (several lines) | — | Events whose message contains any of these (case-insensitive) are ignored entirely. Example: `one text per line`. |
| Status when triggered | choice | Down (critical) | Options: Down (critical) (`down`); Warn (`warn`). |

<a id="bmc"></a>

### Server hardware (iDRAC / iLO / IPMI)

Type ID `bmc`. Power supplies, fans, temperatures and overall health from the server's BMC — Redfish for modern boards, IPMI (ipmitool) for older ones.

**Value:** hottest temperature sensor (°C). Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Protocol | choice | Redfish (iDRAC 8+, iLO 4+, Supermicro X10+) | Options: Redfish (iDRAC 8+, iLO 4+, Supermicro X10+) (`redfish`); IPMI over LAN (needs ipmitool) (`ipmi`). |
| BMC URL * | text | — | Example: `https://10.0.0.30`. Shown only for some choices of the settings above. |
| BMC host * | text | — | Shown only for some choices of the settings above. |
| Username | text | — | — |
| Password | secret (write-only) | — | — |
| Fail if the server is powered off | on/off | on | Shown only for some choices of the settings above. |
| Skip TLS certificate verification *(Advanced)* | on/off | on | For self-signed or internal certificates only — weakens security for anything public-facing. |

## Virtualization & containers

<a id="proxmox"></a>

### Proxmox VE

Type ID `proxmox`. Cluster quorum, node load, a VM/container's state, storage usage, or the age of the last successful backup — via an API token.

**Value:** CPU/RAM %, storage %, stopped guests, or hours since backup. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| API URL * | text | — | Example: `https://pve.lan:8006`. |
| Token ID * | text | — | Example: `monitor@pve!looksee`. |
| Token secret * | secret (write-only) | — | — |
| Check | choice | Node CPU / memory | Options: Node CPU / memory (`node`); Cluster quorum & nodes (`cluster`); VM / container state (`vm`); Storage usage (`storage`); Last backup (vzdump) (`backups`). |
| Node / VMID / storage name | text | — | Example: `pve1, 101, local-zfs, or * for all guests`. Shown only for some choices of the settings above. |
| Metric | choice | CPU % | Options: CPU % (`cpu_percent`); Memory % (`memory_percent`). Shown only for some choices of the settings above. |
| Expected state | text | running | Shown only for some choices of the settings above. |
| Max hours since last OK backup | number | 26 | Shown only for some choices of the settings above. |
| Skip TLS certificate verification *(Advanced)* | on/off | on | For self-signed or internal certificates only — weakens security for anything public-facing. |

<a id="vmware"></a>

### VMware ESXi / vCenter

Type ID `vmware`. VM power state, datastore space, or host health over the vSphere API.

**Value:** VMs not powered on, or datastore %. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Endpoint / vCenter URL * | text | — | Example: `https://esxi.lan`. |
| Username | text | — | — |
| Password | secret (write-only) | — | — |
| Check | choice | VM power state | Options: VM power state (`vm`); Datastore space (`datastore`); Endpoint health (`host`). |
| Name (or * for all) | text | — | Example: `*`. |
| Skip TLS certificate verification *(Advanced)* | on/off | on | For self-signed or internal certificates only — weakens security for anything public-facing. |

<a id="agent-hyperv"></a>

### Hyper-V VMs

Type ID `agent_hyperv`. VM state on a Hyper-V host (via the agent on that machine).

**Value:** VMs not running (or the VM's CPU %). Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| VM name (or * for all) | text | * | — |
| Ignore VMs | text | — | Example: `comma-separated; * wildcards`. |
| Expected state *(Advanced)* | text | Running | — |
| Status when triggered | choice | Down (critical) | Options: Down (critical) (`down`); Warn (`warn`). |

<a id="agent-docker"></a>

### Docker containers

Type ID `agent_docker`. Container running/healthy state, restarts, or CPU/memory — via the agent on the Docker host.

**Value:** problem count, restarts, or CPU/memory %. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Container (name, glob, or *) | text | * | — |
| Measure | choice | Running & healthy | Options: Running & healthy (`status`); Restarts since last check (`restart_count`); CPU % (`cpu_percent`); Memory % of limit (`memory_percent`). |
| Ignore stopped containers | on/off | — | — |
| Exclude containers *(Advanced)* | text (several lines) | — | One per line; whole names, case ignored, * matches anything. Reusable lists for many checks: the Exclusions page. Example: `*-migrate ⏎ backup-job`. |
| Status when triggered | choice | Down (critical) | Options: Down (critical) (`down`); Warn (`warn`). |
| Hold the alert status for (minutes) *(Advanced)* | number | 15 | One-time events stay failing this long so a normal 2-in-a-row alert rule still catches them. |

## Endpoint metrics (agent)

<a id="host-metric"></a>

### Endpoint metric

Type ID `host_metric`. Any of 60+ metrics the agent reports: CPU detail, load, swap, every disk, inodes, I/O, interfaces, temperatures, SMART, RAID, updates, firewall, Defender, encryption…

**Value:** the metric. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Metric * | metric | — | — |
| Exclude mounts, interfaces, devices or sensors *(Advanced)* | text (several lines) | — | One per line; whole names, case ignored, * matches anything. Reusable lists for many checks: the Exclusions page. Example: `/snap/* ⏎ veth* ⏎ loop*`. |

<a id="disk-forecast"></a>

### Disk full forecast

Type ID `disk_forecast`. Projects when a disk fills at its recent growth rate.

**Value:** days until full (days). Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Mount (blank = soonest to fill) | text | — | — |
| Trend over (days) *(Advanced)* | number | 7 | Longer smooths out weekly patterns; shorter reacts faster to a sudden change in growth. |
| Warn when full within (days) | number | 14 | — |
| Critical when full within (days) | number | 3 | — |

<a id="host-reboot"></a>

### Reboot detection

Type ID `host_reboot`. Flags every reboot so an unplanned one doesn't go unnoticed.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Status when triggered | choice | Warn | Options: Down (critical) (`down`); Warn (`warn`). |
| Hold the alert status for (minutes) *(Advanced)* | number | 15 | One-time events stay failing this long so a normal 2-in-a-row alert rule still catches them. |

<a id="host-change"></a>

### Change detection

Type ID `host_change`. Alerts when something about the endpoint changes: new login sessions, listening ports, hardware/OS inventory, interfaces, mounts.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Watch | choice | New login sessions | Options: New login sessions (`sessions`); Listening ports (`listening_ports`); Hardware / OS inventory (`inventory`); Network interfaces (`interfaces`); Mounted filesystems (`mounts`). |
| Status when triggered | choice | Warn | Options: Down (critical) (`down`); Warn (`warn`). |
| Hold the alert status for (minutes) *(Advanced)* | number | 15 | One-time events stay failing this long so a normal 2-in-a-row alert rule still catches them. |

<a id="agent-heartbeat"></a>

### Agent online

Type ID `agent_heartbeat`. Fails if the endpoint's agent stops reporting — machine down, agent crashed, or network cut.

**Value:** seconds since the last report (s). Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Allowed silence (seconds) | number | 180 | — |
| Status when silent *(Advanced)* | choice | Down | Options: Down (`down`); Warn — e.g. laptops that sleep (`warn`). |

## Services & processes (agent)

<a id="agent-service"></a>

### OS service

Type ID `agent_service`. Is a systemd unit / Windows service running. On Linux also counts restarts.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Service * | text | — | — |
| Warn above N restarts / hour | number | — | systemd only. |
| Should be *(Advanced)* | choice | Running | Stopped makes this a check that a risky or unneeded service stays off. Needs agent 5.0. Options: Running (`running`); Stopped — e.g. Telnet, Remote Registry (`stopped`). |
| Status when triggered *(Advanced)* | choice | Down (critical) | Options: Down (critical) (`down`); Warn (`warn`). |

<a id="agent-process"></a>

### Process

Type ID `agent_process`. Process running (by name substring), how many, and their CPU / memory.

**Value:** count, CPU %, or MB. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Process name * | text | — | — |
| Measure | choice | Instance count | Options: Instance count (`count`); CPU % (`cpu_percent`); Memory (MB) (`memory_mb`). |
| At least N running | number | 1 | — |
| At most N running | number | — | — |

<a id="agent-services-overview"></a>

### Failed / stopped services

Type ID `agent_services_overview`. Any failed systemd unit (Linux), or any automatic-start service that isn't running (Windows).

**Value:** how many. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Ignore | text (several lines) | — | Whole names, case ignored, * matches anything. Reusable lists for many endpoints: the Exclusions page. Example: `one name per line or comma-separated`. |
| Also count services that stopped cleanly (Windows) *(Advanced)* | on/off | — | Off by default: updaters and on-demand services routinely stop themselves with exit code 0. |
| Status when triggered | choice | Down (critical) | Options: Down (critical) (`down`); Warn (`warn`). |

<a id="agent-scheduled-task"></a>

### Scheduled task / timer

Type ID `agent_scheduled_task`. Last result and run time of a Windows scheduled task or a systemd timer. (For cron jobs, use a Heartbeat.)

**Value:** hours since it last ran (h). Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Task / unit * | text | — | Example: `\Backup\Nightly or backup.timer`. |
| Fail if it hasn't run for (hours) | number | — | — |

<a id="agent-script"></a>

### Custom script

Type ID `agent_script`. Runs a script or command wrapper from the agent's script_dir and checks its output and exit code. Without an expected output, exit 0/1/2 = up/warn/down (Nagios convention); a number in the output becomes the value.

**Value:** perfdata or first number in the output. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Script file name * | text | — | Must sit directly in script_dir on that endpoint — the list shows what the agent found there. Looksee never sends commands to run; see the agent README → Custom scripts. Example: `check_queue.sh`. |
| Arguments | text | — | — |
| Expected output | choice | — | Options: None — use the exit code (``); Contains (`contains`); Does not contain (`not_contains`); Equals (whole output) (`equals`); Matches regex (`regex`). |
| Expected text / pattern * | text | — | Shown only for some choices of the settings above. |
| Ignore case | on/off | — | Shown only for some choices of the settings above. |
| Expected exit code | number | — | Blank = any exit code is fine when an expected output is set. Example: `any`. |
| Status when it doesn't match | choice | Down (critical) | Options: Down (critical) (`down`); Warn (`warn`). Shown only for some choices of the settings above. |
| Timeout (seconds) *(Advanced)* | number | 30 | — |
| Read a number from the output *(Advanced)* | on/off | on | — |

## Files & logs (agent)

<a id="agent-file"></a>

### File / folder

Type ID `agent_file`. Exists, age (did the backup land?), size, file count, folder size, checksum drift, or a folder watchdog for created/changed/deleted files.

**Value:** minutes old, MB, or count. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Path * | text | — | Example: `/srv/backups or C:\Backups`. |
| Check | choice | Exists | Options: Exists (`exists`); Doesn't exist (`not_exists`); Age of file / newest file in folder (`age`); File size (MB) (`size`); Number of files in folder (`count`); Folder size (MB) (`folder_size`); Content changed (checksum) (`checksum`); Folder watchdog (created / modified / deleted) (`watchdog`). |
| Only files matching | text | — | Example: `*.tar.gz`. Shown only for some choices of the settings above. |
| Include subfolders | on/off | — | Shown only for some choices of the settings above. |
| Fail if older than (minutes) | number | — | Shown only for some choices of the settings above. |
| Watch for | several choices | created,modified,deleted | Options: created; modified; deleted. Shown only for some choices of the settings above. |
| Expected SHA-256 | text | — | Blank = the first value seen becomes the baseline. Shown only for some choices of the settings above. |
| Status when triggered | choice | Warn | Options: Down (critical) (`down`); Warn (`warn`). Shown only for some choices of the settings above. |
| Hold the alert status for (minutes) *(Advanced)* | number | 15 | One-time events stay failing this long so a normal 2-in-a-row alert rule still catches them. Shown only for some choices of the settings above. |

<a id="agent-log"></a>

### Log file pattern

Type ID `agent_log`. Tails a log file (follows rotation; globs allowed) and counts new lines matching a pattern.

**Value:** new matching lines. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Log file * | text | — | Example: `/var/log/app/*.log`. |
| Match (regex) | text | — | Example: `ERROR\|FATAL`. |
| Ignore case | on/off | on | — |
| Count lines that DON'T match *(Advanced)* | on/off | — | — |
| Exclude lines containing *(Advanced)* | text (several lines) | — | One per line; a line containing any of these texts (case ignored) is ignored. Reusable lists for many checks: the Exclusions page. Example: `healthcheck ⏎ DEBUG`. |
| Status when triggered | choice | Down (critical) | Options: Down (critical) (`down`); Warn (`warn`). |

<a id="agent-journal"></a>

### systemd journal

Type ID `agent_journal`. New journal entries for a unit and/or priority, optionally filtered by text (Linux).

**Value:** new matching entries. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Unit | text | — | — |
| Priority at or above | choice | err | Options: any (``); emerg; alert; crit; err; warning; notice; info. |
| Text matches (regex) | text | — | — |
| Exclude entries containing *(Advanced)* | text (several lines) | — | One per line; a line containing any of these texts (case ignored) is ignored. Reusable lists for many checks: the Exclusions page. Example: `pam_unix ⏎ healthcheck`. |
| Status when triggered | choice | Down (critical) | Options: Down (critical) (`down`); Warn (`warn`). |

<a id="agent-eventlog"></a>

### Windows Event Log

Type ID `agent_eventlog`. New events by log, ID, level and source — disk errors, failed logons (4625), unexpected shutdowns (6008)…

**Value:** new matching events. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Log | text | System | Example: `System, Application, Security`. |
| Event IDs | text | — | Example: `41,6008`. |
| Levels | several choices | critical,error | Options: critical; error; warning; information. |
| Source / provider | text | — | — |
| Message matches (regex) | text | — | — |
| Exclude events *(Advanced)* | text (several lines) | — | One per line: an event ID (digits only) skips that ID; anything else skips events whose message contains it. Reusable lists: the Exclusions page. Example: `10016 ⏎ DistributedCOM`. |
| Status when triggered | choice | Down (critical) | Options: Down (critical) (`down`); Warn (`warn`). |

## OS & hardware (agent)

<a id="agent-perfcounter"></a>

### Windows performance counter

Type ID `agent_perfcounter`. Any Windows perf counter path (wildcards combined).

**Value:** counter value. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Counter path * | text | — | Example: `\Processor(_Total)\% Processor Time`. |
| Combine instances by *(Advanced)* | choice | sum | Options: sum; avg; max; min. |

<a id="agent-vpn"></a>

### VPN tunnel

Type ID `agent_vpn`. WireGuard handshake age, or that a tunnel interface (OpenVPN, Tailscale, ZeroTier…) exists and is up.

**Value:** seconds since the last WireGuard handshake (s). Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Type | choice | WireGuard | Options: WireGuard (`wireguard`); Any tunnel interface (`interface`). |
| Interface * | text | — | Example: `wg0`. |
| Peer public key *(Advanced)* | text | — | Shown only for some choices of the settings above. |
| Max handshake age (s) | number | 300 | Shown only for some choices of the settings above. |

<a id="agent-ups"></a>

### UPS (NUT / apcupsd)

Type ID `agent_ups`. A UPS attached to this endpoint: on battery = warn, low battery = down.

**Value:** battery charge (%). Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Software | choice | Network UPS Tools (upsc) | Options: Network UPS Tools (upsc) (`nut`); apcupsd (apcaccess) (`apcupsd`). |
| UPS name | text | ups@localhost | Shown only for some choices of the settings above. |

<a id="agent-backup"></a>

### Backup job (Borg / restic / Veeam)

Type ID `agent_backup`. Age (and result, for Veeam) of the newest backup.

**Value:** hours since the newest backup (h). Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Tool | choice | BorgBackup | Options: BorgBackup (`borg`); restic; Veeam (Windows event log) (`veeam`). |
| Repository | text | — | Example: `ssh://backup@nas/./repo`. Shown only for some choices of the settings above. |
| Passphrase | secret (write-only) | — | Shown only for some choices of the settings above. |
| Fail if older than (hours) | number | 26 | — |
| Extra environment *(Advanced)* | secret (write-only) | — | Example: `BORG_RSH=ssh -i /root/.ssh/backup`. Shown only for some choices of the settings above. |

## Software & security (agent)

<a id="host-packages"></a>

### Upgradable packages

Type ID `host_packages`. Lists the packages with updates waiting (apt, dnf, pacman, Windows Update, macOS). Ubuntu phased updates — held back on purpose by Ubuntu's gradual rollout — are left out unless you include them.

**Value:** packages to update. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Fail when | choice | a security update is waiting | Options: a security update is waiting (`security`); any update is waiting (`any`); never (just report — or use thresholds) (`none`). |
| Status when triggered | choice | Warn | Options: Down (critical) (`down`); Warn (`warn`). |
| Only count security updates | on/off | — | — |
| Include Ubuntu phased updates *(Advanced)* | on/off | — | Off by default: Ubuntu holds these back for most machines until its rollout reaches them, so apt won't install them yet anyway. |
| Exclude packages *(Advanced)* | text (several lines) | — | One per line; whole names, case ignored, * matches anything. Reusable lists for many checks: the Exclusions page. Example: `linux-image-* ⏎ linux-headers-*`. |

<a id="host-software"></a>

### Installed software changed

Type ID `host_software`. Alerts when software is installed, removed or changes version — OS packages, Windows programs, macOS apps, global npm/pip packages, runtimes and lock files.

**Value:** packages installed. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Only watch | several choices | — | Blank = everything. Options: Debian/Ubuntu packages (`dpkg`); RPM packages (`rpm`); Alpine packages (`apk`); Arch packages (`pacman`); Windows programs (`windows`); macOS apps (`macos`); npm; pip; Composer (`composer`); Runtimes (Node, Python, PHP) (`runtime`). |
| Hold the alert status for (minutes) *(Advanced)* | number | 60 | One-time events stay failing this long so a normal 2-in-a-row alert rule still catches them. |
| Status when triggered | choice | Warn | Options: Down (critical) (`down`); Warn (`warn`). |
| Exclude packages *(Advanced)* | text (several lines) | — | One per line; whole names, case ignored, * matches anything. Reusable lists for many checks: the Exclusions page. Example: `google-chrome-* ⏎ microsoft-edge-*`. |
| Also watch lock files *(Advanced)* | text (several lines) | — | One path per line: package-lock.json, npm-shrinkwrap.json, Pipfile.lock, requirements.txt or composer.lock. Only files with those names are read. Example: `/srv/app/package-lock.json`. |

<a id="host-vulnerable"></a>

### Vulnerable or unsupported software

Type ID `host_vulnerable`. Checks installed software against known vulnerabilities (OSV.dev — OS packages, npm, pip, Composer, lock files) and end-of-life dates (endoflife.date — the OS, Node.js, Python, PHP, PostgreSQL, MySQL, MariaDB). Package names and versions are sent to those public services.

**Value:** vulnerable packages. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Warn at severity | choice | medium | Options: low; medium; high; critical. |
| Down at severity | choice | high | Options: low; medium; high; critical. |
| Unsupported (end of life) | choice | Down | Options: Down (`down`); Warn (`warn`). |
| Warn this many days before end of life | number | 90 | — |
| Accepted risks | text (several lines) | — | One per line: a package name (* wildcards) or an advisory ID (CVE-…, GHSA-…, USN-…), then # and why it can't be updated or replaced. Reasons are shown with the result. Example: `libssl1.1 # needed by the old ERP client ⏎ CVE-2024-1234 # not reachable here`. |
| Also check lock files | text (several lines) | — | One path per line: package-lock.json, npm-shrinkwrap.json, Pipfile.lock, requirements.txt or composer.lock — your apps' own dependencies. Only files with those names are read. Example: `/srv/app/package-lock.json ⏎ /var/www/site/composer.lock`. |
| Look up vulnerabilities (OSV.dev) *(Advanced)* | on/off | on | — |
| Look up end-of-life dates (endoflife.date) *(Advanced)* | on/off | on | — |

## Push & smart

<a id="heartbeat"></a>

### Heartbeat (cron / job check-in)

Type ID `heartbeat`. Your job calls a unique URL when it finishes; if no call arrives within the interval plus grace, the check goes down. The interval below is how often you expect the call.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Grace period (seconds) *(Advanced)* | number | 60 | Extra time after the interval before a missing call counts as a failure — allow for jobs that run long. |

<a id="push-value"></a>

### Push a value

Type ID `push_value`. A script sends a number to a unique URL (?value=42); thresholds and graphs apply as for any check.

**Value:** the pushed value. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Grace period (seconds) *(Advanced)* | number | 60 | — |
| Recover on its own after (minutes) *(Advanced)* | number | — | A failure pushed in normally stays until the next push. Set this to mark the check recovered when no new result has arrived for this long. Example: `off`. |

<a id="calculated"></a>

### Calculated value

Type ID `calculated`. Works out a value from up to four other checks' latest values — UPS load in watts from load % and capacity, two disks' combined free space, the difference between two sensors.

**Value:** the calculated value. Thresholds apply to it.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Expression * | text | — | Use a, b, c and d for the checks below. + - * / % ^, brackets, min max abs round floor ceil sqrt log10. Example: `a / 100 * b`. |
| a = | another check | — | — |
| b = | another check | — | — |
| c = | another check | — | — |
| d = | another check | — | — |
| Unit label | text | — | Example: ` W`. |
| Inputs must be newer than (minutes) *(Advanced)* | number | 15 | An older input makes the result unknown rather than calculating from stale data. |

<a id="anomaly"></a>

### Anomaly (unusual value)

Type ID `anomaly`. Compares another check's latest value to its own history for the same hour of day (or week), and flags anything unusually far off.

| Setting | Kind | Default | Notes |
|---|---|---|---|
| Watch this check * | another check | — | — |
| Using its | choice | value | Options: value; response time (`latency`). |
| Unusual beyond (standard deviations) | number | 3 | — |
| Direction | choice | too high or too low | Options: too high or too low (`both`); too high only (`above`); too low only (`below`). |
| Compare with *(Advanced)* | choice | same hour, previous days | Options: same hour, previous days (`hour_of_day`); same hour & weekday (`hour_of_week`); all recent values (`none`). |
| History (days) *(Advanced)* | number | 14 | — |
| Learn from at least N samples *(Advanced)* | number | 20 | — |
