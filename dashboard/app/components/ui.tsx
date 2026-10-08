"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Tooltip } from "./Tooltip";

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
      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR[status] ?? "var(--muted)" }} />
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
    primary: "bg-[var(--up)] font-medium text-black hover:brightness-110",
    danger: "border border-[var(--down)]/60 text-[var(--down)] hover:bg-[var(--down)]/10",
    ghost: "text-[var(--muted)] hover:text-[var(--text)]",
  }[variant];
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={`rounded-md px-3 py-1.5 text-sm disabled:cursor-not-allowed disabled:opacity-40 ${styles} ${className}`}>
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
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-2 sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={`my-4 w-full ${wide ? "max-w-3xl" : "max-w-lg"} rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-2xl`}>
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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Drop selections that no longer exist (deleted, filtered by a reload).
  const key = visibleIds.join(",");
  useEffect(() => {
    setSelected((prev) => {
      const visible = new Set(visibleIds);
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
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

export type BulkAction = { key: string; label: string; danger?: boolean; run: () => void };

// Sticky bar that appears whenever something is selected — the entry point
// for every multi-select action on a page.
export function BulkBar({ count, noun, actions, onClear }: { count: number; noun: string; actions: BulkAction[]; onClear: () => void }) {
  if (count === 0) return null;
  return (
    <div className="sticky bottom-3 z-30 mt-4 flex flex-wrap items-center gap-2 rounded-xl border border-[var(--up)]/50 bg-[var(--panel)] p-2 shadow-2xl">
      <span className="px-2 text-sm font-medium">
        {count} {noun}
        {count === 1 ? "" : "s"} selected
      </span>
      <span className="hidden h-5 w-px bg-[var(--border)] sm:block" />
      {actions.map((a) => (
        <Button key={a.key} variant={a.danger ? "danger" : "default"} onClick={a.run} className="!px-2 !py-1 text-xs">
          {a.label}
        </Button>
      ))}
      <span className="flex-1" />
      <Button variant="ghost" onClick={onClear} className="!px-2 !py-1 text-xs">
        Clear selection
      </Button>
    </div>
  );
}

// A small one-field prompt modal for bulk actions that need a parameter
// (minutes, interval, tags, target endpoint...).
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
    <div role="status" className={`fixed bottom-20 left-1/2 z-[60] max-w-[90vw] -translate-x-1/2 rounded-lg border px-4 py-2 text-sm shadow-xl ${kind === "error" ? "border-[var(--down)] bg-[var(--panel)] text-[var(--down)]" : "border-[var(--border)] bg-[var(--panel)]"}`}>
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
        <span key={t} className="rounded bg-[var(--border)]/60 px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
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
      className={`rounded-full border px-2.5 py-0.5 text-xs ${active ? "border-[var(--text)] text-[var(--text)]" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]"}`}
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
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}
