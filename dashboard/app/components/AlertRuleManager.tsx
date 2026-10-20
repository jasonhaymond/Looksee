// A check's alert rules: list, add, edit, enable/disable, delete.
//
// Where this sits: shown on a check's page (app/checks/[id], "Alert rules"
// tab) and in the inline check detail. A rule says when a failing check
// notifies (after N failing results in a row, on down only or warn too),
// who it notifies (channels), whether it reminds while still failing, and
// whether it escalates to more channels after a while. Rules are stored by
// the engine (engine/src/routes/alertRules.ts); a check with no rule shows
// on dashboards but notifies no one.
//
// "use client" makes this a React component that runs in the browser.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, type AlertRule, type Channel } from "../lib/api";
import { Button, Label, inputClass } from "./ui";

/** Comma-separated channel names for a list of channel IDs. */
function channelNames(ids: string[], channels: Channel[]) {
  return ids.map((id) => channels.find((c) => c.id === id)?.name ?? "?").join(", ") || "no channel";
}

/** The editable fields of a rule, as text for the form inputs. */
type RuleDraft = { consecutive: string; triggerOn: "down" | "warn"; primary: string[]; renotify: string; escalateAfter: string; escalation: string[] };

const emptyDraft = (): RuleDraft => ({ consecutive: "2", triggerOn: "down", primary: [], renotify: "", escalateAfter: "", escalation: [] });

/** A saved rule as form values, for editing. */
const draftOf = (r: AlertRule): RuleDraft => ({
  consecutive: String(r.consecutiveFailures),
  triggerOn: r.triggerOn,
  primary: r.channelIds,
  renotify: r.renotifyMinutes ? String(r.renotifyMinutes) : "",
  escalateAfter: r.escalateAfterMinutes ? String(r.escalateAfterMinutes) : "",
  escalation: r.escalationChannelIds,
});

/** Form values as the API's fields. Escalation channels only apply with a delay. */
const payloadOf = (d: RuleDraft) => ({
  consecutiveFailures: Math.max(1, Number(d.consecutive) || 2),
  triggerOn: d.triggerOn,
  channelIds: d.primary,
  renotifyMinutes: d.renotify ? Number(d.renotify) : null,
  escalateAfterMinutes: d.escalateAfter ? Number(d.escalateAfter) : null,
  escalationChannelIds: d.escalateAfter ? d.escalation : [],
});

/**
 * The rule form, used both to add a rule and to edit one.
 *
 * @param value the current form values
 * @param onChange called with new values on every edit
 * @param channels the notification channels to choose from
 */
function RuleForm({ value, onChange, channels }: { value: RuleDraft; onChange: (v: RuleDraft) => void; channels: Channel[] }) {
  const set = <K extends keyof RuleDraft>(k: K, v: RuleDraft[K]) => onChange({ ...value, [k]: v });
  // Adds or removes one channel ID from a list.
  const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Label label="Results in a row" help="How many consecutive failing results before notifying. Higher = fewer false alarms, slower to notice.">
          <input type="number" min={1} value={value.consecutive} onChange={(e) => set("consecutive", e.target.value)} className={inputClass} />
        </Label>
        <Label label="Failing means">
          <select value={value.triggerOn} onChange={(e) => set("triggerOn", e.target.value as "down" | "warn")} className={inputClass}>
            <option value="down">Down only</option>
            <option value="warn">Warn or down</option>
          </select>
        </Label>
        <Label label="Remind every (min)" help="Re-send while still failing. Blank = only once.">
          <input type="number" min={1} value={value.renotify} onChange={(e) => set("renotify", e.target.value)} className={inputClass} />
        </Label>
        <Label label="Escalate after (min)" help="If still failing this long, also notify the escalation channels below. Blank = no escalation.">
          <input type="number" min={1} value={value.escalateAfter} onChange={(e) => set("escalateAfter", e.target.value)} className={inputClass} />
        </Label>
      </div>
      <div>
        <span className="text-xs text-[var(--muted)]">Notify:</span>
        <div className="mt-1 flex flex-wrap gap-3">
          {channels.map((c) => (
            <label key={c.id} className="flex items-center gap-1.5">
              <input type="checkbox" className="accent-[var(--up)]" checked={value.primary.includes(c.id)} onChange={() => set("primary", toggle(value.primary, c.id))} />
              {c.name}
            </label>
          ))}
        </div>
      </div>
      {value.escalateAfter && (
        <div>
          <span className="text-xs text-[var(--muted)]">Escalate to:</span>
          <div className="mt-1 flex flex-wrap gap-3">
            {channels.map((c) => (
              <label key={c.id} className="flex items-center gap-1.5">
                <input type="checkbox" className="accent-[var(--warn)]" checked={value.escalation.includes(c.id)} onChange={() => set("escalation", toggle(value.escalation, c.id))} />
                {c.name}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The rules of one check, each editable, plus the form to add another.
 *
 * @param checkId the check whose rules are shown
 */
export function AlertRuleManager({ checkId }: { checkId: string }) {
  const [rules, setRules] = useState<AlertRule[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<RuleDraft>(emptyDraft());
  // The rule being edited (its ID) and its form values.
  const [editing, setEditing] = useState<{ id: string; value: RuleDraft } | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Loads the check's rules and the channels they can notify.
  const load = useCallback(
    () =>
      Promise.all([api.alertRules(checkId), api.channels()]).then(([ruleList, channelList]) => {
        setRules(ruleList);
        setChannels(channelList);
        setLoaded(true);
      }),
    [checkId]
  );

  useEffect(() => {
    load();
  }, [load]);

  async function add() {
    setError(null);
    try {
      await api.createAlertRule({ checkId, ...payloadOf(draft) });
      setDraft(emptyDraft());
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add the rule");
    }
  }

  async function saveEdit() {
    if (!editing) return;
    setError(null);
    try {
      await api.updateAlertRule(editing.id, payloadOf(editing.value));
      setEditing(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the rule");
    }
  }

  if (!loaded) return null;

  return (
    <div className="space-y-3 text-sm">
      {rules.length === 0 ? (
        <p className="text-[var(--muted)]">No alert rule — this check shows on dashboards but won&apos;t notify anyone.</p>
      ) : (
        <ul className="space-y-2">
          {rules.map((r) =>
            editing?.id === r.id ? (
              // This rule open for editing: the form, prefilled.
              <li key={r.id} className="space-y-3 rounded-md border border-[var(--border-strong)] p-3">
                <p className="text-xs font-medium">Edit alert rule</p>
                <RuleForm value={editing.value} onChange={(value) => setEditing({ id: r.id, value })} channels={channels} />
                <div className="flex gap-2">
                  <Button variant="primary" className="!py-0.5 text-xs" onClick={saveEdit} disabled={!editing.value.primary.length}>
                    Save changes
                  </Button>
                  <Button variant="ghost" className="!py-0.5 text-xs" onClick={() => setEditing(null)}>
                    Cancel
                  </Button>
                </div>
              </li>
            ) : (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border)] p-2">
                <span className={r.enabled ? "" : "opacity-50"}>
                  {!r.enabled && <span className="mr-1 text-xs font-medium">[off]</span>}
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
                  <button onClick={() => setEditing({ id: r.id, value: draftOf(r) })} className="underline">
                    Edit
                  </button>
                  <button onClick={async () => (await api.updateAlertRule(r.id, { enabled: !r.enabled }), load())} className="text-[var(--muted)] underline">
                    {r.enabled ? "Disable" : "Enable"}
                  </button>
                  <button onClick={async () => (await api.deleteAlertRule(r.id), load())} className="text-[var(--down)] underline">
                    Delete
                  </button>
                </span>
              </li>
            )
          )}
        </ul>
      )}
      {error && <p className="text-[var(--down)]">{error}</p>}

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
          <RuleForm value={draft} onChange={setDraft} channels={channels} />
          <Button variant="primary" onClick={add} disabled={draft.primary.length === 0}>
            Add rule
          </Button>
        </div>
      )}
    </div>
  );
}
