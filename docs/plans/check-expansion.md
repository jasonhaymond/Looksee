# Expanding checks and templates — recommendations

**Status: recommendations only.** Nothing here is built. Written for 5.0 (plan item 6.2)
as a menu for future releases, roughly in order of value for the effort. Each item says
what it would add, how it would work in Looksee's existing pieces, and what to watch
out for.

Related: [v5.0 plan](v5.0.md), [check reference](../check-reference.md),
[check settings](../check-settings.md), [README](../../README.md).

## Contents

1. [Quick wins (small, high value)](#quick-wins-small-high-value)
2. [New check types](#new-check-types)
3. [Templates](#templates)
4. [SNMP](#snmp)
5. [Software and security](#software-and-security)
6. [Smarter suggestions](#smarter-suggestions)
7. [Things to avoid](#things-to-avoid)

## Quick wins (small, high value)

| Idea | How | Notes |
|---|---|---|
| **Certificate checks for every TLS port the agent sees listening** | Suggestions already know listening ports; add `ssl_cert` suggestions for 443/8443/993/995/636/465 alongside the reachability ones | Covers internal web UIs (Proxmox, NAS, printers) whose certs expire unnoticed |
| **"Expected listening ports" baseline** | A `host_change` variant that compares listening ports with a saved list rather than the previous report | Catches a new service appearing (or one vanishing) on a server that shouldn't change |
| **Windows certificate store expiry** | Agent: `Get-ChildItem Cert:\LocalMachine\My` → days to expiry per cert; new metric family `certs.*` | Many on-prem apps (RDS, IIS, ADFS) fail silently on an expired local cert |
| **Local admin group membership** | Agent: list members of Administrators / `sudo`/`wheel`; `host_change` kind `admins` | Complements the Windows event-ID check in the security baseline, and works on Linux |
| **Scheduled-task inventory change** | Agent: task/timer names + actions hash; `host_change` kind `tasks` | Persistence via scheduled tasks is a common attacker step |
| **Thresholds on calculated SNMP extra OIDs per row** | Let walks use `Calculate` per row (e.g. % used per storage row) and aggregate after | Today Calculate runs on the combined value |

## New check types

| Type | What | Effort | Notes |
|---|---|---|---|
| **Active Directory replication** | `repadmin /replsummary` parsed by the agent on a DC | Medium | Pair with the DC role template |
| **DNS zone serial / DNSSEC expiry** | Engine: compare SOA serials across a zone's name servers; RRSIG expiry days | Small | Extends the DNS check; pure network, no agent |
| **SMB share reachable + login** | Engine: connect and list a share with stored credentials | Medium | Credentials must be write-only like other secrets |
| **Wi-Fi controller / AP state** | UniFi and Omada APIs as app integrations (APs offline, clients, firmware) | Medium per vendor | Common in small offices and homes |
| **pfSense / OPNsense** | API integration: gateways down, CARP state, package updates | Medium | Gateway status is the most asked-for item |
| **Backup freshness for NAS jobs** | Synology Hyper Backup / Active Backup via DSM API | Medium | Complements the agent backup-job check |
| **Microsoft 365 / Entra service health** | Graph API service health for a tenant | Medium | Needs an app registration; read-only scope |
| **Speed test** | Agent runs a short download/upload to a chosen server | Small | Run rarely (hourly) — it uses real bandwidth |
| **Kubernetes** | Nodes ready, pods crash-looping, PVC usage via the API | Large | Only if a real deployment needs it |

## Templates

- **Role templates to add:** Hyper-V cluster node, RDS/terminal server (session counts,
  licensing service), print server (spooler + PrintService event IDs 372/805 — already
  documented as a manual check), Nextcloud (cron freshness via `occ`, PHP-FPM, Redis),
  Home Assistant, Plex/Jellyfin, UniFi controller, WireGuard gateway.
- **Template versions:** applying a template records which template (and version) each
  check came from, so a later change to the template can offer "update 12 checks made
  from this template" instead of being a one-time copy.
- **Template export/import:** SNMP and role templates as JSON files, so templates can be
  shared between Looksee installs. Validate on import exactly as on create.
- **Group-wide apply:** apply a role or SNMP template to every endpoint in a group in one
  action (skipping existing checks, as single applies already do).

## SNMP

- **MIB import:** let an admin upload a vendor MIB file; parse only OBJECT-TYPE names,
  OIDs, syntax and enumerations into the dictionary (no MIB compiler at runtime). Size
  and count limits; parse in the engine, never execute anything.
- **More vendor counters in the dictionary:** Fortinet, Ubiquiti, MikroTik, HPE/Aruba
  switches, Eaton UPS, Vertiv/Liebert, NetApp — each a handful of high-value OIDs.
- **LLDP/CDP neighbors:** walk LLDP-MIB to show which switch port each device is on;
  later, a topology view and a check that alerts when a device moves port.
- **Per-port templates:** "uplink" vs "access port" profiles on the SNMP interfaces check
  (thresholds and alerting differ by role).
- **SNMP community write-only:** today v1/v2c community strings are returned to the
  dashboard like other settings (v3 keys are already write-only). Make communities
  write-only too — this was raised in the 5.0 security review.

## Software and security

- **Windows Update details:** KB numbers and classifications for pending updates, and
  "last successfully installed" age as a metric.
- **Winget / Chocolatey / Homebrew upgradable lists** to complement the OS package
  managers.
- **CISA KEV flag:** mark vulnerabilities on CISA's Known Exploited Vulnerabilities list
  and allow "down only for known-exploited". Cache the list daily like the other lookups.
- **SBOM export:** download an endpoint's software list as CycloneDX JSON.
- **Per-group accepted risks:** an exclusion list kind for advisory IDs, so an accepted
  risk can be recorded once for a group of servers with its reason.

## Smarter suggestions

- **Learn from what's added:** when most endpoints with a given role have a check the
  current one lacks, suggest it ("8 of your 9 web servers have an HTTP check on /health").
- **Suggest from traffic:** flows (NetFlow/sFlow) show which internal services are used;
  suggest checks for busy internal services that have none.
- **Suggest alert rules,** not only checks: checks without any alert rule in a group that
  otherwise has one.
- **Dismiss with a reason:** let a suggestion be dismissed per endpoint so it stops
  reappearing, recorded like accepted risks.

## Things to avoid

- **Arbitrary command execution from the dashboard.** Custom scripts deliberately run
  only files already placed on the endpoint; keep it that way for every new agent check.
- **Full-text software search across the fleet without limits** — the software lists are
  large; index or cap any new query.
- **More third-party lookups by default.** OSV.dev and endoflife.date are opt-out today;
  any new external lookup should be opt-in and documented as sending data out.
