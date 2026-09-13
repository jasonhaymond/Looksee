"use client";

import { useState } from "react";
import { api } from "../lib/api";

const TYPE_HINTS: Record<string, string> = {
  ping: '{"host": "8.8.8.8"}',
  tcp: '{"host": "10.1.30.10", "port": 5432}',
  http: '{"url": "https://example.com", "expectedStatus": 200}',
  dns: '{"hostname": "pi.hole"}',
  ssl_cert: '{"host": "example.com", "port": 443, "warnDays": 14}',
  agent_service: '{"serviceName": "nginx"}',
};

export function AddCheckForm({ siteId, onCreated }: { siteId: string; onCreated: () => void }) {
  const [name, setName] = useState("");
  const [type, setType] = useState("ping");
  const [config, setConfig] = useState(TYPE_HINTS.ping);
  const [interval, setIntervalSeconds] = useState(60);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    let parsedConfig: Record<string, unknown>;
    try {
      parsedConfig = JSON.parse(config);
    } catch {
      setError("Config must be valid JSON");
      return;
    }
    try {
      await api.createCheck({ siteId, name, type, config: parsedConfig, intervalSeconds: interval });
      setName("");
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
    <form onSubmit={handleSubmit} className="mt-2 space-y-2 rounded-lg border border-[var(--border)] p-3">
      <input
        placeholder="Name"
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-sm outline-none"
      />
      <select
        value={type}
        onChange={(e) => {
          setType(e.target.value);
          setConfig(TYPE_HINTS[e.target.value]);
        }}
        className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-sm"
      >
        {Object.keys(TYPE_HINTS).map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <textarea
        value={config}
        onChange={(e) => setConfig(e.target.value)}
        rows={2}
        className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 font-mono text-xs outline-none"
      />
      <input
        type="number"
        min={5}
        value={interval}
        onChange={(e) => setIntervalSeconds(Number(e.target.value))}
        className="w-24 rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-sm"
      />
      <span className="ml-1 text-xs text-[var(--muted)]">seconds</span>
      {error && <p className="text-xs text-[var(--down)]">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="rounded-md bg-[var(--up)] px-3 py-1 text-sm font-medium text-black">
          Create
        </button>
        <button type="button" onClick={() => setOpen(false)} className="text-sm text-[var(--muted)]">
          Cancel
        </button>
      </div>
    </form>
  );
}
