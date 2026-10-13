"use client";

import { useEffect, useState } from "react";

type Theme = "system" | "light" | "dark";
const KEY = "looksee.theme";
const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<Theme, string> = { system: "Theme: system", light: "Theme: light", dark: "Theme: dark" };
const ICON: Record<Theme, string> = { system: "◐", light: "☀", dark: "☾" };

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
  const [theme, setTheme] = useState<Theme>("system");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved === "light" || saved === "dark") setTheme(saved);
    } catch {
      // stays system
    }
  }, []);
  return (
    <button
      type="button"
      onClick={() => {
        const next = NEXT[theme];
        applyTheme(next);
        setTheme(next);
      }}
      title={`${LABEL[theme]} — click to switch`}
      aria-label={`${LABEL[theme]}. Switch to ${NEXT[theme]}`}
      className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] px-2 py-0.5 text-[var(--muted)] hover:text-[var(--text)]"
    >
      <span aria-hidden>{ICON[theme]}</span>
      {showLabel && <span className="text-xs">{LABEL[theme]}</span>}
    </button>
  );
}
