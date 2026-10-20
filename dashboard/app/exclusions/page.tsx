// The Exclusions page (/exclusions): reusable lists of items that checks
// ignore — mount points, interfaces, message texts, services, containers,
// event IDs, packages — kept in one place instead of repeated on every check.
//
// Where this sits: lists are stored by the engine
// (engine/src/routes/exclusions.ts). Before a check runs, the engine merges
// its own "Exclude" setting with every enabled list of a kind that check type
// uses, applying to all checks or only to chosen groups
// (engine/src/services/exclusions.ts). A check's page shows the merged result
// and where each item came from.
//
// "use client" makes this a React component that runs in the browser. The
// engine refuses every call without a session; usePageAuth sends a
// signed-out visitor to the sign-in page.

"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type ExclusionKind, type ExclusionList, type Group } from "../lib/api";
import { PageHelp } from "../components/PageHelp";
import { Button, ConfirmDialog, EmptyState, Label, Modal, MultiPicker, inputClass } from "../components/ui";
import { usePageAuth } from "../components/usePageAuth";

/** The page: every list with its kind, scope and items, plus the editor. */
export default function ExclusionsPage() {
  const authed = usePageAuth();
  const [lists, setLists] = useState<ExclusionList[] | null>(null);
  const [kinds, setKinds] = useState<ExclusionKind[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  // The list open in the editor: an existing one, "new", or none.
  const [editing, setEditing] = useState<ExclusionList | "new" | null>(null);
  const [deleting, setDeleting] = useState<ExclusionList | null>(null);

  // Loads the lists, the kinds (labels and help) and the groups (for names
  // and the group picker) together.
  const load = useCallback(
    () =>
      Promise.all([api.exclusionLists(), api.exclusionKinds(), api.groups()]).then(([l, k, g]) => {
        setLists(l);
        setKinds(k);
        setGroups(g);
      }),
    []
  );
  useEffect(() => {
    if (authed) load();
  }, [authed, load]);

  if (!authed) return null;
  const kindLabel = (id: string) => kinds.find((k) => k.id === id)?.label ?? id;
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name ?? "deleted group";

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-medium">Exclusions</h1>
        <Button variant="primary" onClick={() => setEditing("new")}>
          + New exclusion list
        </Button>
      </div>
      <PageHelp anchor="exclusions">
        Items checks should ignore — the /snap mounts on every Ubuntu server, Docker&apos;s veth interfaces, a noisy log message, a service that&apos;s meant to be stopped. A list applies to every check that looks at that kind of item, or only to the checks in the groups you choose. Each check can also exclude items of its own (its &ldquo;Exclude&rdquo; setting); its page shows everything it ignores and why.
      </PageHelp>
      {lists && !lists.length ? (
        <EmptyState>No exclusion lists yet.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {(lists ?? []).map((l) => (
            <li key={l.id} className="surface space-y-1.5 rounded-xl p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`font-medium ${l.enabled ? "" : "opacity-60"}`}>{l.name}</span>
                {!l.enabled && <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs">off</span>}
                <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)]">{kindLabel(l.kind)}</span>
                <span className="text-xs text-[var(--muted)]">{l.applyToAll ? "applies to all checks" : l.groupIds.length ? `applies to ${l.groupIds.map(groupName).join(", ")}` : "applies to nothing yet — choose groups or all checks"}</span>
                <span className="ml-auto flex gap-3 text-xs">
                  <button className="underline" onClick={() => setEditing(l)}>
                    Edit
                  </button>
                  <button className="text-[var(--muted)] underline" onClick={async () => (await api.updateExclusionList(l.id, { enabled: !l.enabled }), load())}>
                    {l.enabled ? "Turn off" : "Turn on"}
                  </button>
                  <button className="text-[var(--down)] underline" onClick={() => setDeleting(l)}>
                    Delete
                  </button>
                </span>
              </div>
              {l.description && <p className="text-xs text-[var(--muted)]">{l.description}</p>}
              <p className="flex flex-wrap gap-1">
                {l.items.slice(0, 30).map((i) => (
                  <code key={i} className="rounded bg-[var(--code-bg)] px-1.5 py-0.5 text-xs">
                    {i}
                  </code>
                ))}
                {l.items.length > 30 && <span className="text-xs text-[var(--muted)]">+{l.items.length - 30} more</span>}
                {!l.items.length && <span className="text-xs text-[var(--muted)]">No items</span>}
              </p>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <ListEditor
          list={editing === "new" ? null : editing}
          kinds={kinds}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete exclusion list"
          message={`Delete "${deleting.name}"? Checks stop ignoring its ${deleting.items.length} item(s) on their next run.`}
          actionLabel="Delete"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.deleteExclusionList(deleting.id);
            setDeleting(null);
            load();
          }}
        />
      )}
    </main>
  );
}

/**
 * Creates or edits a list: name, kind (with how its items match and which
 * checks use it), items one per line, and where it applies.
 *
 * @param list the list to edit, or null for a new one
 */
function ListEditor({ list, kinds, groups, onClose, onSaved }: { list: ExclusionList | null; kinds: ExclusionKind[]; groups: Group[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  const [kind, setKind] = useState(list?.kind ?? "mounts");
  const [items, setItems] = useState((list?.items ?? []).join("\n"));
  const [scope, setScope] = useState<"all" | "groups">(list && !list.applyToAll ? "groups" : "all");
  const [groupIds, setGroupIds] = useState<string[]>(list?.groupIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const k = kinds.find((x) => x.id === kind);

  async function save() {
    setError(null);
    const input = { name, description: description || null, kind, items, applyToAll: scope === "all", groupIds: scope === "groups" ? groupIds : [] };
    try {
      if (list) await api.updateExclusionList(list.id, input);
      else await api.createExclusionList(input);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save the list");
    }
  }

  return (
    <Modal title={list ? "Edit exclusion list" : "New exclusion list"} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <Label label="Name *">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Ubuntu snap mounts" className={inputClass} />
          </Label>
          <Label label="What the items are">
            <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputClass}>
              {kinds.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.label}
                </option>
              ))}
            </select>
          </Label>
        </div>
        <Label label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </Label>
        {k && (
          <p className="text-xs text-[var(--muted)]">
            {k.help}{" "}
            {k.match === "name" ? "Whole names, case ignored; * matches anything and ? one character." : "Matched anywhere in the message, case ignored."} Used by: {k.types.map((t) => t.replace(/_/g, " ")).join(", ")}.
          </p>
        )}
        <Label label="Items (one per line)">
          <textarea value={items} onChange={(e) => setItems(e.target.value)} rows={6} className={`${inputClass} font-mono`} placeholder={k?.match === "text" ? "scanner-01\nCRON[" : "/snap/*\n/boot/efi"} />
        </Label>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={scope === "all"} onChange={() => setScope("all")} className="accent-[var(--up)]" />
            All checks that use this kind of item
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={scope === "groups"} onChange={() => setScope("groups")} className="accent-[var(--up)]" />
            Only checks in these groups
          </label>
        </div>
        {scope === "groups" &&
          (groups.length ? (
            <MultiPicker items={groups.map((g) => ({ id: g.id, label: g.name, sub: g.kind === "filter" ? "filter group" : "manual group" }))} selected={groupIds} onChange={setGroupIds} placeholder="Search groups…" height="max-h-48" />
          ) : (
            <p className="text-xs text-[var(--muted)]">No groups yet — create one on the Groups page first.</p>
          ))}
        {error && <p className="text-[var(--down)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!name.trim() || (scope === "groups" && !groupIds.length)}>
            {list ? "Save changes" : "Create list"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
