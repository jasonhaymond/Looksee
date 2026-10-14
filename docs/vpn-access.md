# VPN-Only Access

How to make Looksee reachable only through your VPN — just the admin dashboard, or the
agents too — using an OpenVPN or WireGuard remote-access server on your firewall, and how
to undo it. Firewall steps use pfSense's menus; other firewalls have equivalents.

> **All addresses and names here are examples.** The guide uses a made-up network:
> LAN `10.20.0.0/16`, servers VLAN `10.20.30.0/24`, Caddy at `10.20.30.10`, Looksee at
> `10.20.30.45`, the firewall's DNS resolver at `10.20.1.1`, VPN clients in
> `10.20.100.0/24` (OpenVPN) and `10.20.111.0/24` (WireGuard), hostname
> `looksee.example.com`. Substitute your own everywhere.

> **Status: not applied.** Production today is deliberately public, protected by the
> required two-factor sign-in and the security rules (decided October 2026). This guide
> is the plan for when you choose to lock it down; nothing in it is set up yet. Follow it
> in order — the VPN path is proven working *before* anything is restricted, so you can't
> lock yourself out partway through.

Related: [security-guide.md](security-guide.md) (two-factor, IP allowlist, recovery),
[deployment-guide.md](deployment-guide.md) (Caddy, firewall, agents),
[user-guide.md](user-guide.md), [README](../README.md).

## Contents

1. [Choosing how far to go](#1-choosing-how-far-to-go)
2. [What talks to Looksee](#2-what-talks-to-looksee)
3. [Before you start](#3-before-you-start)
4. [Step 1 — Let the VPN reach Looksee](#4-step-1--let-the-vpn-reach-looksee)
5. [Step 2 — Split DNS](#5-step-2--split-dns)
6. [Step 3 — Prove it works over the VPN](#6-step-3--prove-it-works-over-the-vpn)
7. [Option A — Admin only through the VPN](#7-option-a--admin-only-through-the-vpn)
8. [Option B — Agents through the VPN too](#8-option-b--agents-through-the-vpn-too)
9. [Option C — Nothing public at all](#9-option-c--nothing-public-at-all)
10. [Verifying the lockdown](#10-verifying-the-lockdown)
11. [Rolling back](#11-rolling-back)
12. [Troubleshooting](#12-troubleshooting)

## 1. Choosing how far to go

| | Admin dashboard | Agents, site collectors, heartbeats | Public status pages | Effort |
|---|---|---|---|---|
| **Today** | Public (2FA required) | Public (per-host keys/tokens) | Public | — |
| **A. Admin via VPN** | VPN/LAN only | Public | Public | Low — one Caddy block |
| **B. Agents via VPN too** | VPN/LAN only | VPN/LAN only | Public | Medium — every remote agent needs a tunnel |
| **C. Nothing public** | VPN/LAN only | VPN/LAN only | Gone | High — no port forward, DNS-01 certificates |

**Option A is the recommended step.** It removes the sign-in page — the only part of
Looksee an attacker can usefully hammer — from the internet, while every agent and
heartbeat keeps working unchanged. Agents authenticate with per-host keys and can only
*report*; they can't read anything back, so leaving their paths public costs little.

Option B is worth it only if every remote machine can hold a VPN connection reliably. An
agent that loses its tunnel goes silent, and Looksee raises "agent offline" alerts for it.

## 2. What talks to Looksee

| Who | Paths | Direction | Affected by |
|---|---|---|---|
| You, in a browser or the phone app | `/`, every dashboard page, `/api/*` (the rest) | Inbound | A, B, C |
| Agents | `/api/agent/*`, `/install/*` (install + self-update downloads) | Inbound | B, C |
| Site collectors (run by an agent at a remote site) | `/api/collector/*` | Inbound | B, C |
| Heartbeat / push URLs (cron jobs, backup scripts, other services) | `/api/hb/<token>` | Inbound | B, C |
| Public status pages | `/status/*`, `/api/public/*`, `/_next/*` (page assets) | Inbound | C |
| Uptime monitors, `update.sh` | `/api/health` | Inbound | C only |
| Syslog, SNMP traps, NetFlow/sFlow sent straight to the server | UDP/TCP 1514, 1162, 2055, 6343 | Inbound, not via Caddy | B, C (firewall, not Caddy) |
| Notifications (email, Telegram, Slack, Teams, push), watchdog ping, checks of outside sites | — | Outbound | Never |

Web push to your phone is delivered by Google/Apple, not by your phone connecting to
Looksee, so alerts still arrive with the VPN off. Opening the alert in the app needs the
VPN up.

## 3. Before you start

You need:

- **Shell access to the Looksee server** and the Caddy host, from the LAN — not only
  through Looksee itself. This is your way back in if
  something goes wrong (see [Rolling back](#11-rolling-back)).
- **A working remote-access VPN profile on each device you'll use** — one that can
  reach the LAN (a *split tunnel* that routes your internal networks into the VPN). Below,
  the OpenVPN server is called `REMOTE_ACCESS` and its WireGuard equivalent
  `WG_REMOTE_ACCESS`.
  - A full-tunnel or privacy profile whose firewall rules block the LAN won't work: it
    can't reach Looksee's internal address.
  - Nor will a DNS-filtering-only profile that reaches nothing but the resolver.
- **Your LAN/VPN ranges written down.** The examples below use `10.20.0.0/16`, which
  covers every VLAN and both VPN client ranges. If you'd rather not trust every VLAN (a
  guest or IoT network, say), list only the ones you use instead — e.g. your own
  workstation VLAN plus the VPN ranges: `10.20.70.0/24 10.20.100.0/24 10.20.111.0/24`.
- **`TRUST_PROXY` set** on the engine (security guide →
  [real client IP](security-guide.md#getting-the-real-client-ip-behind-a-proxy)). Without
  it, Looksee sees every visitor as the Caddy host, and its own allowlist and security log
  are meaningless. Caddy's own `remote_ip` check (used below) doesn't depend on it.

Below, `looksee.example.com` is the Looksee hostname and `10.20.30.10` the Caddy host's
LAN address.

## 4. Step 1 — Let the VPN reach Looksee

VPN clients reach Looksee the same way LAN machines do: through Caddy's LAN address on
port 443. Check that the VPN allows it. In the pfSense web UI:

1. **VPN → OpenVPN → Servers → `REMOTE_ACCESS` → Edit.** Under *Tunnel Settings*, **IPv4
   Local network(s)** must include the network Caddy is on (`10.20.30.0/24`). If it names a
   firewall alias instead of networks, check the alias under **Firewall → Aliases**.
2. On the same page, under *Advanced Client Settings*, **DNS Server enable** should be
   ticked with **DNS Server 1** = `10.20.1.1`. Step 2 depends on VPN clients using pfSense
   for DNS.
3. **Firewall → Rules → `REMOTE_ACCESS`** (the VPN's interface tab): a pass rule from the
   VPN's net to the servers network on TCP 443 must exist above any block rule.
4. For WireGuard: **VPN → WireGuard → Peers** — each peer's *Allowed IPs* on the client
   side (the device's tunnel config) must include `10.20.30.0/24`. The client config's
   `DNS =` line must be `10.20.1.1`. **Firewall → Rules → `WG_REMOTE_ACCESS`** must pass to
   the servers net.

**Check:** connect a laptop to `REMOTE_ACCESS` from outside (phone hotspot), then:

```bash
ping -c 3 10.20.30.10
curl -sk https://10.20.30.10/ -o /dev/null -w "%{http_code}\n"
```

Ping should answer. curl should print a status code (any code, even `404` or `000` from
the certificate mismatch, proves the TCP connection). A timeout means the route or
firewall rule is missing.

## 5. Step 2 — Split DNS

On the VPN, the Looksee hostname must resolve to Caddy's **LAN** address. If it resolves
to the public IP instead, traffic to it doesn't go into the split tunnel; it goes out the
device's own internet connection. Caddy then sees the device's public IP and refuses it.

In pfSense: **Services → DNS Resolver → Host Overrides → Add**:

| Field | Value |
|---|---|
| Host | `looksee` |
| Domain | `example.com` |
| IP Address | `10.20.30.10` (Caddy's LAN address) |
| Description | Looksee — internal address for LAN/VPN |

**Save**, then **Apply Changes**.

This also applies to every LAN machine using pfSense for DNS. That is what you want: LAN
browsers and LAN agents now reach Caddy directly, arriving with their real `10.20.x.x`
address rather than via the router's NAT reflection. Public DNS is unchanged, so
certificate renewals keep working.

**Check** on the VPN-connected laptop (and on a LAN machine):

```bash
nslookup looksee.example.com
```

The answer should be `10.20.30.10`, from server `10.20.1.1`. Windows caches DNS: run
`ipconfig /flushdns` if it still shows the public IP.

## 6. Step 3 — Prove it works over the VPN

Before restricting anything:

1. With the laptop on the VPN from outside, open `https://looksee.example.com`.
   Sign in. The certificate is the normal valid one, since the name matches.
2. In Looksee, **System → Security → IP access** shows **Your current IP as Looksee sees
   it**. It should be the laptop's VPN address (`10.20.100.x` or `10.20.111.x`).
   - If it shows `10.20.30.10` (the Caddy host), fix `TRUST_PROXY` first.
   - If it shows your public IP, split DNS isn't in effect; go back to Step 2.
3. Repeat on the phone, with the VPN connected over mobile data.
4. **On Android, make the VPN always-on** so the app works without remembering to connect:
   *Settings → Network & internet → VPN → ⚙ next to OpenVPN/WireGuard → Always-on VPN*.

Only continue once both devices show their VPN address.

## 7. Option A — Admin only through the VPN

Two layers, both recommended. Caddy refuses outsiders before they reach Looksee at all.
Looksee's own allowlist refuses them again if Caddy is ever misconfigured, and logs each
refusal.

### A1. Caddy

On the Caddy host, edit `/etc/caddy/Caddyfile`. Wrap the existing Looksee site's
`handle` blocks in a `route { }` block, and put the restriction first inside it:

```caddy
looksee.example.com {
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    -Server
  }
  route {
    # Everyone outside the LAN/VPN gets a 403, except on the paths agents,
    # heartbeats, installers and public status pages use.
    @outsider {
      not remote_ip 10.20.0.0/16
      not path /api/agent/* /api/collector/* /api/hb/* /install/* /status/* /api/public/* /_next/* /api/health /icon.svg /manifest.json /sw.js
    }
    respond @outsider "Not available from your network." 403

    @api path /api/* /install/*
    handle @api {
      reverse_proxy 10.20.30.45:4100
    }
    handle {
      reverse_proxy 10.20.30.45:3100
    }
  }
}
```

**The `route { }` wrapper is required.** Caddy normally sorts directives into its own
fixed order, and `handle` runs before `respond`. Without the wrapper, the `respond` line
is silently never reached and nothing is blocked. This was tested on Caddy 2: without
`route`, every path returned 200 from outside; with it, only the listed paths did.

`/_next/*` is in the list because public status pages load their scripts from it. Those
files are the dashboard's program code, the same for every installation, and contain no
data.

Apply it:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

**Check:** `validate` ends with `Valid configuration`. The reload prints nothing. Then
run the checks in [section 10](#10-verifying-the-lockdown).

### A2. Looksee's own allowlist

In Looksee (connected over the VPN), go to **System → Security → IP access**:

1. Enter one range per line: `10.20.0.0/16` (or the narrower list from
   [section 3](#3-before-you-start)).
2. Leave **Also apply to agents, collectors and heartbeat URLs** *unticked*.
3. Tick **Only allow these IPs and networks**, then **Save IP access**. Looksee refuses to
   save a list that doesn't include the address you're using right now, so this step
   can't lock you out.

**Check:** the page shows the allowlist as on. Any refusal from now on appears in
**Security → Events** as *allowlist_denied*.

## 8. Option B — Agents through the VPN too

Do Option A first and live with it for a while. Then:

### B1. Get every agent onto the LAN or a tunnel

| Where the agent is | What to do |
|---|---|
| On the home LAN | Nothing. With split DNS it already arrives from a `10.20.x.x` address. |
| A remote site with its own router | A site-to-site tunnel between that router and pfSense (WireGuard is the simplest). Add the site's LAN range to the allow list. |
| A remote site without a router you control | Run an always-on WireGuard client on the site-collector host (or on each machine with an agent). Add the tunnel range. |
| A roaming laptop | An always-on VPN client, or accept that it reports only while connected. Its agent queues nothing, so gaps show as "offline". |

The agent's `engine_url` can stay `https://looksee.example.com`, but only if
that name resolves to the internal address over the tunnel. Two ways to arrange that:
point the remote site's DNS (or the tunnel's DNS setting) at `10.20.1.1`, or add the same
host override on the remote site's own resolver.

If neither is possible, change the agent's `engine_url` to an internal name that resolves
there, then restart the agent. The config file is in a different place on each OS:

| OS | Config file | Restart |
|---|---|---|
| Linux | `/etc/looksee-agent/looksee-agent.yaml` | `sudo systemctl restart looksee-agent` |
| macOS | `/usr/local/etc/looksee-agent/looksee-agent.yaml` | `sudo launchctl unload /Library/LaunchDaemons/com.looksee.agent.plist && sudo launchctl load -w /Library/LaunchDaemons/com.looksee.agent.plist` |
| Windows | `C:\ProgramData\LookseeAgent\looksee-agent.yaml` | `Stop-ScheduledTask -TaskName LookseeAgent; Start-ScheduledTask -TaskName LookseeAgent` (elevated PowerShell) |

Caddy's certificate is only valid for the public hostname, so the internal name must be
an alias that still resolves to Caddy and uses the same hostname. Don't point agents at a
bare IP: TLS verification fails.

**Check:** each host's row on **Hosts** shows *last seen* within the last minute. Do this
for every remote host before B2. Any host still reporting from a public IP is refused
once B2 is in place.

### B2. Narrow Caddy's public paths

In the Caddyfile from A1, shorten the `not path` line so only status pages and health
stay public, and add each remote site's range to `remote_ip`:

```caddy
    @outsider {
      not remote_ip 10.20.0.0/16 10.2.0.0/24
      not path /status/* /api/public/* /_next/* /api/health /icon.svg /manifest.json /sw.js
    }
```

(`10.2.0.0/24` is an example remote site's LAN behind a site-to-site tunnel.) Validate
and reload as in A1.

In Looksee, **Security → IP access**: add the same remote ranges, tick **Also apply to
agents, collectors and heartbeat URLs**, and **Save IP access**.

### B3. Things that stop working

- **Heartbeat URLs called from outside your networks.** This covers a cloud backup
  service, a VPS cron job, or anything else not on the LAN or a tunnel. Each one starts
  missing, and its heartbeat check alerts. Move it behind the VPN, or keep `/api/hb/*` in
  the public path list. The URL's token is its credential, so leaving it public is a
  reasonable compromise.
- **Installing a new agent from outside.** The one-line install command downloads from
  `/install/*`. Run it from a machine that's already on the LAN or a tunnel.
- **Direct syslog/trap/flow push from remote sites** (UDP/TCP 1514, 1162, 2055, 6343)
  doesn't go through Caddy, so the Caddyfile doesn't affect it. Send it over the tunnel
  instead. On the Looksee server, replace the per-site public-IP rules from
  [deployment guide §5](deployment-guide.md#5-firewall) with the tunnel range, e.g.
  `sudo ufw allow from 10.2.0.0/24 to any port 1514`. Then remove those ports' port
  forwards on pfSense (**Firewall → NAT → Port Forward**). A site with a collector
  already sends to its collector locally, so it needs none of this.

## 9. Option C — Nothing public at all

Option C removes the pfSense port forward for 443 (and 80) to Caddy entirely. Public
status pages and outside uptime monitors stop working. Use the outbound
[watchdog](user-guide.md#watchdog) instead: it pings out, so it needs no inbound access.

The catch is certificates. Let's Encrypt has to reach Caddy over port 80 or 443 to issue
and renew them through the normal HTTP/TLS challenge. With no port forward, renewal fails
after about 60 days. The two ways out:

1. **DNS-01 challenge.** Caddy proves ownership by creating a DNS TXT record through your
   DNS provider's API. That needs a Caddy build containing that provider's module (from
   [caddyserver.com/download](https://caddyserver.com/download) or `xcaddy`) and an API
   token, set in the site block:

   ```caddy
   looksee.example.com {
     tls {
       dns <provider> {env.DNS_API_TOKEN}
     }
     # ...route block as in A1/B2, with the @outsider block removed...
   }
   ```

   Store the token in Caddy's environment file (e.g. `/etc/caddy/env`, mode 600), not in
   the Caddyfile. Keep the 80/443 port forward until a renewal through DNS has worked,
   which you'll see in `journalctl -u caddy` as `certificate obtained successfully`.
2. **Keep the port forward and Option B's Caddy rules.** This is functionally almost the
   same: only `/api/health` and status pages answer, and the challenges keep working.
   This is the simpler choice unless you specifically want no open port.

## 10. Verifying the lockdown

Run these from **outside, off the VPN** (phone hotspot, VPN disconnected):

```bash
H=https://looksee.example.com
for p in / /login /api/auth/me /api/checks /api/agent/config /api/hb/test /install/install.sh /status/x /api/health; do
  printf '%-22s %s\n' "$p" "$(curl -s -o /dev/null -w '%{http_code}' "$H$p")"
done
```

What success looks like:

| Path | Option A | Option B |
|---|---|---|
| `/`, `/login`, `/api/auth/me`, `/api/checks` | `403` | `403` |
| `/api/agent/config`, `/api/hb/test`, `/install/install.sh` | **not** `403` (`401`/`404`/`200` — Looksee answered) | `403` |
| `/status/x`, `/api/health` | not `403` | not `403` |

Then **connect the VPN** and run it again. Nothing should be `403`.
`/api/health` should return `200`.

Finally, in Looksee: **Hosts** shows every agent reporting normally, **Security → Events**
shows no *allowlist_denied* from your own addresses, and a heartbeat check you trigger
from the LAN turns green.

## 11. Rolling back

From a machine on the LAN, or with SSH to the Caddy host:

1. In the Caddyfile, delete the `@outsider { ... }` block and its `respond @outsider`
   line. You can leave the `route { }` wrapper; it's harmless.
2. Validate and reload Caddy:

   ```bash
   sudo caddy validate --config /etc/caddy/Caddyfile
   sudo systemctl reload caddy
   ```

3. Turn off the in-app allowlist: **System → Security → IP access**, untick **Only allow
   these IPs and networks**, then **Save IP access**. If you can't reach the dashboard at
   all, run this on the Looksee server instead:

   ```bash
   cd ~/Looksee/engine
   npm run security:reset    # turns off the allowlist and new-IP confirmation, clears IP blocks
   ```

   It asks for `y`. It prints
   `Done. The running engine picks this up within 10 seconds — no restart needed.`
4. Remove the DNS host override only if you want LAN clients back on the public address.
   Leaving it in place is harmless and slightly faster.

**Check:** the off-VPN loop from section 10 returns no `403`s.

Agents whose `engine_url` you changed in B1 keep working as long as the internal name
still resolves for them. Nothing in the database changes at any point in this guide, so
there's no data to restore.

## 12. Troubleshooting

- **Everything returns 200 from outside after adding the block.** The `route { }` wrapper
  is missing (see A1). Caddy accepts the file, but never reaches `respond`.
- **403 while on the VPN.** Check what Looksee sees on **Security → IP access**, or
  Caddy's access log for the source address.
  - Your public IP: split DNS isn't working on that device. Run `nslookup`, flush its DNS
    cache, and check the VPN pushes `10.20.1.1`.
  - A `10.20.x.x` address outside your `remote_ip` list: add the range.
  - On Android, some browsers use their own "secure DNS" (DNS over HTTPS) and bypass the
    VPN's resolver. Turn it off in the browser's privacy settings, or set Android's
    *Private DNS* to *Off/Automatic*.
- **The VPN connects but the page times out.** Step 1 is incomplete: either the route to
  `10.20.30.0/24` isn't pushed, or the VPN interface's firewall rule doesn't pass it.
- **An agent went offline right after B2.** It's still reaching Looksee from a public IP.
  Check its tunnel. In Caddy's log, look for `403` on `/api/agent/` from that host's
  address.
- **Certificate errors on the VPN.** You're browsing to the IP or another name. Use the
  public hostname; split DNS makes it resolve internally.
- **Passkey sign-in fails over the VPN but worked before.** It's the same hostname, so it
  shouldn't. If you reached Looksee by a different name, passkeys are bound to the
  original one (security guide →
  [passkeys](security-guide.md#two-factor-authentication-required)).
