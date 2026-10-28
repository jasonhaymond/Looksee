// Local user accounts check (check type agent_users): judges the account list
// an endpoint's agent reports, comparing it with the previous list so that a
// new account, a removed one, or a change to one (enabled/disabled, gained or
// lost admin rights, password changed, renamed full name, new shell) raises
// an alert — a classic sign of an intruder making themselves at home.
//
// Where this sits: routes/agent.ts calls evaluateUserAccounts when an agent
// reports an agent_users result. The agent only lists the accounts
// (agent/internal/checks/users.go); every judgement is made here, on the
// engine (CLAUDE.md: thresholds and judgements are always the engine's).
//
// State kept between reports (checks.state): the previous list (by account
// name), a history of changes (newest first, at most 500), and when the last
// change was seen, so the alert status is held for holdMinutes.

import { excludeItems, nameExcluded } from "./probes/exclude.js";
import { worst, type Status } from "./thresholds.js";
import { own } from "../lib/own.js";

/** One account as the agent reports it (fields it couldn't read are absent). */
export type UserAccount = {
  name: string;
  // Linux/macOS user ID, or the Windows SID.
  uid?: string;
  fullName?: string;
  enabled?: boolean;
  // Member of the administrators group (Windows Administrators; sudo, wheel
  // or admin on Linux; admin on macOS).
  admin?: boolean;
  // A built-in/service account (Linux/macOS UID below 1000/500, Windows
  // built-ins such as DefaultAccount) — left out unless asked for.
  system?: boolean;
  shell?: string;
  locked?: boolean;
  // When the password was last set (ISO date) — a change means the password
  // was changed.
  passwordLastSet?: string;
  lastLogon?: string;
};

/** The fields compared between reports, with how a change to each reads. */
const WATCHED: { key: keyof UserAccount; label: string }[] = [
  { key: "uid", label: "ID" },
  { key: "fullName", label: "full name" },
  { key: "enabled", label: "enabled" },
  { key: "admin", label: "admin" },
  { key: "locked", label: "locked" },
  { key: "shell", label: "shell" },
  { key: "passwordLastSet", label: "password set" },
];

/** One change, as shown in the check's details and history. */
export type UserChange = { change: "added" | "removed" | "changed"; user: string; detail: string; admin?: boolean };

/** Cleans the agent's list: well-formed entries only, names unique, at most 5000. */
export function cleanUsers(raw: unknown): UserAccount[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: UserAccount[] = [];
  for (const r of raw.slice(0, 5000)) {
    if (!r || typeof r !== "object" || typeof (r as UserAccount).name !== "string") continue;
    const u = r as Record<string, unknown>;
    const name = String(u.name).slice(0, 256);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const text = (k: string) => (typeof own(u, k) === "string" ? String(own(u, k)).slice(0, 512) : undefined);
    const flag = (k: string) => (typeof own(u, k) === "boolean" ? (own(u, k) as boolean) : undefined);
    out.push({ name, uid: text("uid"), fullName: text("fullName"), enabled: flag("enabled"), admin: flag("admin"), system: flag("system"), shell: text("shell"), locked: flag("locked"), passwordLastSet: text("passwordLastSet"), lastLogon: text("lastLogon") });
  }
  return out;
}

/** A field's value as text for messages ("yes"/"no" for flags, "—" for unknown). */
const show = (v: unknown) => (v === undefined || v === null || v === "" ? "—" : typeof v === "boolean" ? (v ? "yes" : "no") : String(v));

/**
 * Compares two account lists.
 *
 * @param prev the previous list, by lowercase name
 * @param users this report's list (already filtered)
 * @returns one entry per added, removed or changed account; `admin` marks a
 *   change that gave someone admin rights (a new admin, or admin: no → yes)
 */
export function diffUsers(prev: Record<string, UserAccount>, users: UserAccount[]): UserChange[] {
  const changes: UserChange[] = [];
  const current = new Map(users.map((u) => [u.name.toLowerCase(), u]));
  for (const [key, u] of current) {
    const before = own(prev, key);
    if (!before) {
      changes.push({ change: "added", user: u.name, detail: [u.admin ? "admin" : null, u.enabled === false ? "disabled" : null, u.fullName || null].filter(Boolean).join(", ") || "new account", admin: u.admin === true });
      continue;
    }
    // Only fields the agent reported both times are compared — a field one
    // platform can't read isn't a change.
    // own() reads only the account's own fields (k comes from WATCHED, a
    // fixed list, but this keeps the lookup safe by construction).
    const was = (k: keyof UserAccount) => own(before as Record<string, unknown>, k);
    const is = (k: keyof UserAccount) => own(u as Record<string, unknown>, k);
    const diffs = WATCHED.filter(({ key: k }) => was(k) !== undefined && is(k) !== undefined && was(k) !== is(k)).map(({ key: k, label }) => (k === "passwordLastSet" ? "password changed" : `${label}: ${show(was(k))} → ${show(is(k))}`));
    if (diffs.length) changes.push({ change: "changed", user: u.name, detail: diffs.join("; "), admin: before.admin === false && u.admin === true });
  }
  for (const [key, u] of Object.entries(prev)) if (!current.has(key)) changes.push({ change: "removed", user: u.name, detail: u.admin ? "was an admin" : "account removed" });
  return changes.sort((a, b) => a.user.localeCompare(b.user));
}

type Result = { status: Status; message: string | null; value?: number | null; details?: unknown; latencyMs: number | null };
type HistoryRow = UserChange & { when: string };

/**
 * Judges one agent_users result.
 *
 * Settings (config): watch — which changes count ("added,removed,changed" by
 * default); includeSystem — also watch built-in/service accounts; exclude —
 * account names to ignore (wildcards; merged with reusable "User accounts"
 * lists); severity — status for a change (warn); adminSeverity — status when
 * someone gains admin rights (down); holdMinutes — how long a change keeps
 * the check failing (60).
 *
 * @param config the check's settings, with exclusions merged in
 * @param state the check's state from the previous report
 * @param result what the agent reported (details.users is the list)
 * @returns the judged result and the state to store
 */
export function evaluateUserAccounts<T extends Result>(config: Record<string, unknown>, state: Record<string, unknown>, result: T): { result: T; state: Record<string, unknown> } {
  // The agent couldn't list accounts (its message says why): pass it on.
  const listed = cleanUsers((result.details as { users?: unknown } | null)?.users);
  if (!listed) return { result, state };

  const excluded = excludeItems(config.exclude, true);
  const includeSystem = config.includeSystem === true || config.includeSystem === "true";
  const users = listed.filter((u) => (includeSystem || !u.system) && !nameExcluded(u.name, excluded));
  const watch = new Set(String(config.watch ?? "added,removed,changed").split(",").map((s) => s.trim()).filter(Boolean));

  const prev = state.users as Record<string, UserAccount> | undefined;
  const all = prev ? diffUsers(prev, users) : [];
  const changes = all.filter((c) => watch.has(c.change));
  const now = new Date().toISOString();
  const history: HistoryRow[] = [...changes.map((c) => ({ when: now, ...c })), ...((Array.isArray(state.history) ? state.history : []) as HistoryRow[])].slice(0, 500);

  // Status for this report's changes: the admin severity if anyone gained
  // admin rights, the normal severity otherwise.
  const severity: Status = String(config.severity ?? "warn") === "down" ? "down" : "warn";
  const adminSeverity: Status = String(config.adminSeverity ?? "down") === "warn" ? "warn" : "down";
  const nowStatus: Status = changes.length ? (changes.some((c) => c.admin) ? worst(severity, adminSeverity) : severity) : "up";
  const changedAt = changes.length ? Date.now() : (state.changedAt as number | undefined);
  const heldStatus = changes.length ? nowStatus : ((state.heldStatus as Status | undefined) ?? severity);
  const lastChange = changes.length ? changes.slice(0, 4).map((c) => `${c.change} ${c.user}${c.detail ? ` (${c.detail})` : ""}`).join("; ") + (changes.length > 4 ? "; …" : "") : (state.lastChange as string | undefined);
  const nextState = { users: Object.fromEntries(users.map((u) => [u.name.toLowerCase(), u])), history, changedAt, heldStatus, lastChange };

  const details = {
    changes,
    history: history.slice(0, 200),
    users: users.map((u) => ({ name: u.name, fullName: u.fullName, enabled: u.enabled, admin: u.admin, locked: u.locked, lastLogon: u.lastLogon })),
  };
  const holdMs = Number(config.holdMinutes ?? 60) * 60_000;
  const base = { ...result, value: users.length, details };
  if (!prev) return { result: { ...base, status: "up", message: `Baseline recorded: ${users.length} account(s)` }, state: nextState };
  if (changes.length) return { result: { ...base, status: nowStatus, message: lastChange ?? "Accounts changed" }, state: nextState };
  if (changedAt && Date.now() - changedAt < holdMs) return { result: { ...base, status: heldStatus, message: `${lastChange} (${Math.round((Date.now() - changedAt) / 60_000)} min ago)` }, state: nextState };
  return { result: { ...base, status: "up", message: `${users.length} account(s), no changes` }, state: nextState };
}
