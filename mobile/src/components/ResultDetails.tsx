// A check result's full contents for the check screen: the result rows
// (tap one to see its whole message instead of the first two lines) and the
// latest result's details — every list in it (zone changes, vulnerable
// packages, interfaces, sessions…) as its own section, and every other field
// as a label and value. The dashboard shows the same in CheckDetail.tsx's
// Details; this is the phone-sized version of it.

import { useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { own, type CheckResult } from "../lib/shared";
import { dateTime } from "../lib/format";
import { useTheme } from "../lib/theme";
import * as Clipboard from "expo-clipboard";
import { useSession } from "../lib/session";
import { Button, Row, StatusBadge, T } from "./ui";

/** Records a section shows before "Show all". */
const ROWS_AT_FIRST = 25;

/** Whether a value is a plain record (an object that isn't a list). */
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Whether a value is a non-empty list of records — shown as a section of cards. */
const isTable = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.length > 0 && v.every(isRecord);

/** A field name as a heading: "checkedPackages" → "Checked packages". */
const titleOf = (key: string) => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** A value as text: "—" for nothing, lists joined, advisories as "id (severity)", objects as JSON. */
function text(v: unknown): string {
  if (v == null || v === "") return "—";
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x !== "object" || x === null)) return v.length ? v.map(String).join(", ") : "none";
    if (v.every((x) => isRecord(x) && typeof x.id === "string")) return v.map((x) => `${String((x as { id: string }).id)}${typeof (x as { severity?: unknown }).severity === "string" ? ` (${String((x as { severity: string }).severity)})` : ""}`).join(", ");
  }
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

/**
 * One value. A single http(s) address opens in the browser when tapped
 * (only http/https — the regex matches one web address and nothing else —
 * so text from a check can't open another kind of link). An in-app help
 * section ("/help/patching#apt-kept-back") opens that page of the Looksee
 * server's help in the browser. A suggested command (field "command") is
 * shown in monospace with a Copy button; the app never runs it.
 */
function Value({ v, field }: { v: unknown; field?: string }) {
  const { colors } = useTheme();
  const { serverUrl } = useSession();
  const s = text(v);
  if (field === "command" && typeof v === "string") {
    return (
      <View style={{ gap: 4 }}>
        <T size="s" selectable style={{ fontFamily: "monospace" }}>{s}</T>
        <Button small title="Copy command" onPress={() => void Clipboard.setStringAsync(s)} />
      </View>
    );
  }
  // "/help/" then only letters, digits and / _ # - (one character class, so
  // it runs in linear time), e.g. "/help/patching#apt-kept-back".
  if (/^\/help\/[A-Za-z0-9/_#-]*$/.test(s) && serverUrl) {
    return (
      <Pressable onPress={() => void Linking.openURL(`${serverUrl}${s}`)} accessibilityRole="link">
        <T size="s" color={colors.accent} style={{ textDecorationLine: "underline" }}>Open help</T>
      </Pressable>
    );
  }
  if (/^https?:\/\/\S+$/.test(s)) {
    return (
      <Pressable onPress={() => void Linking.openURL(s)} accessibilityRole="link">
        <T size="s" color={colors.accent} style={{ textDecorationLine: "underline" }}>{s}</T>
      </Pressable>
    );
  }
  return <T size="s" selectable>{s}</T>;
}

/**
 * One record of a section: each field on its own line, label then value, in
 * the order the check named (`order`), then any others.
 */
function RecordCard({ record, order }: { record: Record<string, unknown>; order?: string[] }) {
  const { colors } = useTheme();
  const keys = Object.keys(record);
  const sorted = order ? [...order.filter((k) => keys.includes(k)), ...keys.filter((k) => !order.includes(k))] : keys;
  return (
    <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: 6, gap: 2 }}>
      {sorted.map((k) => [k, own(record, k)] as const).filter(([, v]) => v != null && v !== "").map(([k, v]) => (
        <View key={k} style={{ flexDirection: "row", gap: 8 }}>
          <T size="s" muted style={{ minWidth: 90 }}>{k}</T>
          <View style={{ flex: 1 }}>
            <Value v={v} field={k} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** A list of records with its title and count; the first 25, then "Show all". */
function Section({ title, rows, order }: { title: string | null; rows: Record<string, unknown>[]; order?: string[] }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, ROWS_AT_FIRST);
  return (
    <View style={{ gap: 2 }}>
      {title ? <T bold size="s">{title} ({rows.length})</T> : null}
      {shown.map((r, i) => <RecordCard key={i} record={r} order={order} />)}
      {rows.length > ROWS_AT_FIRST ? <Button small title={all ? `Show the first ${ROWS_AT_FIRST}` : `Show all ${rows.length}`} onPress={() => setAll(!all)} /> : null}
    </View>
  );
}

/**
 * A result's details, all of it (see the file header).
 *
 * @param value the result's `details` as stored
 */
export function ResultDetails({ value }: { value: unknown }) {
  if (value == null) return null;
  if (isTable(value)) return <Section title={null} rows={value} />;
  if (!isRecord(value)) return <T size="s" selectable>{JSON.stringify(value, null, 2)}</T>;
  // `columns` is the field order: a list (first table) or { table: [fields] }.
  const columns = value.columns;
  const orderFor = (table: string, index: number): string[] | undefined => {
    const list = isRecord(columns) ? own(columns, table) : index === 0 ? columns : undefined;
    return Array.isArray(list) ? list.map(String) : undefined;
  };
  const entries = Object.entries(value).filter(([k]) => k !== "columns");
  const tables = entries.filter(([, v]) => isTable(v)) as [string, Record<string, unknown>[]][];
  const rest = entries.filter(([, v]) => !isTable(v));
  return (
    <View style={{ gap: 10 }}>
      {rest.map(([k, v]) => (
        <View key={k} style={{ flexDirection: "row", gap: 8 }}>
          <T size="s" muted style={{ minWidth: 110 }}>{titleOf(k)}</T>
          <View style={{ flex: 1 }}>
            <Value v={v} field={k} />
          </View>
        </View>
      ))}
      {tables.map(([k, rows], i) => <Section key={k} title={tables.length > 1 || rest.length ? titleOf(k) : null} rows={rows} order={orderFor(k, i)} />)}
    </View>
  );
}

/**
 * One result row: status, message (two lines, or all of it after a tap),
 * and when/how long/value underneath.
 */
export function ResultRow({ result: r }: { result: CheckResult }) {
  const [open, setOpen] = useState(false);
  const sub = [dateTime(r.checkedAt), r.latencyMs != null ? `${r.latencyMs} ms` : null, r.value != null ? `value ${r.value}` : null, r.inMaintenance ? "maintenance" : null, r.excluded ? "excluded from stats" : null].filter(Boolean).join(" · ");
  return (
    <Row
      left={<StatusBadge status={r.status} small />}
      title={<T selectable={open} numberOfLines={open ? undefined : 2}>{r.message ?? r.status}</T>}
      subtitle={sub}
      onPress={() => setOpen(!open)}
    />
  );
}

/** The latest result that has details, from newest-first results. */
export const latestDetails = (results: CheckResult[]) => results.find((r) => r.details != null)?.details;
