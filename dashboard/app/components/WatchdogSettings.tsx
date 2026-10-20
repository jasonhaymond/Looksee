// An endpoint's "Watchdog" tab: make its agent a watchdog that alerts by
// email and/or chat when it can't reach Looksee — the alert that still
// works when the Looksee server itself is down.
//
// Where this sits: a tab of EndpointPanel (the Endpoints list and each
// endpoint's page). Settings are saved with PUT /api/endpoints/:id/watchdog
// (engine/src/routes/endpoints.ts); the agent picks them up on its next
// config poll and reports its status back (agent/internal/watchdog).
//
// Security note shown to the admin: a watchdog agent receives the SMTP
// password and the chosen channels' delivery settings (bot tokens, webhook
// URLs), because it has to send without Looksee. They're stored on that
// endpoint readable by the agent's service account only — pick endpoints you
// trust.
//
// "use client" makes this a React component that runs in the browser.

"use client";

import { useState } from "react";
import { api, type Channel, type Endpoint } from "../lib/api";
import { formatLocal } from "../lib/localTime";
import { Button, Label, inputClass, relativeTime } from "./ui";

// Channel types the agent can deliver to itself (engine: WATCHDOG_CHANNEL_TYPES).
const AGENT_CHANNEL_TYPES = new Set(["telegram", "slack", "teams", "webhook"]);

/**
 * The watchdog settings form and the agent's last reported watchdog status.
 *
 * @param host the endpoint
 * @param channels every notification channel (only agent-deliverable ones are offered)
 * @param onChanged reloads the endpoint after a save or test request
 */
export function WatchdogSettings({ host, channels, onChanged }: { host: Endpoint; channels: Channel[]; onChanged: () => void }) {
  const w = host.watchdog;
  const [enabled, setEnabled] = useState(Boolean(w?.enabled));
  const [afterMinutes, setAfterMinutes] = useState(String(w?.afterMinutes ?? 5));
  const [emailTo, setEmailTo] = useState((w?.emailTo ?? []).join(", "));
  const [channelIds, setChannelIds] = useState<string[]>(w?.channelIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const usable = channels.filter((c) => AGENT_CHANNEL_TYPES.has(c.type));
  const status = host.watchdogStatus;

  async function save() {
    setError(null);
    setSaved(false);
    try {
      await api.setWatchdog(host.id, { enabled, afterMinutes: Number(afterMinutes) || 5, emailTo, channelIds });
      setSaved(true);
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    }
  }

  return (
    <div className="space-y-3 text-sm">
      <p className="text-[var(--muted)]">
        A watchdog agent checks that it can reach Looksee. If it can&apos;t for the time below, it sends the alert itself — by email and/or chat — and again when Looksee is back. Use one or two endpoints in different places (another site, a cloud VM), so one network problem can&apos;t silence both.
      </p>
      {!host.hasAgentKey && <p className="text-[var(--warn)]">This endpoint has no agent yet — install one from the Agent tab first.</p>}
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-[var(--up)]" />
        Make this endpoint&apos;s agent a watchdog
      </label>
      {enabled && (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Label label="Alert after (minutes)" help="How long Looksee must be unreachable before the alert goes out. 5 is a good start; shorter catches more brief blips.">
              <input type="number" min={1} max={1440} value={afterMinutes} onChange={(e) => setAfterMinutes(e.target.value)} className={inputClass} />
            </Label>
            <Label label="Email to" help="Comma-separated. Sent through the SMTP server set on the Channels page." className="sm:col-span-2">
              <input value={emailTo} onChange={(e) => setEmailTo(e.target.value)} placeholder="ops@example.com" className={inputClass} />
            </Label>
          </div>
          <div>
            <span className="text-xs text-[var(--muted)]">Also post to:</span>
            {usable.length ? (
              <div className="mt-1 flex flex-wrap gap-3">
                {usable.map((c) => (
                  <label key={c.id} className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      className="accent-[var(--up)]"
                      checked={channelIds.includes(c.id)}
                      onChange={() => setChannelIds((ids) => (ids.includes(c.id) ? ids.filter((x) => x !== c.id) : [...ids, c.id]))}
                    />
                    {c.name} <span className="text-xs text-[var(--muted)]">({c.type})</span>
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-xs text-[var(--muted)]">No Telegram, Slack, Teams or webhook channels yet (add one on the Channels page).</p>
            )}
          </div>
          <p className="rounded-md border border-[var(--warn)]/40 bg-[var(--warn)]/10 p-2 text-xs">
            <strong>Good to know:</strong> to send without Looksee, this agent receives the SMTP password and the chosen channels&apos; delivery settings (bot tokens, webhook URLs). They&apos;re stored on {host.name}, readable only by the agent&apos;s service account. Pick endpoints you trust.
          </p>
        </>
      )}
      {error && <p className="text-[var(--down)]">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={save}>
          Save
        </Button>
        {w?.enabled && (
          <Button
            onClick={async () => {
              await api.testWatchdogAgent(host.id);
              onChanged();
            }}
            title="The agent sends a test message on its next check-in (within a minute)"
          >
            Send test
          </Button>
        )}
        {saved && <span className="text-xs text-[var(--up)]">✓ Saved — the agent picks it up on its next check-in.</span>}
      </div>
      {w?.enabled && (
        <div className="space-y-0.5 rounded-md border border-[var(--border)] p-2 text-xs">
          <p className="font-medium">What the agent last reported</p>
          {!status ? (
            <p className="text-[var(--muted)]">Nothing yet — the agent reports after its next check-in (needs agent 5.0 or newer).</p>
          ) : (
            <>
              <p>{status.alerting ? <span className="text-[var(--down)]">✕ Alerting — it can&apos;t reach Looksee</span> : <span className="text-[var(--up)]">✓ Reaching Looksee</span>}</p>
              {status.lastAlertAt && <p>Last alert: {formatLocal(new Date(status.lastAlertAt))}</p>}
              {status.lastRecoveryAt && <p>Last &ldquo;reachable again&rdquo;: {formatLocal(new Date(status.lastRecoveryAt))}</p>}
              {w.testRequestedAt && status.lastTestId !== w.testRequestedAt && <p className="text-[var(--muted)]">Test requested {relativeTime(w.testRequestedAt)} — waiting for the agent.</p>}
              {status.lastTestAt && <p>Last test sent: {formatLocal(new Date(status.lastTestAt))}</p>}
              {status.lastError && (
                <p className="text-[var(--down)]">
                  ! Delivery failed{status.lastErrorAt ? ` (${formatLocal(new Date(status.lastErrorAt))})` : ""}: {status.lastError}
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
