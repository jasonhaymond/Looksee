// A list of actions that slides up from the bottom ("what do you want to do
// with these 5 checks?"). Each action has a label and, for destructive ones,
// danger: true (shown in red). Tapping an action closes the sheet and runs it.

import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useTheme } from "../lib/theme";
import { T } from "./ui";

export type SheetAction = { label: string; onPress: () => void; danger?: boolean; help?: string };

/** @param actions null hides the sheet. */
export function ActionSheet({ title, actions, onClose }: { title?: string; actions: SheetAction[] | null; onClose: () => void }) {
  const { colors } = useTheme();
  return (
    <Modal visible={actions != null} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.45)" }} onPress={onClose} />
      <View style={{ backgroundColor: colors.panel, borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: "75%", paddingBottom: 24 }}>
        {title ? <T bold size="l" style={{ padding: 16, paddingBottom: 8 }}>{title}</T> : null}
        <ScrollView>
          {(actions ?? []).map((a) => (
            <Pressable
              key={a.label}
              android_ripple={{ color: colors.border }}
              onPress={() => {
                onClose();
                a.onPress();
              }}
              style={{ paddingHorizontal: 16, paddingVertical: 12, minHeight: 48, borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth }}
            >
              <T color={a.danger ? colors.down : colors.text}>{a.label}</T>
              {a.help ? <T size="s" muted>{a.help}</T> : null}
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </Modal>
  );
}
