"use client";

// A small "?" hint that reveals help text on hover/focus — CSS-only, no
// positioning library. Used next to a label or field to explain what it's
// for, without permanently taking up space the way inline help text would.
// The bubble isn't rendered until shown (hidden, not just transparent), so a
// "?" near the right edge can't widen the page on a phone.
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
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 hidden w-56 max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-md border border-[var(--border-strong)] bg-[var(--panel-2)] p-2 text-xs font-normal text-[var(--text)] shadow-lg group-hover:block group-focus-within:block"
      >
        {text}
      </span>
    </span>
  );
}
