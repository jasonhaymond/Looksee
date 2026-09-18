"use client";

// A small "?" hint that reveals help text on hover/focus — CSS-only, no
// positioning library. Used next to a label or field to explain what it's
// for, without permanently taking up space the way inline help text would.
export function Tooltip({ text }: { text: string }) {
  return (
    <span className="group relative ml-1 inline-flex">
      <span
        tabIndex={0}
        className="inline-flex h-3.5 w-3.5 cursor-help items-center justify-center rounded-full border border-[var(--muted)] text-[9px] leading-none text-[var(--muted)]"
      >
        ?
      </span>
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 w-56 -translate-x-1/2 rounded-md border border-[var(--border)] bg-[var(--panel)] p-2 text-xs font-normal text-[var(--text)] opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}
