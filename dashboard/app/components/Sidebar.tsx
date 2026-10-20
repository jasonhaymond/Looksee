// The left navigation: the page list plus a live tree of everything being
// monitored — Locations → Sites → Endpoints → Checks — and Groups.
//
// Where this sits: rendered once for every signed-in page by AppShell (in
// the root layout). On wide screens (lg, ≥1024 px) it's a fixed column on the
// left; on narrower screens it's hidden behind a "☰ Menu" button in a thin
// top bar and slides in as a drawer. The tree comes from GET /api/tree
// (engine/src/routes/tree.ts) and refreshes every 30 seconds.
//
// Each tree row shows a status glyph — a shape as well as a colour (✓ up,
// ! warn, ✕ down, ? unknown), so status never depends on colour alone — and,
// when something is failing, a text count ("2 problems"). Which branches are
// open is remembered in the browser (localStorage) between visits.
//
// "use client" makes this a React component that runs in the browser.

"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, type Status, type Tree, type TreeCheck, type TreeEndpoint, type TreeSite } from "../lib/api";
import { NAV } from "../lib/nav";
import { PushEnableButton } from "./PushEnableButton";
import { ThemeToggle } from "./ThemeToggle";
import { pollEvery } from "../lib/poll";

// Where the open/closed state of tree branches is remembered.
const EXPANDED_KEY = "looksee.nav.expanded";
// Where the open/closed state of the page-list sections is remembered.
const SECTIONS_KEY = "looksee.nav.sections";

/**
 * A small status marker: a distinct character per status (so it reads
 * without colour) in the status colour, with the status spelled out for
 * screen readers and as a hover tooltip.
 */
export function StatusGlyph({ status }: { status: Status | string | null }) {
  const s = status ?? "none";
  const glyph = s === "up" ? "✓" : s === "down" ? "✕" : s === "warn" ? "!" : s === "unknown" ? "?" : "–";
  const color = s === "up" ? "var(--up)" : s === "down" ? "var(--down)" : s === "warn" ? "var(--warn)" : "var(--muted)";
  const label = s === "none" ? "no checks" : s;
  return (
    <span title={label} className="inline-flex w-3.5 shrink-0 justify-center text-[11px] font-bold leading-none" style={{ color }}>
      <span aria-hidden>{glyph}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** "3 problems" in the warning colour, or nothing when all is well. */
function Problems({ n }: { n: number }) {
  if (!n) return null;
  return <span className="ml-auto shrink-0 pl-1 text-[10px] font-medium text-[var(--down)]">{n} problem{n === 1 ? "" : "s"}</span>;
}

/**
 * Reads a JSON value saved in the browser, or `fallback` if nothing is
 * saved or storage is unavailable (private windows can block it).
 */
function readJson<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

/** Saves a JSON value in the browser, ignoring storage that's unavailable. */
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage blocked or full: the tree just won't remember its state.
  }
}

/**
 * One row of the tree: an optional open/close toggle, the status glyph, the
 * name (a link to that object's page) and the problem count.
 *
 * @param depth indent level (0 = top)
 * @param open whether the branch is open; undefined = a leaf with no toggle
 * @param onToggle opens/closes the branch
 * @param active whether this row is the page being viewed
 */
function Row({ depth, open, onToggle, href, name, status, problems, active, sub }: { depth: number; open?: boolean; onToggle?: () => void; href: string; name: string; status: Status | string | null; problems?: number; active: boolean; sub?: string }) {
  return (
    <div className={`group flex items-center gap-1 rounded-md pr-1 text-[13px] ${active ? "bg-[var(--border)]/50" : "hover:bg-[var(--border)]/25"}`} style={{ paddingLeft: depth * 12 + 2 }}>
      {onToggle ? (
        <button onClick={onToggle} aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${name}`} className="w-4 shrink-0 text-center text-[10px] text-[var(--muted)] hover:text-[var(--text)]">
          {open ? "▾" : "▸"}
        </button>
      ) : (
        <span className="w-4 shrink-0" />
      )}
      <StatusGlyph status={status} />
      <Link href={href} className="min-w-0 flex-1 truncate py-1" title={sub ? `${name} — ${sub}` : name}>
        {name}
      </Link>
      <Problems n={problems ?? 0} />
    </div>
  );
}

/**
 * The navigation content shared by the desktop column and the mobile drawer.
 *
 * @param onNavigate called after a link is followed (the drawer closes)
 */
function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const router = useRouter();
  const [tree, setTree] = useState<Tree | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [sections, setSections] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");

  // Restore remembered open/closed state once, in the browser.
  useEffect(() => {
    setExpanded(readJson(EXPANDED_KEY, {}));
    setSections(readJson(SECTIONS_KEY, {}));
  }, []);

  // Load the tree now and every 30 s. A signed-out visitor (401) simply gets
  // no tree; other errors keep the last good tree on screen.
  const load = useCallback(() => {
    api
      .tree()
      .then(setTree)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) setTree(null);
      });
  }, []);
  useEffect(() => {
    load();
    const t = pollEvery(load, 30_000);
    return () => clearInterval(t);
  }, [load]);

  // Close the drawer when the page changes — but not when the drawer first
  // opens (the effect also runs then, which would close it straight away).
  const firstPath = useRef(pathname);
  useEffect(() => {
    if (pathname !== firstPath.current) onNavigate?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on navigation
  }, [pathname]);

  /** Opens or closes one branch and remembers it. */
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      writeJson(EXPANDED_KEY, next);
      return next;
    });
  // A page-list section is open if it holds the page being viewed, unless
  // the admin opened or closed it by hand (remembered in `sections`). Keeping
  // the rest closed leaves most of the column to the tree.
  const isActiveHref = (href: string) => (href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`));
  const sectionOpen = (label: string) => sections[label] ?? NAV.find((g) => g.label === label)!.items.some((i) => isActiveHref(i.href));
  /** Opens or closes one page-list section and remembers it. */
  const toggleSection = (label: string) =>
    setSections((prev) => {
      const next = { ...prev, [label]: !sectionOpen(label) };
      writeJson(SECTIONS_KEY, next);
      return next;
    });

  // With a search typed, only matching objects and the branches leading to
  // them are shown, all opened.
  const q = query.trim().toLowerCase();
  const hit = (name: string) => !q || name.toLowerCase().includes(q);
  const filtered = useMemo(() => {
    if (!tree || !q) return tree;
    const checks = (list: TreeCheck[]) => list.filter((c) => hit(c.name));
    const endpoint = (e: TreeEndpoint): TreeEndpoint | null => {
      const children = hit(e.name) ? e.children : checks(e.children);
      return hit(e.name) || children.length ? { ...e, children } : null;
    };
    const site = (s: TreeSite): TreeSite | null => {
      if (hit(s.name)) return s;
      const endpoints = s.endpoints.map(endpoint).filter((x): x is TreeEndpoint => Boolean(x));
      const own = checks(s.checks);
      return endpoints.length || own.length ? { ...s, endpoints, checks: own } : null;
    };
    return {
      locations: tree.locations
        .map((l) => (hit(l.name) ? l : { ...l, sites: l.sites.map(site).filter((x): x is TreeSite => Boolean(x)) }))
        .filter((l) => hit(l.name) || l.sites.length),
      unassignedSites: tree.unassignedSites.map(site).filter((x): x is TreeSite => Boolean(x)),
      groups: tree.groups.filter((g) => hit(g.name)),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hit depends only on q
  }, [tree, q]);
  const isOpen = (key: string) => Boolean(q) || Boolean(expanded[key]);

  async function signOut() {
    await api.logout();
    router.push("/login");
  }

  /** The rows for one site and, when open, its endpoints and checks. */
  const siteRows = (s: TreeSite, depth: number) => (
    <div key={s.id}>
      <Row depth={depth} open={isOpen(`s:${s.id}`)} onToggle={() => toggle(`s:${s.id}`)} href={`/sites/${s.id}`} name={s.name} status={s.status} problems={s.problems} active={pathname === `/sites/${s.id}`} />
      {isOpen(`s:${s.id}`) && (
        <>
          {s.endpoints.map((e) => (
            <div key={e.id}>
              <Row
                depth={depth + 1}
                open={e.children.length ? isOpen(`e:${e.id}`) : undefined}
                onToggle={e.children.length ? () => toggle(`e:${e.id}`) : undefined}
                href={`/endpoints/${e.id}`}
                name={e.name}
                sub={[e.os, e.agent ? "agent" : null, e.collector ? "site collector" : null].filter(Boolean).join(" · ")}
                status={e.status}
                problems={e.problems}
                active={pathname === `/endpoints/${e.id}`}
              />
              {isOpen(`e:${e.id}`) && e.children.map((c) => <Row key={c.id} depth={depth + 2} href={`/checks/${c.id}`} name={c.name} sub={c.type} status={c.enabled ? c.status : "disabled"} active={pathname === `/checks/${c.id}`} />)}
            </div>
          ))}
          {s.checks.map((c) => (
            <Row key={c.id} depth={depth + 1} href={`/checks/${c.id}`} name={c.name} sub={`${c.type} · site check`} status={c.enabled ? c.status : "disabled"} active={pathname === `/checks/${c.id}`} />
          ))}
          {!s.endpoints.length && !s.checks.length && <p className="py-1 text-xs text-[var(--muted)]" style={{ paddingLeft: (depth + 1) * 12 + 22 }}>Nothing here yet</p>}
        </>
      )}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 pb-2 pt-3">
        <Link href="/" className="text-lg font-semibold">
          Looksee
        </Link>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {/* The page list. */}
        <nav aria-label="Pages" className="mb-3 space-y-1">
          {NAV.map((g) => {
            const open = sectionOpen(g.label);
            return (
              <div key={g.label}>
                <button onClick={() => toggleSection(g.label)} aria-expanded={open} className="flex w-full items-center gap-1 px-1 pt-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)] hover:text-[var(--text)]">
                  <span className="w-3">{open ? "▾" : "▸"}</span>
                  {g.label}
                </button>
                {open &&
                  g.items.map((i) => {
                    const active = isActiveHref(i.href);
                    return (
                      <Link key={i.href} href={i.href} title={i.hint} className={`block rounded-md px-2 py-1 pl-5 text-[13px] ${active ? "bg-[var(--border)]/50 text-[var(--text)]" : "text-[var(--muted)] hover:bg-[var(--border)]/25 hover:text-[var(--text)]"}`}>
                        {i.label}
                      </Link>
                    );
                  })}
              </div>
            );
          })}
        </nav>

        {/* The live tree. */}
        {filtered && (
          <nav aria-label="Monitored objects" className="border-t border-[var(--border)] pt-2">
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a site, endpoint or check…" aria-label="Filter the tree" className="mb-2 w-full rounded-md border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-[13px]" />
            {filtered.locations.map((l) => (
              <div key={l.id}>
                <Row depth={0} open={isOpen(`l:${l.id}`)} onToggle={() => toggle(`l:${l.id}`)} href={`/locations/${l.id}`} name={l.name} status={l.status} problems={l.problems} active={pathname === `/locations/${l.id}`} />
                {isOpen(`l:${l.id}`) && l.sites.map((s) => siteRows(s, 1))}
              </div>
            ))}
            {filtered.unassignedSites.length > 0 && (
              <>
                {filtered.locations.length > 0 && <p className="px-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">No location</p>}
                {filtered.unassignedSites.map((s) => siteRows(s, 0))}
              </>
            )}
            {filtered.groups.length > 0 && (
              <>
                <p className="px-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)]">Groups</p>
                {filtered.groups.map((g) => (
                  <Row key={g.id} depth={0} href={`/groups/${g.id}`} name={g.name} sub={g.kind === "filter" ? "filter group" : "group"} status={g.status} problems={g.problems} active={pathname === `/groups/${g.id}`} />
                ))}
              </>
            )}
            {q && !filtered.locations.length && !filtered.unassignedSites.length && !filtered.groups.length && <p className="px-1 text-xs text-[var(--muted)]">Nothing matches “{query}”.</p>}
          </nav>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border)] px-3 py-2 text-[13px]">
        <ThemeToggle showLabel />
        <PushEnableButton />
        <button onClick={signOut} className="ml-auto text-[var(--muted)] hover:text-[var(--text)]">
          Sign out
        </button>
      </div>
    </div>
  );
}

/**
 * The sidebar in both forms: a fixed column on wide screens, and on narrow
 * screens a top bar with a menu button that opens the same content as a
 * drawer (closed by the ✕ button, the backdrop, Escape, or following a link).
 */
export function Sidebar() {
  const [open, setOpen] = useState(false);

  // Escape closes the drawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      {/* Wide screens: a fixed column. */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-72 border-r border-[var(--border)] bg-[var(--panel)] lg:block">
        <SidebarContent />
      </aside>

      {/* Narrow screens: a top bar with the menu button … */}
      <div className="sticky top-0 z-30 flex items-center justify-between border-b border-[var(--border)] bg-[var(--panel)] px-4 py-2 lg:hidden">
        <Link href="/" className="font-semibold">
          Looksee
        </Link>
        <button onClick={() => setOpen(true)} aria-expanded={open} aria-controls="nav-drawer" className="rounded-md border border-[var(--border)] px-3 py-1 text-sm">
          ☰ Menu
        </button>
      </div>

      {/* … and the drawer it opens. */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button aria-label="Close the menu" className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <aside id="nav-drawer" className="absolute inset-y-0 left-0 w-[85vw] max-w-80 border-r border-[var(--border)] bg-[var(--panel)] shadow-2xl">
            <button onClick={() => setOpen(false)} aria-label="Close the menu" className="absolute right-2 top-2 rounded-md px-2 py-1 text-[var(--muted)] hover:text-[var(--text)]">
              ✕
            </button>
            <SidebarContent onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
    </>
  );
}
