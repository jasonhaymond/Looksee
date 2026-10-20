// The rule builder for filter groups: pick what kind of object the group
// selects, then add conditions ("OS contains Windows", "tag is printer"…),
// with a live preview of what currently matches.
//
// Where this sits: used by the "New group" dialog (app/groups/page.tsx) and
// a filter group's page (app/groups/[id]/page.tsx). The fields and operators
// offered come from the engine (GET /api/groups/fields), which validates the
// rules again when they're saved; the preview is POST /api/groups/preview.
//
// "use client" makes this a React component that runs in the browser.

"use client";

import { useEffect, useState } from "react";
import { api, type GroupFields, type GroupRules, type MemberType } from "../lib/api";
import { inputClass } from "./ui";
import { own } from "../lib/own";

// Readable names for the operators the engine accepts.
const OP_LABEL: Record<string, string> = {
  is: "is",
  is_not: "is not",
  contains: "contains",
  not_contains: "doesn't contain",
  starts_with: "starts with",
  ends_with: "ends with",
};
const TARGET_LABEL: Record<MemberType, string> = { location: "Locations", site: "Sites", endpoint: "Endpoints", check: "Checks" };

/**
 * Edits a filter group's target and rules.
 *
 * @param target which kind of object the group selects
 * @param rules the current rules
 * @param onChange called with the new target and rules on every edit
 */
export function GroupFilterEditor({ target, rules, onChange }: { target: MemberType; rules: GroupRules; onChange: (target: MemberType, rules: GroupRules) => void }) {
  const [meta, setMeta] = useState<GroupFields | null>(null);
  const [preview, setPreview] = useState<{ total: number; matches: { id: string; name: string }[] } | null>(null);

  useEffect(() => {
    api.groupFields().then(setMeta);
  }, []);

  // Re-run the preview half a second after the last change, so typing a
  // value doesn't send a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => {
      api.groupPreview(target, rules).then(setPreview).catch(() => setPreview(null));
    }, 500);
    return () => clearTimeout(t);
  }, [target, rules]);

  if (!meta) return null;
  const fields = own(meta.fields, target) ?? [];
  /** Replaces condition i with a changed copy. */
  const setCond = (i: number, patch: Partial<GroupRules["conditions"][number]>) =>
    onChange(target, { ...rules, conditions: rules.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span>Select</span>
        <select
          value={target}
          onChange={(e) => onChange(e.target.value as MemberType, { ...rules, conditions: [] })}
          aria-label="What the group selects"
          className={`${inputClass} !w-auto`}
        >
          {(Object.keys(TARGET_LABEL) as MemberType[]).map((t) => (
            <option key={t} value={t}>
              {own(TARGET_LABEL, t)}
            </option>
          ))}
        </select>
        <span>matching</span>
        <select value={rules.match} onChange={(e) => onChange(target, { ...rules, match: e.target.value as "all" | "any" })} aria-label="All or any conditions" className={`${inputClass} !w-auto`}>
          <option value="all">all of</option>
          <option value="any">any of</option>
        </select>
        <span>these conditions:</span>
      </div>
      {rules.conditions.map((c, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <select value={c.field} onChange={(e) => setCond(i, { field: e.target.value })} aria-label="Field" className={`${inputClass} !w-auto`}>
            {fields.map((f) => (
              <option key={f.field} value={f.field}>
                {f.label}
              </option>
            ))}
          </select>
          <select value={c.op} onChange={(e) => setCond(i, { op: e.target.value })} aria-label="Comparison" className={`${inputClass} !w-auto`}>
            {meta.ops.map((o) => (
              <option key={o} value={o}>
                {own(OP_LABEL, o) ?? o}
              </option>
            ))}
          </select>
          <input value={c.value} onChange={(e) => setCond(i, { value: e.target.value })} aria-label="Value" placeholder={fields.find((f) => f.field === c.field)?.hint ?? "value"} className={`${inputClass} !w-48 flex-1`} />
          <button onClick={() => onChange(target, { ...rules, conditions: rules.conditions.filter((_, j) => j !== i) })} aria-label="Remove condition" className="text-[var(--muted)] hover:text-[var(--down)]">
            ✕
          </button>
        </div>
      ))}
      <button onClick={() => onChange(target, { ...rules, conditions: [...rules.conditions, { field: fields[0].field, op: "contains", value: "" }] })} className="text-[var(--muted)] underline hover:text-[var(--text)]">
        + Add condition
      </button>
      <div className="rounded-md border border-[var(--border)] bg-[var(--bg)] p-2 text-xs">
        {!rules.conditions.length ? (
          <span className="text-[var(--muted)]">Add a condition to see what matches. (A filter with no conditions matches nothing.)</span>
        ) : preview ? (
          <>
            <span className="font-medium">
              Matches {preview.total} {own(TARGET_LABEL, target)?.toLowerCase()} now
            </span>
            {preview.matches.length > 0 && <span className="text-[var(--muted)]">: {preview.matches.slice(0, 30).map((m) => m.name).join(", ")}{preview.total > 30 ? ", …" : ""}</span>}
          </>
        ) : (
          <span className="text-[var(--muted)]">Checking…</span>
        )}
      </div>
    </div>
  );
}
