# Security Guide

How Looksee protects itself when it's reachable from the internet, how to set each
safeguard up, a hardening checklist for a public deployment, and how to get back in if
you lock yourself out. Everything here is configured on **System → Security** unless
noted.

Related: [deployment-guide.md](deployment-guide.md) (server setup, reverse proxy,
firewall), [windows-agent-security.md](windows-agent-security.md) (the agent and Windows
security software), [user-guide.md](user-guide.md), [README](../README.md).

## Contents

1. [What's protected and what's public](#whats-protected-and-whats-public)
2. [Two-factor authentication (required)](#two-factor-authentication-required)
3. [Sign-in safeguards](#sign-in-safeguards)
4. [New-IP email confirmation](#new-ip-email-confirmation)
5. [IP allowlist](#ip-allowlist)
6. [Attack detection, notifications and blocking](#attack-detection-notifications-and-blocking)
7. [The security log](#the-security-log)
8. [Getting the real client IP behind a proxy](#getting-the-real-client-ip-behind-a-proxy)
9. [Hardening checklist for an internet-facing Looksee](#hardening-checklist-for-an-internet-facing-looksee)
10. [Locked out? Recovery](#locked-out-recovery)

## What's protected and what's public

| Reachable without signing in | Why | Protection |
|---|---|---|
| `/api/health` | Uptime monitors and the update script | Reveals only up/down and version; never blocked |
| `/install/*` | The agent install scripts and binaries | Nothing secret in them; the agent key is in the command you copy, not on the server |
| `/api/agent/*`, `/api/collector/*` | Agents and site collectors | Per-host agent key; wrong keys are logged and rate-ruled (*Agent key guessing*) |
| `/api/hb/<token>` | Heartbeat/push URLs | The token is the credential; unknown tokens are logged (*Heartbeat token guessing*) |
| `/status/<slug>` | Public status pages you publish | Shows only the names, status and uptime of checks you put on them |
| The sign-in page | — | Password + required two-factor, lockouts, optional allowlist and new-IP confirmation |

Everything else needs a signed-in session. Sessions are `httpOnly`, `secure` (in
production) and `SameSite=Strict` cookies, so another website can't make your browser
act in Looksee. Passwords are bcrypt-hashed; channel URLs/tokens, check passwords and the
SMTP/backup secrets are write-only (never sent back to the browser).

## Two-factor authentication (required)

Every sign-in needs a code from an authenticator app (TOTP — Microsoft/Google
Authenticator, 1Password, Bitwarden, Aegis, …). It can't be turned off in the app.

**First sign-in** (new install, or the first sign-in after upgrading to 4.0):

1. Enter your email and password. Looksee shows a QR code.
2. Scan it with your authenticator app (or tap **Can't scan?** and type the key).
3. Enter the 6-digit code the app shows and click **Turn on two-factor & sign in**.
4. Looksee shows **ten recovery codes, once**. Save them in your password manager, tick
   the box, and continue. Each code signs you in once without the app.

**Every later sign-in:** password, then the current 6-digit code — or your passkey, if
you've added one (below) — or **Use a recovery code**. Each code works once; if a code is
refused right after you used it, wait for the next one.

**Passkeys and security keys.** Under *Your account & 2FA → Passkeys & security keys*,
**+ Add a passkey**: name it, enter a current authenticator code (so a stolen session
can't add its own key), and touch your YubiKey or confirm on your phone/Windows Hello.
At sign-in, **Use a passkey or security key** replaces typing the code. The authenticator
app stays enrolled as the fallback, so two-factor never gets weaker; adding a passkey is
logged and sends a security notification. Passkeys are bound to Looksee's address
(the dashboard's hostname) — they work at `https://looksee.example.com`, not at an IP
or a different hostname. For a proxy setup where that address can't be worked out from
`DASHBOARD_URL`/`PUBLIC_URL`, set `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGINS` in
`engine/.env`.

**On the Security page (Your account & 2FA):**

- **New recovery codes** — replaces all of them (asks for a current code). Do this when
  fewer than three are left.
- **Move to a new phone / app** — shows a new QR code; your old authenticator keeps
  working until a code from the new one is confirmed.
- **Change password** — needs the current password and a current code; signs out every
  other session.
- **Signed-in sessions** — where and when each session signed in and was last active;
  sign one or all others out.

Lost both the phone and the recovery codes? See [Recovery](#locked-out-recovery).

## Sign-in safeguards

| Setting | Default | What it does |
|---|---|---|
| Lock out after N failures | 5 | Wrong passwords *or* wrong codes, counted both per IP and per account within the window. While locked, sign-in is refused (and logged) even with the right password. 0 turns it off (not recommended). |
| …within / for (minutes) | 15 | The counting window, and so how long a lockout lasts. |
| Minimum password length | 12 | Enforced when changing the password. |
| Stay signed in for | 720 h (30 days) | Session lifetime for new sign-ins. Shorter is safer on shared computers. |
| Sign out after idle | off | Ends a session unused for this many minutes. A dashboard left open keeps itself active. |

There's also a fixed rate limit of 30 sign-in attempts per IP per 15 minutes, in front of
everything else.

## New-IP email confirmation

When on, signing in from an IP address you haven't signed in from before also needs a
6-digit code sent to your account's email (on top of two-factor). The email also tells
you the IP — if it wasn't you, your password is known; change it.

1. Make sure email works: **Alerting → Channels → SMTP server → Send test email**.
2. On **Security → Sign-in safeguards**, tick **Email a code when signing in from a new
   IP address** and **Save**.
3. The IPs you've signed in from are under **Known sign-in IPs**; **Forget** one to make
   it ask again.

If the email can't be sent, sign-in from a new IP fails with a message saying so — test
SMTP first, and know the [recovery command](#locked-out-recovery).

## IP allowlist

Restricts the sign-in page and admin API to IPs/networks you list — the strongest
protection if you always use Looksee from known places (home, office, a VPN).

1. On **Security → IP access**, check **Your current IP as Looksee sees it**. If it's a
   private address (10.x, 192.168.x, 172.16–31.x) while you're actually coming from the
   internet, fix [the real client IP](#getting-the-real-client-ip-behind-a-proxy) first.
2. Enter one IP or CIDR range per line — e.g. your home's public IP, `10.0.0.0/8` for the
   LAN, your VPN's range. **Add my current IP** adds yours.
3. Tick **Only allow these IPs and networks** and **Save IP access**. Looksee refuses to
   save a list that doesn't include your current IP.

Agents, site collectors, heartbeat URLs, install scripts and public status pages keep
working from anywhere — unless you tick **Also apply to agents, collectors and heartbeat
URLs**, in which case every agent's and site's public IP must be listed too.
`/api/health` is always reachable.

**Dynamic home IP?** Allow your ISP's range, or better, connect through a VPN
(WireGuard/Tailscale/OpenVPN on pfSense) and allow only the VPN's range.

## Attack detection, notifications and blocking

Looksee records security events (see the table below) and **rules** turn patterns of
them into action: a notification, an automatic IP block, or both.

**Where notifications go:** **Send security emails to** (blank = your sign-in email —
needs SMTP), plus any **chat/push channels** you tick (Slack, Teams, Telegram, webhook,
push). **Send a test** confirms the path.

**Built-in rules** (edit, turn off or delete any of them):

| Rule | Fires when | Then |
|---|---|---|
| Password guessing | 5 failed sign-ins or wrong codes from one IP in 10 min | Notify + block the IP for 60 min |
| Vulnerability scanner | 3 scanner probes from one IP in 10 min | Notify + block for 24 h |
| Agent key guessing | 10 invalid agent keys from one IP in 10 min | Notify + block for 60 min |
| Heartbeat token guessing | 30 unknown heartbeat tokens from one IP in 10 min | Notify + block for 60 min |
| Sign-in from a new IP | Any successful sign-in from an IP not used before | Notify |
| Lockout or password change | An account lockout, a password change, or a recovery code used | Notify |

**Your own rules:** **+ Add rule**, tick the event types, set *at least N times within M
minutes*, choose per-IP or overall counting, and whether to notify and/or block (and for
how long). The **quiet period** stops a rule from notifying again for the same IP during
an ongoing attack. Examples:

- *Any allowlist denial* (threshold 1, notify) — someone outside your networks reached
  the sign-in page.
- *Distributed password guessing* — `login_failed` 20 times in 60 minutes, **not** per IP.
- *Rate limit hits* — `rate_limited` 3 times in 10 minutes, block for a day.

**Blocked IPs** (on **IP access**) lists current blocks, whether from a rule or added by
hand (IP or CIDR, for a time or until removed), with **Unblock**. A blocked IP gets
`403` for everything except `/api/health`. Looksee won't let you block your own current
IP by hand.

**Event types:**

| Event | Recorded when |
|---|---|
| Successful sign-in / Failed sign-in | After the second step / a wrong email or password |
| Sign-in refused: locked out | A sign-in attempt while locked |
| Sign-in from a new IP / New IP confirmed | First sign-in from an IP / with the emailed code |
| Wrong two-factor or email code | A wrong code at the second step |
| Two-factor set up / Recovery code used | Enrollment or moving authenticators / a recovery code |
| Password changed / Session signed out remotely | From the Security page |
| Request from an IP not on the allowlist | Each denied request |
| IP blocked | A rule or a person blocked an IP |
| Scanner/exploit probe | A request for a path that only exists on other software (`/.env`, `/wp-login.php`, `/phpmyadmin`, `/.git`, `.php` files, path traversal, …) |
| Invalid agent key / Unknown heartbeat token | A bad credential on the machine endpoints |
| Rate limit hit | Sign-in rate limit exceeded |
| Security settings changed | Any change on this page |

## The security log

**Security → Security log** shows every event for the last 24 hours to 30 days, filtered
by type, warnings/info, or a search over IP, path, browser and detail; click an IP to
see only its events. Events are kept for 180 days (`SECURITY_EVENT_RETENTION_DAYS` in
`engine/.env`).

## Getting the real client IP behind a proxy

Blocks, the allowlist, lockouts, "new IP" and the log all depend on Looksee knowing the
browser's real IP. Behind a reverse proxy (Caddy), every request arrives *from the
proxy*, with the real IP in the `X-Forwarded-For` header — which Looksee only believes
from proxies it trusts.

- **Default:** proxies on loopback/private addresses are trusted. That's right when the
  only way to reach the engine's port (4100) is through your proxy.
- **Recommended:** set the proxy's exact address in `engine/.env`, and firewall port 4100
  so only the proxy can reach it (deployment guide §5):

  ```bash
  echo 'TRUST_PROXY=10.1.30.10' >> ~/Looksee/engine/.env   # your Caddy host's IP
  pm2 restart looksee-engine
  ```

**Check:** sign in from your phone on mobile data; **Security → IP access** should show
the phone's public IP, not the proxy's. Caddy replaces any `X-Forwarded-For` a client
sends with the real address by default, so it can't be spoofed through Caddy — only by
reaching port 4100 directly, which the firewall rule prevents.

## Hardening checklist for an internet-facing Looksee

Built in and on by default: required two-factor, bcrypt, lockouts, rate limiting,
SameSite=Strict httpOnly cookies, scanner/brute-force/key-guessing detection with
auto-blocking, security headers on the API and dashboard, write-only secrets, per-host
agent keys, script checks limited to approved scripts.

Recommended, roughly in order of value:

1. **Don't expose the dashboard to the whole internet if you don't need to.** The
   strongest option is reaching it only through a VPN (WireGuard/Tailscale/OpenVPN) or
   an identity-aware proxy (Cloudflare Access, Authentik/Authelia forward-auth), while
   leaving only the machine paths (`/api/agent`, `/api/collector`, `/api/hb`,
   `/install`, `/status`, `/api/health`) public for remote agents. With Caddy:

   ```caddy
   looksee.example.com {
     @outsider {
       not remote_ip 203.0.113.10 10.0.0.0/8 100.64.0.0/10
       not path /api/agent/* /api/collector/* /api/hb/* /api/public/* /install/* /status/* /api/health /_next/*
     }
     respond @outsider 403
     # ...the handle blocks from the deployment guide...
   }
   ```

   (Replace the addresses with your public IP, LAN and VPN ranges.) Looksee's own
   allowlist does the same inside the app; doing it at the proxy too means the app is
   never even reached.
2. **Set `TRUST_PROXY`** and firewall port 4100/3100 to the proxy only (above).
3. **Turn on new-IP email confirmation** once SMTP is tested.
4. **Add HSTS and tidy headers at Caddy:**

   ```caddy
   looksee.example.com {
     header {
       Strict-Transport-Security "max-age=31536000; includeSubDomains"
       -Server
     }
     # ...
   }
   ```

5. **Geo-block or rate-limit at the edge** — pfSense pfBlockerNG GeoIP on the port
   forward, or CrowdSec reading Caddy's access log, stops most scanners before they
   reach Looksee.
6. **Send security notifications somewhere you'll see quickly** — a Teams/Slack/Telegram
   channel or push, not just email.
7. **Keep the server patched** (`unattended-upgrades` on Ubuntu/Debian) and update
   Looksee regularly (`scripts/update.sh`).
8. **Treat backups as secrets** — they contain check credentials and agent keys. Looksee's
   Borg backups are encrypted; keep the passphrase in your password manager.
9. **Rotate credentials that leak** — **Regenerate key** on a host (Agent tab), **Regenerate
   URL** on a heartbeat check, **Replace settings** on a channel.
10. **Monitor Looksee from outside** — turn on the [watchdog](user-guide.md#watchdog)
    (System → Watchdog) with a free Healthchecks.io check, so you hear about it if
    Looksee itself goes down.
11. **Sign the Windows agent** so security software on your hosts trusts it — see
    [windows-agent-security.md](windows-agent-security.md#signing-the-agent).

Chosen for the production deployment (October 2026): the dashboard stays public behind
two-factor, lockouts and rules; Caddy adds HSTS and hides its Server header; security
notifications go to email and phone push.

Since 4.1: passkeys/security keys as a second factor (above) and the outbound
[watchdog](user-guide.md#watchdog) for Looksee's own outages. Not planned: more than one
user account, per-agent IP pinning.

## Locked out? Recovery

The recovery command needs a shell on the Looksee server — nothing here is reachable over
the web, which is what makes it safe.

```bash
cd ~/Looksee/engine
npm run security:reset              # turns off the allowlist and new-IP confirmation, removes all IP blocks
npm run security:reset -- --2fa     # also clears two-factor; you'll set it up again at the next sign-in
```

It lists what it will do and asks for `y` to continue. **What success looks like:**
`Done. The running engine picks this up within 10 seconds — no restart needed.` Then
sign in again (and, after `--2fa`, enrol your authenticator and save the new recovery
codes). Lockouts from failed sign-ins expire on their own after the lockout window.

Forgot the password itself? `npm run db:create-admin` in the same folder resets it (it
asks before overwriting).
