"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api, type Check, type StatusPage } from "../lib/api";
import { TopNav } from "../components/TopNav";
import { PageHelp } from "../components/PageHelp";
import { Button, EmptyState, Label, Modal, inputClass } from "../components/ui";
import { usePageAuth } from "../components/usePageAuth";

export default function StatusPagesAdmin() {
  const authed = usePageAuth();
  const [pages, setPages] = useState<StatusPage[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [editing, setEditing] = useState<StatusPage | "new" | null>(null);
  const load = useCallback(async () => {
    const [p, c] = await Promise.all([api.statusPages(), api.checks()]);
    setPages(p);
    setChecks(c);
  }, []);
  useEffect(() => {
    if (authed) load();
  }, [authed, load]);

  if (!authed) return null;
  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <TopNav active="/status-pages" />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Status pages</h2>
        <Button variant="primary" onClick={() => setEditing("new")}>
          + New status page
        </Button>
      </div>
      <PageHelp anchor="status-pages">Public pages anyone can open without signing in, showing only the checks you pick — their names, current status and 90 days of uptime. Nothing else (hosts, IPs, messages) is exposed.</PageHelp>
      {pages.length === 0 ? (
        <EmptyState>No status pages yet.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {pages.map((p) => (
            <li key={p.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel)]/40 p-3 text-sm">
              <div className="flex-1">
                <div className="font-medium">
                  {p.title} {!p.published && <span className="text-xs text-[var(--warn)]">(unpublished)</span>}
                </div>
                <div className="text-xs text-[var(--muted)]">
                  /status/{p.slug} · {p.checkIds.length} check(s)
                </div>
              </div>
              <Link href={`/status/${p.slug}`} target="_blank" className="text-xs underline">
                Open public page
              </Link>
              <button className="text-xs text-[var(--muted)] underline" onClick={() => setEditing(p)}>
                Edit
              </button>
              <button className="text-xs text-[var(--down)] underline" onClick={async () => confirm(`Delete "${p.title}"? Its public link stops working.`) && (await api.deleteStatusPage(p.id), load())}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      {editing && <Editor page={editing === "new" ? null : editing} checks={checks} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), load())} />}
    </main>
  );
}

function Editor({ page, checks, onClose, onSaved }: { page: StatusPage | null; checks: Check[]; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState(page?.title ?? "");
  const [slug, setSlug] = useState(page?.slug ?? "");
  const [description, setDescription] = useState(page?.description ?? "");
  const [published, setPublished] = useState(page?.published ?? true);
  const [picked, setPicked] = useState<string[]>(page?.checkIds ?? []);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const move = (id: string, dir: -1 | 1) =>
    setPicked((p) => {
      const i = p.indexOf(id);
      const j = i + dir;
      if (j < 0 || j >= p.length) return p;
      const n = [...p];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  return (
    <Modal title={page ? `Edit ${page.title}` : "New status page"} onClose={onClose} wide>
      <form
        className="space-y-3 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const body = { title, slug: slug || title, description: description || null, published, checkIds: picked };
            if (page) await api.updateStatusPage(page.id, body);
            else await api.createStatusPage(body);
            onSaved();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Save failed");
          }
        }}
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Label label="Title *">
            <input autoFocus required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Haymond Technologies status" className={inputClass} />
          </Label>
          <Label label="URL slug" help="The page lives at /status/<slug>. Blank = made from the title.">
            <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="status" className={inputClass} />
          </Label>
        </div>
        <Label label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </Label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={published} onChange={(e) => setPublished(e.target.checked)} className="accent-[var(--up)]" />
          Published (reachable without signing in)
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <div className="mb-1 text-xs text-[var(--muted)]">Available checks</div>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" className={`${inputClass} mb-2`} />
            <div className="max-h-60 space-y-1 overflow-y-auto">
              {checks
                .filter((c) => !picked.includes(c.id) && c.name.toLowerCase().includes(filter.toLowerCase()))
                .map((c) => (
                  <button type="button" key={c.id} onClick={() => setPicked((p) => [...p, c.id])} className="block w-full rounded px-2 py-1 text-left hover:bg-[var(--border)]/40">
                    + {c.name}
                  </button>
                ))}
            </div>
          </div>
          <div>
            <div className="mb-1 text-xs text-[var(--muted)]">On the page, in this order (names are shown publicly)</div>
            <ol className="max-h-72 space-y-1 overflow-y-auto">
              {picked.map((id) => (
                <li key={id} className="flex items-center gap-2 rounded border border-[var(--border)] px-2 py-1">
                  <span className="flex-1">{checks.find((c) => c.id === id)?.name ?? "(deleted)"}</span>
                  <button type="button" aria-label="Move up" onClick={() => move(id, -1)} className="text-[var(--muted)]">
                    ↑
                  </button>
                  <button type="button" aria-label="Move down" onClick={() => move(id, 1)} className="text-[var(--muted)]">
                    ↓
                  </button>
                  <button type="button" aria-label="Remove" onClick={() => setPicked((p) => p.filter((x) => x !== id))} className="text-[var(--down)]">
                    ✕
                  </button>
                </li>
              ))}
            </ol>
          </div>
        </div>
        {error && <p className="text-[var(--down)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
