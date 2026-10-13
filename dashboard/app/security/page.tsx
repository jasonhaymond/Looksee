"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import qrcode from "qrcode-generator";
import { api, type Channel, type IpBlock, type SecurityEvent, type SecurityOverview, type SecurityRule, type SessionRow, type TrustedIp } from "../lib/api";
import { TopNav } from "../components/TopNav";
import { PageHelp } from "../components/PageHelp";
import { ActionMenu, Button, FilterChip, Label, Modal, inputClass, relativeTime, useToast } from "../components/ui";
import { Tooltip } from "../components/Tooltip";
import { usePageAuth } from "../components/usePageAuth";

const SECTIONS = [
  ["account", "Your account & 2FA"],
  ["signin", "Sign-in safeguards"],
  ["access", "IP access"],
  ["detection", "Attack detection"],
  ["events", "Security log"],
] as const;

function Card({ id, title, help, children }: { id: string; title: string; help?: string; children: React.ReactNode }) {
  return (
    <section id={id} className="surface scroll-mt-4 rounded-xl p-4">
      <h2 className="mb-3 inline-flex items-center font-medium">
        {title}
        {help && <Tooltip text={help} />}
      </h2>
      {children}
    </section>
  );
}

function Toggle({ checked, onChange, label, help }: { checked: boolean; onChange: (v: boolean) => void; label: string; help?: string }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--accent)]" />
      <span>
        {label}
        {help && <span className="block text-xs text-[var(--muted)]">{help}</span>}
      </span>
    </label>
  );
}

function CodesBox({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  return (
    <Modal title="New recovery codes" onClose={onClose}>
      <p className="mb-2 text-sm text-[var(--muted)]">Each signs you in once without your authenticator. Your old codes no longer work. This is the only time these are shown — save them in a password manager now.</p>
      <ul className="mb-3 grid grid-cols-2 gap-1 rounded-md bg-[var(--code-bg)] p-3 font-mono text-sm">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex justify-between">
        <Button onClick={() => navigator.clipboard.writeText(codes.join("\n"))}>Copy all</Button>
        <Button variant="primary" onClick={onClose}>
          I&apos;ve saved them
        </Button>
      </div>
    </Modal>
  );
}

function AccountCard({ overview, toast, reload }: { overview: SecurityOverview; toast: (m: string, k?: "info" | "error") => void; reload: () => void }) {
  const [pw, setPw] = useState({ currentPassword: "", newPassword: "", confirm: "", code: "" });
  const [codes, setCodes] = useState<string[] | null>(null);
  const [rotate, setRotate] = useState<{ challengeId: string; secret: string; uri: string } | null>(null);
  const [rotateCode, setRotateCode] = useState("");
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const loadSessions = useCallback(() => api.sessions().then(setSessions), []);
  useEffect(() => {
    loadSessions();
  }, [loadSessions]);
  const ask = (what: string) => prompt(`Enter a current 6-digit code from your authenticator app to ${what}:`)?.trim();
  return (
    <Card id="account" title="Your account & two-factor authentication" help="Two-factor authentication is required for everyone and can't be turned off here. If you lose your authenticator and recovery codes, run npm run security:reset -- --2fa on the server.">
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2 text-sm">
          <p>
            Two-factor: <strong className="text-[var(--up)]">on</strong> (required) · {overview.recoveryCodesLeft} recovery code{overview.recoveryCodesLeft === 1 ? "" : "s"} left
            {overview.recoveryCodesLeft < 3 && <span className="text-[var(--warn)]"> — make new ones</span>}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={async () => {
                const code = ask("make new recovery codes");
                if (!code) return;
                try {
                  setCodes((await api.regenerateRecoveryCodes(code)).recoveryCodes);
                  reload();
                } catch (err) {
                  toast(err instanceof Error ? err.message : "Failed", "error");
                }
              }}
            >
              New recovery codes
            </Button>
            <Button
              onClick={async () => {
                const code = ask("move to a new authenticator");
                if (!code) return;
                try {
                  setRotate(await api.rotateTotp(code));
                } catch (err) {
                  toast(err instanceof Error ? err.message : "Failed", "error");
                }
              }}
            >
              Move to a new phone / app
            </Button>
          </div>
          <p className="pt-2 text-xs text-[var(--muted)]">Password last changed: {overview.passwordChangedAt ? new Date(overview.passwordChangedAt).toLocaleDateString() : "never (set at install)"}</p>
        </div>
        <form
          className="grid grid-cols-2 gap-2 text-sm"
          onSubmit={async (e) => {
            e.preventDefault();
            if (pw.newPassword !== pw.confirm) return toast("The new passwords don't match.", "error");
            try {
              await api.changePassword({ currentPassword: pw.currentPassword, newPassword: pw.newPassword, code: pw.code });
              setPw({ currentPassword: "", newPassword: "", confirm: "", code: "" });
              toast("Password changed. Every other session was signed out.");
              loadSessions();
            } catch (err) {
              toast(err instanceof Error ? err.message : "Failed", "error");
            }
          }}
        >
          <Label label="Current password" className="col-span-2">
            <input type="password" autoComplete="current-password" required value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} className={inputClass} />
          </Label>
          <Label label={`New password (${overview.settings.minPasswordLength}+ chars)`}>
            <input type="password" autoComplete="new-password" required minLength={overview.settings.minPasswordLength} value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} className={inputClass} />
          </Label>
          <Label label="Repeat new password">
            <input type="password" autoComplete="new-password" required value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} className={inputClass} />
          </Label>
          <Label label="Authenticator code">
            <input inputMode="numeric" autoComplete="one-time-code" required value={pw.code} onChange={(e) => setPw({ ...pw, code: e.target.value })} className={inputClass} />
          </Label>
          <div className="flex items-end">
            <Button variant="primary" type="submit">
              Change password
            </Button>
          </div>
        </form>
      </div>
      <div className="mt-4">
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-sm font-medium">Signed-in sessions</h3>
          <Button className="!py-0.5 text-xs" onClick={async () => (await api.revokeSession("others"), loadSessions(), toast("Signed out every other session."))}>
            Sign out all others
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-[var(--muted)]">
              <tr>
                <th className="py-1 pr-2 font-normal">From</th>
                <th className="pr-2 font-normal">Browser</th>
                <th className="pr-2 font-normal">Signed in</th>
                <th className="pr-2 font-normal">Last active</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.id} className="border-t border-[var(--border)]">
                  <td className="py-1 pr-2 font-mono">{s.ip ?? "—"}</td>
                  <td className="max-w-xs truncate pr-2 text-[var(--muted)]" title={s.userAgent ?? ""}>
                    {s.userAgent ?? "—"}
                  </td>
                  <td className="pr-2">{new Date(s.createdAt).toLocaleString()}</td>
                  <td className="pr-2">{relativeTime(s.lastSeenAt)}</td>
                  <td className="text-right">
                    {s.current ? (
                      <span className="text-[var(--up)]">this browser</span>
                    ) : (
                      <button className="text-[var(--down)] underline" onClick={async () => (await api.revokeSession(s.id), loadSessions())}>
                        Sign out
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {codes && <CodesBox codes={codes} onClose={() => setCodes(null)} />}
      {rotate && (
        <Modal title="Move to a new authenticator" onClose={() => setRotate(null)}>
          <div className="space-y-3 text-sm">
            <p className="text-[var(--muted)]">Scan with the new app, then enter its code. Your current authenticator keeps working until you confirm.</p>
            <div className="mx-auto w-48 rounded-md bg-white p-2" dangerouslySetInnerHTML={{ __html: (() => {
              const qr = qrcode(0, "M");
              qr.addData(rotate.uri);
              qr.make();
              return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
            })() }} />
            <code className="block break-all rounded bg-[var(--code-bg)] p-2 text-xs">{rotate.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
            <input value={rotateCode} onChange={(e) => setRotateCode(e.target.value)} placeholder="Code from the new app" inputMode="numeric" className={inputClass} />
            <div className="flex justify-end">
              <Button
                variant="primary"
                onClick={async () => {
                  try {
                    await api.confirmRotateTotp(rotate.challengeId, rotateCode);
                    setRotate(null);
                    toast("Switched to the new authenticator.");
                  } catch (err) {
                    toast(err instanceof Error ? err.message : "Failed", "error");
                  }
                }}
              >
                Confirm
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </Card>
  );
}

function RuleDialog({ rule, kinds, onClose, onSaved }: { rule: SecurityRule | null; kinds: SecurityOverview["kinds"]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: rule?.name ?? "",
    kinds: rule?.kinds ?? ["login_failed"],
    threshold: String(rule?.threshold ?? 5),
    windowMinutes: String(rule?.windowMinutes ?? 10),
    perIp: rule?.perIp ?? true,
    notify: rule?.notify ?? true,
    blockMinutes: rule?.blockMinutes != null ? String(rule.blockMinutes) : "",
    cooldownMinutes: String(rule?.cooldownMinutes ?? 60),
  });
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={rule ? `Edit rule: ${rule.name}` : "New security rule"} onClose={onClose} wide>
      <form
        className="space-y-3 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          const body = { name: f.name, kinds: f.kinds, threshold: Number(f.threshold), windowMinutes: Number(f.windowMinutes), perIp: f.perIp, notify: f.notify, blockMinutes: f.blockMinutes ? Number(f.blockMinutes) : null, cooldownMinutes: Number(f.cooldownMinutes) };
          try {
            if (rule) await api.updateSecurityRule(rule.id, body);
            else await api.createSecurityRule(body);
            onSaved();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Couldn't save");
          }
        }}
      >
        <Label label="Name">
          <input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Repeated sign-in failures" className={inputClass} />
        </Label>
        <div>
          <div className="mb-1 text-xs text-[var(--muted)]">When any of these happen…</div>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {kinds.map((k) => (
              <label key={k.kind} className="flex items-start gap-2">
                <input type="checkbox" className="mt-1 accent-[var(--accent)]" checked={f.kinds.includes(k.kind)} onChange={(e) => setF({ ...f, kinds: e.target.checked ? [...f.kinds, k.kind] : f.kinds.filter((x) => x !== k.kind) })} />
                {k.label}
              </label>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Label label="…at least this many times">
            <input type="number" min={1} value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })} className={inputClass} />
          </Label>
          <Label label="within (minutes)">
            <input type="number" min={1} value={f.windowMinutes} onChange={(e) => setF({ ...f, windowMinutes: e.target.value })} className={inputClass} />
          </Label>
          <Label label="Block the IP for (min)" help="Blank = don't block. Needs a per-IP rule.">
            <input type="number" min={1} value={f.blockMinutes} onChange={(e) => setF({ ...f, blockMinutes: e.target.value })} className={inputClass} />
          </Label>
          <Label label="Quiet period (min)" help="After firing, wait this long before firing again for the same IP — stops an email per request during an attack.">
            <input type="number" min={0} value={f.cooldownMinutes} onChange={(e) => setF({ ...f, cooldownMinutes: e.target.value })} className={inputClass} />
          </Label>
        </div>
        <Toggle checked={f.perIp} onChange={(v) => setF({ ...f, perIp: v })} label="Count per IP address" help="Off = count events from everywhere together (e.g. a distributed attack)." />
        <Toggle checked={f.notify} onChange={(v) => setF({ ...f, notify: v })} label="Send a security notification" help="To the security email and channels set below." />
        {error && <p className="text-[var(--down)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            Save rule
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export default function SecurityPage() {
  const authed = usePageAuth();
  const [overview, setOverview] = useState<SecurityOverview | null>(null);
  const [draft, setDraft] = useState<SecurityOverview["settings"] | null>(null);
  const [allowText, setAllowText] = useState("");
  const [channels, setChannels] = useState<Channel[]>([]);
  const [rules, setRules] = useState<SecurityRule[]>([]);
  const [blocks, setBlocks] = useState<IpBlock[]>([]);
  const [trusted, setTrusted] = useState<TrustedIp[]>([]);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [evFilter, setEvFilter] = useState({ kind: "", severity: "", q: "", hours: 168 });
  const [editingRule, setEditingRule] = useState<SecurityRule | "new" | null>(null);
  const [newBlock, setNewBlock] = useState({ ip: "", minutes: "", reason: "" });
  const toast = useToast();

  const load = useCallback(async () => {
    const [o, ch, r, b, t] = await Promise.all([api.securityOverview(), api.channels(), api.securityRules(), api.ipBlocks(), api.trustedIps()]);
    setOverview(o);
    setDraft(o.settings);
    setAllowText(o.settings.allowlist.join("\n"));
    setChannels(ch);
    setRules(r);
    setBlocks(b);
    setTrusted(t);
  }, []);
  const loadEvents = useCallback(async () => setEvents(await api.securityEvents({ ...evFilter, kind: evFilter.kind || undefined, severity: evFilter.severity || undefined, q: evFilter.q || undefined })), [evFilter]);

  useEffect(() => {
    if (authed) load();
  }, [authed, load]);
  useEffect(() => {
    if (!authed) return;
    const t = setTimeout(loadEvents, 250);
    return () => clearTimeout(t);
  }, [authed, loadEvents]);

  const kindLabel = useMemo(() => new Map(overview?.kinds.map((k) => [k.kind, k.label]) ?? []), [overview]);

  async function save(patch: Partial<SecurityOverview["settings"]>, okMessage = "Saved.") {
    try {
      await api.updateSecuritySettings(patch);
      toast.show(okMessage);
      load();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "Couldn't save", "error");
    }
  }

  if (!authed || !overview || !draft) return null;
  const s = draft;
  const num = (k: keyof typeof s, label: string, help?: string, placeholder?: string) => (
    <Label label={label} help={help}>
      <input type="number" value={s[k] == null ? "" : String(s[k])} placeholder={placeholder} onChange={(e) => setDraft({ ...s, [k]: e.target.value === "" ? null : Number(e.target.value) })} className={inputClass} />
    </Label>
  );

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <TopNav active="/security" />
      <h2 className="mb-3 text-lg font-medium">Security</h2>
      <PageHelp anchor="security">
        How Looksee protects itself while it&apos;s reachable from the internet: required two-factor sign-in, lockouts, optional IP allowlist and new-IP email confirmation, and rules that spot attacks, email you, and block the attacker&apos;s IP. Locked out? Run <code>npm run security:reset</code> in the engine folder on the server.
      </PageHelp>
      <nav className="mb-4 flex flex-wrap gap-1.5 text-xs">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="rounded-full border border-[var(--border)] px-2.5 py-0.5 text-[var(--muted)] hover:text-[var(--text)]">
            {label}
          </a>
        ))}
      </nav>

      <div className="space-y-4">
        <AccountCard overview={overview} toast={toast.show} reload={load} />

        <Card id="signin" title="Sign-in safeguards">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {num("lockoutThreshold", "Lock out after N failures", "Wrong passwords or codes, counted per IP and per account. 0 = never lock out (not recommended).")}
            {num("lockoutMinutes", "…within / for (minutes)")}
            {num("minPasswordLength", "Minimum password length")}
            {num("sessionHours", "Stay signed in for (hours)", "720 = 30 days. Applies to new sign-ins.")}
            {num("idleTimeoutMinutes", "Sign out after idle (minutes)", "Blank = never. A dashboard left open on a wall keeps itself active.", "never")}
          </div>
          <div className="mt-3 space-y-2">
            <Toggle
              checked={s.newIpConfirmation}
              onChange={(v) => setDraft({ ...s, newIpConfirmation: v })}
              label="Email a code when signing in from a new IP address"
              help="On top of two-factor: a sign-in from an IP you haven't used before also needs a code sent to your account's email. Needs working SMTP (Channels page) — test it before turning this on."
            />
          </div>
          <div className="mt-3">
            <Button variant="primary" onClick={() => save({ lockoutThreshold: s.lockoutThreshold, lockoutMinutes: s.lockoutMinutes, minPasswordLength: s.minPasswordLength, sessionHours: s.sessionHours, idleTimeoutMinutes: s.idleTimeoutMinutes, newIpConfirmation: s.newIpConfirmation })}>
              Save sign-in settings
            </Button>
          </div>
          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-[var(--muted)]">Known sign-in IPs ({trusted.length})</summary>
            <ul className="mt-2 space-y-1 text-xs">
              {trusted.map((t) => (
                <li key={t.id} className="flex items-center gap-3">
                  <span className="font-mono">{t.ip}</span>
                  <span className="text-[var(--muted)]">first {new Date(t.firstSeenAt).toLocaleDateString()} · last {relativeTime(t.lastSeenAt)}</span>
                  <button className="text-[var(--down)] underline" onClick={async () => (await api.forgetTrustedIp(t.id), load())}>
                    Forget
                  </button>
                </li>
              ))}
            </ul>
          </details>
        </Card>

        <Card id="access" title="IP access restriction" help="Applies to the sign-in page and every admin API call. Agents, site collectors, heartbeat URLs, install scripts and public status pages keep working from anywhere unless you tick the last option. /api/health always stays open for uptime monitors.">
          <p className="mb-2 text-sm">
            Your current IP as Looksee sees it: <code className="rounded bg-[var(--code-bg)] px-1">{overview.yourIp}</code>
            {/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|::1)/.test(overview.yourIp) && <span className="text-xs text-[var(--muted)]"> (a private address — if you&apos;re coming in through a reverse proxy, check TRUST_PROXY in the engine&apos;s .env: currently {overview.trustProxy})</span>}
          </p>
          <Toggle checked={s.allowlistEnabled} onChange={(v) => setDraft({ ...s, allowlistEnabled: v })} label="Only allow these IPs and networks" />
          <textarea rows={4} value={allowText} onChange={(e) => setAllowText(e.target.value)} placeholder={"203.0.113.10\n10.0.0.0/8\n2001:db8::/48"} className={`${inputClass} mt-2 font-mono text-xs`} />
          <p className="mt-1 text-xs text-[var(--muted)]">One IP or CIDR range per line. Saving refuses a list that doesn&apos;t include your current IP.</p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <Toggle checked={s.allowlistAgents} onChange={(v) => setDraft({ ...s, allowlistAgents: v })} label="Also apply to agents, collectors and heartbeat URLs" />
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={() => save({ allowlistEnabled: s.allowlistEnabled, allowlist: allowText.split(/[\s,]+/).filter(Boolean), allowlistAgents: s.allowlistAgents })}>
              Save IP access
            </Button>
            <Button onClick={() => setAllowText((t) => [t.trim(), overview.yourIp].filter(Boolean).join("\n"))}>Add my current IP</Button>
          </div>

          <h3 className="mb-1 mt-5 text-sm font-medium">Blocked IPs</h3>
          {blocks.length === 0 ? (
            <p className="text-xs text-[var(--muted)]">None right now. Rules below block attackers automatically; you can also block by hand.</p>
          ) : (
            <table className="w-full text-xs">
              <tbody>
                {blocks.map((b) => (
                  <tr key={b.id} className="border-t border-[var(--border)]">
                    <td className="py-1 pr-2 font-mono">{b.ip}</td>
                    <td className="pr-2">{b.reason}</td>
                    <td className="pr-2 text-[var(--muted)]">{b.until ? `until ${new Date(b.until).toLocaleString()}` : "until removed"}</td>
                    <td className="text-right">
                      <button className="underline" onClick={async () => (await api.unblockIp(b.id), load())}>
                        Unblock
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <form
            className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-4"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api.blockIp({ ip: newBlock.ip, minutes: newBlock.minutes ? Number(newBlock.minutes) : null, reason: newBlock.reason || undefined });
                setNewBlock({ ip: "", minutes: "", reason: "" });
                load();
              } catch (err) {
                toast.show(err instanceof Error ? err.message : "Couldn't block", "error");
              }
            }}
          >
            <input required value={newBlock.ip} onChange={(e) => setNewBlock({ ...newBlock, ip: e.target.value })} placeholder="IP or CIDR" className={inputClass} />
            <input type="number" value={newBlock.minutes} onChange={(e) => setNewBlock({ ...newBlock, minutes: e.target.value })} placeholder="minutes (blank = forever)" className={inputClass} />
            <input value={newBlock.reason} onChange={(e) => setNewBlock({ ...newBlock, reason: e.target.value })} placeholder="reason" className={inputClass} />
            <Button type="submit">Block</Button>
          </form>
        </Card>

        <Card id="detection" title="Attack detection & security notifications">
          <div className="grid gap-3 sm:grid-cols-2">
            <Label label="Send security emails to" help="Blank = the admin account's email.">
              <input value={s.notifyEmail ?? ""} onChange={(e) => setDraft({ ...s, notifyEmail: e.target.value })} placeholder="(your sign-in email)" className={inputClass} />
            </Label>
            <div>
              <div className="mb-1 text-xs text-[var(--muted)]">Also notify these channels</div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                {channels.filter((c) => c.type !== "email").map((c) => (
                  <label key={c.id} className="flex items-center gap-1.5">
                    <input type="checkbox" className="accent-[var(--accent)]" checked={s.notifyChannelIds.includes(c.id)} onChange={(e) => setDraft({ ...s, notifyChannelIds: e.target.checked ? [...s.notifyChannelIds, c.id] : s.notifyChannelIds.filter((x) => x !== c.id) })} />
                    {c.name}
                  </label>
                ))}
                {!channels.some((c) => c.type !== "email") && <span className="text-xs text-[var(--muted)]">No push/chat channels yet.</span>}
              </div>
            </div>
          </div>
          <div className="mt-2">
            <Toggle checked={s.detectScans} onChange={(v) => setDraft({ ...s, detectScans: v })} label="Detect vulnerability scanners" help="Requests for paths that only exist on other software (/.env, /wp-login.php, /phpmyadmin…) are logged as probes." />
          </div>
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={() => save({ notifyEmail: s.notifyEmail || null, notifyChannelIds: s.notifyChannelIds, detectScans: s.detectScans })}>
              Save
            </Button>
            <Button onClick={async () => (await api.testSecurityNotification(), toast.show("Test security notification sent."))}>Send a test</Button>
          </div>

          <div className="mb-1 mt-5 flex items-center justify-between">
            <h3 className="text-sm font-medium">Rules</h3>
            <Button className="!py-0.5 text-xs" onClick={() => setEditingRule("new")}>
              + Add rule
            </Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-left text-[var(--muted)]">
                <tr>
                  <th className="py-1 pr-2 font-normal">Rule</th>
                  <th className="pr-2 font-normal">When</th>
                  <th className="pr-2 font-normal">Then</th>
                  <th className="pr-2 font-normal">Last fired</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id} className={`border-t border-[var(--border)] align-top ${r.enabled ? "" : "opacity-60"}`}>
                    <td className="py-1.5 pr-2 font-medium">
                      {r.name}
                      {!r.enabled && <span className="ml-1 font-normal text-[var(--muted)]">(off)</span>}
                    </td>
                    <td className="pr-2">
                      {r.threshold}× in {r.windowMinutes} min{r.perIp ? " from one IP" : ""}: {r.kinds.map((k) => kindLabel.get(k) ?? k).join(", ")}
                    </td>
                    <td className="pr-2">{[r.notify ? "notify" : null, r.blockMinutes ? `block ${r.blockMinutes >= 1440 ? `${Math.round(r.blockMinutes / 1440)} d` : `${r.blockMinutes} min`}` : null].filter(Boolean).join(" + ") || "log only"}</td>
                    <td className="pr-2 text-[var(--muted)]">{relativeTime(r.lastFiredAt)}</td>
                    <td className="text-right">
                      <ActionMenu
                        label="Edit"
                        actions={[
                          { key: "edit", label: "Edit…", run: () => setEditingRule(r) },
                          { key: "toggle", label: r.enabled ? "Turn off" : "Turn on", run: async () => (await api.updateSecurityRule(r.id, { enabled: !r.enabled }), load()) },
                          { key: "del", label: "Delete", danger: true, run: async () => confirm(`Delete rule "${r.name}"?`) && (await api.deleteSecurityRule(r.id), load()) },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card id="events" title="Security log">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {[24, 168, 720].map((h) => (
              <FilterChip key={h} active={evFilter.hours === h} onClick={() => setEvFilter({ ...evFilter, hours: h })}>
                {h === 24 ? "24 hours" : h === 168 ? "7 days" : "30 days"}
              </FilterChip>
            ))}
            {["", "warn", "info"].map((sv) => (
              <FilterChip key={sv || "all"} active={evFilter.severity === sv} onClick={() => setEvFilter({ ...evFilter, severity: sv })}>
                {sv ? (sv === "warn" ? "Warnings" : "Info") : "All levels"}
              </FilterChip>
            ))}
          </div>
          <div className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <select value={evFilter.kind} onChange={(e) => setEvFilter({ ...evFilter, kind: e.target.value })} className={inputClass} aria-label="Event type">
              <option value="">All event types</option>
              {overview.kinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
            </select>
            <input value={evFilter.q} onChange={(e) => setEvFilter({ ...evFilter, q: e.target.value })} placeholder="Search IP, path, browser, detail…" className={inputClass} />
          </div>
          <div className="max-h-[28rem] overflow-auto rounded border border-[var(--border)]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[var(--panel-2)] text-left text-[var(--muted)]">
                <tr>
                  <th className="px-2 py-1 font-normal">When</th>
                  <th className="px-2 py-1 font-normal">Event</th>
                  <th className="px-2 py-1 font-normal">IP</th>
                  <th className="px-2 py-1 font-normal">Detail</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-t border-[var(--border)] align-top">
                    <td className="whitespace-nowrap px-2 py-1 text-[var(--muted)]">{new Date(e.createdAt).toLocaleString()}</td>
                    <td className={`px-2 py-1 ${e.severity === "warn" ? "text-[var(--warn)]" : ""}`}>{kindLabel.get(e.kind) ?? e.kind}</td>
                    <td className="px-2 py-1 font-mono">
                      {e.ip ? (
                        <button className="underline" title="Show only this IP" onClick={() => setEvFilter({ ...evFilter, q: e.ip! })}>
                          {e.ip}
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="px-2 py-1">
                      {e.detail}
                      {e.path && <span className="block font-mono text-[var(--muted)]">{e.path}</span>}
                    </td>
                  </tr>
                ))}
                {!events.length && (
                  <tr>
                    <td colSpan={4} className="p-3 text-center text-[var(--muted)]">
                      Nothing logged with these filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      {editingRule && <RuleDialog rule={editingRule === "new" ? null : editingRule} kinds={overview.kinds} onClose={() => setEditingRule(null)} onSaved={() => (setEditingRule(null), load())} />}
      {toast.node}
    </main>
  );
}
