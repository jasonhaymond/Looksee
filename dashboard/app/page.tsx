"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
// v2's default export uses a newer composable prop API; /legacy gives the
// flat v1-style props (cols, rowHeight, onDragStop, ...) this file uses.
import GridLayout, { WidthProvider } from "react-grid-layout/legacy";
import type { LayoutItem } from "react-grid-layout";
import { api, ApiError, type Site, type Check, type CheckResult, type Dashboard, type Widget, type WidgetType, type Host } from "./lib/api";
import { TopNav } from "./components/TopNav";
import { StatusTile } from "./components/StatusTile";
import { GroupSummaryCard } from "./components/GroupSummaryCard";
import { AddWidgetForm } from "./components/AddWidgetForm";

const Grid = WidthProvider(GridLayout);
const REFRESH_MS = 15_000;
const LAST_DASHBOARD_KEY = "looksee.lastDashboardId";
// Below this width, dragging/resizing a grid is more fiddly than useful —
// widgets render as a plain stacked list instead. Matches this app's
// desktop-first "arrange it" workflow; viewing status works fine either way.
const DESKTOP_BREAKPOINT_PX = 640;

export default function DashboardsPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null);

  const [dashboards, setDashboards] = useState<Dashboard[]>([]);
  const [activeDashboardId, setActiveDashboardId] = useState<string | null>(null);
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [editMode, setEditMode] = useState(false);
  const [showAddWidget, setShowAddWidget] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  const [sites, setSites] = useState<Site[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [latestByCheck, setLatestByCheck] = useState<Map<string, CheckResult>>(new Map());

  useEffect(() => {
    api
      .me()
      .then(() => setAuthChecked(true))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.push("/login");
      });
  }, [router]);

  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${DESKTOP_BREAKPOINT_PX}px)`);
    setIsDesktop(mq.matches);
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Ensures at least one dashboard always exists, and remembers the last one
  // viewed across visits (a fresh install has none — this is what a
  // brand-new user lands on instead of an empty error state).
  const loadDashboards = useCallback(async () => {
    let list = await api.dashboards();
    if (list.length === 0) {
      const created = await api.createDashboard("Overview");
      list = [created];
    }
    setDashboards(list);
    const remembered = localStorage.getItem(LAST_DASHBOARD_KEY);
    const nextActive = list.find((d) => d.id === remembered)?.id ?? list[0].id;
    setActiveDashboardId((current) => current ?? nextActive);
  }, []);

  const loadWidgets = useCallback(async (dashboardId: string) => {
    setWidgets(await api.widgets(dashboardId));
  }, []);

  const loadStatusData = useCallback(async () => {
    const siteList = await api.sites();
    setSites(siteList);
    const perSiteChecks = await Promise.all(siteList.map((s) => api.checks(s.id)));
    const allChecks = perSiteChecks.flat();
    setChecks(allChecks);
    const perSiteHosts = await Promise.all(siteList.map((s) => api.hosts(s.id)));
    setHosts(perSiteHosts.flat());
    const latestPairs = await Promise.all(
      allChecks.map(async (c) => {
        const results = await api.checkResults(c.id, 1);
        return [c.id, results[0]] as const;
      })
    );
    setLatestByCheck(new Map(latestPairs.filter(([, r]) => r)));
  }, []);

  useEffect(() => {
    if (!authChecked) return;
    loadDashboards();
    loadStatusData();
    const timer = setInterval(loadStatusData, REFRESH_MS);
    return () => clearInterval(timer);
  }, [authChecked, loadDashboards, loadStatusData]);

  useEffect(() => {
    if (activeDashboardId) {
      loadWidgets(activeDashboardId);
      localStorage.setItem(LAST_DASHBOARD_KEY, activeDashboardId);
    }
  }, [activeDashboardId, loadWidgets]);

  function handleSwitchDashboard(id: string) {
    setEditMode(false);
    setActiveDashboardId(id);
  }

  async function handleNewDashboard() {
    const name = prompt("Dashboard name:");
    if (!name?.trim()) return;
    const created = await api.createDashboard(name.trim());
    setDashboards((prev) => [...prev, created]);
    setActiveDashboardId(created.id);
  }

  async function handleRename() {
    if (!activeDashboardId || !renameValue.trim()) {
      setRenaming(false);
      return;
    }
    const updated = await api.renameDashboard(activeDashboardId, renameValue.trim());
    setDashboards((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
    setRenaming(false);
  }

  async function handleDeleteDashboard() {
    if (!activeDashboardId) return;
    if (!confirm("Delete this dashboard? Its widgets go with it — the checks/sites themselves are unaffected.")) return;
    await api.deleteDashboard(activeDashboardId);
    setActiveDashboardId(null);
    await loadDashboards();
  }

  async function handleAddWidget(type: WidgetType, targetId: string) {
    if (!activeDashboardId) return;
    const config = type === "status_tile" ? { checkId: targetId } : { siteId: targetId };
    // Drop the new widget below whatever's already there rather than at
    // (0,0) — compaction (default RGL behavior) then settles it into the
    // first real gap.
    const y = widgets.reduce((max, w) => Math.max(max, w.y + w.h), 0);
    const created = await api.createWidget(activeDashboardId, { type, config, x: 0, y, w: 4, h: 3 });
    setWidgets((prev) => [...prev, created]);
    setShowAddWidget(false);
  }

  async function handleRemoveWidget(id: string) {
    await api.deleteWidget(id);
    setWidgets((prev) => prev.filter((w) => w.id !== id));
  }

  // react-grid-layout's default vertical compaction/collision avoidance means
  // moving or resizing one widget often shifts others too — it hands back the
  // full recomputed layout, not just the item that was directly touched.
  // Persisting only that one item leaves every widget it displaced holding a
  // stale DB position, which snaps back on the next reload. Diff the whole
  // settled layout against current state and persist everything that moved.
  async function persistLayout(layout: readonly LayoutItem[]) {
    const changed = layout.filter((item) => {
      const widget = widgets.find((w) => w.id === item.i);
      return widget && (widget.x !== item.x || widget.y !== item.y || widget.w !== item.w || widget.h !== item.h);
    });
    if (changed.length === 0) return;
    setWidgets((prev) =>
      prev.map((widget) => {
        const item = changed.find((i) => i.i === widget.id);
        return item ? { ...widget, x: item.x, y: item.y, w: item.w, h: item.h } : widget;
      })
    );
    await Promise.all(changed.map((item) => api.updateWidget(item.i, { x: item.x, y: item.y, w: item.w, h: item.h })));
  }

  if (!authChecked || isDesktop === null) return null;

  const siteById = new Map(sites.map((s) => [s.id, s]));
  const checkById = new Map(checks.map((c) => [c.id, c]));

  function renderWidgetContent(widget: Widget) {
    if (widget.type === "status_tile") {
      const check = widget.config.checkId ? checkById.get(widget.config.checkId) : undefined;
      if (!check) {
        return (
          <p className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3 text-xs text-[var(--muted)]">
            Check not found — it may have been deleted.
          </p>
        );
      }
      return <StatusTile check={check} latest={latestByCheck.get(check.id)} hosts={hosts} onChanged={loadStatusData} />;
    }
    const site = widget.config.siteId ? siteById.get(widget.config.siteId) : undefined;
    return (
      <GroupSummaryCard
        site={site}
        checks={checks.filter((c) => c.siteId === widget.config.siteId)}
        latestByCheck={latestByCheck}
      />
    );
  }

  return (
    <main className="mx-auto max-w-5xl p-6">
      <TopNav active="/" />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <select
          value={activeDashboardId ?? ""}
          onChange={(e) => handleSwitchDashboard(e.target.value)}
          className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-sm"
        >
          {dashboards.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <button onClick={handleNewDashboard} className="text-sm text-[var(--muted)] hover:text-[var(--text)]">
          + New dashboard
        </button>
        {renaming ? (
          <span className="flex items-center gap-1">
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleRename()}
              className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-sm outline-none"
            />
            <button onClick={handleRename} className="text-sm text-[var(--up)]">
              Save
            </button>
          </span>
        ) : (
          <button
            onClick={() => {
              setRenameValue(dashboards.find((d) => d.id === activeDashboardId)?.name ?? "");
              setRenaming(true);
            }}
            className="text-sm text-[var(--muted)] hover:text-[var(--text)]"
          >
            Rename
          </button>
        )}
        <button onClick={handleDeleteDashboard} className="text-sm text-[var(--down)] hover:underline">
          Delete
        </button>

        <span className="flex-1" />

        {isDesktop && (
          <button
            onClick={() => setEditMode((v) => !v)}
            className={`rounded-md border px-3 py-1 text-sm ${editMode ? "border-[var(--up)] text-[var(--up)]" : "border-[var(--border)] text-[var(--muted)]"}`}
          >
            {editMode ? "Done editing" : "Edit layout"}
          </button>
        )}
      </div>

      {showAddWidget && <div className="mb-4"><AddWidgetForm sites={sites} checks={checks} onAdd={handleAddWidget} onCancel={() => setShowAddWidget(false)} /></div>}

      {widgets.length === 0 && !showAddWidget && (
        <p className="mb-4 text-sm text-[var(--muted)]">
          This dashboard is empty.{" "}
          <button onClick={() => setShowAddWidget(true)} className="underline">
            Add a widget
          </button>{" "}
          to get started.
        </p>
      )}

      {isDesktop ? (
        <>
          <Grid
            className="mb-4"
            cols={12}
            rowHeight={56}
            margin={[12, 12]}
            isDraggable={editMode}
            isResizable={editMode}
            draggableCancel=".no-drag"
            layout={widgets.map((w) => ({ i: w.id, x: w.x, y: w.y, w: w.w, h: w.h }))}
            onDragStop={(layout: readonly LayoutItem[]) => persistLayout(layout)}
            onResizeStop={(layout: readonly LayoutItem[]) => persistLayout(layout)}
          >
            {widgets.map((widget) => (
              <div key={widget.id} className="relative overflow-auto">
                {editMode && (
                  <button
                    onClick={() => handleRemoveWidget(widget.id)}
                    className="no-drag absolute right-1 top-1 z-10 rounded bg-[var(--down)]/20 px-1.5 text-xs text-[var(--down)]"
                  >
                    ✕
                  </button>
                )}
                {renderWidgetContent(widget)}
              </div>
            ))}
          </Grid>
          {!showAddWidget && (
            <button onClick={() => setShowAddWidget(true)} className="text-sm text-[var(--muted)] hover:text-[var(--text)]">
              + Add widget
            </button>
          )}
        </>
      ) : (
        <div className="space-y-3">
          {widgets.map((widget) => (
            <div key={widget.id}>{renderWidgetContent(widget)}</div>
          ))}
          {!showAddWidget && (
            <button onClick={() => setShowAddWidget(true)} className="text-sm text-[var(--muted)] hover:text-[var(--text)]">
              + Add widget
            </button>
          )}
          <p className="text-xs text-[var(--muted)]">Rearranging widgets needs a wider screen.</p>
        </div>
      )}
    </main>
  );
}
