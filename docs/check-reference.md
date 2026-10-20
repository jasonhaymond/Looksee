# Check Reference

Every check type Looksee has: what it watches, exactly how Looksee does it, what its
**value** is (what thresholds and charts use), and the commands to see the same thing
yourself — useful when a check fails and you want to confirm it, or to understand what
a check will report before you add it.

This guide is also built into the app (**Help & user guide → Check reference**), and
every check's form has a **How this check works** link to its entry here. Every setting
of every type, with its default, is listed in [check settings](check-settings.md). For
using checks in general (adding, thresholds, alerts, exclusions, recovery), see the
[user guide](user-guide.md).

**Who runs it.** *Engine* checks are run by the Looksee server — or by a remote site's
collector, or an endpoint's agent when you choose **Run from** (see the user guide's
[Multiple sites](user-guide.md#multiple-sites)). *Agent* checks run on the chosen
endpoint's agent. *Report* checks are judged by the engine from the metrics every agent
report already carries. Commands below marked *(from Looksee)* should be run on whatever
runs the check — the Looksee server, the collector machine, or the agent's machine.

**Common to every check.** Under **Advanced** every check has a retry interval, tags,
**Depends on** and **Recovers together with**; any failing check can be **resolved** by
hand or through its recovery URL; and checks that look at several items (disks,
interfaces, services, containers, events, packages) take **exclusions** — their own
and from reusable lists. See the user guide's
[Resolving and recovery](user-guide.md#resolving-and-recovery) and
[Exclusions](user-guide.md#exclusions).

## Contents

1. [Reachability & web](#reachability--web)
2. [Network services](#network-services)
3. [Databases & apps](#databases--apps)
4. [Network devices & hardware](#network-devices--hardware)
5. [Virtualization & containers](#virtualization--containers)
6. [Endpoint metrics (agent)](#endpoint-metrics-agent)
7. [Services & processes (agent)](#services--processes-agent)
8. [Files & logs (agent)](#files--logs-agent)
9. [OS & hardware (agent)](#os--hardware-agent)
10. [Software & security (agent)](#software--security-agent)
11. [Push & smart](#push--smart)

## Reachability & web

<a id="ping"></a>

### Ping

**What it watches:** whether a device answers ICMP echo (ping), with packet loss, jitter
and round-trip time. **Engine** (or an agent/collector).

**How it works:** sends *Pings per check* echo requests (default 3) using the system
`ping` command and parses the replies. All lost → down. Loss at or above *Warn/Critical
at loss %* → warn/down. Jitter is the average difference between consecutive round-trip
times.

**Value:** average round-trip time (ms); response-time thresholds apply to it.

**Check it yourself** *(from Looksee)*:

```bash
ping -c 5 10.0.0.1            # Linux/macOS
```

```powershell
ping -n 5 10.0.0.1            # Windows
Test-Connection 10.0.0.1 -Count 5
```

Many devices and Windows hosts drop ping by default (Windows Defender Firewall's "File
and Printer Sharing (Echo Request)" rule). Use a TCP check if you can't allow it.

<a id="tcp"></a>

### TCP port

**What it watches:** whether a TCP port accepts connections. **Engine.**

**How it works:** opens a TCP connection to host:port and closes it immediately. Refused
or timed out → down. Under Advanced: *Timeout*, and *Send after connecting* / *Reply must contain* to check
a banner or a simple request/response (e.g. send `PING\r\n`, expect `+PONG` from
Redis) — no reply containing the text → down.

**Value:** connect time (ms).

**Check it yourself:**

```bash
nc -vz db.lan 5432            # Linux/macOS (netcat)
```

```powershell
Test-NetConnection db.lan -Port 5432
```

*Refused* means the host answered but nothing listens on that port (service stopped, or
bound to 127.0.0.1 only). *Timed out* usually means a firewall drops the traffic.

<a id="udp"></a>

### UDP port

**What it watches:** a UDP service that replies to a request. **Engine.**

**How it works:** sends the *Payload* (text, or hex if ticked) and waits for any reply,
optionally requiring it to contain some text. UDP has no handshake, so a reply is the
only proof a service is there — a silent port can't be told apart from a closed one.

**Value:** reply time (ms).

**Check it yourself:** `echo -n ping | nc -u -w2 host 161` (Linux/macOS). Windows has no
built-in UDP client; use the service's own client (e.g. `nslookup` for DNS on 53).

<a id="http"></a>

### HTTP(S)

**What it watches:** a web page or API: status code, content, JSON fields, redirects and
response time. **Engine.**

**How it works:** makes the request (GET by default) with the method, headers and body
you set, following redirects unless turned off. Then, in order: the status must match
*Expected status* (blank accepts anything under 400; ranges like `200-299,301` and
`2xx` work); the body must / must not contain text or match a regex; an optional JSON
path (`$.status`) is compared; *Must end at URL* checks where redirects landed. TLS
certificate errors fail the check unless *Skip TLS verification* is ticked.

**Value:** the number at the JSON path, when numeric. Response time has its own
thresholds.

**Check it yourself:**

```bash
curl -sS -o /dev/null -w '%{http_code} %{time_total}s\n' -L https://example.com/health
curl -sS https://example.com/health | jq .status
```

```powershell
Invoke-WebRequest https://example.com/health -UseBasicParsing | Select-Object StatusCode, Content
curl.exe -sS -o NUL -w "%{http_code} %{time_total}s`n" -L https://example.com/health
```

<a id="browser"></a>

### Real browser (headless Chrome)

**What it watches:** that a page actually *renders* — for single-page apps whose HTML is
empty until JavaScript runs. **Engine** (needs Chrome/Chromium on the machine running
it; set `CHROME_PATH` if it's not in a standard place).

**How it works:** loads the URL in headless Chrome, waits for the page (and for the CSS
selector, if set), checks the rendered text, and warns on JavaScript errors in the
console.

**Value:** page load time (ms).

**Check it yourself:** open the page in a normal browser with the developer tools
(F12) **Console** tab open, and look for red errors. From a shell:
`chromium --headless --dump-dom https://example.com | grep "expected text"`.

<a id="dns"></a>

### DNS

**What it watches:** that a name resolves, optionally through a specific server, to an
expected answer, and (optionally) with DNSSEC validation. **Engine.**

**How it works:** queries the record type (A, AAAA, MX, TXT, …) through the server you
name (or the system resolver), checks the answer contains *Answer must contain*, and
for DNSSEC requires the server to set the AD (authenticated data) flag.

**Value:** lookup time (ms).

**Check it yourself:**

```bash
dig @10.0.0.53 example.com A +short
dig @1.1.1.1 example.com A +dnssec | grep flags   # look for "ad"
```

```powershell
Resolve-DnsName example.com -Type A -Server 10.0.0.53
nslookup example.com 10.0.0.53
```

<a id="ssl_cert"></a>

### TLS certificate

**What it watches:** a certificate's expiry, whether it's trusted and matches the name,
and whether the server still accepts old TLS 1.0/1.1. **Engine.**

**How it works:** opens a TLS connection to host:port, reads the certificate chain,
computes days until expiry (warn/critical at your day counts), checks the chain
validates and the hostname matches (each optional), then separately tries a TLS 1.0
and 1.1 handshake and warns if either is accepted.

**Value:** days until expiry.

**Check it yourself:**

```bash
echo | openssl s_client -connect example.com:443 -servername example.com 2>/dev/null | openssl x509 -noout -dates -subject -issuer
openssl s_client -connect example.com:443 -tls1_1 </dev/null   # should fail
```

```powershell
$t = New-Object Net.Sockets.TcpClient("example.com", 443)
$s = New-Object Net.Security.SslStream($t.GetStream())
$s.AuthenticateAsClient("example.com"); $s.RemoteCertificate.GetExpirationDateString()
```

<a id="domain_expiry"></a>

### Domain registration expiry

**What it watches:** when the domain registration itself (not the certificate) expires.
**Engine.**

**How it works:** looks up the domain's registry RDAP server (from IANA's bootstrap
list) and reads the *expiration* event date.

**Value:** days until the registration expires.

**Check it yourself:** `whois example.com | grep -i expir` (Linux/macOS), or
`https://rdap.org/domain/example.com` in a browser. Your registrar's dashboard is the
final word.

<a id="websocket"></a>

### WebSocket

**What it watches:** that a `ws://`/`wss://` endpoint accepts connections and, optionally,
answers a message. **Engine.**

**How it works:** opens the WebSocket, optionally sends *Send on connect*, and waits for
a message containing the expected text.

**Value:** connection time (ms).

**Check it yourself:** `npx wscat -c wss://example.com/socket` then type the message.
In a browser console: `new WebSocket("wss://example.com/socket").onmessage = e => console.log(e.data)`.

## Network services

<a id="protocol"></a>

### Mail / SSH / FTP / LDAP / RDP

**What it watches:** that a service speaks its protocol, not just that the port is open.
**Engine.**

**How it works:** connects and does just enough of the protocol: SMTP greeting (and
STARTTLS if required), IMAP/POP3 greeting, FTP banner, SSH version banner, LDAP bind
(anonymous or with your DN), RDP connection request. *Response must match* checks the
banner against a regex (e.g. `OpenSSH_9`).

**Value:** response time (ms).

**Check it yourself:**

```bash
nc mail.example.com 25          # expect "220 ..."; type QUIT
ssh -v -o BatchMode=yes host exit 2>&1 | grep "remote software"
openssl s_client -starttls smtp -connect mail.example.com:587
ldapsearch -x -H ldap://dc.lan -b "" -s base
```

```powershell
Test-NetConnection mail.example.com -Port 25
```

<a id="email_roundtrip"></a>

### Email round-trip

**What it watches:** that mail actually flows end to end — sending, delivery and the
mailbox. **Engine.**

**How it works:** sends a message with a unique tag by SMTP, then polls the IMAP mailbox
until it arrives (or the timeout passes), and deletes it if asked.

**Value:** delivery time in seconds.

**Check it yourself:** send yourself a message and time its arrival; check the mail
server's queue (`postqueue -p` on Postfix, *Queue Viewer* on Exchange).

<a id="ntp"></a>

### NTP server

**What it watches:** a time server is synchronized and close to correct time. **Engine.**

**How it works:** sends an SNTP request, reads the stratum (1–15; 16 = unsynchronized)
and calculates the clock offset from the four timestamps.

**Value:** absolute offset (ms).

**Check it yourself:**

```bash
ntpdate -q pool.ntp.org        # or: chronyc sources -v
```

```powershell
w32tm /stripchart /computer:pool.ntp.org /samples:3 /dataonly
```

<a id="dhcp"></a>

### DHCP server

**What it watches:** that a DHCP server answers, and that no other (rogue) server does.
**Engine.**

**How it works:** broadcasts a DHCP DISCOVER from UDP port 68 and collects OFFERs (no
lease is taken). If *Expected server IP* is set, an offer from any other server fails
the check. Binding port 68 needs privileges — see the deployment guide.

**Value:** time to the first offer (ms).

**Check it yourself:** `sudo nmap --script broadcast-dhcp-discover` (Linux). On Windows,
`ipconfig /renew` and `ipconfig /all` show which server gave the lease.

<a id="grpc"></a>

### gRPC health

**What it watches:** a gRPC service's standard health endpoint. **Engine.**

**How it works:** calls `grpc.health.v1.Health/Check` (for the named service, or the
whole server) and expects `SERVING`.

**Check it yourself:** `grpc_health_probe -addr=host:50051` or
`grpcurl -plaintext host:50051 grpc.health.v1.Health/Check`.

<a id="mqtt"></a>

### MQTT broker

**What it watches:** an MQTT broker accepts a client. **Engine.**

**How it works:** connects (optionally with TLS and credentials) and checks the CONNACK
return code.

**Check it yourself:** `mosquitto_sub -h broker -t '$SYS/broker/uptime' -C 1 -u user -P pass`.

<a id="docker_registry"></a>

### Container registry

**What it watches:** a Docker/OCI registry answers, and optionally that an image tag
exists. **Engine.**

**How it works:** calls `/v2/` (handling token auth), then `HEAD /v2/<image>/manifests/<tag>`.

**Check it yourself:** `curl -sI https://registry.example.com/v2/` (expect 200 or 401),
or `docker manifest inspect registry.example.com/library/nginx:latest`.

<a id="traceroute"></a>

### Traceroute / path change

**What it watches:** the network path to a host, and when it changes. **Engine** (needs
`traceroute` on Linux/macOS, uses `tracert` on Windows).

**How it works:** traces up to *Max hops*, remembers the hop list, and warns (or goes
down) when the path differs from last time. Can require the path to pass through a hop,
and fail if the destination isn't reached.

**Value:** hop count.

**Check it yourself:** `traceroute -n 1.1.1.1` / `mtr -rwc 10 1.1.1.1` (Linux/macOS),
`tracert -d 1.1.1.1` / `pathping 1.1.1.1` (Windows).

<a id="public_ip"></a>

### Public IP change

**What it watches:** the public IP address of the network the check runs from. **Engine.**

**How it works:** fetches an IP-echo URL (default `api.ipify.org`), remembers the
address, and holds warn (or down) after a change. With *Expected IP* set, any other
address is down.

**Check it yourself:** `curl -s https://api.ipify.org` / `(Invoke-RestMethod https://api.ipify.org)`.

<a id="arp_presence"></a>

### Device present (ARP)

**What it watches:** whether a device is on the same LAN segment as the engine/collector
— works even for devices that ignore ping — and optionally that the right hardware
answers on an IP. **Engine.**

**How it works:** pings the IP once (to refresh the ARP cache, ignoring the reply), then
reads the system ARP/neighbour table. IP missing → down; MAC differs from the expected
one → down (IP conflict or replaced device). With only a MAC set, it finds which IP
that MAC has. Each sighting is recorded for [IP change tracking](#ip_change).

**Check it yourself:** `ip neigh show 10.0.0.23` (Linux), `arp -n 10.0.0.23` (macOS),
`arp -a | findstr 10.0.0.23` or `Get-NetNeighbor -IPAddress 10.0.0.23` (Windows). Only
works on the same Layer-2 network (VLAN).

<a id="ip_change"></a>

### IP address change (by MAC)

**What it watches:** a device's MAC address showing up at a new IP — the DHCP lease that
moved and broke every check pointing at the old address. **Engine** (reads Looksee's own
records).

**How it works:** Looksee records every MAC→IP pair it sees: from agents' interface
lists (every ~10 minutes), discovery scans, and ARP checks. This check looks at the
MAC you enter (or every MAC of its endpoint) and, when the newest address appeared within
the *hold* period and differs from the previous one, reports warn (or down) with the old
and new IP. IPv6 is ignored unless ticked, because privacy addresses change by design.

**Value:** number of IP changes in the last 24 hours.

**Check it yourself:** on the device: `ip -br addr` (Linux), `ifconfig` (macOS),
`ipconfig /all` (Windows). On the DHCP server: its lease list (pfSense: *Status → DHCP
Leases*). Give the device a static mapping/reservation to stop it moving.

## Databases & apps

<a id="database"></a>

### Database

**What it watches:** PostgreSQL, MySQL/MariaDB, SQL Server, Redis or MongoDB — that you
can log in and query, or a health metric. **Engine.**

**How it works:** connects with the credentials, then depending on *What to check*:
runs the query (default `SELECT 1`) or reads a single value from it; connection count
as % of the server's maximum; replication lag (seconds behind the primary); database
size; queries running longer than N seconds; memory (Redis/MongoDB).

**Value:** the chosen metric. Login time is the response time.

**Check it yourself:**

```bash
psql -h db.lan -U monitor -d app -c "select count(*)*100.0/current_setting('max_connections')::int from pg_stat_activity"
mysql -h db.lan -u monitor -p -e "SHOW GLOBAL STATUS LIKE 'Threads_connected'; SHOW VARIABLES LIKE 'max_connections'"
redis-cli -h redis.lan INFO memory | grep used_memory_human
mongosh "mongodb://db.lan" --eval "db.serverStatus().connections"
```

```powershell
sqlcmd -S sql.lan -U monitor -Q "SELECT COUNT(*) FROM sys.dm_exec_sessions"
```

Use a dedicated read-only monitoring account.

<a id="prometheus"></a>

### Prometheus metric

**What it watches:** any metric any Prometheus exporter publishes (node_exporter,
cAdvisor, Caddy, Traefik, …). **Engine.**

**How it works:** fetches the `/metrics` text, keeps the series with that name that
match the label filter (`mountpoint="/"`, `fstype!="tmpfs"`), and combines them (sum,
avg, min, max, count). With *rate* ticked, it's the per-second change since the
previous run.

**Value:** the combined number (per second if rate).

**Check it yourself:** `curl -s http://host:9100/metrics | grep '^node_filesystem_avail_bytes'`.

<a id="webserver_status"></a>

### Web server status page

**What it watches:** load on nginx, Apache or Caddy. **Engine.**

**How it works:** reads nginx's `stub_status`, Apache's `mod_status?auto`, or Caddy's
Prometheus metrics, and reports the chosen metric; request and error rates are
per-second deltas between runs.

**Check it yourself:** `curl http://127.0.0.1/nginx_status`,
`curl "http://127.0.0.1/server-status?auto"`, `curl http://127.0.0.1:2019/metrics`.
The status page must be enabled in the server's config (and is usually restricted to
localhost — run the check from an agent on that host, or allow Looksee's IP).

<a id="app_integration"></a>

### App integration

**What it watches:** Nextcloud, Home Assistant, Plex, Jellyfin or Pi-hole through their
own APIs, or any JSON API. **Engine.**

**How it works:** calls the app's API with the token (Nextcloud *serverinfo* with an
NC-Token, Home Assistant long-lived token, `X-Plex-Token`, Jellyfin API key, Pi-hole app
password) and reads the chosen metric — or, for any JSON API, the value at a JSON path;
for Home Assistant, an entity's state compared with the expected state.

**Check it yourself:** e.g.
`curl -H "NC-Token: …" "https://cloud.example.com/ocs/v2.php/apps/serverinfo/api/v1/info?format=json"`,
`curl -H "Authorization: Bearer …" https://ha.local:8123/api/states/sensor.outdoor_temp`.

## Network devices & hardware

<a id="snmp"></a>

### SNMP value / template

**What it watches:** anything a device publishes over SNMP — one value, a walked table,
or a ready-made template. **Engine** (or the site collector).

**How it works:** SNMP v1, v2c (community) or v3 (user, auth/privacy). Modes:

- **Single value** — `GET` one OID. Text values can be matched with *Text value must
  contain*.
- **Walk: average/sum/min/max/count** — `GETBULK`-walks every value under the OID and
  combines them. *Only rows whose index matches* narrows the rows by the OID suffix.
- **Full walk** — keeps every OID/value under the subtree in the result details; the
  value is the row count or a sum/average/min/max.
- **Counter — per-second rate** — for Counter32/Counter64 values; on walks each row's
  rate is computed separately (a row that went backwards — wrap or reboot — is skipped
  that run), then combined. The first run only collects a baseline.

Templates read standard MIBs (no vendor MIB files): printer supplies, **printer errors**
(hrPrinterDetectedErrorState + Printer-MIB alert table), **failed print jobs** (Job
Monitoring MIB, RFC 2707 — not every printer has it), UPS battery/runtime/on battery
(UPS-MIB), CPU/memory/fullest disk (HOST-RESOURCES), hottest sensor (ENTITY-SENSOR), and
reboot detection (sysUpTime going backwards).

**Calculations (Advanced).** *Calculate* applies a formula to the value
(`value / 10`, `used / size * 100`) using only `+ - * / % ^`, brackets and
`min max abs round floor ceil sqrt log10` — a calculator, never code. *Extra OIDs* reads
more values in the same poll (`name = OID`, or `name = rate(OID)` for a counter's
per-second rate) for the formula to use by name; with them the main OID is optional.
`ref` stands for another check's latest value. A formula that can't be worked out (an
unknown name, division by zero) makes the result **unknown** with the reason.

The walk browser names known OIDs from a built-in dictionary (standard MIBs, the Printer
MIB, UPS-MIB, and vendor counters for HP, Brother, Canon, Ricoh, Xerox, Kyocera, Lexmark
and Konica Minolta), shows values readably, and says which vendor owns any other
enterprise OID. Sets of SNMP checks for one kind of device are
[SNMP templates](user-guide.md#snmp-templates).

**Value:** the value read or computed (× *Multiply by*, then *Calculate*).

**Check it yourself** *(from Looksee)* — or use **Walk this device…** in the check form:

```bash
snmpget  -v2c -c public 10.0.0.2 1.3.6.1.2.1.1.3.0          # uptime
snmpwalk -v2c -c public 10.0.0.2 1.3.6.1.2.1.31.1.1.1.6     # ifHCInOctets per port
snmpwalk -v3 -l authPriv -u monitor -a SHA -A 'authpass' -x AES -X 'privpass' 10.0.0.2 1.3.6.1.2.1.1
snmpwalk -v2c -c public printer.lan 1.3.6.1.2.1.43.18.1.1.8  # printer alert descriptions
```

On Windows, install the Net-SNMP tools or use the walk browser. "No response" almost
always means the community/credentials are wrong, SNMP isn't enabled, or the device's
SNMP access list doesn't include the engine's (or collector's) IP.

<a id="snmp_interfaces"></a>

### SNMP interfaces

**What it watches:** every port on a switch, router or firewall in one check: ports that
went down, utilization and error rates. **Engine.**

**How it works:** walks `ifTable` and `ifXTable`. A port with admin status *up* but oper
status not *up* (and not *dormant*) is a failure; admin-down ports are ignored.
Traffic uses the 64-bit `ifHCInOctets/ifHCOutOctets` counters when the device has them
(32-bit `ifInOctets/ifOutOctets` otherwise), and errors/discards are summed, all as
per-second deltas from the previous run — so the first run shows no traffic yet, and
rates appear from the second run. Utilization = the busier direction ÷ `ifHighSpeed`.

**Value:** the busiest port's utilization %.

**Check it yourself:**

```bash
snmpwalk -v2c -c public 10.0.0.2 1.3.6.1.2.1.31.1.1.1.1   # ifName
snmpwalk -v2c -c public 10.0.0.2 1.3.6.1.2.1.2.2.1.8      # ifOperStatus (1 = up)
snmpwalk -v2c -c public 10.0.0.2 1.3.6.1.2.1.31.1.1.1.6   # ifHCInOctets — run twice, subtract, divide by the seconds between
```

On pfSense, enable *Services → SNMP* with the *MibII* and *Network Interfaces* modules
(the latter provides the 64-bit counters).

<a id="trap_match"></a>

### SNMP trap received

**What it watches:** SNMP traps sent to Looksee. **Engine** (matches events already
received).

**How it works:** counts received traps in the window matching the source IP and the
pattern (searched in the trap OID and varbinds). Any match → the chosen status; with
thresholds set, only above a count.

*Clears when text matches* recovers the check as soon as a matching trap arrives after
a failure (`linkUp` after `linkDown`); *Recover on its own after* recovers it when no new
matching trap has arrived for that long. Message exclusions drop traps containing any
excluded text before counting.

**Value:** matching traps in the window.

**Check it yourself:** **Insights → Traps & syslog**. Send a test trap:
`snmptrap -v2c -c public looksee-host:1162 '' 1.3.6.1.6.3.1.1.5.3`.

<a id="syslog_match"></a>

### Syslog message received

**What it watches:** syslog lines sent to Looksee. **Engine** (matches events already
received).

**How it works:** counts received messages in the window from the source IP, at or above
the severity, matching the regex.

Recovery and exclusions work as for traps: *Clears when text matches*, *Recover on its
own after*, and excluded message texts.

**Value:** matching messages in the window.

**Check it yourself:** **Insights → Traps & syslog**; send a test with
`logger -n looksee-host -P 1514 -p user.err "test link down"`.

<a id="bmc"></a>

### Server hardware (iDRAC / iLO / IPMI)

**What it watches:** power supplies, fans, temperatures and overall health from the
server's management controller. **Engine.**

**How it works:** Redfish: reads `/redfish/v1/Systems` and `/Chassis` (health rollup,
power state, PSUs, fans, thermal). IPMI: runs `ipmitool -I lanplus … sdr` and reads
sensor states.

**Value:** hottest temperature sensor (°C).

**Check it yourself:**

```bash
curl -sku user:pass https://10.0.0.30/redfish/v1/Systems/System.Embedded.1 | jq .Status
ipmitool -I lanplus -H 10.0.0.30 -U user -P pass sdr elist
```

Or log in to the iDRAC/iLO web page and look at its health and event log.

## Virtualization & containers

<a id="proxmox"></a>

### Proxmox VE

**What it watches:** cluster quorum, node CPU/memory, a guest's state, storage usage, or
how long since the last successful backup. **Engine.**

**How it works:** calls the Proxmox API with an API token (create one under
*Datacenter → Permissions → API Tokens* with the *PVEAuditor* role) and reads
`/cluster/status`, `/nodes/<node>/status`, `/cluster/resources`, storage status, or the
vzdump task log.

**Value:** CPU/memory %, storage %, number of guests not in the expected state, or hours
since the last OK backup.

**Check it yourself:** on a node: `pvecm status`, `pvesh get /nodes/pve1/status`,
`qm list` / `pct list`, `pvesm status`, and the *Tasks* panel for vzdump.

<a id="vmware"></a>

### VMware ESXi / vCenter

**What it watches:** VM power state, datastore space, or host health. **Engine.**

**How it works:** logs in to the vSphere REST API and reads VMs, datastores or host
state.

**Value:** VMs not powered on, or datastore % used.

**Check it yourself:** the vSphere client; on ESXi over SSH: `vim-cmd vmsvc/getallvms`,
`esxcli storage filesystem list`.

<a id="agent_hyperv"></a>

### Hyper-V VMs

**What it watches:** VM states on a Hyper-V host. **Agent** (on the Hyper-V host).

**How it works:** runs `Get-VM` through PowerShell and compares each VM's state with the
expected state (default *Running*), skipping ignored VMs.

**Value:** VMs not in the expected state.

**Check it yourself:** `Get-VM | Select-Object Name, State, Uptime` (elevated PowerShell).

<a id="agent_docker"></a>

### Docker containers

**What it watches:** containers running and healthy, restart loops, or CPU/memory.
**Agent** (on the Docker host).

**How it works:** talks to the Docker Engine API over its socket (`/var/run/docker.sock`
on Linux, the named pipe on Windows): lists containers matching the name/glob, checks
state and health-check status, counts restarts since the last check, or reads stats.
The agent's user needs access to the socket (on Linux, the `docker` group — see the
agent README).

**Value:** problem count, restarts, or CPU/memory %.

**Check it yourself:**

```bash
docker ps -a --format 'table {{.Names}}\t{{.Status}}'
docker inspect -f '{{.State.Health.Status}} {{.RestartCount}}' mycontainer
docker stats --no-stream
```

## Endpoint metrics (agent)

<a id="host_metric"></a>

### Endpoint metric

**What it watches:** any of 60+ measurements every agent report carries. **Report.**

**How it works:** the agent collects a snapshot every 30 seconds (CPU per core, load,
memory/swap, every mounted filesystem, disk I/O, every interface, TCP states, listening
ports, temperatures, fans, battery, SMART, RAID/ZFS, pending updates, reboot pending,
clock sync, Defender, firewall, disk encryption, failed logins) and the engine checks the
chosen metric. For per-instance metrics (a disk, an interface) leave the instance blank
to evaluate all of them and report the worst — excluded mounts, interfaces, disk
devices and sensors are skipped. Yes/no metrics use *Healthy when* instead of
thresholds. The *updates* metrics leave out Ubuntu phased updates (Ubuntu's gradual
rollout holds them back anyway); `updates.phased` counts them on their own.

**Value:** the metric.

**Check it yourself** — the same numbers by hand:

| Metric | Linux | macOS | Windows |
|---|---|---|---|
| CPU | `top -bn1 \| head -5` / `mpstat 1 1` | `top -l1 \| head -10` | `Get-Counter '\Processor(_Total)\% Processor Time'` |
| Memory | `free -m` | `vm_stat` | `Get-CimInstance Win32_OperatingSystem \| select FreePhysicalMemory,TotalVisibleMemorySize` |
| Disks | `df -h` / `df -i` (inodes) | `df -h` | `Get-Volume` |
| Disk I/O | `iostat -x 1 2` | `iostat 1 2` | `Get-Counter '\PhysicalDisk(*)\% Disk Time'` |
| Interfaces | `ip -s link` | `netstat -ib` | `Get-NetAdapterStatistics` |
| Listening ports | `ss -tlnp` | `lsof -iTCP -sTCP:LISTEN` | `Get-NetTCPConnection -State Listen` |
| Temperatures | `sensors` | `sudo powermetrics --samplers smc -n1` | `Get-CimInstance -Namespace root/wmi MSAcpi_ThermalZoneTemperature` |
| SMART | `sudo smartctl -H -A /dev/sda` | `smartctl -H disk0` | `Get-PhysicalDisk \| Get-StorageReliabilityCounter` |
| RAID / ZFS | `cat /proc/mdstat`, `zpool status -x` | `diskutil appleRAID list` | `Get-StoragePool` |
| Updates | `apt list --upgradable` / `dnf check-update` | `softwareupdate -l` | Settings → Windows Update |
| Reboot pending | `ls /var/run/reboot-required` | — | `Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'` |
| Clock | `timedatectl` / `chronyc tracking` | `sntp -d time.apple.com` | `w32tm /query /status` |
| Firewall | `sudo ufw status` / `firewall-cmd --state` | `/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate` | `Get-NetFirewallProfile \| select Name,Enabled` |
| Encryption | `lsblk -f` (crypto_LUKS) | `fdesetup status` | `manage-bde -status C:` |
| Defender | — | — | `Get-MpComputerStatus \| select RealTimeProtectionEnabled,AntivirusSignatureAge` |
| Failed logins | `journalctl -u ssh --since -1h \| grep Failed` | `log show --last 1h --predicate 'eventMessage contains "authentication failure"'` | Security log event 4625 |

<a id="host_cpu"></a><a id="host_memory"></a><a id="host_disk"></a>

### CPU / memory / disk usage (simple)

Older single-number checks kept for existing setups; **Endpoint metric** covers them in more
detail. Same commands as above.

<a id="disk_forecast"></a>

### Disk full forecast

**What it watches:** how many days until a disk fills at its recent growth rate. **Engine**
(from stored agent metrics).

**How it works:** fits a straight line through the disk's used space over the *Trend
over* period and projects when it reaches 100%. A shrinking or flat disk is fine.

**Value:** days until full.

**Check it yourself:** compare `df -h` (or `Get-Volume`) over a few days; find what's
growing with `du -xh --max-depth=1 / | sort -h` or WinDirStat/TreeSize.

<a id="host_reboot"></a>

### Reboot detection

**What it watches:** any reboot. **Report.**

**How it works:** the agent's reported boot time changing means the machine restarted; the
check holds warn (or down) for the hold period so an alert rule catches it.

**Check it yourself:** `last -x reboot | head` / `uptime -s` (Linux), `last reboot`
(macOS), Event Viewer → System, events 6005/6006/6008/1074/41 (Windows), or
`(Get-CimInstance Win32_OperatingSystem).LastBootUpTime`.

<a id="host_change"></a>

### Change detection

**What it watches:** new login sessions, new/removed listening ports, hardware or OS
inventory changes, interfaces, or mounts. **Report.**

**How it works:** compares each report's list with the previous one and holds the
chosen status for the hold period when something was added or removed, naming what
changed.

**Check it yourself:** `who` / `ss -tlnp` / `ip link` / `findmnt` (Linux); `query user`,
`Get-NetTCPConnection -State Listen` (Windows).

<a id="agent_heartbeat"></a>

### Agent online

**What it watches:** that the agent is still reporting — the machine is up, the agent
running, and the network path to Looksee working. **Engine.**

**How it works:** fails when the endpoint's last report is older than the allowed
silence. *Status when silent* (Advanced) chooses down or warn.

**Value:** seconds since the last report.

**Check it yourself:** `systemctl status looksee-agent` and
`journalctl -u looksee-agent -n 50` (Linux); `sudo launchctl list | grep looksee`
(macOS); `Get-ScheduledTask LookseeAgent | Get-ScheduledTaskInfo` (Windows) — to see the agent's
own output, stop the task and run
`C:\ProgramData\LookseeAgent\looksee-agent.exe -config C:\ProgramData\LookseeAgent\looksee-agent.yaml -once`
in an elevated PowerShell. Then `curl -I https://your-looksee/api/health` from
that machine.

## Services & processes (agent)

<a id="agent_service"></a>

### OS service

**What it watches:** that a systemd unit or Windows service is running; on Linux also
how often it restarts. **Agent.**

**How it works:** `systemctl is-active <name>` (and `NRestarts` for the restart count)
on Linux; `Get-Service` on Windows. Use **Browse** in the form to pick from the
endpoint's services with their state. **Advanced → Should be: Stopped** turns it around:
the check fails if the service *is* running — for services that should stay off
(Telnet, Remote Registry). Needs agent 5.0.

**Check it yourself:**

```bash
systemctl status nginx
journalctl -u nginx -n 50
```

```powershell
Get-Service Spooler | Select-Object Name, Status, StartType
Get-WinEvent -FilterHashtable @{LogName='System'; Id=7031,7034} -MaxEvents 10
```

<a id="agent_process"></a>

### Process

**What it watches:** a process is running (by name, substring match), how many, and
their CPU or memory. **Agent.**

**How it works:** lists processes and matches the name case-insensitively (so `nginx`
matches `nginx.exe`); counts them, or sums their CPU % / resident memory.

**Value:** count, CPU %, or MB.

**Check it yourself:** `pgrep -a nginx` / `ps aux | grep nginx` (Linux/macOS),
`Get-Process nginx | Select-Object Id, CPU, WorkingSet64` or Task Manager → Details
(Windows). The endpoint's **Processes** tab shows the same list.

<a id="agent_services_overview"></a>

### Failed / stopped services

**What it watches:** every failed systemd unit (Linux), or every automatic-start Windows
service that isn't running. **Agent.**

**How it works:** `systemctl list-units --failed`; on Windows, automatic services not
running — excluding ones that stopped cleanly (exit code 0) unless ticked, since
updaters and on-demand services do that routinely. Excluded services (own list or
reusable lists; `*` and `?` wildcards) are skipped.

**Value:** how many.

**Check it yourself:**

```bash
systemctl --failed
```

```powershell
Get-CimInstance Win32_Service -Filter "StartMode='Auto' AND State<>'Running'" | Select-Object Name, ExitCode
```

<a id="agent_scheduled_task"></a>

### Scheduled task / timer

**What it watches:** a Windows scheduled task's last result and run time, or a systemd
timer's service. **Agent.** (Cron has no record of results — use a
[Heartbeat](#heartbeat) for cron jobs.)

**How it works:** Windows: `Get-ScheduledTaskInfo` (last run time, last result; 0 =
success). Linux: `systemctl show <unit>` (Result, ExecMainStatus, last exit time).

**Value:** hours since it last ran.

**Check it yourself:** `Get-ScheduledTask -TaskName Nightly | Get-ScheduledTaskInfo`
(Windows), `systemctl list-timers` and `systemctl status backup.service` (Linux).

<a id="agent_script"></a>

### Custom script

**What it watches:** whatever your script checks, judged by its output and/or exit code.
**Agent.**

**How it works:** runs a script that sits directly in the agent's `script_dir` (`.ps1`
through PowerShell on Windows; anything executable elsewhere) with the arguments, under
the timeout. Looksee never sends a command to run — only the name of a script already on
the endpoint, so a compromised Looksee login can't run code on your machines. Without an
expected output: exit 0/1/2 = up/warn/down, other codes = unknown, and the first line is
the message (Nagios plugins work as-is, including `| label=value` performance data).
With an expected output (agent 4.0+): the engine compares the output (contains, doesn't
contain, equals, regex; optionally case-insensitive) and the exit code, and reports the
mismatch.

**Value:** the first perfdata value, or the first number in the output.

**Check it yourself:** run it exactly as the agent does, as the agent's user:

```bash
sudo -u looksee-agent /etc/looksee-agent/scripts/check_queue.sh arg1; echo "exit $?"
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\ProgramData\LookseeAgent\scripts\check.ps1; "exit $LASTEXITCODE"
```

## Files & logs (agent)

<a id="agent_file"></a>

### File / folder

**What it watches:** a file or folder: exists / doesn't exist, age of the file (or the
newest file in a folder — "did last night's backup land?"), size, number of files,
folder size, content changes (SHA-256), or a **watchdog** for files created, modified or
deleted. **Agent.**

**How it works:** stats the path (optionally only files matching a pattern, optionally
recursive). Checksum mode compares with the expected SHA-256 or the first one seen. The
watchdog compares a directory snapshot with the previous one and holds the status for
the hold period.

**Value:** minutes old, MB, or count.

**Check it yourself:**

```bash
ls -lt /srv/backups | head          # newest first
du -sh /srv/backups; find /srv/backups -type f | wc -l
sha256sum /etc/important.conf
```

```powershell
Get-ChildItem C:\Backups | Sort-Object LastWriteTime -Descending | Select-Object -First 5
(Get-ChildItem C:\Backups -Recurse | Measure-Object Length -Sum).Sum / 1MB
Get-FileHash C:\important.conf -Algorithm SHA256
```

<a id="agent_log"></a>

### Log file pattern

**What it watches:** new lines in a log file matching a pattern. **Agent.**

**How it works:** remembers its position in the file (following rotation; globs pick
the newest match) and counts new lines matching the regex (or not matching, if
inverted) since the last run; the matched lines are in the result details.

**Value:** new matching lines.

**Check it yourself:** `tail -f /var/log/app/app.log | grep -E 'ERROR|FATAL'`;
`Get-Content C:\logs\app.log -Wait -Tail 20 | Select-String 'ERROR'`.

<a id="agent_journal"></a>

### systemd journal

**What it watches:** new journal entries for a unit and/or at a priority, optionally
matching text. **Agent** (Linux).

**How it works:** reads `journalctl` from a saved cursor, so each entry is counted once.

**Value:** new matching entries.

**Check it yourself:** `journalctl -u nginx -p err --since "-1h"`.

<a id="agent_eventlog"></a>

### Windows Event Log

**What it watches:** new events by log, event ID, level, source and message text.
**Agent** (Windows).

**How it works:** queries `Get-WinEvent` from the last record it saw, so each event is
counted once. Useful IDs: 41 and 6008 (unexpected shutdown), 7031/7034 (service crashed),
7/11/51/153 (disk errors), 4625 (failed logon, *Security* log), 1074 (who restarted it),
and 372/805 in *Microsoft-Windows-PrintService/Operational* (failed print jobs).

**Value:** new matching events.

**Check it yourself:**

```powershell
Get-WinEvent -FilterHashtable @{LogName='System'; Id=41,6008; StartTime=(Get-Date).AddDays(-1)}
Get-WinEvent -FilterHashtable @{LogName='System'; Level=1,2} -MaxEvents 20
```

## OS & hardware (agent)

<a id="agent_perfcounter"></a>

### Windows performance counter

**What it watches:** any Windows performance counter. **Agent** (Windows).

**How it works:** reads the counter path with `Get-Counter` (wildcard instances combined
by sum/avg/max/min).

**Value:** the counter value.

**Check it yourself:** `Get-Counter '\Processor(_Total)\% Processor Time' -SampleInterval 1 -MaxSamples 3`;
list counters with `Get-Counter -ListSet * | Select-Object CounterSetName`.

<a id="agent_vpn"></a>

### VPN tunnel

**What it watches:** a WireGuard peer's last handshake, or that any tunnel interface
(OpenVPN, Tailscale, ZeroTier, …) exists and is up. **Agent.**

**How it works:** `wg show <iface> dump` for handshake age (WireGuard re-handshakes
about every 2 minutes on an active tunnel); otherwise the interface's up flag.

**Value:** seconds since the last WireGuard handshake.

**Check it yourself:** `sudo wg show wg0 latest-handshakes`, `ip link show tun0`,
`tailscale status`; on Windows `Get-NetAdapter | Where-Object InterfaceDescription -match 'WireGuard|TAP|Tailscale'`.

<a id="agent_ups"></a>

### UPS (NUT / apcupsd)

**What it watches:** a UPS connected to this endpoint. **Agent.**

**How it works:** reads `upsc <ups>` (Network UPS Tools) or `apcaccess` (apcupsd): on
battery → warn, low battery → down.

**Value:** battery charge %.

**Check it yourself:** `upsc ups@localhost` / `apcaccess status`.

<a id="agent_backup"></a>

### Backup job (Borg / restic / Veeam)

**What it watches:** that backups are recent (and, for Veeam, succeeded). **Agent.**

**How it works:** Borg: `borg list --last 1 --json <repo>`; restic: `restic snapshots
--latest 1 --json`; Veeam: the newest job-finished event in the Windows event log.
Passphrase and extra environment are passed as environment variables, never on the
command line.

**Value:** hours since the newest backup.

**Check it yourself:** `BORG_PASSPHRASE=… borg list --last 3 ssh://backup@nas/./repo`,
`restic -r … snapshots --latest 3`, or the Veeam console's job history.

## Software & security (agent)

These read the installed-software list agent 5.0 reports: Debian/Ubuntu (dpkg), RPM,
Alpine (apk) and Arch (pacman) packages, Windows programs (the registry's Uninstall
keys), macOS apps, global npm and pip packages, the Node.js/Python/PHP runtimes, and any
lock files you list. The agent sends the list when it changes, and at least once a day.

<a id="host_packages"></a>

### Upgradable packages

**What it watches:** packages with updates waiting. **Report.**

**How it works:** the agent lists upgradable packages (`apt list --upgradable` plus
`apt-get -s upgrade` to spot phased ones, `dnf check-update` with its security list,
`checkupdates` on Arch, Windows Update, `softwareupdate -l` on macOS). *Fail when* a
security update is waiting (default), any update is, or never. Ubuntu phased updates are
left out unless *Include Ubuntu phased updates* is ticked; excluded packages are neither
counted nor listed.

**Value:** packages to update.

**Check it yourself:**

```bash
apt list --upgradable                      # Debian/Ubuntu
sudo apt-get -s upgrade | grep -i phasing  # phased (deferred) ones
dnf check-update; dnf updateinfo list --security   # RHEL/Fedora
```

```powershell
Get-WindowsUpdate   # PSWindowsUpdate module; or Settings → Windows Update
```

<a id="host_software"></a>

### Installed software changed

**What it watches:** software installed, removed, or changed version. **Report.**

**How it works:** compares each software list with the previous one and, when something
changed, holds the chosen status for the hold period, naming what changed. *Only watch* limits it to some sources; excluded packages are
ignored (browsers that update themselves daily are good candidates).

**Value:** packages installed.

**Check it yourself:** `zgrep -h " install \| upgrade \| remove " /var/log/dpkg.log*`
(Debian/Ubuntu), `rpm -qa --last | head` (RPM), *Settings → Apps → Installed apps* or
`Get-WinEvent -FilterHashtable @{LogName='Application'; ProviderName='MsiInstaller'}`
(Windows).

<a id="host_vulnerable"></a>

### Vulnerable or unsupported software

**What it watches:** installed packages with known vulnerabilities, and an OS or runtime
past (or near) its end of support. **Report** (with lookups by the Looksee server).

**How it works:** the engine sends package names, versions and ecosystems (never
hostnames or addresses) to [OSV.dev](https://osv.dev)'s batch API and reads each
advisory's severity; the OS release and runtime versions are looked up on
[endoflife.date](https://endoflife.date). Answers are cached (advisories 7 days,
end-of-life dates 1 day). The worst finding decides: at or above *Down at severity* →
down, at or above *Warn at severity* → warn; an unsupported OS/runtime → the chosen
status, and a warning from *Warn this many days before end of life*. **Accepted risks**
(a package name or advisory ID, then `# reason`) are left out, with the reasons shown
in the result. Either lookup can be turned off under Advanced.

**Value:** vulnerable packages.

**Check it yourself:** paste a package into [osv.dev](https://osv.dev/list); on Ubuntu
`pro security-status`; `npm audit` / `pip-audit` / `composer audit` in an application
folder; `cat /etc/os-release` and look the version up on endoflife.date.

## Push & smart

<a id="heartbeat"></a>

### Heartbeat (cron / job check-in)

**What it watches:** that a job ran — your job calls a URL when it finishes. **Engine.**

**How it works:** each call to `/api/hb/<token>` records up (or down/warn with
`?status=`). If no call arrives within the interval plus the grace period, the check
goes down. See the user guide's [Heartbeats](user-guide.md#heartbeats-and-pushed-values).

**Check it yourself:** run the job by hand and watch the check turn up; check cron with
`grep CRON /var/log/syslog` or `journalctl -u cron`.

<a id="push_value"></a>

### Push a value

**What it watches:** a number your script sends (`?value=42`). **Engine.**

**How it works:** like a heartbeat, with the value stored so thresholds, charts and
anomaly detection apply.

**Value:** the pushed value.

<a id="calculated"></a>

### Calculated value

**What it watches:** a number worked out from up to four other checks' latest values.
**Engine.**

**How it works:** reads the latest value of the checks chosen as *a*–*d* and evaluates
the *Expression* with the same safe calculator as SNMP *Calculate*. If an input has no
value, or is older than *Inputs must be newer than*, the result is **unknown** rather than
a number worked out from stale data.

**Value:** the result; thresholds apply.

**Check it yourself:** open each input check's page and do the sum.

<a id="anomaly"></a>

### Anomaly (unusual value)

**What it watches:** another check's value (or response time) being unusually far from
its own normal. **Engine.**

**How it works:** takes the source check's history for the same hour of day (or hour of
the week) over the history period, computes the mean and standard deviation, and flags
the latest value: more than *sensitivity* standard deviations away (in the chosen
direction) is warn, more than 1.5× that is down. It learns before judging: until there
are *at least N samples* it reports up with "Learning baseline".

**Value:** the z-score (how many standard deviations from normal).

**Check it yourself:** open the source check's page and compare its chart over 7 or 30
days with the current value.
