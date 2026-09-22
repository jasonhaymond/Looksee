"use client";

import { useState } from "react";
import { api, type Check, type Host } from "../lib/api";
import { CheckConfigFields, CHECK_TYPE_HELP, normalizeConfig, validateConfig } from "./CheckConfigFields";
import { Tooltip } from "./Tooltip";

export function EditCheckForm({
  check,
  hosts,
  siteNameById,
  onSaved,
  onCancel,
}: {
  check: Check;
  hosts: Host[];
  siteNameById?: Map<string, string>;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(check.name);
  const [config, setConfig] = useState<Record<string, unknown>>(check.config);
  const [hostId, setHostId] = useState(check.hostId ?? "");
  const [interval, setIntervalSeconds] = useState(check.intervalSeconds);
  const [enabled, setEnabled] = useState(check.enabled);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const normalized = normalizeConfig(check.type, config);
    const validationError = validateConfig(check.type, normalized);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (check.type === "agent_service" && !hostId) {
      setError("Service checks need a host to run the agent on.");
      return;
    }
    try {
      await api.updateCheck(check.id, { name, hostId: hostId || null, config: normalized, intervalSeconds: interval, enabled });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save check");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-2 space-y-2 rounded-lg border border-[var(--border)] p-3 text-sm">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
        className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none"
      />
      <p className="inline-flex items-center text-xs text-[var(--muted)]">
        Type: {check.type} <Tooltip text={CHECK_TYPE_HELP[check.type] ?? ""} /> (can't be changed — delete and recreate to switch types)
      </p>
      {(check.type === "agent_service" || hosts.length > 0) && (
        <label className="block">
          <span className="inline-flex items-center text-[var(--muted)]">
            Host{check.type === "agent_service" ? "" : " (optional)"}
            <Tooltip text="Which host this check belongs to. Service checks require the Looksee agent installed on that host." />
          </span>
          <select
            value={hostId}
            onChange={(e) => setHostId(e.target.value)}
            required={check.type === "agent_service"}
            className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
          >
            <option value="">{check.type === "agent_service" ? "Select a host…" : "None"}</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
                {siteNameById && h.siteId !== check.siteId ? ` (${siteNameById.get(h.siteId) ?? "other site"})` : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      <CheckConfigFields type={check.type} config={config} onChange={setConfig} />
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-1">
          <span className="text-[var(--muted)]">Interval</span>
          <input
            type="number"
            min={5}
            value={interval}
            onChange={(e) => setIntervalSeconds(Number(e.target.value))}
            className="w-20 rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
          />
          <span className="text-xs text-[var(--muted)]">sec</span>
        </label>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
      </div>
      {error && <p className="text-xs text-[var(--down)]">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="rounded-md bg-[var(--up)] px-3 py-1 font-medium text-black">
          Save
        </button>
        <button type="button" onClick={onCancel} className="text-[var(--muted)]">
          Cancel
        </button>
      </div>
    </form>
  );
}
