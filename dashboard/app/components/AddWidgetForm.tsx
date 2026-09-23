"use client";

import { useState } from "react";
import type { Check, Host, Endpoint, WidgetType } from "../lib/api";

const WIDGET_TYPE_LABELS: Record<WidgetType, string> = {
  status_tile: "Status tile (one check)",
  group_summary: "Group summary (one endpoint)",
  uptime_history: "Uptime history (one check)",
  host_metrics: "Host metrics (one host)",
  note: "Note",
  alert_history: "Alert history (one endpoint or all)",
  network_bandwidth: "Network bandwidth (one host)",
  all_hosts: "All hosts grid",
  backup_status: "Backup status",
  clock: "Clock / date",
  section_header: "Section header (group widgets visually)",
};

// Types that need no target picker at all — "Add" is available immediately.
const NO_TARGET_TYPES = new Set<WidgetType>(["all_hosts", "backup_status", "clock"]);

export function AddWidgetForm({
  endpoints,
  checks,
  hosts,
  onAdd,
  onCancel,
}: {
  endpoints: Endpoint[];
  checks: Check[];
  hosts: Host[];
  // For every type except "note"/"section_header", target is the chosen
  // check/endpoint/host id. For those two, target is the initial text
  // instead — there's nothing existing to pick, so the form collects the
  // content directly.
  onAdd: (type: WidgetType, target: string) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<WidgetType>("status_tile");
  const [targetId, setTargetId] = useState("");
  const [noteText, setNoteText] = useState("");

  const endpointNameById = new Map(endpoints.map((e) => [e.id, e.name]));
  const hostNameById = new Map(hosts.map((h) => [h.id, h.name]));

  // Which endpoint/host a check or host belongs to isn't obvious from its
  // name alone once there's more than a couple — label each option with its
  // source so picking the right one doesn't require guessing.
  let options: { id: string; label: string }[] = [];
  if (type === "status_tile" || type === "uptime_history") {
    options = checks.map((c) => {
      const endpoint = endpointNameById.get(c.endpointId) ?? "unknown endpoint";
      const host = c.hostId ? hostNameById.get(c.hostId) : undefined;
      return { id: c.id, label: host ? `${c.name} — ${endpoint} / ${host}` : `${c.name} — ${endpoint}` };
    });
  } else if (type === "group_summary") {
    options = endpoints.map((e) => ({ id: e.id, label: e.name }));
  } else if (type === "host_metrics" || type === "network_bandwidth") {
    options = hosts.map((h) => ({ id: h.id, label: `${h.name} — ${endpointNameById.get(h.endpointId) ?? "unknown endpoint"}` }));
  } else if (type === "alert_history") {
    options = [{ id: "", label: "All endpoints" }, ...endpoints.map((e) => ({ id: e.id, label: e.name }))];
  }

  const isFreeText = type === "note" || type === "section_header";
  const canAdd = isFreeText || NO_TARGET_TYPES.has(type) || type === "alert_history" || Boolean(targetId);

  function handleAdd() {
    if (!canAdd) return;
    onAdd(type, isFreeText ? noteText : targetId);
  }

  return (
    <div className="flex flex-wrap items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3 text-sm">
      <select
        value={type}
        onChange={(e) => {
          setType(e.target.value as WidgetType);
          setTargetId("");
        }}
        className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
      >
        {(Object.keys(WIDGET_TYPE_LABELS) as WidgetType[]).map((t) => (
          <option key={t} value={t}>
            {WIDGET_TYPE_LABELS[t]}
          </option>
        ))}
      </select>
      {type === "note" ? (
        <textarea
          autoFocus
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder="Note text…"
          rows={2}
          className="min-w-40 flex-1 rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
        />
      ) : type === "section_header" ? (
        <input
          autoFocus
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder="Section name…"
          className="min-w-40 flex-1 rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
        />
      ) : NO_TARGET_TYPES.has(type) ? null : (
        <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="min-w-40 rounded-md border border-[var(--border)] bg-transparent px-2 py-1">
          {type !== "alert_history" && <option value="">Choose...</option>}
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      <button onClick={handleAdd} disabled={!canAdd} className="rounded-md bg-[var(--up)] px-3 py-1 font-medium text-black disabled:opacity-40">
        Add
      </button>
      <button onClick={onCancel} className="text-[var(--muted)]">
        Cancel
      </button>
    </div>
  );
}
