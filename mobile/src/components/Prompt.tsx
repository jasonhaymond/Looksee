// A one-field question dialog ("Maintenance for how many minutes?"). Android
// has no built-in text prompt, so screens use this hook instead:
//
//   const [prompt, ask] = usePrompt();
//   const minutes = await ask({ title: "Maintenance", label: "Minutes", initial: "60", numeric: true });
//   …and render {prompt} somewhere in the screen.
//
// ask() resolves to the text entered, or null when cancelled.

import { useCallback, useRef, useState } from "react";
import { Modal, View } from "react-native";
import { useTheme } from "../lib/theme";
import { Button, ButtonRow, Field, T } from "./ui";

type Ask = { title: string; label: string; message?: string; initial?: string; numeric?: boolean; okLabel?: string; secure?: boolean };

/** Out: [the dialog element to render, ask(question) → Promise<answer | null>]. */
export function usePrompt(): [React.ReactNode, (q: Ask) => Promise<string | null>] {
  const { colors } = useTheme();
  const [question, setQuestion] = useState<Ask | null>(null);
  const [value, setValue] = useState("");
  // The pending ask()'s resolve function, called when the dialog closes.
  const resolver = useRef<((v: string | null) => void) | null>(null);

  const ask = useCallback((q: Ask) => {
    setQuestion(q);
    setValue(q.initial ?? "");
    return new Promise<string | null>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const close = (answer: string | null) => {
    resolver.current?.(answer);
    resolver.current = null;
    setQuestion(null);
  };

  const element = (
    <Modal visible={question != null} transparent animationType="fade" onRequestClose={() => close(null)}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "center", padding: 24 }}>
        <View style={{ backgroundColor: colors.panel, borderRadius: 12, padding: 16, gap: 12 }}>
          <T bold size="l">{question?.title}</T>
          {question?.message ? <T muted>{question.message}</T> : null}
          <Field label={question?.label ?? ""} value={value} onChangeText={setValue} autoFocus keyboardType={question?.numeric ? "number-pad" : "default"} secureTextEntry={question?.secure} onSubmitEditing={() => close(value)} />
          <ButtonRow>
            <Button title="Cancel" onPress={() => close(null)} />
            <Button title={question?.okLabel ?? "OK"} variant="primary" onPress={() => close(value)} />
          </ButtonRow>
        </View>
      </View>
    </Modal>
  );
  return [element, ask];
}
