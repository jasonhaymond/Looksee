"use client";

import { RANGE_OPTIONS } from "../lib/timeRange";

export function RangeSelect({ hours, onChange }: { hours: number; onChange: (hours: number) => void }) {
  return (
    <select
      value={hours}
      onChange={(e) => onChange(Number(e.target.value))}
      className="no-drag rounded-md border border-[var(--border)] bg-transparent px-1.5 py-0.5 text-xs text-[var(--muted)] outline-none"
    >
      {RANGE_OPTIONS.map((o) => (
        <option key={o.hours} value={o.hours}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
