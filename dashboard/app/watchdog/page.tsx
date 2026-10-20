// The Watchdog page (/watchdog): the two ways to be told when Looksee itself
// is down, since Looksee can't alert about its own outage.
//
// 1. The outbound "dead man's switch": while healthy, the engine pings an
//    outside service (healthchecks.io, Uptime Kuma…), which alerts when the
//    pings stop (engine/src/routes/watchdog.ts, services/watchdog.ts).
// 2. Watchdog agents: endpoints whose Looksee agent alerts by email/chat on
//    its own when it can't reach Looksee. Set up per endpoint (Endpoints →
//    an endpoint → Watchdog tab); this page lists them and their status.
//
// "use client" makes this a React component that runs in the browser. The
// engine refuses every call without a session; usePageAuth sends a
// signed-out visitor to the sign-in page.

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, type Endpoint, type WatchdogView } from "../lib/api";
import { PageHelp } from "../components/PageHelp";
import { Button, Label, inputClass, relativeTime, useToast } from "../components/ui";
import { usePageAuth } from "../components/usePageAuth";

/** The page: the outbound watchdog's settings, the watchdog agents, and setup help. */
export default function WatchdogPage() {
  const authed = usePageAuth();
  const [w, setW] = useState<WatchdogView | null>(null);
  const [url, setUrl] = useState("");
  const [failUrl, setFailUrl] = useState("");
  const [interval, setInterval_] = useState("60");
  // Endpoints set up as watchdog agents.
  const [agents, setAgents] = useState<Endpoint[]>([]);
  const toast = useToast();

  // Loads the outbound watchdog's settings and the endpoints that are
  // watchdog agents.
  const load = useCallback(
    () =>
      Promise.all([api.watchdog(), api.endpoints()]).then(([v, eps]) => {
        setW(v);
        setInterval_(String(v.intervalSeconds));
        setAgents(eps.filter((e) => e.watchdog?.enabled));
      }),
    []
  );
  useEffect(() => {
    if (authed) load();
  }, [authed, load]);

  async function save(patch: Parameters<typeof api.updateWatchdog>[0], msg = "Saved.") {
    try {
      setW(await api.updateWatchdog(patch));
      setUrl("");
      setFailUrl("");
      toast.show(msg);
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "Couldn't save", "error");
    }
  }

  if (!authed || !w) return null;
  return (
    <main className="mx-auto max-w-4xl p-4 sm:p-6">
      <h2 className="mb-3 text-lg font-medium">Watchdog</h2>
      <PageHelp anchor="watchdog">
        Looksee can alert on everything except its own outage. While it&apos;s healthy it pings an outside service every minute; if the pings stop — server down, power or internet out at home, Looksee stuck — that service alerts you.
      </PageHelp>

      <section className="surface mb-4 rounded-xl p-4 text-sm">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <span className={`font-medium ${w.enabled ? "text-[var(--up)]" : "text-[var(--muted)]"}`}>{w.enabled ? "On" : "Off"}</span>
          <span className="text-xs text-[var(--muted)]">
            Self-check: {w.selfCheck.ok ? "healthy" : <span className="text-[var(--down)]">{w.selfCheck.reason}</span>} · last ping {relativeTime(w.lastPingAt)}
            {w.lastResult ? ` (${w.lastResult})` : ""}
            {w.lastError ? <span className="text-[var(--down)]"> — {w.lastError}</span> : null}
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Label label="Ping URL" help="Write-only: the URL holds the service's secret token, so it's never shown again once saved.">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder={w.urlSet ? `saved: ${w.url} — type to replace` : "https://hc-ping.com/…"} className={inputClass} />
          </Label>
          <Label label="Failure URL (optional)" help="Called instead when Looksee's self-check fails (database unreachable, scheduler stuck), so you're alerted even if the process is still up. Healthchecks.io: the ping URL + /fail.">
            <input value={failUrl} onChange={(e) => setFailUrl(e.target.value)} placeholder={w.failUrlSet ? `saved: ${w.failUrl} — type to replace` : "https://hc-ping.com/…/fail"} className={inputClass} />
          </Label>
          <Label label="Ping every (seconds)" help="30–3600. Set the outside service's expected period to match, with a few minutes' grace.">
            <input type="number" min={30} max={3600} value={interval} onChange={(e) => setInterval_(e.target.value)} className={inputClass} />
          </Label>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="primary"
            onClick={() => save({ ...(url ? { url } : {}), ...(failUrl ? { failUrl } : {}), intervalSeconds: Number(interval) || 60 })}
          >
            Save
          </Button>
          <Button onClick={() => save({ enabled: !w.enabled, ...(url ? { url } : {}) }, w.enabled ? "Watchdog turned off." : "Watchdog on — pinging every minute.")}>{w.enabled ? "Turn off" : "Turn on"}</Button>
          <Button
            disabled={!w.urlSet}
            onClick={async () => {
              try {
                const r = await api.testWatchdog();
                toast.show(r.healthy ? "Ping sent — check the service shows Looksee as up." : `Self-check failed: ${r.detail}`, r.healthy ? "info" : "error");
              } catch (err) {
                toast.show(err instanceof Error ? err.message : "Ping failed", "error");
              }
              load();
            }}
          >
            Send a ping now
          </Button>
          {w.failUrlSet && (
            <Button variant="ghost" onClick={() => save({ failUrl: null }, "Failure URL removed.")}>
              Remove failure URL
            </Button>
          )}
        </div>
      </section>

      <section className="surface mb-4 rounded-xl p-4 text-sm">
        <h3 className="mb-1 font-medium">Watchdog agents</h3>
        <p className="mb-2 text-xs text-[var(--muted)]">
          Agents that alert by email or chat themselves when they can&apos;t reach Looksee — no outside service needed. Turn one on from an endpoint&apos;s <strong>Watchdog</strong> tab (Endpoints → the endpoint); one or two in different places is plenty.
        </p>
        {agents.length ? (
          <ul className="space-y-1">
            {agents.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2 text-xs">
                {a.watchdogStatus?.alerting ? <span className="text-[var(--down)]">✕ alerting</span> : a.watchdogStatus ? <span className="text-[var(--up)]">✓ reaching Looksee</span> : <span className="text-[var(--muted)]">? no report yet</span>}
                <Link href={`/endpoints/${a.id}`} className="font-medium underline">
                  {a.name}
                </Link>
                <span className="text-[var(--muted)]">
                  after {a.watchdog!.afterMinutes} min → {[a.watchdog!.emailTo.length ? `${a.watchdog!.emailTo.length} email` : "", a.watchdog!.channelIds.length ? `${a.watchdog!.channelIds.length} channel(s)` : ""].filter(Boolean).join(" + ")} · last report {relativeTime(a.lastSeenAt)}
                </span>
                {a.watchdogStatus?.lastError && <span className="text-[var(--down)]">! {a.watchdogStatus.lastError}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-[var(--muted)]">None yet.</p>
        )}
      </section>

      <section className="surface rounded-xl p-4 text-sm">
        <h3 className="mb-2 font-medium">Setting up the outside service</h3>
        <details className="mb-2" open>
          <summary className="cursor-pointer font-medium">Healthchecks.io (free tier, built for this)</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-[var(--muted)]">
            <li>Sign up at healthchecks.io → <strong>Add Check</strong>. Set <em>Period</em> 1 minute and <em>Grace</em> 5 minutes.</li>
            <li>Copy its ping URL (https://hc-ping.com/…) into <strong>Ping URL</strong> above, and the same URL plus <code>/fail</code> into <strong>Failure URL</strong>.</li>
            <li>Under the check&apos;s <em>Integrations</em>, choose how to be told (email, Telegram, push, SMS…).</li>
            <li>Save, <strong>Turn on</strong>, then <strong>Send a ping now</strong> — the check turns green on healthchecks.io.</li>
          </ol>
        </details>
        <details className="mb-2">
          <summary className="cursor-pointer font-medium">Uptime Kuma (self-hosted — run it off-site)</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-[var(--muted)]">
            <li>Add a monitor of type <strong>Push</strong>, heartbeat interval 60 s, retries 3.</li>
            <li>Copy its push URL into <strong>Ping URL</strong>; for the failure URL use the same URL with <code>?status=down&amp;msg=self-check</code>.</li>
            <li>It only helps if Uptime Kuma runs somewhere else — a VPS or another site — not in the same homelab.</li>
          </ol>
        </details>
        <details>
          <summary className="cursor-pointer font-medium">UptimeRobot / Better Stack (they poll Looksee instead)</summary>
          <p className="mt-2 text-[var(--muted)]">
            No ping needed: add an HTTP(S) monitor for <code>https://&lt;your-looksee&gt;/api/health</code> with keyword <code>&quot;status&quot;:&quot;ok&quot;</code>. It returns an error when the database is unreachable. Leave this watchdog off, or use both.
          </p>
        </details>
      </section>
      {toast.node}
    </main>
  );
}
