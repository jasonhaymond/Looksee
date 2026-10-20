// Live-data polling that leaves the person using the page alone.
//
// Where this sits: every page and widget that refreshes its data on a timer
// (Checks, Endpoints, dashboards, Alerts, Logs, Backups, …) calls
// pollEvery() instead of the browser's setInterval(). Each refresh re-draws
// the page, and a re-draw can disturb whatever the user is doing at that
// moment: mobile browsers close an open dropdown picker (and some reset its
// choice) when the page around it is re-drawn, and highlighted text can lose
// its highlight. So a refresh is skipped while the user is busy — typing in
// or choosing from a form field, or highlighting text — and the data catches
// up on the next tick once they're done.
//
// "Busy" also has a time limit: a field that stays focused with no typing,
// tapping or clicking for a minute no longer pauses refreshes, so a page
// left with the cursor in a search box still updates.

/** How long after the last tap, click or key press the user counts as busy. */
const BUSY_FOR_MS = 60_000;

// Input types that are buttons or toggles: focusing one doesn't open a
// picker or hold typed text, so it never pauses refreshes.
const NOT_TEXT_INPUTS = new Set(["button", "submit", "reset", "checkbox", "radio", "image", "file", "color", "range", "hidden"]);

// When the user last tapped, clicked, typed or changed a field (ms since
// epoch). Updated by the listeners below; 0 until the first interaction.
let lastInteraction = 0;

// Register the listeners once, in the browser only (this module is also
// loaded during Next.js's server-side render, where there's no document).
// "capture: true" sees the event before any page code can stop it.
if (typeof document !== "undefined") {
  const mark = () => {
    lastInteraction = Date.now();
  };
  for (const type of ["pointerdown", "keydown", "input", "change"]) {
    document.addEventListener(type, mark, { capture: true, passive: true });
  }
}

/**
 * Whether the user is in the middle of something a refresh would disturb:
 * a text field, text box or dropdown has focus, or some text is
 * highlighted — and they've interacted within the last minute.
 *
 * @returns true to skip this refresh
 */
export function userIsBusy(): boolean {
  if (typeof document === "undefined") return false;
  if (Date.now() - lastInteraction > BUSY_FOR_MS) return false;
  const el = document.activeElement;
  // A focused dropdown, text box or contenteditable area (rich text).
  if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement && !NOT_TEXT_INPUTS.has(el.type)) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  // Highlighted text (e.g. being selected to copy). A collapsed selection
  // is just a caret position, not a highlight.
  const selection = window.getSelection();
  return !!selection && !selection.isCollapsed && selection.toString().trim() !== "";
}

/**
 * Calls `refresh` every `ms` milliseconds, skipping any tick where the user
 * is busy (see userIsBusy). A drop-in replacement for setInterval: returns
 * the timer ID, which clearInterval() stops as usual.
 *
 * @param refresh the function that reloads the data
 * @param ms the time between refreshes, in milliseconds
 */
export function pollEvery(refresh: () => unknown, ms: number): ReturnType<typeof setInterval> {
  return setInterval(() => {
    if (!userIsBusy()) refresh();
  }, ms);
}
