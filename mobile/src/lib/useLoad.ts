// A small "load data for this screen" hook: runs a request when the screen
// comes into view (and again each time it's returned to), tracks loading and
// errors, and offers reload() for pull-to-refresh. Optionally repeats every
// N seconds while the screen is visible, like the dashboard's polling.
//
// Hooks are React functions (named use…) that keep state for a component.

import { useCallback, useRef, useState } from "react";
import { useFocusEffect } from "expo-router";
import { errorText } from "./format";

export type Loaded<T> = {
  data: T | undefined;
  error: string | null;
  // true during the first load only (screens show a spinner then).
  loading: boolean;
  // true while a pull-to-refresh reload runs.
  refreshing: boolean;
  reload: () => Promise<void>;
  setData: (d: T) => void;
};

/**
 * @param load the request(s) to run; must be wrapped in useCallback by the caller or be stable
 * @param pollSeconds repeat this often while the screen is focused (0 = no polling)
 */
export function useLoad<T>(load: () => Promise<T>, pollSeconds = 0): Loaded<T> {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Ignores an answer from an older request that arrives after a newer one.
  const generation = useRef(0);

  const run = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const result = await load();
      if (mine !== generation.current) return;
      setData(result);
      setError(null);
    } catch (err) {
      if (mine === generation.current) setError(errorText(err));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [load]);

  // Runs when the screen is shown (and when `run` changes, i.e. its inputs did).
  useFocusEffect(
    useCallback(() => {
      void run();
      if (!pollSeconds) return undefined;
      const timer = setInterval(() => void run(), pollSeconds * 1000);
      return () => clearInterval(timer);
    }, [run, pollSeconds])
  );

  const reload = useCallback(async () => {
    setRefreshing(true);
    await run();
    setRefreshing(false);
  }, [run]);

  return { data, error, loading: loading && data === undefined, refreshing, reload, setData };
}
