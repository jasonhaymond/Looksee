// A group's page (/groups/<id>): what the group contains, everything it
// covers, and actions on all of it at once.
//
// Where this sits: opened from the navigation tree or the Groups list. A
// manual group's members are added and removed here (or with "Add to group"
// elsewhere); a filter group's rules are edited here. "Covers" means every
// check reached through the hierarchy — a site member brings all its
// endpoints' checks — and that set is what the actions apply to:
// maintenance (a window scoped to the group itself, so it follows the
// group's membership while it runs), enable/disable, run now, and adding an
// alert rule. Data: GET /api/groups/<id> and GET /api/tree.
//
// "use client" makes this a React component that runs in the browser; the
// engine refuses every call without a session, and usePageAuth sends a
// signed-out visitor to the sign-in page.

"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, type Channel, type GroupDetail, type GroupRules, type MemberType, type Site, type Endpoint, type Check, type Location, type Tree } from "../../lib/api";
import { GroupFilterEditor } from "../../components/GroupFilterEditor";
import { Breadcrumbs, ChecksTable, SummaryLine, type CheckRow } from "../../components/NodeViews";
import { StatusGlyph } from "../../components/Sidebar";
import { AlertOptions, Button, ConfirmDialog, Label, Modal, MultiPicker, PromptDialog, alertRulePayload, emptyAlertOptions, inputClass, useToast, type AlertOptionsValue, type PickItem } from "../../components/ui";
import { usePageAuth } from "../../components/usePageAuth";

/** The page. */
export default function GroupPage() {
  const authed = usePageAuth();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<GroupDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [tree, setTree] = useState<Tree | null>(null);
  // Which dialog is open, if any.
  const [dialog, setDialog] = useState<null | "rename" | "delete" | "maintenance" | "alert" | "add">(null);
  // Unsaved edits to a filter group's rules.
  const [draft, setDraft] = useState<{ target: MemberType; rules: GroupRules } | null>(null);
  const toast = useToast();

  // Loads the group and the tree (for the covered checks' names and statuses).
  const load = useCallback(async () => {
    try {
      const [d, t] = await Promise.all([api.group(id), api.tree()]);
      setDetail(d);
      setTree(t);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setMissing(true);
    }
  }, [id]);
  useEffect(() => {
    if (authed) load();
  }, [authed, load]);

  // Every check the group covers, with where it lives, from the tree.
  const covered: CheckRow[] = useMemo(() => {
    if (!detail || !tree) return [];
    const ids = new Set(detail.coveredCheckIds);
    const out: CheckRow[] = [];
    for (const s of [...tree.locations.flatMap((l) => l.sites), ...tree.unassignedSites]) {
      for (const e of s.endpoints) for (const c of e.children) if (ids.has(c.id)) out.push({ ...c, endpoint: e.name, site: s.name });
      for (const c of s.checks) if (ids.has(c.id)) out.push({ ...c, endpoint: null, site: s.name });
    }
    return out;
  }, [detail, tree]);

  if (!authed) return null;
  if (missing) return <main className="mx-auto max-w-5xl p-4 sm:p-6 text-[var(--muted)]">This group doesn&apos;t exist (it may have been deleted).</main>;
  if (!detail) return null;
  const g = detail.group;
  const checkIds = detail.coveredCheckIds;

  /** Runs one bulk action on every covered check and reports the result. */
  async function bulk(action: string, params: Record<string, unknown>, verb: string) {
    try {
      const r = await api.bulkChecks(checkIds, action, params);
      toast.show(`${verb} ${r.affected} check${r.affected === 1 ? "" : "s"}.${r.errors.length ? ` ${r.errors.length} failed.` : ""}`, r.errors.length ? "error" : "info");
      load();
    } catch (err) {
      toast.show(err instanceof Error ? err.message : "Failed", "error");
    }
  }

  /** Removes one direct member (manual groups). */
  async function removeMember(type: MemberType, memberId: string) {
    await api.groupMembers(g.id, { remove: [{ type, id: memberId }] });
    load();
  }

  const m = detail.members;
  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <div>
        <Breadcrumbs trail={[{ label: "Groups", href: "/groups" }, { label: g.name }]} />
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold">{g.name}</h1>
          <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)]">{g.kind === "filter" ? `filter · selects ${g.target}s` : "manual"}</span>
          <span className="flex-1" />
          <Button className="!py-0.5 text-xs" onClick={() => setDialog("rename")}>
            Rename…
          </Button>
          <Button variant="danger" className="!py-0.5 text-xs" onClick={() => setDialog("delete")}>
            Delete group
          </Button>
        </div>
        {g.description && <p className="text-sm text-[var(--muted)]">{g.description}</p>}
        <SummaryLine status={detail.status} problems={detail.problems} checkCount={checkIds.length} />
      </div>

      {/* Actions on everything the group covers. */}
      <section className="surface flex flex-wrap items-center gap-2 rounded-xl p-3 text-sm">
        <span className="text-[var(--muted)]">For all {checkIds.length} covered checks:</span>
        <Button className="!py-0.5 text-xs" disabled={!checkIds.length} onClick={() => setDialog("maintenance")}>
          Maintenance…
        </Button>
        <Button className="!py-0.5 text-xs" disabled={!checkIds.length} onClick={() => setDialog("alert")}>
          Add alert rule…
        </Button>
        <Button className="!py-0.5 text-xs" disabled={!checkIds.length} onClick={() => bulk("run_now", {}, "Ran")}>
          Run now
        </Button>
        <Button className="!py-0.5 text-xs" disabled={!checkIds.length} onClick={() => bulk("enable", {}, "Enabled")}>
          Enable
        </Button>
        <Button className="!py-0.5 text-xs" disabled={!checkIds.length} onClick={() => bulk("disable", {}, "Disabled")}>
          Disable
        </Button>
      </section>

      {/* Filter groups: the rules. */}
      {g.kind === "filter" && g.target && (
        <section className="surface rounded-xl p-4">
          <h2 className="mb-2 text-sm font-medium">Rules</h2>
          <GroupFilterEditor target={draft?.target ?? g.target} rules={draft?.rules ?? g.rules} onChange={(target, rules) => setDraft({ target, rules })} />
          {draft && (
            <div className="mt-2 flex gap-2">
              <Button
                variant="primary"
                className="!py-0.5 text-xs"
                onClick={async () => {
                  try {
                    await api.updateGroup(g.id, draft);
                    setDraft(null);
                    toast.show("Rules saved.");
                    load();
                  } catch (err) {
                    toast.show(err instanceof Error ? err.message : "Couldn't save", "error");
                  }
                }}
              >
                Save rules
              </Button>
              <Button variant="ghost" className="!py-0.5 text-xs" onClick={() => setDraft(null)}>
                Discard changes
              </Button>
            </div>
          )}
        </section>
      )}

      {/* Direct members. */}
      <section className="surface rounded-xl p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">{g.kind === "filter" ? "Matching now" : "Members"}</h2>
          {g.kind === "manual" && (
            <Button className="!py-0.5 text-xs" onClick={() => setDialog("add")}>
              + Add members…
            </Button>
          )}
        </div>
        {!m.locations.length && !m.sites.length && !m.endpoints.length && !m.checks.length ? (
          <p className="text-sm text-[var(--muted)]">{g.kind === "filter" ? "Nothing matches the rules right now." : "Empty — add members here, or use “Add to group” on any location, site, endpoint or check page."}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {(
              [
                ...m.locations.map((x) => ({ type: "location" as const, id: x.id, name: x.name, href: `/locations/${x.id}`, status: null, sub: "location" })),
                ...m.sites.map((x) => ({ type: "site" as const, id: x.id, name: x.name, href: `/sites/${x.id}`, status: x.status, sub: "site" })),
                ...m.endpoints.map((x) => ({ type: "endpoint" as const, id: x.id, name: x.name, href: `/endpoints/${x.id}`, status: x.status, sub: ["endpoint", x.site, x.os].filter(Boolean).join(" · ") })),
                ...m.checks.map((x) => ({ type: "check" as const, id: x.id, name: x.name, href: `/checks/${x.id}`, status: x.enabled ? x.status : "disabled", sub: ["check", x.endpoint ?? x.site].filter(Boolean).join(" · ") })),
              ]
            ).map((x) => (
              <li key={`${x.type}:${x.id}`} className="flex items-center gap-2">
                <StatusGlyph status={x.status} />
                <Link href={x.href} className="hover:underline">
                  {x.name}
                </Link>
                <span className="text-xs text-[var(--muted)]">{x.sub}</span>
                {g.kind === "manual" && (
                  <button onClick={() => removeMember(x.type, x.id)} aria-label={`Remove ${x.name} from the group`} className="ml-auto text-xs text-[var(--muted)] hover:text-[var(--down)]">
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="surface rounded-xl p-4">
        <h2 className="mb-2 text-sm font-medium">All covered checks ({covered.length})</h2>
        <ChecksTable checks={covered} showWhere empty="This group doesn't cover any checks yet." />
      </section>

      {dialog === "rename" && (
        <PromptDialog
          title="Rename group"
          label="Name"
          initial={g.name}
          actionLabel="Save"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await api.updateGroup(g.id, { name });
            setDialog(null);
            load();
          }}
        />
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          title={`Delete "${g.name}"?`}
          message="The group is removed. Its members (locations, sites, endpoints, checks) are not touched. Maintenance windows aimed at this group stop applying."
          confirmWord="delete"
          actionLabel="Delete group"
          onClose={() => setDialog(null)}
          onConfirm={async () => {
            await api.deleteGroup(g.id);
            router.push("/groups");
          }}
        />
      )}
      {dialog === "maintenance" && (
        <PromptDialog
          title={`Maintenance for "${g.name}"`}
          label="For how many minutes?"
          type="number"
          initial="60"
          help="Covers whatever is in the group while the window runs. Results are still recorded; alerts are held and SLA reports skip this time."
          actionLabel="Start maintenance"
          onClose={() => setDialog(null)}
          onSubmit={async (v) => {
            const minutes = Math.max(1, Number(v) || 60);
            const now = new Date();
            await api.createMaintenance({ name: `Maintenance: ${g.name}`, scope: "group", targetIds: [g.id], startsAt: now.toISOString(), endsAt: new Date(now.getTime() + minutes * 60_000).toISOString() });
            setDialog(null);
            toast.show(`${g.name} is in maintenance for ${minutes} minutes.`);
            load();
          }}
        />
      )}
      {dialog === "alert" && <AlertRuleDialog count={checkIds.length} onClose={() => setDialog(null)} onSubmit={(p) => (setDialog(null), bulk("add_alert_rule", p, "Added an alert rule to"))} />}
      {dialog === "add" && <AddMembersDialog groupId={g.id} onClose={() => setDialog(null)} onDone={() => (setDialog(null), load())} />}
      {toast.node}
    </main>
  );
}

/** Chooses channels and options for an alert rule added to every covered check. */
function AlertRuleDialog({ count, onClose, onSubmit }: { count: number; onClose: () => void; onSubmit: (p: Record<string, unknown>) => void }) {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [value, setValue] = useState<AlertOptionsValue>(emptyAlertOptions());
  useEffect(() => {
    api.channels().then(setChannels);
  }, []);
  return (
    <Modal title={`Add an alert rule to ${count} checks`} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <AlertOptions channels={channels} value={value} onChange={setValue} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!value.channelIds.length} onClick={() => {
              // Null only when no channel is chosen, which the button prevents.
              const payload = alertRulePayload(value);
              if (payload) onSubmit(payload);
            }}>
            Add alert rule
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Picks locations, sites, endpoints and checks to add to a manual group,
 * searching across all of them.
 */
function AddMembersDialog({ groupId, onClose, onDone }: { groupId: string; onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<MemberType>("endpoint");
  const [data, setData] = useState<{ locations: Location[]; sites: Site[]; endpoints: Endpoint[]; checks: Check[] } | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.locations(), api.sites(), api.endpoints(), api.checks()]).then(([locations, sites, endpoints, checks]) => setData({ locations, sites, endpoints, checks }));
  }, []);

  // The picker's items for the chosen kind, grouped by site where that helps.
  const items: PickItem[] = useMemo(() => {
    if (!data) return [];
    const siteName = new Map(data.sites.map((s) => [s.id, s.name]));
    if (kind === "location") return data.locations.map((l) => ({ id: l.id, label: l.name }));
    if (kind === "site") return data.sites.map((s) => ({ id: s.id, label: s.name, sub: s.description ?? undefined }));
    if (kind === "endpoint") return data.endpoints.map((e) => ({ id: e.id, label: e.name, sub: [e.hostname, e.os].filter(Boolean).join(" · ") || undefined, group: siteName.get(e.siteId) }));
    const epName = new Map(data.endpoints.map((e) => [e.id, e.name]));
    return data.checks.map((c) => ({ id: c.id, label: c.name, sub: c.endpointId ? epName.get(c.endpointId) : undefined, group: siteName.get(c.siteId) }));
  }, [data, kind]);

  async function save() {
    setError(null);
    try {
      await api.groupMembers(groupId, { add: picked.map((id) => ({ type: kind, id })) });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add");
    }
  }

  return (
    <Modal title="Add members" onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <Label label="Add">
          <select
            value={kind}
            onChange={(e) => {
              // Switching kind clears the selection from the previous list.
              setKind(e.target.value as MemberType);
              setPicked([]);
            }}
            className={inputClass}
          >
            <option value="endpoint">Endpoints</option>
            <option value="site">Sites</option>
            <option value="location">Locations</option>
            <option value="check">Checks</option>
          </select>
        </Label>
        <MultiPicker items={items} selected={picked} onChange={setPicked} placeholder="Search…" groupLabel="Site" height="max-h-72" />
        {error && <p className="text-[var(--down)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!picked.length} onClick={save}>
            Add {picked.length || ""}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
