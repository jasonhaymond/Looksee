"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type WatchdogView } from "../lib/api";
import { TopNav } from "../components/TopNav";
import { PageHelp } from "../components/PageHelp";
import { Button, Label, inputClass, relativeTime, useToast } from "../components/ui";
import { usePageAuth } from "../components/usePageAuth";

// The outbound "dead man's switch": Looksee can alert on everything except
// its own outage, so it pings an outside service that alerts when the pings
// stop.
export default function WatchdogPage() {
  const authed = usePageAuth();
  const [w, setW] = useState<WatchdogView | null>(null);
  const [url, setUrl] = useState("");
  const [failUrl, setFailUrl] = useState("");
  const [interval, setInterval_] = useState("60");
  const toast = useToast();

  const load = useCallback(async () => {
    const v = await api.watchdog();
    setW(v);
    setInterval_(String(v.intervalSeconds));
  }, []);
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
      <TopNav active="/watchdog" />
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
