// The public status page at /status/<slug>: no sign-in needed.
//
// Where this sits: published from System → Status pages. Anyone with the link
// can open it, so it shows only what the engine's public route returns
// (engine/src/routes/public.ts) — each listed check's name, current status
// and 90 daily uptime bars — never endpoints, addresses or messages.
//
// "use client" (below) makes this a React component that runs in the
// visitor's browser, so the data is fetched from there — which is also how
// the visitor's time zone reaches the engine: each daily bar covers the
// visitor's own calendar day, not the server's.

"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, type PublicStatus } from "../../lib/api";
import { STATUS_COLOR } from "../../components/ui";
import { pollEvery } from "../../lib/poll";

// The banner text and color for the page's overall state.
const OVERALL = {
  operational: { text: "All systems operational", color: "var(--up)" },
  degraded: { text: "Some systems degraded", color: "var(--warn)" },
  down: { text: "Some systems are down", color: "var(--down)" },
};

/**
 * The color of one day's uptime bar.
 *
 * @param uptime that day's uptime percentage, or null for no results
 * @returns a theme color: grey (no data), green (≥ 99.9%), amber (≥ 95%), red
 */
function dayColor(uptime: number | null) {
  if (uptime == null) return "var(--border)";
  if (uptime >= 99.9) return "var(--up)";
  if (uptime >= 95) return "var(--warn)";
  return "var(--down)";
}

/**
 * Shows a calendar date ("2026-10-13") in the visitor's own date format,
 * e.g. "Oct 13, 2026". It's read as noon local time so no time-zone offset
 * can tip it onto the neighbouring day.
 */
const formatDay = (day: string) => new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { dateStyle: "medium" });

/**
 * The page itself. Loads the status once, then again every minute while open.
 * A page that doesn't exist and one that isn't published look the same.
 */
export default function PublicStatusPage() {
  // useParams reads the <slug> part of the URL; useState holds values that
  // re-draw the page when they change.
  const { slug } = useParams<{ slug: string }>();
  const [data, setData] = useState<PublicStatus | null>(null);
  const [missing, setMissing] = useState(false);

  // useEffect runs after the page first appears (and again if the slug
  // changes); the function it returns stops the timer when the page closes.
  useEffect(() => {
    const load = () =>
      api
        .publicStatus(slug)
        .then((d) => {
          setData(d);
          document.title = d.title;
        })
        .catch(() => setMissing(true));
    load();
    const t = pollEvery(load, 60_000);
    return () => clearInterval(t);
  }, [slug]);

  if (missing) return <main className="mx-auto max-w-3xl p-6 text-center text-[var(--muted)]">This status page doesn&apos;t exist or isn&apos;t published.</main>;
  if (!data) return null;
  const overall = OVERALL[data.overall];
  return (
    <main className="mx-auto max-w-3xl p-4 sm:p-8">
      <h1 className="text-2xl font-semibold">{data.title}</h1>
      {data.description && <p className="mt-1 text-[var(--muted)]">{data.description}</p>}
      <div className="mt-6 flex items-center gap-3 rounded-xl border p-4" style={{ borderColor: overall.color }}>
        <span className="h-3 w-3 rounded-full" style={{ background: overall.color }} />
        <span className="font-medium">{overall.text}</span>
      </div>
      <ul className="mt-6 space-y-4">
        {data.checks.map((c) => (
          <li key={c.name} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{c.name}</span>
              {/* The status is spelled out next to the dot, so it never relies on color alone. */}
              <span className="inline-flex items-center gap-2 text-sm">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_COLOR[c.status] }} />
                {c.status === "up" ? "Operational" : c.status === "warn" ? "Degraded" : c.status === "down" ? "Down" : "Unknown"}
              </span>
            </div>
            {/* One bar per day, oldest on the left; hovering shows that day's uptime. */}
            <div className="mt-3 flex h-8 gap-px" aria-label={`90-day uptime for ${c.name}`}>
              {c.days.map((d) => (
                <span key={d.day} title={`${formatDay(d.day)}: ${d.uptime == null ? "no data" : `${d.uptime}% up`}`} className="flex-1 rounded-sm" style={{ background: dayColor(d.uptime) }} />
              ))}
            </div>
            <div className="mt-1 flex justify-between text-xs text-[var(--muted)]">
              <span>90 days ago</span>
              <span>{c.uptime90 != null ? `${c.uptime90}% uptime` : "no data yet"}</span>
              <span>Today</span>
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-8 text-center text-xs text-[var(--muted)]">
        Updated {new Date(data.generatedAt).toLocaleString()}
        {/* Says which calendar the bars use; the engine falls back to UTC if the visitor's zone wasn't usable. */}
        {data.timeZone ? ` · Days in ${data.timeZone === "UTC" ? "UTC" : "your time zone"}` : ""} · Powered by Looksee
      </p>
    </main>
  );
}
