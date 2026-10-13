"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type Channel, type ChannelTemplate, type SmtpSettings, type TemplateInfo } from "../lib/api";
import { TopNav } from "../components/TopNav";
import { Tooltip } from "../components/Tooltip";
import { PageHelp } from "../components/PageHelp";
import { ActionMenu, Button, FilterChip, Label, Modal, inputClass, useToast } from "../components/ui";
import { usePageAuth } from "../components/usePageAuth";
import {
  ChannelConfigFields,
  CHANNEL_TYPE_HELP,
  CHANNEL_TYPE_LABEL,
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
    <details className="surface mb-6 rounded-xl p-4">
      <summary className="mb-3 inline-flex cursor-pointer items-center font-medium">
        SMTP server
        {settings.host ? <span className="ml-2 text-xs font-normal text-[var(--muted)]">{settings.host}</span> : <span className="ml-2 text-xs font-normal text-[var(--warn)]">not set: email alerts and sign-in codes need it</span>}
        <Tooltip text="One SMTP server for the whole engine — individual email channels below just specify a recipient address, not their own server. Previously only configurable by editing engine/.env directly; that still works as a fallback if you'd rather not use this form." />
      </summary>
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
        <button type="submit" className="rounded-md bg-[var(--accent)] px-3 py-1.5 font-medium text-[var(--on-accent)]">
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
    </details>
  );
}


function TemplateEditor({ channel, onClose, onSaved }: { channel: Channel; onClose: () => void; onSaved: () => void }) {
  const [info, setInfo] = useState<TemplateInfo | null>(null);
  const [templates, setTemplates] = useState<Record<string, ChannelTemplate>>(channel.templates ?? {});
  const [event, setEvent] = useState("triggered");
  const [preview, setPreview] = useState<Record<string, { title: string; body: string }> | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.channelTemplates().then(setInfo);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => api.previewTemplates(templates).then(setPreview).catch(() => undefined), 300);
    return () => clearTimeout(t);
  }, [templates]);
  if (!info) return null;
  const cur = templates[event] ?? {};
  const def = info.defaults[event];
  const set = (k: "title" | "body", v: string) => setTemplates((t) => ({ ...t, [event]: { ...t[event], [k]: v } }));
  return (
    <Modal title={`Message templates — ${channel.name}`} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-[var(--muted)]">Blank fields use the default (shown greyed). Insert variables with {"{{name}}"}; empty ones disappear cleanly.</p>
        <div className="flex flex-wrap gap-1">
          {info.events.map((ev) => (
            <FilterChip key={ev} active={event === ev} onClick={() => setEvent(ev)}>
              {ev}
              {templates[ev]?.title || templates[ev]?.body ? " •" : ""}
            </FilterChip>
          ))}
        </div>
        <div className="grid gap-3 md:grid-cols-[1fr_200px]">
          <div className="space-y-2">
            <Label label={channel.type === "email" ? "Subject" : "Title"}>
              <input value={cur.title ?? ""} onChange={(e) => set("title", e.target.value)} placeholder={def.title} className={inputClass} />
            </Label>
            <Label label="Message">
              <textarea rows={8} value={cur.body ?? ""} onChange={(e) => set("body", e.target.value)} placeholder={def.body} className={`${inputClass} font-mono text-xs`} />
            </Label>
          </div>
          <div>
            <div className="mb-1 text-xs text-[var(--muted)]">Variables (click to add)</div>
            <ul className="max-h-64 space-y-1 overflow-y-auto text-xs">
              {info.variables.map((v) => (
                <li key={v.name}>
                  <button type="button" className="font-mono underline" onClick={() => set("body", `${cur.body ?? def.body}{{${v.name}}}`)}>
                    {`{{${v.name}}}`}
                  </button>{" "}
                  <span className="text-[var(--muted)]">{v.help}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
        {preview?.[event] && (
          <div className="rounded-md border border-[var(--border)] bg-[var(--code-bg)] p-3">
            <div className="mb-1 text-xs text-[var(--muted)]">Preview with sample data</div>
            <div className="font-medium">{preview[event].title}</div>
            <pre className="mt-1 whitespace-pre-wrap font-sans text-xs">{preview[event].body}</pre>
          </div>
        )}
        <div className="flex justify-between gap-2">
          <Button variant="ghost" onClick={() => setTemplates((t) => ({ ...t, [event]: {} }))}>
            Reset this event to default
          </Button>
          <span className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await api.updateChannel(channel.id, { templates });
                onSaved();
                onClose();
              }}
            >
              Save templates
            </Button>
          </span>
        </div>
      </div>
    </Modal>
  );
}

function ChannelRow({ channel, onChanged, toast }: { channel: Channel; onChanged: () => void; toast: (m: string, k?: "info" | "error") => void }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(channel.name);
  const [editingConfig, setEditingConfig] = useState(false);
  const [editingTemplates, setEditingTemplates] = useState(false);
  const [config, setConfig] = useState<Record<string, unknown>>(defaultChannelConfigFor(channel.type));
  const [error, setError] = useState<string | null>(null);
  const custom = Object.values(channel.templates ?? {}).some((t) => t.title || t.body);

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

  return (
    <li className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {renaming ? (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!name.trim()) return;
              await api.updateChannel(channel.id, { name: name.trim() });
              setRenaming(false);
              onChanged();
            }}
            className="flex items-center gap-2"
          >
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
            <Button type="submit" className="!py-1 text-xs">
              Save
            </Button>
          </form>
        ) : (
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{channel.name}</span>
            <span className="rounded bg-[var(--border)]/50 px-1.5 py-0.5 text-xs">{CHANNEL_TYPE_LABEL[channel.type] ?? channel.type}</span>
            {custom && <span className="text-xs text-[var(--muted)]">custom templates</span>}
            {!channel.enabled && <span className="text-xs text-[var(--warn)]">disabled</span>}
          </span>
        )}
        <ActionMenu
          label="Manage"
          actions={[
            {
              key: "test",
              label: "Send a test alert",
              run: async () => {
                try {
                  await api.testChannel(channel.id);
                  toast(`Test sent through “${channel.name}”.`);
                } catch (err) {
                  toast(err instanceof Error ? err.message : "Test failed", "error");
                }
              },
            },
            { key: "tpl", label: "Edit message templates…", run: () => setEditingTemplates(true) },
            ...(channel.type !== "web_push" ? [{ key: "cfg", label: "Replace settings…", run: () => setEditingConfig(true) }] : []),
            { key: "rename", label: "Rename", run: () => setRenaming(true) },
            { key: "toggle", label: channel.enabled ? "Disable" : "Enable", run: async () => (await api.updateChannel(channel.id, { enabled: !channel.enabled }), onChanged()) },
            {
              key: "delete",
              label: "Delete…",
              danger: true,
              run: async () => {
                if (!confirm(`Delete channel "${channel.name}"? Any alert rules using it will just have one fewer channel attached.`)) return;
                await api.deleteChannel(channel.id);
                onChanged();
              },
            },
          ]}
        />
      </div>
      {editingConfig && (
        <form onSubmit={handleSaveConfig} className="mt-3 space-y-2 border-t border-[var(--border)] pt-3 text-xs">
          <p className="inline-flex items-center text-[var(--muted)]">
            Settings are write-only and never shown once saved — this replaces them entirely.
            <Tooltip text="Webhook URLs and bot tokens are secrets: once saved, the engine never sends them back to the browser, so they can't be pre-filled here. Enter the full value again." />
          </p>
          <ChannelConfigFields type={channel.type} config={config} onChange={setConfig} />
          {error && <p className="text-[var(--down)]">{error}</p>}
          <div className="flex gap-2">
            <Button variant="primary" type="submit">
              Save settings
            </Button>
            <Button variant="ghost" onClick={() => setEditingConfig(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {editingTemplates && <TemplateEditor channel={channel} onClose={() => setEditingTemplates(false)} onSaved={onChanged} />}
    </li>
  );
}

export default function ChannelsPage() {
  const authed = usePageAuth();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState("email");
  const [config, setConfig] = useState<Record<string, unknown>>(defaultChannelConfigFor("email"));
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    setChannels(await api.channels());
  }, []);

  useEffect(() => {
    if (authed) load();
  }, [authed, load]);

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
      toast.show(`Added “${name}”. Use Manage → Send a test alert to try it.`);
      setName("");
      setConfig(defaultChannelConfigFor(type));
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create channel");
    }
  }

  if (!authed) return null;

  return (
    <main className="mx-auto max-w-4xl p-4 sm:p-6">
      <TopNav active="/channels" />
      <h2 className="mb-3 text-lg font-medium">Notification channels</h2>
      <PageHelp anchor="channels">Channels are where alerts go: email, Slack, Teams, Telegram, push, or any webhook. A check&apos;s alert rules decide when; each channel&apos;s templates decide what the message says.</PageHelp>

      <SmtpSettingsSection />

      <section className="mb-6">
        {channels.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No channels yet — add one below, then pick it when adding an alert rule.</p>
        ) : (
          <ul className="space-y-2">
            {channels.map((c) => (
              <ChannelRow key={c.id} channel={c} onChanged={load} toast={toast.show} />
            ))}
          </ul>
        )}
      </section>

      <section className="surface rounded-xl p-4">
        <h2 className="mb-3 font-medium">Add a channel</h2>
        <form onSubmit={handleCreate} className="space-y-3 text-sm">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Label label="Name">
              <input placeholder="e.g. Ops Slack, My phone" required value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
            </Label>
            <Label label="Type" help={CHANNEL_TYPE_HELP[type]}>
              <select
                value={type}
                onChange={(e) => {
                  setType(e.target.value);
                  setConfig(defaultChannelConfigFor(e.target.value));
                }}
                className={inputClass}
              >
                {Object.entries(CHANNEL_TYPE_LABEL).map(([t, label]) => (
                  <option key={t} value={t}>
                    {label}
                  </option>
                ))}
              </select>
            </Label>
          </div>
          <ChannelConfigFields type={type} config={config} onChange={setConfig} />
          {error && <p className="text-[var(--down)]">{error}</p>}
          <Button variant="primary" type="submit">
            Add channel
          </Button>
        </form>
      </section>
      {toast.node}
    </main>
  );
}
