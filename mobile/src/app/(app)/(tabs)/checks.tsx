// Checks tab: every check, searchable and filterable by status and site.
// Long-press a check to start selecting; then "Actions" applies a bulk action
// to all selected checks (run now, pause, resume, resolve, maintenance,
// interval, tags, move, alert rules, edit settings on many, delete) through the
// engine's bulk endpoint (POST /api/checks/bulk). "+" adds a check.

import { useCallback, useMemo, useState } from "react";
import { FlatList, View } from "react-native";
import { router } from "expo-router";
import { api, type Check } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { errorText } from "../../../lib/format";
import { useTheme } from "../../../lib/theme";
import { Button, ButtonRow, Chip, Chips, Empty, ErrorBox, Field, Loading, Select, T, confirm, tell } from "../../../components/ui";
import { CheckRow } from "../../../components/CheckRow";
import { ActionSheet, type SheetAction } from "../../../components/ActionSheet";
import { usePrompt } from "../../../components/Prompt";

type StatusFilter = "all" | "problems" | "down" | "warn" | "up" | "paused";

export default function Checks() {
  const { colors } = useTheme();
  const load = useCallback(async () => {
    const [checks, sites] = await Promise.all([api.checks(), api.sites()]);
    return { checks, sites };
  }, []);
  const { data, error, loading, refreshing, reload } = useLoad(load, 30);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [siteId, setSiteId] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [sheet, setSheet] = useState<SheetAction[] | null>(null);
  const [prompt, ask] = usePrompt();
  const siteName = useMemo(() => new Map((data?.sites ?? []).map((s) => [s.id, s.name])), [data?.sites]);

  // The checks matching the search and filters, name order.
  const shown = useMemo(() => {
    const text = q.trim().toLowerCase();
    return (data?.checks ?? [])
      .filter((c) => !siteId || c.siteId === siteId)
      .filter((c) => {
        if (status === "all") return true;
        if (status === "paused") return !c.enabled;
        if (!c.enabled) return false;
        if (status === "problems") return c.lastStatus === "down" || c.lastStatus === "warn";
        return c.lastStatus === status;
      })
      .filter((c) => !text || `${c.name} ${c.type} ${c.tags.join(" ")} ${c.lastMessage ?? ""}`.toLowerCase().includes(text))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data?.checks, q, status, siteId]);

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  /** Runs a bulk action on the selection and reports what happened. */
  async function bulk(action: string, params: Record<string, unknown> = {}, verb = "Done") {
    try {
      const r = await api.bulkChecks(selected, action, params);
      tell(`${verb}: ${r.affected} check${r.affected === 1 ? "" : "s"}`, r.errors.length ? `${r.errors.length} skipped: ${r.errors[0].error}` : undefined);
      setSelected([]);
      void reload();
    } catch (err) {
      tell("That didn't work", errorText(err));
    }
  }

  /** The bulk actions offered for the current selection. */
  function actions(): SheetAction[] {
    const n = selected.length;
    return [
      { label: "Run now", onPress: () => bulk("run_now", {}, "Started") },
      { label: "Pause", onPress: () => bulk("disable", {}, "Paused") },
      { label: "Resume", onPress: () => bulk("enable", {}, "Resumed") },
      { label: "Mark recovered", help: "Resolve by hand; event checks ignore older events.", onPress: () => bulk("resolve", {}, "Resolved") },
      {
        label: "Maintenance for…",
        onPress: async () => {
          const m = await ask({ title: "Maintenance", label: "Minutes", initial: "60", numeric: true, message: "No alerts for these checks until it ends." });
          if (m) void bulk("maintenance", { minutes: Number(m) }, "In maintenance");
        },
      },
      {
        label: "Edit settings on all…",
        help: "Set, clear or keep each setting, and add/remove exclusions, on checks of one type.",
        onPress: () => router.push({ pathname: "/checks/bulk-settings", params: { ids: selected.join(",") } }),
      },
      { label: "Add alert rule…", onPress: () => router.push({ pathname: "/checks/bulk-alert", params: { ids: selected.join(",") } }) },
      {
        label: "Set interval…",
        onPress: async () => {
          const s = await ask({ title: "Check every", label: "Seconds (5 or more)", initial: "60", numeric: true });
          if (s) void bulk("set_interval", { seconds: Number(s) }, "Interval changed");
        },
      },
      {
        label: "Add tags…",
        onPress: async () => {
          const t = await ask({ title: "Add tags", label: "Tags, comma-separated" });
          if (t) void bulk("add_tags", { tags: t.split(",").map((x) => x.trim()).filter(Boolean) }, "Tagged");
        },
      },
      {
        label: "Remove tags…",
        onPress: async () => {
          const t = await ask({ title: "Remove tags", label: "Tags, comma-separated" });
          if (t) void bulk("remove_tags", { tags: t.split(",").map((x) => x.trim()).filter(Boolean) }, "Untagged");
        },
      },
      {
        label: "Move to site…",
        onPress: () => setSheet((data?.sites ?? []).map((s) => ({ label: s.name, onPress: () => bulk("move", { siteId: s.id }, `Moved to ${s.name}`) }))),
      },
      { label: "Remove all alert rules", danger: true, onPress: () => confirm("Remove alert rules?", `Every alert rule on ${n} check(s) is deleted; they'll notify no one.`, () => bulk("clear_alert_rules", {}, "Alert rules removed"), "Remove") },
      { label: `Delete ${n} check${n === 1 ? "" : "s"}…`, danger: true, onPress: () => confirm("Delete checks?", `${n} check(s) and their history are deleted. This can't be undone.`, () => bulk("delete", {}, "Deleted")) },
    ];
  }

  if (loading) return <Loading />;
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: 16, paddingBottom: 4, gap: 8 }}>
        <Field label="Search" value={q} onChangeText={setQ} placeholder="Name, type, tag or message" autoCapitalize="none" />
        <Chips>
          {(["all", "problems", "down", "warn", "up", "paused"] as const).map((s) => (
            <Chip key={s} label={s === "all" ? "All" : s === "problems" ? "Problems" : s[0].toUpperCase() + s.slice(1)} on={status === s} onPress={() => setStatus(s)} />
          ))}
        </Chips>
        <Select label="Site" value={siteId} onChange={setSiteId} options={[{ value: "", label: "All sites" }, ...(data?.sites ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
        <ErrorBox error={error} />
        {selected.length ? (
          <ButtonRow>
            <Button small variant="primary" title={`Actions (${selected.length})`} onPress={() => setSheet(actions())} />
            <Button small title={`Select all ${shown.length}`} onPress={() => setSelected(shown.map((c) => c.id))} />
            <Button small title="Clear" onPress={() => setSelected([])} />
          </ButtonRow>
        ) : (
          <ButtonRow>
            <Button small icon="add" variant="primary" title="Add check" onPress={() => router.push("/checks/new")} />
            <T size="s" muted style={{ alignSelf: "center" }}>Long-press checks to select several.</T>
          </ButtonRow>
        )}
      </View>
      <FlatList<Check>
        data={shown}
        keyExtractor={(c) => c.id}
        refreshing={refreshing}
        onRefresh={reload}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
        renderItem={({ item }) => (
          <CheckRow
            check={item}
            site={siteName.get(item.siteId)}
            selected={selected.includes(item.id)}
            onLongPress={() => toggle(item.id)}
            onPress={selected.length ? () => toggle(item.id) : undefined}
          />
        )}
        ListEmptyComponent={<Empty>No checks match.</Empty>}
      />
      <ActionSheet title={`${selected.length} selected`} actions={sheet} onClose={() => setSheet(null)} />
      {prompt}
    </View>
  );
}
