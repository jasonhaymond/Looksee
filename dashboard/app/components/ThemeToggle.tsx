// The light/dark/system theme switch, remembered in this browser
// (lib/useStoredState.ts).

"use client";

import { useStoredState } from "../lib/useStoredState";

type Theme = "system" | "light" | "dark";
const KEY = "looksee.theme";
// System → Light → Dark → System.
const nextTheme = (t: Theme): Theme => (t === "system" ? "light" : t === "light" ? "dark" : "system");
const themeLabel = (t: Theme) => `Theme: ${t}`;
const themeIcon = (t: Theme) => (t === "light" ? "☀" : t === "dark" ? "☾" : "◐");
/** A saved theme, or undefined for anything else stored under the key. */
const parseTheme = (raw: string): Theme | undefined => (raw === "light" || raw === "dark" || raw === "system" ? raw : undefined);

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // preference only
  }
}

// Cycles System → Light → Dark. A per-browser preference, like the
// grouping choices on the Checks page.
export function ThemeToggle({ showLabel = false }: { showLabel?: boolean }) {
  // The saved theme (lib/useStoredState.ts); "system" until one is chosen.
  const [theme, setTheme] = useStoredState<Theme>(KEY, "system", parseTheme, String);
  const next = nextTheme(theme);
  const label = themeLabel(theme);
  return (
    <button
      type="button"
      onClick={() => {
        applyTheme(next);
        setTheme(next);
      }}
      title={`${label} — click to switch`}
      aria-label={`${label}. Switch to ${next}`}
      className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2 py-0.5 text-[var(--muted)] hover:text-[var(--text)]"
    >
      <span aria-hidden>{themeIcon(theme)}</span>
      {showLabel && <span className="text-xs">{label}</span>}
    </button>
  );
}
