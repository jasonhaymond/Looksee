// The Groups page (/groups): every group with what it contains and its
// status, and the "New group" dialog.
//
// Where this sits: groups are the admin's own sets of locations, sites,
// endpoints and checks — "manual" (picked by hand) or "filter" (saved rules,
// evaluated live). They're stored by the engine (engine/src/routes/groups.ts)
// and appear in the navigation tree. A group's own page is app/groups/[id].
//
// "use client" makes this a React component that runs in the browser; the
// engine refuses every call without a session, and usePageAuth sends a
// signed-out visitor to the sign-in page.

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, type Group, type GroupRules, type MemberType } from "../lib/api";
import { GroupFilterEditor } from "../components/GroupFilterEditor";
import { PageHelp } from "../components/PageHelp";
import { StatusGlyph } from "../components/Sidebar";
import { Button, EmptyState, Label, Modal, inputClass } from "../components/ui";
import { usePageAuth } from "../components/usePageAuth";

/** "2 sites, 5 endpoints" — what a group directly contains, in words. */
function contents(g: Group) {
  const parts = [
    [g.counts.locations, "location"],
    [g.counts.sites, "site"],
    [g.counts.endpoints, "endpoint"],
    [g.counts.checks, "check"],
  ]
    .filter(([n]) => Number(n) > 0)
    .map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "empty";
}

/** The page: the list, plus the New group dialog. */
export default function GroupsPage() {
  const authed = usePageAuth();
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => api.groups().then(setGroups), []);
  useEffect(() => {
    if (authed) load();
  }, [authed, load]);

  if (!authed) return null;
  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-medium">Groups</h1>
        <Button variant="primary" onClick={() => setCreating(true)}>
          + New group
        </Button>
      </div>
      <PageHelp anchor="groups">
        Your own sets of locations, sites, endpoints and checks that cut across sites — &ldquo;all printers&rdquo;, &ldquo;Windows servers&rdquo;, &ldquo;customer X&rdquo;. A manual group holds what you add; a filter group holds whatever matches its rules right now. Use a group for maintenance, bulk actions and alert rules on everything in it.
      </PageHelp>
      {groups && !groups.length ? (
        <EmptyState>No groups yet.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {(groups ?? []).map((g) => (
            <li key={g.id} className="surface flex flex-wrap items-center gap-3 rounded-xl p-3 text-sm">
              <StatusGlyph status={g.status} />
              <Link href={`/groups/${g.id}`} className="font-medium hover:underline">
                {g.name}
              </Link>
              <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)]">{g.kind === "filter" ? `filter · ${g.target}s` : "manual"}</span>
              <span className="text-xs text-[var(--muted)]">
                {contents(g)} · covers {g.counts.coveredChecks} check{g.counts.coveredChecks === 1 ? "" : "s"}
                {g.problems ? <span className="text-[var(--down)]"> · {g.problems} with problems</span> : null}
              </span>
              {g.description && <span className="basis-full text-xs text-[var(--muted)]">{g.description}</span>}
            </li>
          ))}
        </ul>
      )}
      {creating && <NewGroupDialog onClose={() => setCreating(false)} />}
    </main>
  );
}

/**
 * Creates a group: a manual one (members are added afterwards from its page
 * or from "Add to group" anywhere) or a filter one (rules built here, with a
 * live preview). Opens the new group's page when saved.
 */
function NewGroupDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [kind, setKind] = useState<"manual" | "filter">("manual");
  const [target, setTarget] = useState<MemberType>("endpoint");
  const [rules, setRules] = useState<GroupRules>({ match: "all", conditions: [] });
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setError(null);
    try {
      const g = await api.createGroup({ name, description: description || null, kind, ...(kind === "filter" ? { target, rules } : {}) });
      router.push(`/groups/${g.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't create the group");
    }
  }

  return (
    <Modal title="New group" onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <Label label="Name *">
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Printers, Windows servers, Customer X" className={inputClass} />
        </Label>
        <Label label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </Label>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={kind === "manual"} onChange={() => setKind("manual")} className="accent-[var(--up)]" />
            Manual — I&apos;ll pick the members
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={kind === "filter"} onChange={() => setKind("filter")} className="accent-[var(--up)]" />
            Filter — members match rules, automatically
          </label>
        </div>
        {kind === "filter" && (
          <GroupFilterEditor
            target={target}
            rules={rules}
            onChange={(t, r) => {
              setTarget(t);
              setRules(r);
            }}
          />
        )}
        {error && <p className="text-[var(--down)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!name.trim()}>
            Create group
          </Button>
        </div>
      </div>
    </Modal>
  );
}
