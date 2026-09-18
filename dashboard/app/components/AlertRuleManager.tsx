"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type AlertRule, type Channel } from "../lib/api";
import { Tooltip } from "./Tooltip";

export function AlertRuleManager({ checkId }: { checkId: string }) {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [consecutiveFailures, setConsecutiveFailures] = useState(2);
  const [selectedChannels, setSelectedChannels] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

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

  function toggleChannel(id: string) {
    setSelectedChannels((prev) => (prev.includes(id) ? prev.filter((c) => c !== id) : [...prev, id]));
  }

  async function handleAdd() {
    await api.createAlertRule({ checkId, consecutiveFailures, channelIds: selectedChannels });
    setSelectedChannels([]);
    load();
  }

  async function handleDelete(id: string) {
    await api.deleteAlertRule(id);
    load();
  }

  async function handleToggle(rule: AlertRule) {
    await api.updateAlertRule(rule.id, { enabled: !rule.enabled });
    load();
  }

  if (!loaded) return null;

  const channelName = (id: string) => channels.find((c) => c.id === id)?.name ?? "?";

  return (
    <div className="mt-2 space-y-2 border-t border-[var(--border)] pt-2 text-xs">
      {rules.length === 0 ? (
        <p className="text-[var(--muted)]">No alert rule — this check won&apos;t notify anyone.</p>
      ) : (
        rules.map((r) => (
          <div key={r.id} className="flex items-center justify-between">
            <span>
              Alert after {r.consecutiveFailures} failures →{" "}
              {r.channelIds.length ? r.channelIds.map(channelName).join(", ") : "no channel"}
            </span>
            <span className="flex gap-2">
              <button onClick={() => handleToggle(r)} className="text-[var(--muted)] hover:underline">
                {r.enabled ? "Disable" : "Enable"}
              </button>
              <button onClick={() => handleDelete(r.id)} className="text-[var(--down)] hover:underline">
                Delete
              </button>
            </span>
          </div>
        ))
      )}

      {channels.length === 0 ? (
        <p className="text-[var(--muted)]">
          <Link href="/channels" className="underline">
            Add a notification channel
          </Link>{" "}
          first to attach one here.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center">
            Alert after
            <Tooltip text="How many checks in a row must fail before this triggers a notification. Higher = fewer false alarms from a single blip, but slower to notice a real outage." />
          </span>
          <input
            type="number"
            min={1}
            value={consecutiveFailures}
            onChange={(e) => setConsecutiveFailures(Number(e.target.value))}
            className="w-12 rounded border border-[var(--border)] bg-transparent px-1"
          />
          <span>failures via:</span>
          {channels.map((c) => (
            <label key={c.id} className="flex items-center gap-1">
              <input type="checkbox" checked={selectedChannels.includes(c.id)} onChange={() => toggleChannel(c.id)} />
              {c.name}
            </label>
          ))}
          <button onClick={handleAdd} disabled={selectedChannels.length === 0} className="text-[var(--up)] disabled:opacity-40">
            + Add rule
          </button>
        </div>
      )}
    </div>
  );
}
