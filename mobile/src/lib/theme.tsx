// Colours and the light/dark theme for the whole app. The colour values are
// the dashboard's own theme tokens (dashboard/app/globals.css), checked there
// for readable contrast (WCAG AA), so the app looks like the dashboard.
//
// The user can follow the phone's setting or force light/dark (Settings
// screen); that choice is remembered on the phone. React "context" makes the
// current colours available to every screen without passing them down by hand.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import * as Storage from "./storage";

export type Colors = {
  bg: string;
  panel: string;
  border: string;
  borderStrong: string;
  text: string;
  muted: string;
  up: string;
  down: string;
  warn: string;
  maint: string;
  accent: string;
  series: string;
  onAccent: string;
  dangerBg: string;
  onDanger: string;
  codeBg: string;
};

const dark: Colors = {
  bg: "#0e1319",
  panel: "#19212b",
  border: "#3b4e66",
  borderStrong: "#56708f",
  text: "#eef3f8",
  muted: "#a2b0be",
  up: "#3fb950",
  down: "#ff6b61",
  warn: "#e3a72f",
  maint: "#b39dfb",
  accent: "#3fb950",
  series: "#4493f8",
  onAccent: "#04110a",
  dangerBg: "#f85149",
  onDanger: "#1a0402",
  codeBg: "rgba(0,0,0,0.38)",
};

const light: Colors = {
  bg: "#eceff4",
  panel: "#ffffff",
  border: "#c2cbd6",
  borderStrong: "#8d9bab",
  text: "#111820",
  muted: "#4c5967",
  up: "#16702f",
  down: "#c8202c",
  warn: "#8a5a00",
  maint: "#6d3fd6",
  accent: "#16702f",
  series: "#0969da",
  onAccent: "#ffffff",
  dangerBg: "#c8202c",
  onDanger: "#ffffff",
  codeBg: "#eef1f5",
};

export type ThemeChoice = "system" | "light" | "dark";
type ThemeValue = { colors: Colors; dark: boolean; choice: ThemeChoice; setChoice: (c: ThemeChoice) => void };

const ThemeContext = createContext<ThemeValue>({ colors: light, dark: false, choice: "system", setChoice: () => undefined });
const KEY = "looksee.theme";

/** Provides the colours to the app; wraps everything in app/_layout.tsx. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const system = useColorScheme();
  const [choice, setChoiceState] = useState<ThemeChoice>("system");
  // Loads the saved choice once at start.
  useEffect(() => {
    Storage.getItem(KEY).then((v) => {
      if (v === "light" || v === "dark" || v === "system") setChoiceState(v);
    });
  }, []);
  const value = useMemo<ThemeValue>(() => {
    const isDark = choice === "system" ? system === "dark" : choice === "dark";
    return {
      colors: isDark ? dark : light,
      dark: isDark,
      choice,
      setChoice: (c) => {
        setChoiceState(c);
        void Storage.setItem(KEY, c);
      },
    };
  }, [choice, system]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

/** The current colours and theme choice. */
export const useTheme = () => useContext(ThemeContext);

/** The colour for a check status (up/warn/down/unknown). */
export function statusColor(c: Colors, status: string | null | undefined) {
  if (status === "up") return c.up;
  if (status === "down") return c.down;
  if (status === "warn") return c.warn;
  return c.muted;
}
