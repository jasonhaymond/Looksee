// The app's shared building blocks: screen container with pull-to-refresh,
// cards, list rows, buttons, text inputs, switches, pickers, status badges and
// messages. Every screen is made from these, so spacing, colours (from the
// theme, never hard-coded) and touch sizes stay consistent.
//
// React Native renders real Android views: <View> is a box, <Text> is text,
// <Pressable> is anything tappable. Styles are plain objects (like CSS).

import { useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, FlatList, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, TextInput, View, type TextInputProps, type TextStyle, type ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { statusColor, useTheme } from "../lib/theme";
import { statusLabel } from "../lib/format";

/** Screen body: scrolls, pulls to refresh (when onRefresh is given), and shows load errors. */
export function Screen({ children, refreshing = false, onRefresh, padded = true }: { children: ReactNode; refreshing?: boolean; onRefresh?: () => void; padded?: boolean }) {
  const { colors } = useTheme();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={padded ? { padding: 16, gap: 12, paddingBottom: 40 } : undefined}
      keyboardShouldPersistTaps="handled"
      refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={[colors.accent]} progressBackgroundColor={colors.panel} /> : undefined}
    >
      {children}
    </ScrollView>
  );
}

/** Spinner shown while a screen's first load runs. */
export function Loading({ label = "Loading…" }: { label?: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 8, backgroundColor: colors.bg }}>
      <ActivityIndicator color={colors.accent} />
      <T muted>{label}</T>
    </View>
  );
}

/** Text in the theme colour. muted = secondary; size: s (12) / m (14, default) / l (17) / xl (22). */
export function T({ children, muted, bold, size = "m", color, style, selectable, numberOfLines }: { children: ReactNode; muted?: boolean; bold?: boolean; size?: "s" | "m" | "l" | "xl"; color?: string; style?: TextStyle; selectable?: boolean; numberOfLines?: number }) {
  const { colors } = useTheme();
  const fontSize = size === "s" ? 12 : size === "l" ? 17 : size === "xl" ? 22 : 14;
  return (
    <Text selectable={selectable} numberOfLines={numberOfLines} style={[{ color: color ?? (muted ? colors.muted : colors.text), fontSize, fontWeight: bold ? "600" : "400" }, style]}>
      {children}
    </Text>
  );
}

/** A panel with an optional title and a right-hand action. */
export function Card({ title, action, children, style }: { title?: string; action?: ReactNode; children?: ReactNode; style?: ViewStyle }) {
  const { colors } = useTheme();
  return (
    <View style={[{ backgroundColor: colors.panel, borderColor: colors.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14, gap: 10 }, style]}>
      {(title || action) && (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          {title ? <T bold size="l">{title}</T> : <View />}
          {action}
        </View>
      )}
      {children}
    </View>
  );
}

/**
 * A tappable list row: title, optional subtitle, left accessory and a chevron
 * when tappable. Rows are separated by a line above each; first: true leaves
 * it off (the first row of a card without a title).
 */
export function Row({ title, subtitle, left, right, onPress, onLongPress, selected, first }: { title: ReactNode; subtitle?: ReactNode; left?: ReactNode; right?: ReactNode; onPress?: () => void; onLongPress?: () => void; selected?: boolean; first?: boolean }) {
  const { colors } = useTheme();
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      android_ripple={{ color: colors.border }}
      style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, minHeight: 48, borderTopColor: colors.border, borderTopWidth: first ? 0 : StyleSheet.hairlineWidth, backgroundColor: selected ? colors.codeBg : undefined }}
    >
      {left}
      <View style={{ flex: 1, gap: 2 }}>
        {typeof title === "string" ? <T numberOfLines={2}>{title}</T> : title}
        {subtitle ? typeof subtitle === "string" ? <T muted size="s" numberOfLines={2}>{subtitle}</T> : subtitle : null}
      </View>
      {right}
      {onPress && !right ? <Ionicons name="chevron-forward" size={18} color={colors.muted} /> : null}
    </Pressable>
  );
}

/** A button. variant: primary (filled), danger (filled red), plain (outlined). */
export function Button({ title, onPress, variant = "plain", disabled, busy, icon, small }: { title: string; onPress: () => void; variant?: "primary" | "danger" | "plain"; disabled?: boolean; busy?: boolean; icon?: keyof typeof Ionicons.glyphMap; small?: boolean }) {
  const { colors } = useTheme();
  const bg = variant === "primary" ? colors.accent : variant === "danger" ? colors.dangerBg : "transparent";
  const fg = variant === "primary" ? colors.onAccent : variant === "danger" ? colors.onDanger : colors.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || busy}
      accessibilityRole="button"
      android_ripple={{ color: colors.border }}
      style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, backgroundColor: bg, borderColor: variant === "plain" ? colors.borderStrong : bg, borderWidth: 1, borderRadius: 8, paddingHorizontal: small ? 10 : 14, minHeight: small ? 36 : 44, opacity: disabled ? 0.5 : 1 }}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : icon ? <Ionicons name={icon} size={16} color={fg} /> : null}
      <Text style={{ color: fg, fontWeight: "600", fontSize: small ? 13 : 14 }}>{title}</Text>
    </Pressable>
  );
}

/** Buttons side by side, wrapping onto more lines on a narrow screen. */
export function ButtonRow({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{children}</View>;
}

/** A labelled text input, with optional help text underneath. */
export function Field({ label, help, error, ...input }: TextInputProps & { label: string; help?: string; error?: string | null }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: 4 }}>
      <T size="s" muted>{label}</T>
      <TextInput
        placeholderTextColor={colors.muted}
        {...input}
        style={[{ color: colors.text, backgroundColor: colors.bg, borderColor: error ? colors.down : colors.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, fontSize: 15, minHeight: 44 }, input.multiline ? { minHeight: 90, textAlignVertical: "top" } : null, input.style]}
      />
      {help ? <T size="s" muted>{help}</T> : null}
      {error ? <T size="s" color={colors.down}>{error}</T> : null}
    </View>
  );
}

/** A labelled on/off switch row. */
export function Toggle({ label, help, value, onChange, disabled }: { label: string; help?: string; value: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 44 }}>
      <View style={{ flex: 1 }}>
        <T>{label}</T>
        {help ? <T size="s" muted>{help}</T> : null}
      </View>
      <Switch value={value} onValueChange={onChange} disabled={disabled} trackColor={{ true: colors.accent, false: colors.border }} thumbColor={colors.panel} />
    </View>
  );
}

export type Option = { value: string; label: string; sub?: string };

/**
 * A labelled picker: shows the chosen option; tapping opens a full-screen
 * list (searchable when long). multi: pick several, value is then string[].
 */
export function Select({ label, help, options, value, onChange, placeholder = "Choose…", multi }: { label: string; help?: string; options: Option[]; value: string | string[]; onChange: (v: string & string[]) => void; placeholder?: string; multi?: boolean }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  // A single value of "" counts as chosen when an option has that value
  // (e.g. "All sites"); otherwise empty shows the placeholder.
  const chosen = Array.isArray(value) ? value : value || options.some((o) => o.value === "") ? [value] : [];
  const shown = chosen.map((v) => options.find((o) => o.value === v)?.label ?? v).join(", ");
  const list = q ? options.filter((o) => `${o.label} ${o.sub ?? ""}`.toLowerCase().includes(q.toLowerCase())) : options;
  const pick = (v: string) => {
    if (multi) onChange((chosen.includes(v) ? chosen.filter((x) => x !== v) : [...chosen, v]) as string & string[]);
    else {
      onChange(v as string & string[]);
      setOpen(false);
    }
  };
  return (
    <View style={{ gap: 4 }}>
      <T size="s" muted>{label}</T>
      <Pressable onPress={() => setOpen(true)} style={{ flexDirection: "row", alignItems: "center", borderColor: colors.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, minHeight: 44, backgroundColor: colors.bg }}>
        <T style={{ flex: 1 }} muted={!shown} numberOfLines={2}>{shown || placeholder}</T>
        <Ionicons name="chevron-down" size={16} color={colors.muted} />
      </Pressable>
      {help ? <T size="s" muted>{help}</T> : null}
      <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
        <View style={{ flex: 1, backgroundColor: colors.bg }}>
          <View style={{ flexDirection: "row", alignItems: "center", padding: 12, gap: 8, borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth }}>
            <T bold size="l" style={{ flex: 1 }}>{label}</T>
            <Button small title={multi ? "Done" : "Close"} onPress={() => setOpen(false)} variant={multi ? "primary" : "plain"} />
          </View>
          {options.length > 8 && (
            <View style={{ padding: 12 }}>
              <TextInput value={q} onChangeText={setQ} placeholder="Search…" placeholderTextColor={colors.muted} style={{ color: colors.text, borderColor: colors.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, minHeight: 44 }} />
            </View>
          )}
          <FlatList
            data={list}
            keyExtractor={(o) => o.value}
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40 }}
            renderItem={({ item }) => (
              <Row title={item.label} subtitle={item.sub} onPress={() => pick(item.value)} right={chosen.includes(item.value) ? <Ionicons name="checkmark" size={20} color={colors.accent} /> : <View style={{ width: 20 }} />} />
            )}
            ListEmptyComponent={<T muted style={{ padding: 16 }}>Nothing matches.</T>}
          />
        </View>
      </Modal>
    </View>
  );
}

/** A status badge: coloured dot plus the status word (colour is never the only signal). */
export function StatusBadge({ status, small }: { status: string | null | undefined; small?: boolean }) {
  const { colors } = useTheme();
  const color = statusColor(colors, status);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 4, borderColor: color, borderWidth: 1, borderRadius: 10, paddingHorizontal: 6, paddingVertical: small ? 0 : 2, minWidth: small ? 76 : undefined }}>
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />
      <Text style={{ color, fontSize: small ? 10 : 11, fontWeight: "700" }}>{statusLabel(status)}</Text>
    </View>
  );
}

/** A small coloured dot for a status, for dense lists (always next to text that names the item). */
export function Dot({ status }: { status: string | null | undefined }) {
  const { colors } = useTheme();
  return <View accessibilityLabel={statusLabel(status)} style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: statusColor(colors, status) }} />;
}

/** An error message box (red), e.g. a failed request. Shows nothing for null. */
export function ErrorBox({ error }: { error: string | null | undefined }) {
  const { colors } = useTheme();
  if (!error) return null;
  return (
    <View style={{ borderColor: colors.down, borderWidth: 1, borderRadius: 8, padding: 10 }}>
      <T color={colors.down}>{error}</T>
    </View>
  );
}

/** An informational note box (muted). */
export function Note({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warn" | "up" }) {
  const { colors } = useTheme();
  const color = tone === "warn" ? colors.warn : tone === "up" ? colors.up : colors.border;
  return (
    <View style={{ borderColor: color, borderWidth: 1, borderRadius: 8, padding: 10, backgroundColor: colors.codeBg }}>
      {typeof children === "string" ? <T size="s">{children}</T> : children}
    </View>
  );
}

/** "Nothing here yet" text for an empty list. */
export function Empty({ children }: { children: ReactNode }) {
  return <T muted style={{ paddingVertical: 8 }}>{children}</T>;
}

/** A label/value pair on one line, for detail screens. */
export function KeyValue({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
      <T muted size="s" style={{ width: 120 }}>{label}</T>
      <View style={{ flex: 1 }}>{typeof value === "string" || typeof value === "number" ? <T selectable style={mono ? { fontFamily: "monospace", fontSize: 13 } : undefined}>{String(value)}</T> : value}</View>
    </View>
  );
}

/** A filter chip that can be on or off. */
export function Chip({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const { colors } = useTheme();
  return (
    <Pressable onPress={onPress} style={{ borderColor: on ? colors.accent : colors.border, backgroundColor: on ? colors.accent : "transparent", borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, minHeight: 32, justifyContent: "center" }}>
      <Text style={{ color: on ? colors.onAccent : colors.text, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

/** Chips in a wrapping row. */
export function Chips({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>{children}</View>;
}

/**
 * Asks "are you sure?" with the system dialog, then runs the action.
 * Destructive actions always go through this.
 */
export function confirm(title: string, message: string, action: () => void, okLabel = "Delete") {
  Alert.alert(title, message, [
    { text: "Cancel", style: "cancel" },
    { text: okLabel, style: "destructive", onPress: action },
  ]);
}

/** Shows a short message with the system dialog (result of an action, or an error). */
export function tell(title: string, message?: string) {
  Alert.alert(title, message);
}

/** A section heading inside a screen. */
export function Heading({ children }: { children: ReactNode }) {
  return <T bold size="l" style={{ marginTop: 6 }}>{children}</T>;
}
