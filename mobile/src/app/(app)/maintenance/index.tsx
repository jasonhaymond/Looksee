// Maintenance windows: planned times when checks record results but send no
// alerts. Lists every window (running now first), with end-now, edit, on/off
// and delete; "+" opens the editor.

import { useCallback } from "react";
import { Stack, router } from "expo-router";
import { api, type MaintenanceWindow } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { dateTime, errorText } from "../../../lib/format";
import { useTheme } from "../../../lib/theme";
import { Button, ButtonRow, Card, Empty, ErrorBox, Loading, Screen, T, Toggle, confirm, tell } from "../../../components/ui";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A plain description of when a window applies. */
export function describeWindow(w: MaintenanceWindow): string {
  if (w.startsAt && w.endsAt) return `${dateTime(w.startsAt)} → ${dateTime(w.endsAt)}`;
  const every = (w.repeatEvery ?? 1) > 1 ? `every ${w.repeatEvery} ` : "";
  const days = (w.daysOfWeek ?? []).map((d) => DAYS.at(d) ?? d).join(", ");
  const nth = (n: number | null | undefined) => (n === -1 ? "last" : ["", "1st", "2nd", "3rd", "4th"][n ?? 0] ?? `${n}th`);
  const when =
    w.recurrence === "daily" ? `${every || "every "}${every ? "days" : "day"}`
    : w.recurrence === "monthly_day" ? `${every ? `${every}months` : "monthly"} on day ${w.dayOfMonth === -1 ? "last" : w.dayOfMonth}`
    : w.recurrence === "monthly_weekday" ? `${every ? `${every}months` : "monthly"} on the ${nth(w.weekOfMonth)} ${days}`
    : `${every ? `${every}weeks` : "weekly"} on ${days}`;
  return `${when} at ${w.startTime} for ${w.durationMinutes} min${w.timeZone ? ` (${w.timeZone})` : ""}`;
}

export default function Maintenance() {
  const { colors } = useTheme();
  const load = useCallback(() => api.maintenance(), []);
  const { data, error, loading, refreshing, reload } = useLoad(load, 30);

  /** Runs an action on a window and reloads. */
  const act = async (run: () => Promise<unknown>) => {
    try {
      await run();
      await reload();
    } catch (err) {
      tell("That didn't work", errorText(err));
    }
  };

  if (loading) return <Loading />;
  const list = [...(data ?? [])].sort((a, b) => Number(b.active) - Number(a.active));
  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <Stack.Screen options={{ title: "Maintenance windows" }} />
      <ErrorBox error={error} />
      <Button icon="add" variant="primary" title="New window" onPress={() => router.push("/maintenance/edit")} />
      {list.length === 0 ? <Empty>No maintenance windows.</Empty> : list.map((w) => (
        <Card key={w.id} title={w.name} action={w.active ? <T size="s" bold color={colors.maint}>RUNNING NOW</T> : undefined}>
          <T size="s">{describeWindow(w)}</T>
          <T size="s" muted>Applies to: {w.scope === "all" ? "everything" : `${w.targetIds.length} ${w.scope}${w.targetIds.length === 1 ? "" : "s"}`}{w.next && !w.active ? ` · next ${dateTime(w.next)}` : ""}</T>
          <Toggle label="Enabled" value={w.enabled} onChange={(enabled) => act(() => api.updateMaintenance(w.id, { enabled }))} />
          <ButtonRow>
            {w.active ? <Button small title="End now" onPress={() => act(() => api.endMaintenance(w.id))} /> : null}
            <Button small title="Edit" onPress={() => router.push({ pathname: "/maintenance/edit", params: { id: w.id } })} />
            <Button small variant="danger" title="Delete" onPress={() => confirm(`Delete "${w.name}"?`, "The window is removed; alerts resume as normal.", () => void act(() => api.deleteMaintenance(w.id)))} />
          </ButtonRow>
        </Card>
      ))}
    </Screen>
  );
}
