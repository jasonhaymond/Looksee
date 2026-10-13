"use client";

import { useEffect, useRef, useState } from "react";
import { STATUS_COLOR } from "./ui";

// Small, dependency-free SVG charts for the check page. One measure per
// chart (never two y-axes); hover gives a crosshair + readout, and every
// number is also in the results table below them.

// Charts draw at their real pixel width (measured), so axis text stays a
// readable size instead of being scaled down with the SVG.
function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => setW(Math.max(280, Math.round(entries[0].contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const fmtTime = (t: string | number, spanMs: number) => {
  const d = new Date(t);
  return spanMs > 2 * 86_400_000 ? d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
};
const nice = (v: number) => (Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2));

export function LineChart({ points, unit = "", height = 160, label }: { points: { t: string; v: number | null; min?: number | null; max?: number | null }[]; unit?: string; height?: number; label: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const [box, W] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const data = points.filter((p) => p.v != null) as { t: string; v: number; min?: number | null; max?: number | null }[];
  if (data.length < 2)
    return (
      <div ref={box}>
        <p className="py-6 text-center text-xs text-[var(--muted)]">Not enough data in this range for a {label.toLowerCase()} chart.</p>
      </div>
    );
  const pad = { l: 52, r: 12, t: 10, b: 24 };
  const xs = data.map((p) => new Date(p.t).getTime());
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const lo = Math.min(...data.map((p) => p.min ?? p.v));
  const hi = Math.max(...data.map((p) => p.max ?? p.v));
  const yMin = lo >= 0 && lo < hi * 0.5 ? 0 : lo - (hi - lo) * 0.1;
  const yMax = hi + (hi - yMin) * 0.1 || 1;
  const X = (t: number) => pad.l + ((t - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (height - pad.t - pad.b);
  const path = data.map((p, i) => `${i ? "L" : "M"}${X(xs[i]).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
  const band = data.some((p) => p.min != null && p.max != null && p.max !== p.min)
    ? data.map((p, i) => `${i ? "L" : "M"}${X(xs[i]).toFixed(1)},${Y(p.max ?? p.v).toFixed(1)}`).join("") + [...data].reverse().map((p, i) => `L${X(xs[data.length - 1 - i]).toFixed(1)},${Y(p.min ?? p.v).toFixed(1)}`).join("") + "Z"
    : null;
  const ticks = [0, 0.5, 1].map((f) => yMin + f * (yMax - yMin));
  const h = hover != null ? data[hover] : null;
  return (
    <div ref={box} className="relative">
      <svg
        ref={ref}
        width={W}
        height={height}
        viewBox={`0 0 ${W} ${height}`}
        className="block w-full"
        role="img"
        aria-label={`${label} over time`}
        onPointerMove={(e) => {
          const rect = ref.current!.getBoundingClientRect();
          const x = ((e.clientX - rect.left) / rect.width) * W;
          let best = 0;
          for (let i = 1; i < xs.length; i++) if (Math.abs(X(xs[i]) - x) < Math.abs(X(xs[best]) - x)) best = i;
          setHover(best);
        }}
        onPointerLeave={() => setHover(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={Y(t)} y2={Y(t)} stroke="var(--grid)" strokeWidth={1} />
            <text x={pad.l - 6} y={Y(t) + 4} textAnchor="end" fontSize={12} fill="var(--muted)">
              {nice(t)}
            </text>
          </g>
        ))}
        <text x={pad.l} y={height - 5} fontSize={12} fill="var(--muted)">
          {fmtTime(x0, x1 - x0)}
        </text>
        <text x={W - pad.r} y={height - 5} fontSize={12} fill="var(--muted)" textAnchor="end">
          {fmtTime(x1, x1 - x0)}
        </text>
        {band && <path d={band} fill="var(--series)" opacity={0.15} />}
        <path d={path} fill="none" stroke="var(--series)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {h && (
          <g>
            <line x1={X(xs[hover!])} x2={X(xs[hover!])} y1={pad.t} y2={height - pad.b} stroke="var(--muted)" strokeWidth={1} />
            <circle cx={X(xs[hover!])} cy={Y(h.v)} r={4} fill="var(--series)" stroke="var(--panel)" strokeWidth={2} />
          </g>
        )}
      </svg>
      {h && (
        <div className="pointer-events-none absolute top-0 rounded-md border border-[var(--border-strong)] bg-[var(--panel-2)] px-2 py-1 text-xs shadow-lg" style={{ left: `${Math.min(80, (X(xs[hover!]) / W) * 100)}%` }}>
          <div className="font-semibold">
            {nice(h.v)}
            {unit}
            {h.min != null && h.max != null && h.min !== h.max ? <span className="font-normal text-[var(--muted)]"> ({nice(h.min)}–{nice(h.max)})</span> : null}
          </div>
          <div className="text-[var(--muted)]">
            <span className="mr-1 inline-block h-0.5 w-3 align-middle" style={{ background: "var(--series)" }} />
            {label} · {new Date(h.t).toLocaleString()}
          </div>
        </div>
      )}
    </div>
  );
}

// One cell per time bucket, colored by the worst status in it; status is
// also named in the hover readout and the legend (never color alone).
export function StatusStrip({ series }: { series: { t: string; status: string; n: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  if (!series.length) return null;
  const h = hover != null ? series[hover] : null;
  return (
    <div className="relative">
      <div className="flex h-6 min-w-0 gap-px sm:gap-[2px]" role="img" aria-label="Status over time">
        {series.map((s, i) => (
          <span
            key={s.t}
            tabIndex={0}
            onPointerEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onPointerLeave={() => setHover(null)}
            onBlur={() => setHover(null)}
            className={`min-w-0 flex-1 rounded-[1px] sm:rounded-sm ${hover === i ? "outline outline-2 outline-[var(--text)]" : ""}`}
            style={{ background: STATUS_COLOR[s.status] ?? "var(--muted)" }}
          />
        ))}
      </div>
      {h && (
        <div className="pointer-events-none absolute top-8 z-10 rounded-md border border-[var(--border-strong)] bg-[var(--panel-2)] px-2 py-1 text-xs shadow-lg" style={{ left: `${Math.min(75, (hover! / series.length) * 100)}%` }}>
          <div className="font-semibold">{h.status.toUpperCase()}</div>
          <div className="text-[var(--muted)]">
            {new Date(h.t).toLocaleString()} · {h.n} result{h.n === 1 ? "" : "s"}
          </div>
        </div>
      )}
      <div className="mt-1 flex flex-wrap gap-3 text-[10px] text-[var(--muted)]">
        {["up", "warn", "down", "maintenance", "unknown"].map((s) => (
          <span key={s} className="inline-flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm" style={{ background: STATUS_COLOR[s] }} />
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}
