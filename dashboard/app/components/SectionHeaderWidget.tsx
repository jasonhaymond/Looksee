"use client";

import { useState } from "react";
import { api, type Widget } from "../lib/api";

// A plain full-width labeled divider for grouping widgets visually within
// one dashboard — not a data tile, and not collapsible (that would need
// computing which widgets fall "under" it by y-position and hiding them, a
// separate feature). Editing follows NoteWidget's exact "click to edit in
// layout-edit mode" pattern rather than inventing a second one.
export function SectionHeaderWidget({ widget, editMode, onChanged }: { widget: Widget; editMode: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(widget.config.text ?? "");

  async function handleSave() {
    await api.updateWidget(widget.id, { config: { ...widget.config, text } });
    setEditing(false);
    onChanged();
  }

  if (editing) {
    return (
      <div className="no-drag flex h-full items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3">
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSave()}
          placeholder="Section name…"
          className="min-w-0 flex-1 rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-sm font-medium outline-none"
        />
        <button onClick={handleSave} className="shrink-0 rounded-md bg-[var(--up)] px-2 py-1 text-xs font-medium text-black">
          Save
        </button>
        <button
          onClick={() => {
            setText(widget.config.text ?? "");
            setEditing(false);
          }}
          className="shrink-0 text-xs text-[var(--muted)]"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div
      onClick={() => editMode && setEditing(true)}
      className={`flex h-full items-center border-b border-[var(--border)] px-1 ${editMode ? "no-drag cursor-text hover:border-[var(--muted)]" : ""}`}
    >
      <h2 className="truncate text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">
        {widget.config.text || <span className="normal-case">{editMode ? "Click to name this section…" : "(untitled section)"}</span>}
      </h2>
    </div>
  );
}
