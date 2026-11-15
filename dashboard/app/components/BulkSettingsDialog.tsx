// "Edit settings" for the same kind of check on many endpoints (or sites) at
// once — e.g. every "Failed / stopped services" check, or every disk check.
//
// Where this sits: opened from the Checks page's Actions menu (on the
// selected checks) and from a check's own page ("Edit on several
// endpoints…"). It sends one POST /api/checks/bulk { action: "edit_settings" }
// (engine/src/routes/checks.ts), which changes only what was asked for on
// each chosen check and leaves every other setting as that check has it.
//
// For each setting the dialog shows what the chosen checks have now (all the
// same, not set, or how many different values) and offers: keep each
// check's own value, change it to one value on all of them, or clear it so
// each falls back to the default. Exclusions get their own editor: every
// item any chosen check ignores, on how many of them, with a tick to remove
// it, plus a box of items to add — so one item can be added or taken out
// everywhere without overwriting each check's other items.
//
// Security: secrets (passwords, keys) are write-only here as everywhere — the
// dialog only knows whether one is saved, never its value. The engine checks
// the session, setting names and sizes; this dialog is a convenience, not a
// safety boundary.

"use client";

import { useMemo, useState } from "react";
import type { Check, Endpoint, Site } from "../lib/api";
import { TYPE_BY_KEY, typeLabel, type Field } from "../lib/checkTypes";
import { FieldInput } from "./CheckForm";
import { Button, Label, Modal, MultiPicker, inputClass } from "./ui";
import { runInBackground } from "../lib/background";
import { own } from "../lib/own";

/** What to do with one setting on every chosen check. */
type Mode = "keep" | "set" | "clear";

/** One editable setting: a config key, or the interval/retry columns. */
type Setting = { key: string; field: Field; section: "Settings" | "Thresholds" | "Advanced" | "Schedule"; column?: "intervalSeconds" | "retryIntervalSeconds" };

// The check types whose exclusions are message texts (matched anywhere in a
// line, so a comma is part of the text). Every other type's items are names,
// where older settings separated items with commas too. Mirrors the "messages"
// kind in engine/src/services/probes/exclude.ts (EXCLUSION_KINDS).
const TEXT_EXCLUDE_TYPES = new Set(["trap_match", "syslog_match", "agent_log", "agent_journal", "agent_eventlog"]);

// Shown as "••••••••" by the engine in place of a saved secret
// (engine/src/lib/secrets.ts MASK).
const MASK = "••••••••";

const num = (key: string, label: string, section: Setting["section"], help?: string): Setting => ({ key, field: { key, label, kind: "number", help }, section });

/**
 * Every setting the dialog can change for a check type, grouped the way the
 * single-check form groups them: the type's own fields (its exclusions are
 * edited separately), thresholds when the type has a value or latency, the
 * shared "timeouts before down", and the schedule.
 *
 * @param type the check type ID
 */
function settingsFor(type: string): Setting[] {
  const def = TYPE_BY_KEY.get(type);
  if (!def) return [];
  // "metric" picks what a host_metric check measures and decides its other
  // fields, so it stays a per-check choice.
  const fields = def.fields.filter((f) => f.kind !== "metric" && f.key !== "exclude").map<Setting>((f) => ({ key: f.key, field: f, section: f.advanced ? "Advanced" : "Settings" }));
  const thresholds: Setting[] = [
    ...(def.value ? [num("warnAbove", "Warn above", "Thresholds"), num("criticalAbove", "Critical above", "Thresholds"), num("warnBelow", "Warn below", "Thresholds"), num("criticalBelow", "Critical below", "Thresholds")] : []),
    ...(def.latency ? [num("latencyWarnMs", "Warn if slower than (ms)", "Thresholds"), num("latencyCriticalMs", "Critical if slower than (ms)", "Thresholds")] : []),
  ];
  return [
    ...fields,
    ...thresholds,
    num("timeoutsBeforeDown", "Timeouts in a row before down", "Advanced", "A timeout shows WARN first and goes DOWN after this many in a row. Not set = 3."),
    { ...num("intervalSeconds", "Check every (seconds)", "Schedule"), column: "intervalSeconds" },
    { ...num("retryIntervalSeconds", "Retry every (seconds) while failing", "Schedule", "Not set = the normal interval."), column: "retryIntervalSeconds" },
  ];
}

/** A setting's current value on one check ("" / null / missing = not set). */
function valueOn(check: Check, s: Setting): unknown {
  const v = s.column ? check[s.column] : own(check.config, s.key);
  return v === "" || v == null ? undefined : v;
}

/**
 * A check's exclusion items as a list — one per line, plus commas for name
 * items (the same reading as the engine's excludeItems).
 */
function excludeList(check: Check): string[] {
  const raw = own(check.config, "exclude");
  const parts = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(TEXT_EXCLUDE_TYPES.has(check.type) ? /\r?\n/ : /[\r\n,]+/) : [];
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * How a value reads in the summary: an option's label, on/off, a secret as
 * "saved", or the text itself (first line only, shortened).
 */
function describe(field: Field, v: unknown): string {
  if (v === undefined) return "not set";
  if (field.kind === "secret") return "saved";
  if (field.kind === "checkbox") return v === true || v === "true" ? "on" : "off";
  if (field.kind === "select") return field.options?.find((o) => o.value === String(v))?.label ?? String(v);
  const text = typeof v === "object" ? JSON.stringify(v) : String(v);
  const first = text.split("\n")[0];
  return first.length > 40 ? `${first.slice(0, 40)}…` : first + (text.includes("\n") ? " …" : "");
}

/**
 * What the chosen checks have now for one setting, in a few words: "all: 30",
 * "not set on any", "saved on 3 of 5", or "3 different values: 30 ×2, …".
 */
function summarize(s: Setting, targets: Check[]): string {
  const counts = new Map<string, { v: unknown; n: number }>();
  for (const c of targets) {
    const v = valueOn(c, s);
    // A secret's value is masked; only whether one is saved matters.
    const key = s.field.kind === "secret" ? String(v !== undefined) : JSON.stringify(v ?? null);
    const entry = counts.get(key) ?? { v, n: 0 };
    entry.n++;
    counts.set(key, entry);
  }
  if (s.field.kind === "secret") {
    const saved = counts.get("true")?.n ?? 0;
    return saved === targets.length ? "saved on all" : saved ? `saved on ${saved} of ${targets.length}` : "not set on any";
  }
  const entries = [...counts.values()].sort((a, b) => b.n - a.n);
  if (entries.length === 1) return entries[0].v === undefined ? `not set on any${s.field.default !== undefined ? ` (default ${describe(s.field, s.field.default)})` : ""}` : `all: ${describe(s.field, entries[0].v)}`;
  const shown = entries.slice(0, 3).map((e) => `${describe(s.field, e.v)} ×${e.n}`);
  return `${entries.length} different values: ${shown.join(", ")}${entries.length > 3 ? ", …" : ""}`;
}

/**
 * The value to start a "change to" input with: the value the chosen checks
 * share, else the field's default, else empty. A secret always starts empty.
 */
function startingValue(s: Setting, targets: Check[]): unknown {
  if (s.field.kind === "secret") return "";
  const values = targets.map((c) => valueOn(c, s));
  const first = JSON.stringify(values[0] ?? null);
  if (values[0] !== undefined && values.every((v) => JSON.stringify(v ?? null) === first)) return values[0];
  return s.field.default ?? (s.field.kind === "checkbox" ? true : "");
}

/**
 * The dialog itself.
 *
 * @param initial the checks the user started from (the Checks page's
 *   selection, or the one check whose page it was opened on)
 * @param checks every check, so more of the same kind can be added
 * @param sites/endpoints names for the check picker
 * @param onSubmit sends the edit (ids + bulk params) to the engine; runs in
 *   the background after the dialog closes
 */
export function BulkSettingsDialog({ initial, checks, sites, endpoints, onClose, onSubmit }: { initial: Check[]; checks: Check[]; sites: Site[]; endpoints: Endpoint[]; onClose: () => void; onSubmit: (ids: string[], params: Record<string, unknown>) => Promise<void> }) {
  // Settings are per check type, so one type is edited at a time — the most
  // common one in the starting selection, unless the user picks another.
  const typeCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of initial) m.set(c.type, (m.get(c.type) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [initial]);
  const [type, setType] = useState(typeCounts[0]?.[0] ?? "");
  const [picked, setPicked] = useState<string[]>(() => initial.filter((c) => c.type === type).map((c) => c.id));
  const [modes, setModes] = useState<Record<string, Mode>>({});
  const [values, setValues] = useState<Record<string, unknown>>({});
  // Exclusion items to remove (compared ignoring case) and to add.
  const [removeItems, setRemoveItems] = useState<Set<string>>(new Set());
  const [addText, setAddText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const def = TYPE_BY_KEY.get(type);
  const settings = useMemo(() => settingsFor(type), [type]);
  const pickedSet = new Set(picked);
  // The chosen checks, rebuilt only when the choice (or the check list) changes.
  const targets = useMemo(() => {
    const ids = new Set(picked);
    return checks.filter((c) => ids.has(c.id));
  }, [checks, picked]);
  const hasExclude = Boolean(def?.fields.some((f) => f.key === "exclude"));
  const excludeField = def?.fields.find((f) => f.key === "exclude");

  // Names for the check picker: which endpoint, grouped by site.
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const endpointName = new Map(endpoints.map((e) => [e.id, e.name]));
  const pickItems = checks.filter((c) => c.type === type).map((c) => ({ id: c.id, label: c.name, sub: c.endpointId ? endpointName.get(c.endpointId) : undefined, group: siteName.get(c.siteId) }));

  /** Switches the type being edited and starts over with its checks. */
  function chooseType(t: string) {
    setType(t);
    setPicked(initial.filter((c) => c.type === t).map((c) => c.id));
    setModes({});
    setValues({});
    setRemoveItems(new Set());
    setAddText("");
    setError(null);
  }

  /** Sets one setting's mode, filling in a starting value for "change to". */
  function setMode(s: Setting, mode: Mode) {
    setModes((m) => ({ ...m, [s.key]: mode }));
    if (mode === "set" && !(s.key in values)) setValues((v) => ({ ...v, [s.key]: startingValue(s, targets) }));
  }

  // Each chosen check's settings as they'd be after this edit, so a field
  // that only applies to some settings (showIf, e.g. "v3 username" only for
  // SNMP v3) is offered when it applies to at least one chosen check.
  const previews = targets.map((c) => {
    const cfg: Record<string, unknown> = { ...c.config };
    for (const s of settings) {
      if (s.column) continue;
      if (modes[s.key] === "set") cfg[s.key] = values[s.key];
      if (modes[s.key] === "clear") delete cfg[s.key];
    }
    return cfg;
  });
  const visible = settings.filter((s) => !s.field.showIf || previews.some((p) => s.field.showIf!(p)) || (modes[s.key] ?? "keep") !== "keep");

  // Every exclusion item any chosen check has, with how many have it.
  const excludeUnion = useMemo(() => {
    const m = new Map<string, { value: string; n: number }>();
    for (const c of targets) {
      for (const item of new Set(excludeList(c).map((i) => i.toLowerCase()))) {
        const original = excludeList(c).find((i) => i.toLowerCase() === item)!;
        const e = m.get(item) ?? { value: original, n: 0 };
        e.n++;
        m.set(item, e);
      }
    }
    return [...m.values()].sort((a, b) => a.value.localeCompare(b.value));
  }, [targets]);
  const addItems = addText.split(TEXT_EXCLUDE_TYPES.has(type) ? /\r?\n/ : /[\r\n,]+/).map((s) => s.trim()).filter(Boolean);

  /**
   * Turns the dialog's choices into the engine's edit_settings parameters,
   * converting numbers and refusing what can't be saved (a required setting
   * cleared or left empty, a number that isn't one, an interval under 5 s).
   */
  function buildParams(): { params?: Record<string, unknown>; error?: string; changes: string[] } {
    const set: Record<string, unknown> = {};
    const unset: string[] = [];
    const params: Record<string, unknown> = { type };
    const changes: string[] = [];
    for (const s of settings) {
      const mode = modes[s.key] ?? "keep";
      if (mode === "keep") continue;
      let v = mode === "set" ? values[s.key] : undefined;
      // An empty "change to" means the same as clearing it.
      const empty = v === "" || v == null;
      if (mode === "set" && !empty && s.field.kind === "number") {
        const n = Number(v);
        if (!Number.isFinite(n)) return { error: `${s.field.label}: enter a number.`, changes };
        v = n;
      }
      if (mode === "set" && s.field.kind === "secret" && v === MASK) continue;
      if (s.column) {
        if (s.column === "intervalSeconds") {
          if (empty || Number(v) < 5) return { error: "Check every: at least 5 seconds.", changes };
          params.intervalSeconds = v;
        } else params.retryIntervalSeconds = empty ? null : v;
        changes.push(`${s.field.label} → ${empty ? "not set" : String(v)}`);
        continue;
      }
      if (mode === "clear" || empty) {
        if (s.field.required) return { error: `${s.field.label} is required on every check, so it can't be cleared.`, changes };
        unset.push(s.key);
        changes.push(`${s.field.label} → cleared (default)`);
      } else {
        set[s.key] = v;
        changes.push(`${s.field.label} → ${describe(s.field, v)}`);
      }
    }
    if (Object.keys(set).length) params.set = set;
    if (unset.length) params.unset = unset;
    const removing = excludeUnion.filter((i) => removeItems.has(i.value.toLowerCase())).map((i) => i.value);
    if (removing.length) {
      params.excludeRemove = removing;
      changes.push(`Exclusions: remove ${removing.join(", ")}`);
    }
    if (addItems.length) {
      params.excludeAdd = addItems;
      changes.push(`Exclusions: add ${addItems.join(", ")}`);
    }
    return changes.length ? { params, changes } : { changes, error: "Choose at least one change." };
  }
  const built = buildParams();

  /** Renders one setting row: label, what the checks have now, and the choice. */
  const row = (s: Setting) => {
    const mode = modes[s.key] ?? "keep";
    const isBool = s.field.kind === "checkbox";
    // A checkbox is "turn on / turn off"; everything else "change to / clear".
    const choice = isBool ? (mode === "set" ? (values[s.key] === false ? "off" : "on") : mode) : mode;
    const canClear = !s.field.required && s.column !== "intervalSeconds";
    return (
      <div key={s.key} className="rounded-md border border-[var(--border)] p-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm">
              {s.field.label}
              {s.field.required ? " *" : ""}
            </div>
            <div className="text-xs text-[var(--muted)]">Now: {summarize(s, targets)}</div>
          </div>
          <select
            aria-label={`${s.field.label}: what to do`}
            value={choice}
            onChange={(e) => {
              const v = e.target.value;
              if (isBool && (v === "on" || v === "off")) {
                setModes((m) => ({ ...m, [s.key]: "set" }));
                setValues((x) => ({ ...x, [s.key]: v === "on" }));
              } else setMode(s, v as Mode);
            }}
            className={`${inputClass} !w-auto`}
          >
            <option value="keep">Keep each check&apos;s own</option>
            {isBool ? (
              <>
                <option value="on">Turn on for all</option>
                <option value="off">Turn off for all</option>
              </>
            ) : (
              <option value="set">{s.field.kind === "secret" ? "Replace on all with…" : "Change on all to…"}</option>
            )}
            {canClear && !isBool && <option value="clear">Clear on all (use default)</option>}
          </select>
        </div>
        {mode === "set" && !isBool && (
          <div className="mt-2">
            <FieldInput field={{ ...s.field, label: "New value" }} value={values[s.key]} onChange={(v) => setValues((x) => ({ ...x, [s.key]: v }))} items={[]} checks={checks.filter((c) => !pickedSet.has(c.id))} editing={false} multi={false} picked={[]} onPick={() => undefined} />
          </div>
        )}
      </div>
    );
  };

  const sections: Setting["section"][] = ["Settings", "Thresholds", "Advanced", "Schedule"];

  return (
    <Modal title={`Edit settings on ${targets.length} check(s)`} onClose={onClose} wide>
      <div className="space-y-4 text-sm">
        <p className="text-xs text-[var(--muted)]">
          Change a setting on every chosen check at once. Anything left on <em>Keep each check&apos;s own</em> stays exactly as each check has it.
        </p>

        {typeCounts.length > 1 && (
          <Label label="Kind of check to edit" help="Settings belong to a kind of check, so one kind is edited at a time. Checks of other kinds in your selection aren't changed.">
            <select value={type} onChange={(e) => chooseType(e.target.value)} className={inputClass}>
              {typeCounts.map(([t, n]) => (
                <option key={t} value={t}>
                  {typeLabel(t)} ({n} selected)
                </option>
              ))}
            </select>
          </Label>
        )}

        <div>
          <div className="mb-1 text-xs text-[var(--muted)]">
            {typeLabel(type)} checks to change ({picked.length}) — add more of the same kind from other endpoints here
          </div>
          <MultiPicker items={pickItems} selected={picked} onChange={setPicked} placeholder="Search checks…" height="max-h-40" groupLabel="Site" />
        </div>

        {targets.length > 0 && hasExclude && (
          <section className="space-y-2">
            <h3 className="text-sm font-medium">{excludeField?.label ?? "Exclusions"}</h3>
            <p className="text-xs text-[var(--muted)]">
              {excludeField?.help ? `${excludeField.help} ` : ""}Only each check&apos;s own items change here; reusable lists from the Exclusions page keep applying on their own.
            </p>
            {excludeUnion.length ? (
              <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-[var(--border)] p-2">
                {excludeUnion.map((i) => {
                  const k = i.value.toLowerCase();
                  return (
                    <label key={k} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={removeItems.has(k)}
                        onChange={(e) =>
                          setRemoveItems((r) => {
                            const next = new Set(r);
                            if (e.target.checked) next.add(k);
                            else next.delete(k);
                            return next;
                          })
                        }
                        className="accent-[var(--accent)]"
                      />
                      <span className={`font-mono text-xs ${removeItems.has(k) ? "line-through text-[var(--muted)]" : ""}`}>{i.value}</span>
                      <span className="ml-auto shrink-0 text-xs text-[var(--muted)]">
                        on {i.n} of {targets.length}
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-[var(--muted)]">None of the chosen checks has its own exclusions yet.</p>
            )}
            {excludeUnion.length > 0 && <p className="text-xs text-[var(--muted)]">Tick an item to remove it from every chosen check that has it.</p>}
            <Label label="Add to every chosen check (one per line)">
              <textarea value={addText} onChange={(e) => setAddText(e.target.value)} placeholder={excludeField?.placeholder} rows={3} className={`${inputClass} font-mono text-xs`} />
            </Label>
          </section>
        )}

        {targets.length > 0 &&
          sections.map((sec) => {
            const rows = visible.filter((s) => s.section === sec);
            if (!rows.length) return null;
            return (
              <section key={sec} className="space-y-2">
                <h3 className="text-sm font-medium">{sec}</h3>
                {rows.map(row)}
              </section>
            );
          })}

        {targets.length > 0 && built.changes.length > 0 && (
          <div className="rounded-md bg-[var(--accent)]/10 p-2 text-xs">
            <div className="mb-1 font-medium">
              On {targets.length} check(s), this will change:
            </div>
            <ul className="list-disc pl-4">
              {built.changes.map((c) => (
                <li key={c} className="break-words">
                  {c}
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <p className="text-sm text-[var(--down)]">{error}</p>}
        {targets.length > 0 && built.error && built.changes.length > 0 && <p className="text-sm text-[var(--down)]">{built.error}</p>}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!targets.length || !built.params}
            onClick={() => {
              if (!built.params) {
                setError(built.error ?? "Nothing to change.");
                return;
              }
              const ids = targets.map((c) => c.id);
              const params = built.params;
              // Close now; the change runs in the background (lib/background.ts).
              onClose();
              runInBackground(`Edit settings on ${ids.length} check(s)`, () => onSubmit(ids, params));
            }}
          >
            Apply to {targets.length} check(s)
          </Button>
        </div>
      </div>
    </Modal>
  );
}
