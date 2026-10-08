"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type AlertRule, type Channel } from "../lib/api";
import { Button, Label, inputClass } from "./ui";

function channelNames(ids: string[], channels: Channel[]) {
  return ids.map((id) => channels.find((c) => c.id === id)?.name ?? "?").join(", ") || "no channel";
}

export function AlertRuleManager({ checkId }: { checkId: string }) {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [consecutive, setConsecutive] = useState("2");
  const [triggerOn, setTriggerOn] = useState<"down" | "warn">("down");
  const [primary, setPrimary] = useState<string[]>([]);
  const [renotify, setRenotify] = useState("");
  const [escalateAfter, setEscalateAfter] = useState("");
  const [escalation, setEscalation] = useState<string[]>([]);

  async function load() {
    const [ruleList, channelList] = await Promise.all([api.alertRules(checkId), api.channels()]);
    setRules(ruleList);
    setChannels(channelList);
    setLoaded(true);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkId]);

  async function handleAdd() {
    await api.createAlertRule({
      checkId,
      consecutiveFailures: Math.max(1, Number(consecutive) || 2),
      triggerOn,
      channelIds: primary,
      renotifyMinutes: renotify ? Number(renotify) : null,
      escalateAfterMinutes: escalateAfter ? Number(escalateAfter) : null,
      escalationChannelIds: escalateAfter ? escalation : [],
    });
    setPrimary([]);
    setEscalation([]);
    load();
  }

  if (!loaded) return null;

  const toggle = (list: string[], setList: (v: string[]) => void, id: string) => setList(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

  return (
    <div className="space-y-3 text-sm">
      {rules.length === 0 ? (
        <p className="text-[var(--muted)]">No alert rule — this check shows on dashboards but won&apos;t notify anyone.</p>
      ) : (
        <ul className="space-y-2">
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border)] p-2">
              <span className={r.enabled ? "" : "opacity-50"}>
                After <strong>{r.consecutiveFailures}</strong> {r.triggerOn === "warn" ? "warn/down" : "down"} result(s) → {channelNames(r.channelIds, channels)}
                {r.renotifyMinutes ? <span className="text-[var(--muted)]"> · repeat every {r.renotifyMinutes} min</span> : null}
                {r.escalateAfterMinutes ? (
                  <span className="text-[var(--muted)]">
                    {" "}
                    · escalate after {r.escalateAfterMinutes} min → {channelNames(r.escalationChannelIds, channels)}
                  </span>
                ) : null}
              </span>
              <span className="flex gap-3 text-xs">
                <button onClick={async () => (await api.updateAlertRule(r.id, { enabled: !r.enabled }), load())} className="text-[var(--muted)] underline">
                  {r.enabled ? "Disable" : "Enable"}
                </button>
                <button onClick={async () => (await api.deleteAlertRule(r.id), load())} className="text-[var(--down)] underline">
                  Delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {channels.length === 0 ? (
        <p className="text-[var(--muted)]">
          <Link href="/channels" className="underline">
            Add a notification channel
          </Link>{" "}
          first to attach one here.
        </p>
      ) : (
        <div className="space-y-3 rounded-md border border-dashed border-[var(--border)] p-3">
          <p className="text-xs font-medium">Add an alert rule</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Label label="Results in a row" help="How many consecutive failing results before notifying. Higher = fewer false alarms, slower to notice.">
              <input type="number" min={1} value={consecutive} onChange={(e) => setConsecutive(e.target.value)} className={inputClass} />
            </Label>
            <Label label="Failing means">
              <select value={triggerOn} onChange={(e) => setTriggerOn(e.target.value as "down" | "warn")} className={inputClass}>
                <option value="down">Down only</option>
                <option value="warn">Warn or down</option>
              </select>
            </Label>
            <Label label="Remind every (min)" help="Re-send while still failing. Blank = only once.">
              <input type="number" min={1} value={renotify} onChange={(e) => setRenotify(e.target.value)} className={inputClass} />
            </Label>
            <Label label="Escalate after (min)" help="If still failing this long, also notify the escalation channels below.">
              <input type="number" min={1} value={escalateAfter} onChange={(e) => setEscalateAfter(e.target.value)} className={inputClass} />
            </Label>
          </div>
          <div>
            <span className="text-xs text-[var(--muted)]">Notify:</span>
            <div className="mt-1 flex flex-wrap gap-3">
              {channels.map((c) => (
                <label key={c.id} className="flex items-center gap-1.5">
                  <input type="checkbox" className="accent-[var(--up)]" checked={primary.includes(c.id)} onChange={() => toggle(primary, setPrimary, c.id)} />
                  {c.name}
                </label>
              ))}
            </div>
          </div>
          {escalateAfter && (
            <div>
              <span className="text-xs text-[var(--muted)]">Escalate to:</span>
              <div className="mt-1 flex flex-wrap gap-3">
                {channels.map((c) => (
                  <label key={c.id} className="flex items-center gap-1.5">
                    <input type="checkbox" className="accent-[var(--warn)]" checked={escalation.includes(c.id)} onChange={() => toggle(escalation, setEscalation, c.id)} />
                    {c.name}
                  </label>
                ))}
              </div>
            </div>
          )}
          <Button variant="primary" onClick={handleAdd} disabled={primary.length === 0}>
            Add rule
          </Button>
        </div>
      )}
    </div>
  );
}
