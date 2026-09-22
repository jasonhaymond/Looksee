"use client";

import { useState } from "react";
import { api, type Host } from "../lib/api";
import { CheckConfigFields, CHECK_TYPE_LABELS, CHECK_TYPE_HELP, defaultConfigFor, normalizeConfig, validateConfig } from "./CheckConfigFields";
import { Tooltip } from "./Tooltip";

const AGENT_TYPES = new Set(["agent_service", "agent_process"]);

export function AddCheckForm({
  siteId,
  hosts,
  siteNameById,
  onCreated,
}: {
  siteId: string;
  hosts: Host[];
  siteNameById?: Map<string, string>;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState("ping");
  const [config, setConfig] = useState<Record<string, unknown>>(defaultConfigFor("ping"));
  const [hostId, setHostId] = useState("");
  const [interval, setIntervalSeconds] = useState(60);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const selectedHost = hosts.find((h) => h.id === hostId);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const normalized = normalizeConfig(type, config);
    const validationError = validateConfig(type, normalized);
    if (validationError) {
      setError(validationError);
      return;
    }
    if (AGENT_TYPES.has(type) && !hostId) {
      setError("This check type needs a host to run the agent on.");
      return;
    }
    try {
      await api.createCheck({ siteId, hostId: hostId || null, name, type, config: normalized, intervalSeconds: interval });
      setName("");
      setType("ping");
      setConfig(defaultConfigFor("ping"));
      setHostId("");
      setOpen(false);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create check");
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-sm text-[var(--muted)] hover:text-[var(--text)]">
        + Add check
      </button>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="mt-2 space-y-2 rounded-lg border border-[var(--border)] p-3 text-sm">
      <input
        placeholder="Name"
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none"
      />
      <label className="block">
        <span className="inline-flex items-center text-[var(--muted)]">
          Check type
          <Tooltip text={CHECK_TYPE_HELP[type]} />
        </span>
        <select
          value={type}
          onChange={(e) => {
            setType(e.target.value);
            setConfig(defaultConfigFor(e.target.value));
          }}
          className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
        >
          {Object.entries(CHECK_TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {(AGENT_TYPES.has(type) || hosts.length > 0) && (
        <label className="block">
          <span className="inline-flex items-center text-[var(--muted)]">
            Host{AGENT_TYPES.has(type) ? "" : " (optional)"}
            <Tooltip text="Which host this check belongs to. Service/process checks require the Looksee agent installed on that host — see the Hosts page to generate an install command." />
          </span>
          <select
            value={hostId}
            onChange={(e) => setHostId(e.target.value)}
            required={AGENT_TYPES.has(type)}
            className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
          >
            <option value="">{AGENT_TYPES.has(type) ? "Select a host…" : "None"}</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
                {siteNameById && h.siteId !== siteId ? ` (${siteNameById.get(h.siteId) ?? "other site"})` : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      <CheckConfigFields
        type={type}
        config={config}
        onChange={setConfig}
        suggestions={type === "agent_process" ? selectedHost?.availableProcesses ?? undefined : type === "agent_service" ? selectedHost?.availableServices ?? undefined : undefined}
      />
      <label className="block w-32">
        <span className="inline-flex items-center text-[var(--muted)]">
          Interval
          <Tooltip text="How often the engine runs this check, in seconds. Lower = more responsive, more load." />
        </span>
        <div className="mt-1 flex items-center gap-1">
          <input
            type="number"
            min={5}
            value={interval}
            onChange={(e) => setIntervalSeconds(Number(e.target.value))}
            className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
          />
          <span className="text-xs text-[var(--muted)]">sec</span>
        </div>
      </label>
      {error && <p className="text-xs text-[var(--down)]">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="rounded-md bg-[var(--up)] px-3 py-1 font-medium text-black">
          Create
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-[var(--muted)]">
          Cancel
        </button>
      </div>
    </form>
  );
}
