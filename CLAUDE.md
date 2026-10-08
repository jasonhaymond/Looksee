# Looksee — Project Instructions

Follow the global standards in `~/.claude/CLAUDE.md`. This file only records decisions
specific to Looksee that narrow or clarify those standards — silence here means the
global doc governs.

## Project-specific decisions (locked in during scoping, don't re-litigate without asking)

- **Single admin user, no role system.** Looksee is a solo tool for Jason. Skip
  role-gated UI for admin-only actions (backups, deploy panel, log viewer) — there's only
  one user, so there's nothing to gate against. Revisit only if this ever grows beyond
  personal use.
- **No staging environment for v1.** Solo tool, low blast-radius — see global standards'
  "optional/overkill for a solo personal tool" carve-out.
- **`Site` exists in the data model from day one** even with only one site configured
  (the personal homelab). Don't collapse it into a flat host list for convenience — the
  whole point is that a second network (e.g. a separate church/AV network) becomes a
  config entry later, not a schema migration.
- **Agent is Go, single static binary** — no runtime dependency on monitored hosts. Don't
  substitute a Node/Python agent for stack-consistency reasons; the cross-platform,
  no-install-step requirement is the actual point of the agent.
- **Dashboard is a web app / installable PWA**, not a native Expo app. Web Push is the
  push-notification mechanism specifically so no third-party notification account or app
  store build is required.
- **Alerting channels are opt-in per rule.** A check with no channel configured just shows
  on the dashboard silently. Email is the only always-on default; Web Push, webhook
  (Discord/Slack/ntfy/Telegram), and SMS are configured as needed.
- **Network discovery is on-demand only.** Added in 3.0 at Jason's request (originally
  deferred to "v2+"): a scan runs only when started from the Discovery page, results are
  suggestions, and nothing is added without ticking it. Don't turn it into a scheduled
  background scanner that auto-creates checks without asking.
- **One check-type registry per side.** `engine/src/db/checkTypes.ts` decides who runs
  each type; `dashboard/app/lib/checkTypes.ts` describes how to configure it;
  `engine/test/check-types.test.ts` fails if they disagree. Add a type to both.
- **Thresholds are applied by the engine**, never the agent — the agent measures and
  reports a value; `services/thresholds.ts` judges it, so warn/critical mean the same
  thing for every check type.
- **Agent script checks only run files in the agent's own `script_dir`.** The engine may
  choose which approved script runs, never send code to run. Don't add a "run this
  command" check type.
- **Event/flow receivers stay on unprivileged ports with a private-source allowlist** by
  default, so the engine never needs root and isn't an open ingestion endpoint.

See [`spec.md`](spec.md) for the full architecture, data model, and v1 scope.
