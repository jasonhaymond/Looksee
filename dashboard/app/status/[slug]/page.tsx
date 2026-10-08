"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api, type PublicStatus } from "../../lib/api";
import { STATUS_COLOR } from "../../components/ui";

// Public (no sign-in) status page. Only what /api/public/status returns is
// shown — check names, status, and daily uptime — never hosts or messages.
const OVERALL = {
  operational: { text: "All systems operational", color: "var(--up)" },
  degraded: { text: "Some systems degraded", color: "var(--warn)" },
  down: { text: "Some systems are down", color: "var(--down)" },
};

function dayColor(uptime: number | null) {
  if (uptime == null) return "var(--border)";
  if (uptime >= 99.9) return "var(--up)";
  if (uptime >= 95) return "var(--warn)";
  return "var(--down)";
}

export default function PublicStatusPage() {
  const { slug } = useParams<{ slug: string }>();
  const [data, setData] = useState<PublicStatus | null>(null);
  const [missing, setMissing] = useState(false);

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
    const t = setInterval(load, 60_000);
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
              <span className="inline-flex items-center gap-2 text-sm">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_COLOR[c.status] }} />
                {c.status === "up" ? "Operational" : c.status === "warn" ? "Degraded" : c.status === "down" ? "Down" : "Unknown"}
              </span>
            </div>
            <div className="mt-3 flex h-8 gap-px" aria-label={`90-day uptime for ${c.name}`}>
              {c.days.map((d) => (
                <span key={d.day} title={`${d.day}: ${d.uptime == null ? "no data" : `${d.uptime}% up`}`} className="flex-1 rounded-sm" style={{ background: dayColor(d.uptime) }} />
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
      <p className="mt-8 text-center text-xs text-[var(--muted)]">Updated {new Date(data.generatedAt).toLocaleString()} · Powered by Looksee</p>
    </main>
  );
}
