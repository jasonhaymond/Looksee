// Shared pieces of the location, site, endpoint and group pages (the pages
// the navigation tree opens): breadcrumbs, a summary line, a table of checks,
// the "Groups" chips with "Add to group", and the dialog behind it.
//
// Where this sits: app/locations/[id], app/sites/[id], app/endpoints/[id]
// and app/groups/[id] import these. Data comes from the API client
// (lib/api.ts); nothing here talks to the engine except AddToGroupDialog and
// GroupChips, which read and change group membership.
//
// "use client" makes these React components that run in the browser.

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Group, type MemberType, type Status, type TreeCheck } from "../lib/api";
import { typeLabel } from "../lib/checkTypes";
import { StatusGlyph } from "./Sidebar";
import { Button, Label, Modal, inputClass, useToast } from "./ui";

/** One step of a breadcrumb trail: a label and, except for the last, a link. */
export type Crumb = { label: string; href?: string };

/** "Location › Site › Endpoint" above a page title, each step a link. */
export function Breadcrumbs({ trail }: { trail: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-1 flex flex-wrap items-center gap-1 text-xs text-[var(--muted)]">
      {trail.map((c, i) => (
        <span key={i} className="inline-flex items-center gap-1">
          {i > 0 && <span aria-hidden>›</span>}
          {c.href ? (
            <Link href={c.href} className="hover:underline">
              {c.label}
            </Link>
          ) : (
            <span>{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/**
 * A node's status in words: the glyph, the status, and the number of
 * failing checks out of the total.
 */
export function SummaryLine({ status, problems, checkCount }: { status: Status | null; problems: number; checkCount: number }) {
  return (
    <p className="flex items-center gap-2 text-sm">
      <StatusGlyph status={status} />
      <span className="font-medium">{status ?? "no checks"}</span>
      <span className="text-[var(--muted)]">
        · {checkCount} check{checkCount === 1 ? "" : "s"}
        {problems ? (
          <span className="text-[var(--down)]">
            {" "}
            · {problems} with problems
          </span>
        ) : null}
      </span>
    </p>
  );
}

/** A check row for ChecksTable, with where it lives. */
export type CheckRow = TreeCheck & { endpoint?: string | null; site?: string | null };

/**
 * A table of checks: status, name (linking to the check's page), type and,
 * when given, the endpoint/site it belongs to. Problems are listed first.
 *
 * @param showWhere whether to show the endpoint/site columns
 */
export function ChecksTable({ checks, showWhere = false, empty = "No checks." }: { checks: CheckRow[]; showWhere?: boolean; empty?: string }) {
  if (!checks.length) return <p className="text-sm text-[var(--muted)]">{empty}</p>;
  // Worst first, so problems are at the top; then by name.
  const rank: Record<string, number> = { down: 0, warn: 1, unknown: 2, up: 3 };
  const sorted = [...checks].sort((a, b) => (a.enabled === b.enabled ? 0 : a.enabled ? -1 : 1) || (rank[a.status ?? "unknown"] ?? 2) - (rank[b.status ?? "unknown"] ?? 2) || a.name.localeCompare(b.name));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-[var(--muted)]">
            <th className="py-1 pr-2 font-normal">Status</th>
            <th className="py-1 pr-2 font-normal">Check</th>
            <th className="py-1 pr-2 font-normal">Type</th>
            {showWhere && <th className="py-1 pr-2 font-normal">Endpoint</th>}
            {showWhere && <th className="py-1 font-normal">Site</th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map((c) => (
            <tr key={c.id} className="border-t border-[var(--border)]">
              <td className="whitespace-nowrap py-1.5 pr-2">
                <span className="inline-flex items-center gap-1 text-xs">
                  <StatusGlyph status={c.enabled ? c.status : "disabled"} />
                  {c.enabled ? c.status ?? "unknown" : "disabled"}
                </span>
              </td>
              <td className="py-1.5 pr-2">
                <Link href={`/checks/${c.id}`} className="hover:underline">
                  {c.name}
                </Link>
              </td>
              <td className="py-1.5 pr-2 text-xs text-[var(--muted)]">{typeLabel(c.type)}</td>
              {showWhere && <td className="py-1.5 pr-2 text-xs text-[var(--muted)]">{c.endpoint ?? "—"}</td>}
              {showWhere && <td className="py-1.5 text-xs text-[var(--muted)]">{c.site ?? "—"}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Adds objects to a manual group — an existing one, or a new one created
 * here. (Filter groups take their members from their rules, so they aren't
 * offered.)
 *
 * @param members the objects to add, e.g. [{ type: "endpoint", id }]
 * @param onDone called after they've been added
 */
export function AddToGroupDialog({ members, onClose, onDone }: { members: { type: MemberType; id: string }[]; onClose: () => void; onDone: () => void }) {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [choice, setChoice] = useState("");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Only manual groups can be added to.
  useEffect(() => {
    api.groups().then((g) => setGroups(g.filter((x) => x.kind === "manual")));
  }, []);

  async function save() {
    setError(null);
    try {
      if (choice === "__new") {
        if (!newName.trim()) {
          setError("Name the new group");
          return;
        }
        await api.createGroup({ name: newName.trim(), kind: "manual", members });
      } else if (choice) {
        await api.groupMembers(choice, { add: members });
      } else {
        setError("Choose a group");
        return;
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't add to the group");
    }
  }

  return (
    <Modal title={`Add ${members.length} to a group`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <Label label="Group">
          <select value={choice} onChange={(e) => setChoice(e.target.value)} className={inputClass}>
            <option value="">Choose…</option>
            {(groups ?? []).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
            <option value="__new">+ New group…</option>
          </select>
        </Label>
        {choice === "__new" && (
          <Label label="New group name">
            <input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Printers, Windows servers, Customer X" className={inputClass} />
          </Label>
        )}
        {error && <p className="text-[var(--down)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save}>
            Add
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * The groups an object belongs to (by hand or by matching a filter), each a
 * link, plus an "Add to group" button.
 */
export function GroupChips({ type, id }: { type: MemberType; id: string }) {
  const [groups, setGroups] = useState<{ id: string; name: string; kind: string }[] | null>(null);
  const [adding, setAdding] = useState(false);
  const toast = useToast();
  const load = () => api.groupsOf(type, id).then(setGroups);
  useEffect(() => {
    api.groupsOf(type, id).then(setGroups);
  }, [type, id]);
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-[var(--muted)]">Groups:</span>
      {groups === null ? null : groups.length ? (
        groups.map((g) => (
          <Link key={g.id} href={`/groups/${g.id}`} title={g.kind === "filter" ? "In this group because it matches the group's filter" : "Added to this group by hand"} className="rounded-full border border-[var(--border)] px-2 py-0.5 hover:bg-[var(--border)]/40">
            {g.name}
            {g.kind === "filter" ? " (filter)" : ""}
          </Link>
        ))
      ) : (
        <span className="text-[var(--muted)]">none</span>
      )}
      <button onClick={() => setAdding(true)} className="rounded-full px-2 py-0.5 text-[var(--muted)] underline hover:text-[var(--text)]">
        + Add to group
      </button>
      {adding && (
        <AddToGroupDialog
          members={[{ type, id }]}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            toast.show("Added to the group.");
            load();
          }}
        />
      )}
      {toast.node}
    </div>
  );
}
