"use client";

import { useState } from "react";
import type { Check, Host, Site, WidgetType } from "../lib/api";

const WIDGET_TYPE_LABELS: Record<WidgetType, string> = {
  status_tile: "Status tile (one check)",
  group_summary: "Group summary (one site)",
  uptime_history: "Uptime history (one check)",
  host_metrics: "Host metrics (one host)",
  note: "Note",
  alert_history: "Alert history (one site or all)",
  network_bandwidth: "Network bandwidth (one host)",
  all_hosts: "All hosts grid",
  backup_status: "Backup status",
  clock: "Clock / date",
};

// Types that need no target picker at all — "Add" is available immediately.
const NO_TARGET_TYPES = new Set<WidgetType>(["all_hosts", "backup_status", "clock"]);

export function AddWidgetForm({
  sites,
  checks,
  hosts,
  onAdd,
  onCancel,
}: {
  sites: Site[];
  checks: Check[];
  hosts: Host[];
  // For every type except "note", target is the chosen check/site/host id.
  // For "note", target is the note's initial text instead — there's
  // nothing existing to pick, so the form collects the content directly.
  onAdd: (type: WidgetType, target: string) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<WidgetType>("status_tile");
  const [targetId, setTargetId] = useState("");
  const [noteText, setNoteText] = useState("");

  const siteNameById = new Map(sites.map((s) => [s.id, s.name]));
  const hostNameById = new Map(hosts.map((h) => [h.id, h.name]));

  // Which site/host a check or host belongs to isn't obvious from its name
  // alone once there's more than a couple — label each option with its
  // source so picking the right one doesn't require guessing.
  let options: { id: string; label: string }[] = [];
  if (type === "status_tile" || type === "uptime_history") {
    options = checks.map((c) => {
      const site = siteNameById.get(c.siteId) ?? "unknown site";
      const host = c.hostId ? hostNameById.get(c.hostId) : undefined;
      return { id: c.id, label: host ? `${c.name} — ${site} / ${host}` : `${c.name} — ${site}` };
    });
  } else if (type === "group_summary") {
    options = sites.map((s) => ({ id: s.id, label: s.name }));
  } else if (type === "host_metrics" || type === "network_bandwidth") {
    options = hosts.map((h) => ({ id: h.id, label: `${h.name} — ${siteNameById.get(h.siteId) ?? "unknown site"}` }));
  } else if (type === "alert_history") {
    options = [{ id: "", label: "All sites" }, ...sites.map((s) => ({ id: s.id, label: s.name }))];
  }

  const canAdd = type === "note" || NO_TARGET_TYPES.has(type) || type === "alert_history" || Boolean(targetId);

  function handleAdd() {
    if (!canAdd) return;
    onAdd(type, type === "note" ? noteText : targetId);
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
