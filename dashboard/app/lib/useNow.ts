// "What time is it now", for components that show live times ("12 min ago",
// the clock widget, "online" if seen recently).
//
// Why a hook: React expects rendering to give the same result every time for
// the same inputs, so reading the clock (Date.now()) while rendering is
// "impure" and its lint rules flag it. Instead, one shared timer ticks every
// second and components subscribe to it with useSyncExternalStore (React's
// way to read a value that lives outside React); they re-render when it
// ticks. The timer only runs while something is subscribed.

import { useSyncExternalStore } from "react";

let now = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Starts listening; the timer runs while there's at least one listener. */
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (!timer) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      for (const l of listeners) l();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** The current time in milliseconds, updated every second. */
export function useNow(): number {
  return useSyncExternalStore(
    subscribe,
    () => now,
    // 0 during server rendering (there's no ticking clock there); the first
    // render in the browser replaces it. Components treat 0 as "not yet".
    () => 0
  );
}
