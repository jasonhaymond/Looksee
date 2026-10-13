"use client";

import { useState } from "react";
import type { Check, Host, Endpoint, WidgetType } from "../lib/api";
import { typeLabel } from "../lib/checkTypes";
import { Button, MultiPicker, inputClass, type PickItem } from "./ui";

const WIDGET_TYPES: { type: WidgetType; label: string; help: string; pick?: "check" | "endpoint" | "host" | "endpoint-or-all" }[] = [
  { type: "status_tile", label: "Status tile", help: "One check's status, uptime and response time", pick: "check" },
  { type: "uptime_history", label: "Uptime history", help: "One check's up/down bars over time", pick: "check" },
  { type: "group_summary", label: "Endpoint summary", help: "Every check in one endpoint at a glance", pick: "endpoint" },
  { type: "status_summary", label: "Problems right now", help: "Everything down or warning", pick: "endpoint-or-all" },
  { type: "alert_history", label: "Alert history", help: "Recent alert incidents", pick: "endpoint-or-all" },
  { type: "host_metrics", label: "Host metrics", help: "CPU, memory and disk of one host", pick: "host" },
  { type: "network_bandwidth", label: "Network bandwidth", help: "One host's traffic", pick: "host" },
  { type: "all_hosts", label: "All hosts", help: "Every host and its agent state" },
  { type: "top_talkers", label: "Top talkers", help: "NetFlow / sFlow conversations" },
  { type: "backup_status", label: "Backup status", help: "Looksee's own backups" },
  { type: "clock", label: "Clock", help: "Date and time" },
  { type: "note", label: "Note", help: "Free text" },
  { type: "section_header", label: "Section header", help: "A full-width divider to group widgets" },
];

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
  // check/endpoint/host id. For those two, target is the initial text.
  // Called once per picked target, so several tiles can be added at once.
  onAdd: (type: WidgetType, target: string) => Promise<void> | void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<WidgetType>("status_tile");
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // The dashboard refreshes status every few seconds; the lists here are a
  // snapshot taken when the form opened, so the picker never re-sorts or
  // jumps back to the top while you're scrolling it.
  const [snapshot] = useState(() => ({ endpoints, checks, hosts }));
  const def = WIDGET_TYPES.find((w) => w.type === type)!;
  const endpointName = new Map(snapshot.endpoints.map((e) => [e.id, e.name]));
  const hostName = new Map(snapshot.hosts.map((h) => [h.id, h.name]));

  let items: PickItem[] = [];
  if (def.pick === "check")
    items = snapshot.checks
      .filter((c) => c.enabled)
      .map((c) => ({ id: c.id, label: c.name, group: endpointName.get(c.endpointId), sub: [typeLabel(c.type), c.hostId ? hostName.get(c.hostId) : null].filter(Boolean).join(" · ") }));
  else if (def.pick === "host") items = snapshot.hosts.map((h) => ({ id: h.id, label: h.name, group: endpointName.get(h.endpointId), sub: h.hostname ?? undefined }));
  else if (def.pick === "endpoint" || def.pick === "endpoint-or-all") items = snapshot.endpoints.map((e) => ({ id: e.id, label: e.name, sub: e.description ?? undefined }));

  const free = type === "note" || type === "section_header";
  const multi = def.pick === "check" || def.pick === "host" || def.pick === "endpoint";
  const canAdd = free ? text.trim().length > 0 : !def.pick || def.pick === "endpoint-or-all" || picked.length > 0;

  async function add() {
    if (!canAdd) return;
    setBusy(true);
    try {
      if (free) await onAdd(type, text);
      else if (!def.pick) await onAdd(type, "");
      else if (def.pick === "endpoint-or-all") await onAdd(type, picked[0] ?? "");
      else for (const id of picked) await onAdd(type, id);
      onCancel();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="surface space-y-3 rounded-xl p-3 text-sm">
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-5">
        {WIDGET_TYPES.map((w) => (
          <button
            key={w.type}
            type="button"
            onClick={() => {
              setType(w.type);
              setPicked([]);
            }}
            aria-pressed={type === w.type}
            className={`rounded-lg border p-2 text-left ${type === w.type ? "border-[var(--accent)] bg-[var(--accent)]/10" : "border-[var(--border)] hover:bg-[var(--panel-2)]"}`}
          >
            <span className="block text-sm font-medium">{w.label}</span>
            <span className="block text-xs text-[var(--muted)]">{w.help}</span>
          </button>
        ))}
      </div>
      {type === "note" && <textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Note text…" rows={2} className={inputClass} />}
      {type === "section_header" && <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Section name…" className={inputClass} />}
      {def.pick && (
        <div>
          <div className="mb-1 text-xs text-[var(--muted)]">
            {def.pick === "endpoint-or-all" ? "Limit to one endpoint (optional — none picked = all endpoints)" : multi ? `Pick one or more — one widget each` : "Pick one"}
          </div>
          <MultiPicker items={items} selected={picked} onChange={setPicked} single={!multi} placeholder={`Search ${def.pick === "check" ? "checks by name, type or host" : def.pick === "host" ? "hosts" : "endpoints"}…`} groupLabel="Endpoint" height="max-h-72" />
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="primary" onClick={add} disabled={!canAdd || busy}>
          {busy ? "Adding…" : picked.length > 1 ? `Add ${picked.length} widgets` : "Add widget"}
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
