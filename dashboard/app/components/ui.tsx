// Shared building blocks for every page: status badges and colours, buttons,
// labelled fields, dialogs (modal, confirm, prompt), multi-select and bulk
// bars, pickers, alert-rule options, toasts, and small formatters.

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Tooltip } from "./Tooltip";
import { own } from "../lib/own";

// Shared building blocks for the management pages, so every table, filter
// bar and bulk-action flow looks and behaves the same.

export const STATUS_COLOR: Record<string, string> = {
  up: "var(--up)",
  down: "var(--down)",
  warn: "var(--warn)",
  unknown: "var(--muted)",
  maintenance: "var(--maint)",
  disabled: "var(--muted)",
};

// Status is never conveyed by color alone — the dot carries color, the
// text label is the required second encoding (colorblind-safe).
export function StatusBadge({ status, compact = false }: { status: string; compact?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: own(STATUS_COLOR, status) ?? "var(--muted)" }} />
      {!compact && <span className="text-[10px] font-medium tracking-wide text-[var(--muted)]">{status.toUpperCase()}</span>}
    </span>
  );
}

export function Button({
  children,
  onClick,
  variant = "default",
  type = "button",
  disabled,
  title,
  className = "",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "default" | "primary" | "danger" | "ghost";
  type?: "button" | "submit";
  disabled?: boolean;
  title?: string;
  className?: string;
}) {
  const styles = {
    default: "border border-[var(--border)] text-[var(--text)] hover:bg-[var(--border)]/40",
    primary: "bg-[var(--accent)] font-medium text-[var(--on-accent)] hover:brightness-110",
    danger: "border border-[var(--down)]/60 text-[var(--down)] hover:bg-[var(--down)]/10",
    ghost: "text-[var(--muted)] hover:text-[var(--text)]",
  };
  const style = own(styles, variant);
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={`rounded-md px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${style} ${className}`}>
      {children}
    </button>
  );
}

export const inputClass = "w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1.5 text-sm outline-none focus:border-[var(--muted)]";

export function Label({ label, help, children, className = "" }: { label: string; help?: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block text-sm ${className}`}>
      <span className="mb-1 inline-flex items-center text-xs text-[var(--muted)]">
        {label}
        {help && <Tooltip text={help} />}
      </span>
      {children}
    </label>
  );
}

export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[var(--overlay)] p-2 sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`my-4 w-full ${wide ? "max-w-3xl" : "max-w-lg"} rounded-xl border border-[var(--border-strong)] bg-[var(--panel)] shadow-2xl`}>
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h2 className="font-medium">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="text-[var(--muted)] hover:text-[var(--text)]">
            ✕
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

// Destructive bulk actions require retyping a word (the global standard for
// hard-to-reverse admin actions), not just a click-through.
export function ConfirmDialog({
  title,
  message,
  confirmWord,
  actionLabel,
  onConfirm,
  onClose,
}: {
  title: string;
  message: React.ReactNode;
  confirmWord?: string;
  actionLabel: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const ok = !confirmWord || typed.trim().toLowerCase() === confirmWord.toLowerCase();
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div>{message}</div>
        {confirmWord && (
          <Label label={`Type "${confirmWord}" to confirm`}>
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} className={inputClass} />
          </Label>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!ok || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onClose();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Working…" : actionLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function useSelection(visibleIds: string[]) {
  const [chosen, setSelected] = useState<Set<string>>(new Set());
  // Only selections that are still visible count (a reload may have deleted
  // or filtered some away) — worked out here rather than pruned afterwards.
  const key = visibleIds.join(",");
  const selected = useMemo(() => {
    const visible = new Set(visibleIds);
    const next = new Set([...chosen].filter((id) => visible.has(id)));
    return next.size === chosen.size ? chosen : next;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key stands for visibleIds
  }, [chosen, key]);
  const toggle = useCallback((id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  }), []);
  const setMany = useCallback((ids: string[], on: boolean) => setSelected((prev) => {
    const next = new Set(prev);
    for (const id of ids) {
      if (on) next.add(id);
      else next.delete(id);
    }
    return next;
  }), []);
  const clear = useCallback(() => setSelected(new Set()), []);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someSelected = visibleIds.some((id) => selected.has(id));
  return { selected, ids: useMemo(() => [...selected], [selected]), toggle, setMany, clear, allSelected, someSelected };
}

export function Checkbox({ checked, indeterminate = false, onChange, label }: { checked: boolean; indeterminate?: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = indeterminate && !checked;
      }}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      className="h-4 w-4 cursor-pointer accent-[var(--up)]"
    />
  );
}

export type BulkAction = { key: string; label: string; danger?: boolean; group?: string; hint?: string; run: () => void };

// A dropdown of actions grouped under headings, destructive ones last.
// Opens upward when anchored to the bottom of the screen (the bulk bar).
export function ActionMenu({ actions, label = "Actions", up = false, primary = false }: { actions: BulkAction[]; label?: string; up?: boolean; primary?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const safe = actions.filter((a) => !a.danger);
  const groups = [...new Set(safe.map((a) => a.group ?? ""))];
  const danger = actions.filter((a) => a.danger);
  const item = (a: BulkAction) => (
    <button
      key={a.key}
      role="menuitem"
      type="button"
      onClick={() => {
        setOpen(false);
        a.run();
      }}
      className={`block w-full rounded-md px-3 py-1.5 text-left text-sm hover:bg-[var(--border)]/40 ${a.danger ? "text-[var(--down)]" : ""}`}
    >
      {a.label}
      {a.hint && <span className="block text-xs text-[var(--muted)]">{a.hint}</span>}
    </button>
  );
  return (
    <div ref={ref} className="relative">
      <Button variant={primary ? "primary" : "default"} onClick={() => setOpen((v) => !v)} className="whitespace-nowrap !px-3 !py-1 text-sm">
        <span aria-haspopup="menu" aria-expanded={open}>
          {label} {up ? "▴" : "▾"}
        </span>
      </Button>
      {open && (
        <div role="menu" className={`absolute ${up ? "left-0" : "left-0 sm:left-auto sm:right-0"} z-40 max-h-[70vh] w-64 overflow-y-auto rounded-lg border border-[var(--border-strong)] bg-[var(--panel-2)] p-1 shadow-2xl ${up ? "bottom-full mb-2" : "top-full mt-2"}`}>
          {groups.map((g) => (
            <div key={g || "_"} className="py-0.5">
              {g && <div className="px-3 pb-0.5 pt-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">{g}</div>}
              {safe.filter((a) => (a.group ?? "") === g).map(item)}
            </div>
          ))}
          {danger.length > 0 && <div className="mt-1 border-t border-[var(--border)] pt-1">{danger.map(item)}</div>}
        </div>
      )}
    </div>
  );
}

// Sticky bar that appears whenever something is selected — the entry point
// for every multi-select action on a page, all of them in one menu.
export function BulkBar({ count, noun, actions, onClear }: { count: number; noun: string; actions: BulkAction[]; onClear: () => void }) {
  if (count === 0) return null;
  return (
    <div className="sticky bottom-3 z-30 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--accent)]/60 bg-[var(--panel-2)] p-2 shadow-2xl">
      <span className="px-2 text-sm font-medium">
        {count} {noun}
        {count === 1 ? "" : "s"} selected
      </span>
      <ActionMenu actions={actions} up primary />
      <span className="flex-1" />
      <Button variant="ghost" onClick={onClear} className="!px-2 !py-1 text-xs">
        Clear selection
      </Button>
    </div>
  );
}

export type PickItem = { id: string; label: string; sub?: string; group?: string };

// Searchable, filterable checkbox list for choosing many of something
// (endpoints, sites, checks). Keeps its own scroll position across parent
// re-renders, since items are keyed by id and the list never remounts.
export function MultiPicker({
  items,
  selected,
  onChange,
  placeholder = "Search…",
  single = false,
  height = "max-h-64",
  groupLabel = "Group",
}: {
  items: PickItem[];
  selected: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  single?: boolean;
  height?: string;
  groupLabel?: string;
}) {
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("");
  const groups = useMemo(() => [...new Set(items.map((i) => i.group).filter(Boolean))].sort() as string[], [items]);
  const query = q.trim().toLowerCase();
  const shown = items.filter((i) => (!group || i.group === group) && (!query || `${i.label} ${i.sub ?? ""} ${i.group ?? ""}`.toLowerCase().includes(query)));
  const set = new Set(selected);
  const toggle = (id: string) => {
    if (single) return onChange(set.has(id) ? [] : [id]);
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange([...next]);
  };
  const allShown = shown.length > 0 && shown.every((i) => set.has(i.id));
  return (
    <div className="rounded-lg border border-[var(--border)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] p-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} className={`${inputClass} min-w-40 flex-1`} aria-label={placeholder} />
        {groups.length > 1 && (
          <select value={group} onChange={(e) => setGroup(e.target.value)} className={`${inputClass} w-auto`} aria-label={`Filter by ${groupLabel}`}>
            <option value="">All {groupLabel.toLowerCase()}s</option>
            {groups.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        )}
        {!single && (
          <button
            type="button"
            className="text-xs text-[var(--muted)] underline"
            onClick={() => onChange(allShown ? selected.filter((id) => !shown.some((i) => i.id === id)) : [...new Set([...selected, ...shown.map((i) => i.id)])])}
          >
            {allShown ? "Unselect shown" : `Select ${shown.length} shown`}
          </button>
        )}
      </div>
      <div className={`${height} overflow-y-auto p-1`}>
        {shown.length === 0 && <p className="p-2 text-xs text-[var(--muted)]">Nothing matches.</p>}
        {shown.map((i) => (
          <label key={i.id} className={`flex cursor-pointer items-start gap-2 rounded px-2 py-1 text-sm hover:bg-[var(--border)]/30 ${set.has(i.id) ? "bg-[var(--accent)]/10" : ""}`}>
            <input type={single ? "radio" : "checkbox"} checked={set.has(i.id)} onChange={() => toggle(i.id)} className="mt-1 accent-[var(--accent)]" />
            <span className="min-w-0">
              <span className="block truncate">{i.label}</span>
              {(i.sub || i.group) && <span className="block truncate text-xs text-[var(--muted)]">{[i.group, i.sub].filter(Boolean).join(" · ")}</span>}
            </span>
          </label>
        ))}
      </div>
      {!single && <div className="border-t border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)]">{selected.length} selected</div>}
    </div>
  );
}

export type AlertOptionsValue = { channelIds: string[]; escalationChannelIds: string[]; consecutiveFailures: string; triggerOn: "down" | "warn"; renotifyMinutes: string; escalateAfterMinutes: string };
export const emptyAlertOptions = (): AlertOptionsValue => ({ channelIds: [], escalationChannelIds: [], consecutiveFailures: "2", triggerOn: "down", renotifyMinutes: "", escalateAfterMinutes: "" });
// What the API's alertRule parameter expects; null when no channel is
// picked (no rule at all).
export function alertRulePayload(v: AlertOptionsValue) {
  if (!v.channelIds.length && !v.escalationChannelIds.length) return null;
  return {
    channelIds: v.channelIds,
    escalationChannelIds: v.escalationChannelIds,
    consecutiveFailures: Number(v.consecutiveFailures) || 2,
    triggerOn: v.triggerOn,
    renotifyMinutes: v.renotifyMinutes ? Number(v.renotifyMinutes) : null,
    escalateAfterMinutes: v.escalateAfterMinutes ? Number(v.escalateAfterMinutes) : null,
  };
}

// The same alert-rule options everywhere checks get created: the check
// form, suggested checks, discovery and bulk "add alert rule".
export function AlertOptions({ channels, value, onChange }: { channels: { id: string; name: string; type: string }[]; value: AlertOptionsValue; onChange: (v: AlertOptionsValue) => void }) {
  const set = <K extends keyof AlertOptionsValue>(k: K, v: AlertOptionsValue[K]) => onChange({ ...value, [k]: v });
  const toggle = (k: "channelIds" | "escalationChannelIds", id: string) => {
    const list = k === "channelIds" ? value.channelIds : value.escalationChannelIds;
    set(k, list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  };
  if (!channels.length) {
    return (
      <p className="text-xs text-[var(--muted)]">
        No notification channels yet —{" "}
        <a className="underline" href="/channels">
          add one
        </a>{" "}
        to get alerts.
      </p>
    );
  }
  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="mb-1 text-xs text-[var(--muted)]">Notify</div>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {channels.map((c) => (
            <label key={c.id} className="flex items-center gap-1.5">
              <input type="checkbox" className="accent-[var(--accent)]" checked={value.channelIds.includes(c.id)} onChange={() => toggle("channelIds", c.id)} />
              {c.name} <span className="text-xs text-[var(--muted)]">({c.type.replace("_", " ")})</span>
            </label>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Label label="Failures in a row" help="Consecutive failing results before the alert fires — 2 or more avoids alerts for a single blip.">
          <input type="number" min={1} value={value.consecutiveFailures} onChange={(e) => set("consecutiveFailures", e.target.value)} className={inputClass} />
        </Label>
        <Label label="Failing means">
          <select value={value.triggerOn} onChange={(e) => set("triggerOn", e.target.value as "down" | "warn")} className={inputClass}>
            <option value="down">Down only</option>
            <option value="warn">Warn or down</option>
          </select>
        </Label>
        <Label label="Remind every (min)" help="Repeat the alert while it stays open. Blank = once.">
          <input type="number" min={1} value={value.renotifyMinutes} onChange={(e) => set("renotifyMinutes", e.target.value)} className={inputClass} />
        </Label>
        <Label label="Escalate after (min)" help="If still open this long, also notify the escalation channels below.">
          <input type="number" min={1} value={value.escalateAfterMinutes} onChange={(e) => set("escalateAfterMinutes", e.target.value)} className={inputClass} />
        </Label>
      </div>
      {value.escalateAfterMinutes && (
        <div>
          <div className="mb-1 text-xs text-[var(--muted)]">Escalate to</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {channels.map((c) => (
              <label key={c.id} className="flex items-center gap-1.5">
                <input type="checkbox" className="accent-[var(--accent)]" checked={value.escalationChannelIds.includes(c.id)} onChange={() => toggle("escalationChannelIds", c.id)} />
                {c.name}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// A small one-field prompt modal for bulk actions that need a parameter
// (minutes, interval, tags, target site...).
export function PromptDialog({
  title,
  label,
  help,
  initial = "",
  type = "text",
  options,
  actionLabel = "Apply",
  onSubmit,
  onClose,
}: {
  title: string;
  label: string;
  help?: string;
  initial?: string;
  type?: "text" | "number";
  options?: { value: string; label: string }[];
  actionLabel?: string;
  onSubmit: (value: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial || options?.[0]?.value || "");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSubmit(value);
            onClose();
          } finally {
            setBusy(false);
          }
        }}
      >
        <Label label={label} help={help}>
          {options ? (
            <select autoFocus value={value} onChange={(e) => setValue(e.target.value)} className={inputClass}>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input autoFocus type={type} value={value} onChange={(e) => setValue(e.target.value)} className={inputClass} />
          )}
        </Label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={busy || (!options && value === "")}>
            {busy ? "Working…" : actionLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function Toast({ message, kind = "info", onDone }: { message: string; kind?: "info" | "error"; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, kind === "error" ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [onDone, kind]);
  return (
    <div role="status" className={`fixed bottom-20 left-1/2 z-[60] max-w-[90vw] -translate-x-1/2 rounded-lg border px-4 py-2 text-sm shadow-xl ${kind === "error" ? "border-[var(--down)] bg-[var(--panel-2)] text-[var(--down)]" : "border-[var(--border-strong)] bg-[var(--panel-2)]"}`}>
      {message}
    </div>
  );
}

export function useToast() {
  const [toast, setToast] = useState<{ message: string; kind: "info" | "error" } | null>(null);
  const show = useCallback((message: string, kind: "info" | "error" = "info") => setToast({ message, kind }), []);
  const node = toast ? <Toast message={toast.message} kind={toast.kind} onDone={() => setToast(null)} /> : null;
  return { show, node };
}

export function relativeTime(iso: string | null | undefined) {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

export function Tags({ tags }: { tags: string[] }) {
  if (!tags?.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {tags.map((t) => (
        <span key={t} className="rounded bg-[var(--border)]/50 px-1.5 py-0.5 text-[10px] text-[var(--text)]">
          {t}
        </span>
      ))}
    </span>
  );
}

export function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-2.5 py-0.5 text-xs ${active ? "border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--text)]" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]"}`}
    >
      {children}
    </button>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="rounded-xl border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--muted)]">{children}</div>;
}

export function formatBytes(n: number | null | undefined) {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units.at(i)}`;
}
