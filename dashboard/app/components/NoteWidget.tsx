"use client";

import { useState } from "react";
import { api, type Widget } from "../lib/api";

// The one widget type whose content is edited in place rather than
// pointing at an existing check/endpoint/host — editing just PATCHes the
// widget's own config.text, reusing the same endpoint every other config
// update already goes through.
export function NoteWidget({ widget, editMode, onChanged }: { widget: Widget; editMode: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(widget.config.text ?? "");

  async function handleSave() {
    await api.updateWidget(widget.id, { config: { ...widget.config, text } });
    setEditing(false);
    onChanged();
  }

  if (editing) {
    return (
      <div className="no-drag flex h-full flex-col gap-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="min-h-0 flex-1 resize-none rounded-md border border-[var(--border)] bg-transparent p-2 text-sm outline-none"
        />
        <div className="flex gap-2 text-xs">
          <button onClick={handleSave} className="rounded-md bg-[var(--up)] px-2 py-1 font-medium text-black">
            Save
          </button>
          <button
            onClick={() => {
              setText(widget.config.text ?? "");
              setEditing(false);
            }}
            className="text-[var(--muted)]"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={() => editMode && setEditing(true)}
      className={`h-full overflow-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3 text-sm whitespace-pre-wrap ${editMode ? "no-drag cursor-text hover:border-[var(--muted)]" : ""}`}
    >
      {widget.config.text || <span className="text-[var(--muted)]">{editMode ? "Click to add a note…" : "(empty note)"}</span>}
    </div>
  );
}
