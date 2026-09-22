"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, type Channel, type SmtpSettings } from "../lib/api";
import { TopNav } from "../components/TopNav";
import { Tooltip } from "../components/Tooltip";
import { PageHelp } from "../components/PageHelp";
import {
  ChannelConfigFields,
  CHANNEL_TYPE_HELP,
  defaultChannelConfigFor,
  normalizeChannelConfig,
  validateChannelConfig,
} from "../components/ChannelConfigFields";

function SmtpSettingsSection() {
  const [settings, setSettings] = useState<SmtpSettings | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("");
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [from, setFrom] = useState("");
  const [testTo, setTestTo] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testStatus, setTestStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    const { settings: s } = await api.smtpSettings();
    setSettings(s);
    setHost(s.host ?? "");
    setPort(s.port != null ? String(s.port) : "");
    setUser(s.user ?? "");
    setFrom(s.from ?? "");
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaveError(null);
    setSaved(false);
    try {
      await api.updateSmtpSettings({
        host: host.trim() || null,
        port: port.trim() ? Number(port) : null,
        user: user.trim() || null,
        ...(password ? { password } : {}),
        from: from.trim() || null,
      });
      setPassword("");
      setSaved(true);
      load();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save settings");
    }
  }

  async function handleTest() {
    setTestStatus(null);
    if (!testTo.trim()) return;
    try {
      await api.sendTestEmail(testTo.trim());
      setTestStatus("Sent — check the inbox.");
    } catch (err) {
      setTestStatus(err instanceof Error ? err.message : "Failed to send");
    }
  }

  if (!settings) return null;

  return (
    <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--panel)]/40 p-4">
      <h2 className="mb-3 inline-flex items-center font-medium">
        SMTP server (for the &quot;email&quot; channel type)
        <Tooltip text="One SMTP server for the whole engine — individual email channels below just specify a recipient address, not their own server. Previously only configurable by editing engine/.env directly; that still works as a fallback if you'd rather not use this form." />
      </h2>
      <form onSubmit={handleSave} className="space-y-2 text-sm">
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[var(--muted)]">Host</span>
            <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none" />
          </label>
          <label className="block">
            <span className="text-[var(--muted)]">Port</span>
            <input type="number" value={port} onChange={(e) => setPort(e.target.value)} placeholder="587" className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none" />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[var(--muted)]">Username</span>
            <input value={user} onChange={(e) => setUser(e.target.value)} className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none" />
          </label>
          <label className="block">
            <span className="text-[var(--muted)]">
              Password {settings.passwordSet && <span className="text-[var(--muted)]">(already set — leave blank to keep it)</span>}
            </span>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none" />
          </label>
        </div>
        <label className="block">
          <span className="text-[var(--muted)]">From address</span>
          <input value={from} onChange={(e) => setFrom(e.target.value)} placeholder='Looksee <looksee@example.com>' className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none" />
        </label>
        {saveError && <p className="text-[var(--down)]">{saveError}</p>}
        {saved && <p className="text-[var(--up)]">Saved.</p>}
        <button type="submit" className="rounded-md bg-[var(--up)] px-3 py-1.5 font-medium text-black">
          Save settings
        </button>
      </form>
      <div className="mt-3 flex items-center gap-2 border-t border-[var(--border)] pt-3">
        <input
          value={testTo}
          onChange={(e) => setTestTo(e.target.value)}
          placeholder="you@example.com"
          className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-sm outline-none"
        />
        <button type="button" onClick={handleTest} className="rounded-md border border-[var(--border)] px-3 py-1 text-sm">
          Send test email
        </button>
        {testStatus && <span className="text-xs text-[var(--muted)]">{testStatus}</span>}
      </div>
    </section>
  );
}

function ChannelRow({ channel, onChanged }: { channel: Channel; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(channel.name);
  const [editingConfig, setEditingConfig] = useState(false);
  const [config, setConfig] = useState<Record<string, unknown>>(defaultChannelConfigFor(channel.type));
  const [error, setError] = useState<string | null>(null);

  async function handleRename(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await api.updateChannel(channel.id, { name: name.trim() });
    setRenaming(false);
    onChanged();
  }

  async function handleSaveConfig(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const normalized = normalizeChannelConfig(config);
    const validationError = validateChannelConfig(channel.type, normalized);
    if (validationError) {
      setError(validationError);
      return;
    }
    await api.updateChannel(channel.id, { config: normalized });
    setEditingConfig(false);
    onChanged();
  }

  async function handleDelete() {
    if (!confirm(`Delete channel "${channel.name}"? Any alert rules using it will just have one fewer channel attached.`)) return;
    await api.deleteChannel(channel.id);
    onChanged();
  }

  return (
    <li className="rounded-md border border-[var(--border)] p-2 text-sm">
      <div className="flex items-center justify-between">
        {renaming ? (
          <form onSubmit={handleRename} className="flex items-center gap-2">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none"
            />
            <button type="submit" className="text-xs text-[var(--up)]">
              Save
            </button>
            <button type="button" onClick={() => setRenaming(false)} className="text-xs text-[var(--muted)]">
              Cancel
            </button>
          </form>
        ) : (
          <span>
            <span className="font-medium">{channel.name}</span> <span className="text-[var(--muted)]">({channel.type})</span>
          </span>
        )}
        {!renaming && (
          <div className="flex items-center gap-3 text-xs">
            <button onClick={() => setRenaming(true)} className="text-[var(--muted)] hover:underline">
              Rename
            </button>
            {channel.type !== "web_push" && (
              <button onClick={() => setEditingConfig((v) => !v)} className="text-[var(--muted)] hover:underline">
                {editingConfig ? "cancel" : "update config"}
              </button>
            )}
            <button onClick={handleDelete} className="text-[var(--down)] hover:underline">
              Delete
            </button>
          </div>
        )}
      </div>
      {editingConfig && (
        <form onSubmit={handleSaveConfig} className="mt-2 space-y-2 border-t border-[var(--border)] pt-2 text-xs">
          <p className="inline-flex items-center text-[var(--muted)]">
            Config is write-only and never shown once saved — this replaces it entirely.
            <Tooltip text="Same as backup passphrases and other secrets in Looksee: once saved, the engine never sends config back to the browser, so it can't be pre-filled here. Enter the full value again." />
          </p>
          <ChannelConfigFields type={channel.type} config={config} onChange={setConfig} />
          {error && <p className="text-[var(--down)]">{error}</p>}
          <button type="submit" className="rounded-md bg-[var(--up)] px-3 py-1 font-medium text-black">
            Save config
          </button>
        </form>
      )}
    </li>
  );
}

export default function ChannelsPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState("email");
  const [config, setConfig] = useState<Record<string, unknown>>(defaultChannelConfigFor("email"));
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
    const normalized = normalizeChannelConfig(config);
    const validationError = validateChannelConfig(type, normalized);
    if (validationError) {
      setError(validationError);
      return;
    }
    try {
      await api.createChannel({ name, type, config: normalized });
      setName("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create channel");
    }
  }

  if (!authChecked) return null;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <TopNav active="/channels" />
      <PageHelp anchor="channels-and-notifications-alerts">
        Channels are where alerts get sent (currently email via SMTP). Alert rules, configured per-check on Manage, decide when a channel actually gets notified.
      </PageHelp>

      <SmtpSettingsSection />

      <h2 className="mb-4 text-lg font-medium">Notification channels</h2>

      <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--panel)]/40 p-4">
        {channels.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No channels yet — add one below, then attach it to a check's alert rule.</p>
        ) : (
          <ul className="space-y-2">
            {channels.map((c) => (
              <ChannelRow key={c.id} channel={c} onChanged={load} />
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
          <label className="block">
            <span className="inline-flex items-center text-[var(--muted)]">
              Channel type
              <Tooltip text={CHANNEL_TYPE_HELP[type]} />
            </span>
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value);
                setConfig(defaultChannelConfigFor(e.target.value));
              }}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
            >
              {Object.keys(CHANNEL_TYPE_HELP).map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <ChannelConfigFields type={type} config={config} onChange={setConfig} />
          {error && <p className="text-[var(--down)]">{error}</p>}
          <button type="submit" className="rounded-md bg-[var(--up)] px-3 py-1.5 font-medium text-black">
            Add channel
          </button>
        </form>
      </section>
    </main>
  );
}
