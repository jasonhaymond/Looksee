// One check in a list: its status badge, name, and a line saying what's
// wrong, its type, site, and how long it has been in this state. Tapping opens
// the check unless the list handles taps itself (selection mode).

import { router } from "expo-router";
import { typeLabel, type Check } from "../lib/shared";
import { relativeTime } from "../lib/format";
import { Row, StatusBadge } from "./ui";

/** @param site the check's site name, when the list spans several sites. */
export function CheckRow({ check, site, selected, onPress, onLongPress }: { check: Check; site?: string; selected?: boolean; onPress?: () => void; onLongPress?: () => void }) {
  return (
    <Row
      selected={selected}
      left={<StatusBadge status={check.enabled ? check.lastStatus : null} small />}
      title={check.name}
      subtitle={[check.enabled ? null : "paused", check.inMaintenance ? "in maintenance" : null, check.lastMessage, typeLabel(check.type), site, check.lastStatusChangeAt ? `since ${relativeTime(check.lastStatusChangeAt)}` : null].filter(Boolean).join(" · ")}
      onPress={onPress ?? (() => router.push(`/checks/${check.id}`))}
      onLongPress={onLongPress}
    />
  );
}
