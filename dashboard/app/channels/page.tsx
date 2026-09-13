"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, type Channel } from "../lib/api";
import { TopNav } from "../components/TopNav";

const CONFIG_HINTS: Record<string, { placeholder: string; help: string }> = {
  email: { placeholder: '{"to": "you@example.com"}', help: "Sent via the engine's configured SMTP_* settings." },
  webhook: {
    placeholder: '{"url": "https://discord.com/api/webhooks/..."}',
    help: 'Generic POST — works for Discord/Slack/ntfy/Telegram-shaped webhook URLs. Optional "bodyTemplate" with {{message}}.',
  },
  web_push: { placeholder: "{}", help: "No config needed — delivers to every browser subscribed via the dashboard's \"Enable push notifications\"." },
  sms: { placeholder: '{"to": "+15555550100"}', help: "Not yet wired to a provider (see spec.md deferred items) — saving this channel is a no-op until one is." },
};

export default function ChannelsPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState("email");
  const [config, setConfig] = useState(CONFIG_HINTS.email.placeholder);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setChannels(await api.channels());
  }, []);

  useEffect(() => {
    api
      .me()
      .then(() => setAuthChecked(true))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.push("/login");
      });
  }, [router]);

  useEffect(() => {
    if (authChecked) load();
  }, [authChecked, load]);

  async function handleCreate(e: React.FormEvent) {
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
      await api.createChannel({ name, type, config: parsedConfig });
      setName("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create channel");
    }
  }

  async function handleDelete(id: string) {
    await api.deleteChannel(id);
    load();
  }

  if (!authChecked) return null;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <TopNav active="/channels" />
      <h2 className="mb-4 text-lg font-medium">Notification channels</h2>

      <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--panel)]/40 p-4">
        {channels.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No channels yet — add one below, then attach it to a check's alert rule.</p>
        ) : (
          <ul className="space-y-2">
            {channels.map((c) => (
              <li key={c.id} className="flex items-center justify-between rounded-md border border-[var(--border)] p-2 text-sm">
                <span>
                  <span className="font-medium">{c.name}</span> <span className="text-[var(--muted)]">({c.type})</span>
                </span>
                <button onClick={() => handleDelete(c.id)} className="text-xs text-[var(--down)] hover:underline">
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--panel)]/40 p-4">
        <h2 className="mb-3 font-medium">Add a channel</h2>
        <form onSubmit={handleCreate} className="space-y-2 text-sm">
          <input
            placeholder="Name (e.g. My phone)"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none"
          />
          <select
            value={type}
            onChange={(e) => {
              setType(e.target.value);
              setConfig(CONFIG_HINTS[e.target.value].placeholder);
            }}
            className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
          >
            {Object.keys(CONFIG_HINTS).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <p className="text-xs text-[var(--muted)]">{CONFIG_HINTS[type].help}</p>
          <textarea
            value={config}
            onChange={(e) => setConfig(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 font-mono text-xs outline-none"
          />
          {error && <p className="text-[var(--down)]">{error}</p>}
          <button type="submit" className="rounded-md bg-[var(--up)] px-3 py-1.5 font-medium text-black">
            Add channel
          </button>
        </form>
      </section>
    </main>
  );
}
