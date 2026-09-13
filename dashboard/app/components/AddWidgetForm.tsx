"use client";

import { useState } from "react";
import type { Check, Site, WidgetType } from "../lib/api";

export function AddWidgetForm({
  sites,
  checks,
  onAdd,
  onCancel,
}: {
  sites: Site[];
  checks: Check[];
  onAdd: (type: WidgetType, targetId: string) => void;
  onCancel: () => void;
}) {
  const [type, setType] = useState<WidgetType>("status_tile");
  const [targetId, setTargetId] = useState("");

  const options = type === "status_tile" ? checks.map((c) => ({ id: c.id, label: c.name })) : sites.map((s) => ({ id: s.id, label: s.name }));

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3 text-sm">
      <select
        value={type}
        onChange={(e) => {
          setType(e.target.value as WidgetType);
          setTargetId("");
        }}
        className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
      >
        <option value="status_tile">Status tile (one check)</option>
        <option value="group_summary">Group summary (one site)</option>
      </select>
      <select value={targetId} onChange={(e) => setTargetId(e.target.value)} className="min-w-40 rounded-md border border-[var(--border)] bg-transparent px-2 py-1">
        <option value="">Choose...</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <button
        onClick={() => targetId && onAdd(type, targetId)}
        disabled={!targetId}
        className="rounded-md bg-[var(--up)] px-3 py-1 font-medium text-black disabled:opacity-40"
      >
        Add
      </button>
      <button onClick={onCancel} className="text-[var(--muted)]">
        Cancel
      </button>
    </div>
  );
}
