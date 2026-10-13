# Security Audit — Looksee 4.0.0 (October 2026)

A full security check of Looksee 4.0.0 against the development standards
(`~/.claude/CLAUDE.md`: security baseline, secrets, logging, monitoring, deployment), plus
a review of every dependency for known vulnerabilities, support status and currency.
Done 2026-10-13 on the 4.0.0 working tree.

Related: [security guide](security-guide.md) · [deployment guide](deployment-guide.md) ·
[Windows agent & security software](windows-agent-security.md) · [README](../README.md)

## Contents

1. [Summary](#summary)
2. [Dependencies](#dependencies)
3. [Runtimes and platforms](#runtimes-and-platforms)
4. [Code review findings](#code-review-findings)
5. [Against the security baseline](#against-the-security-baseline)
6. [Open items](#open-items)

## Summary

| Area | Result |
|---|---|
| Engine production dependencies | **0 known vulnerabilities** after updates (critical `proxy-addr` and high `nodemailer` fixed) |
| Dashboard production dependencies | **0 known vulnerabilities** after Next.js 16.4.0 (critical advisories fixed) |
| Agent (Go) | **No vulnerabilities** (govulncheck, Linux/Windows/macOS) after moving to Go 1.26+/gopsutil v4 |
| Dev-only tooling | 4 moderate (engine) + 5 high (dashboard lint) — not shipped, not exploitable as used; accepted, see below |
| Code review | 5 issues found in the new security features and agent inventory — all fixed and covered by tests |
| Runtimes | **Server Node.js 20 is end-of-life** — upgrade step added to the 4.0 upgrade guide (manual, needs root) |

## Dependencies

Checked with `npm audit`, `npm outdated`, `govulncheck` and the projects' own support
pages.

**Engine** (`engine/package.json`):

| Package | Was | Now | Why |
|---|---|---|---|
| express (→ `proxy-addr`, `qs`) | 4.22.2 | 4.22.3 | **Critical**: `proxy-addr` IPv4-mapped-IPv6 trust-subnet IP spoofing (GHSA-jqcg-44mw-7w3h) — directly relevant to `TRUST_PROXY`; `qs` DoS/array-limit bypass |
| nodemailer | 9.1.1 | 10.1.0 | **High** advisory (≤10.0.8); 10.x's only breaking change is requiring Node 20+ |
| `ip-address`, `source-map-js`, `sprintf-js` (transitive) | — | fixed | `npm audit fix` |
| grpc-js, drizzle-orm/kit, express-rate-limit, imapflow, net-snmp, pg, puppeteer-core, supertest, tsx | patch/minor | latest within range | currency |

Remaining (dev-only): an old `esbuild` inside `drizzle-kit` (GHSA-67mh-4wv8-2f99, affects
esbuild's *dev server*, which nothing here runs). The offered "fix" downgrades drizzle-kit
to 0.18 — rejected. Re-check when drizzle-kit drops `@esbuild-kit`.

Not upgraded, deliberately: Express 5 (Express 4 is still officially supported — "ongoing";
5 is recommended and worth a planned migration), TypeScript 7, Vitest 5, dotenv 18,
bcryptjs 3 (major versions; no security driver).

**Dashboard** (`dashboard/package.json`):

| Package | Was | Now | Why |
|---|---|---|---|
| next / eslint-config-next | 16.3.3 | 16.4.0 | **Critical**: SSG/ISR cache poisoning (GHSA-mcj8-r9mp-w47p), image-optimization SSRF (GHSA-cjq9-62q9-8jv4) |
| sharp (transitive) | <0.35.5 | fixed | **High**: librsvg (CVE-2026-96889) |
| react / react-dom, react-grid-layout | 19.2.8 / 2.2.4 | 19.3.0 / 2.3.0 | currency |
| qrcode-generator, marked | — | 2.0.4, 16.4.2 | new in 4.0 (both MIT, zero dependencies) |

Remaining (dev-only): `braces`/`micromatch`/`brace-expansion` via `eslint-config-next`
(ReDoS/stack exhaustion when *linting* attacker-controlled glob patterns — not a real
input here). The offered fix downgrades the lint config — rejected.

**Agent** (`agent/go.mod`): Go directive 1.22 → **1.26**, build image `golang:1.22` →
**`golang:1.27`**, gopsutil **v3 → v4.26.9** (v3 no longer developed; temperature API moved
to `sensors`), go-winio 0.6.3, `golang.org/x/sys` current. `govulncheck` clean for linux,
windows and darwin; tests pass under `-race`; all five platform builds pass.

Lockfiles were regenerated with npm 10 and pass `npm@10 ci --dry-run`, per CLAUDE.md.

## Runtimes and platforms

| Component | In use | Status | Action |
|---|---|---|---|
| Node.js (server) | 20 (per CLAUDE.md) | **EOL 2026-04-30** — no security fixes | Upgrade to **Node 24 LTS** (EOL 2028-04-30): steps in [deployment guide → Upgrading to 4.0](deployment-guide.md#upgrading-to-40); first-install docs now use Node 24 |
| Node.js (collector runtime) | 24 (pinned) | supported | none |
| Go toolchain | 1.22 | EOL 2025-02 | moved to 1.26+/1.27 |
| PostgreSQL | 16 | supported to 2028-11 | none |
| Express | 4.22 | supported ("ongoing") | plan an Express 5 migration |
| Next.js | 16.4 | current | none |

## Code review findings

Reviewed every route, middleware and service added or changed in 4.0, with emphasis on
authentication, the security gate, client-IP handling, logging, and data the agent sends.

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | Medium | **TOTP codes reusable** within their ~90 s window (shoulder-surfed or replayed code + password) | Each code accepted once per user (`consumeTotp`); test added |
| 2 | Medium | **Account lockout as denial of service**: failing sign-ins as the admin's email from anywhere locked the admin out | Account-wide lockout no longer applies from IPs the account has signed in from; per-IP lockout unchanged; test added |
| 3 | Medium | **Self-block**: five typos from home triggered the *Password guessing* rule's 60-minute block of your own IP | Rules never auto-block allowlisted or known sign-in IPs (still notify); test added |
| 4 | Medium | **Heartbeat token in the security log** when a denied/unknown request hit `/api/hb/<token>` | Tokens masked in every logged path; test added |
| 5 | Medium | **Credentials in process command lines** (`--password=…`, URL passwords) would have been stored and shown in the new Processes tab | Masked in the agent before sending; Go tests for 10 patterns |

Also checked and found sound: login never issues a session on the password alone;
challenges are IP-bound, expire in 10 minutes and allow 5 attempts; bcrypt with a dummy
hash for unknown users (no user enumeration by timing or message); recovery codes are
bcrypt-hashed; constant-time code comparison; sessions are new on every sign-in; the
session list never exposes tokens; secrets stay write-only (channel configs, SNMPv3 keys —
the walk browser merges them server-side); webhook template values are JSON-escaped;
in-app help HTML comes only from repo docs at build time; inventory payloads are capped;
the allowlist refuses to lock out the current IP; `/api/health` stays reachable.

Accepted risks (documented in the security guide):

- With the default `TRUST_PROXY` (private ranges), a client that can reach the engine's
  port *directly* on the LAN could spoof `X-Forwarded-For`. Mitigated by setting
  `TRUST_PROXY` to the proxy's IP and firewalling 4100/3100 to the proxy (both now in the
  deployment guide).
- TOTP secrets are stored in the database (necessarily readable to verify codes); database
  backups are already treated as sensitive and Borg backups are encrypted.
- Admin-only features can reach arbitrary hosts (SNMP walk, channel tests) — the same
  capability checks already have; there is one admin and no role system by design.

## Against the security baseline

| Standard | Status |
|---|---|
| HTTPS in production | Documented (Caddy); HSTS snippet added to the security guide |
| Rate-limit auth endpoints | Yes — sign-in and verify (30 / 15 min / IP), per-challenge attempt cap, lockouts, rules |
| httpOnly + secure cookies | Yes — plus `SameSite=Strict`; `secure` when `NODE_ENV=production` (set in `ecosystem.config.cjs`) |
| Passwords hashed | bcrypt (cost 12); recovery codes bcrypt; min length configurable |
| CORS restricted | Explicit `CORS_ALLOWED_ORIGINS` only |
| Secrets write-only | Yes, including new channel types and `signing.env` (gitignored) |
| Secrets & `.env.example` | New vars documented: `TRUST_PROXY`, `DASHBOARD_URL`, `SECURITY_EVENT_RETENTION_DAYS`; `agent/signing.env.example` |
| Logging (no secrets, retention) | Security log masks tokens; command lines masked; 180-day retention; expired sessions/challenges/blocks pruned daily |
| Monitoring access points | Unchanged `/api/health`; security log viewable in the admin UI |
| Admin-only destructive actions | Single-admin app (CLAUDE.md); security changes need a session, and password/2FA changes need a current code |

## Open items

For you to do (each documented where linked):

1. **Upgrade the production server to Node.js 24** —
   [deployment guide → Upgrading to 4.0](deployment-guide.md#upgrading-to-40), step 2.
2. **Set `TRUST_PROXY`** and firewall 4100/3100 to the Caddy host — same section, step 1.
3. Choose a code-signing option for the Windows agent —
   [windows-agent-security.md → Signing the agent](windows-agent-security.md#signing-the-agent).
4. Optional hardening: VPN/identity-proxy in front of the dashboard, Caddy HSTS, edge
   geo-blocking — [security guide checklist](security-guide.md#hardening-checklist-for-an-internet-facing-looksee).

Planned work (not urgent): Express 5 migration; re-check the two dev-only advisories when
drizzle-kit and eslint-config-next release fixes; passkeys/WebAuthn as a second factor.
