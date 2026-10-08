import type { MeasuredResult } from "../thresholds.js";

export type ProbeContext = {
  checkId: string;
  hostId: string | null;
  endpointId?: string | null;
  intervalSeconds: number;
  // The check's persisted state from its previous run (checks.state).
  state: Record<string, unknown>;
  createdAt?: Date;
};

// `state`, when returned, replaces checks.state. `skip` means "nothing to
// record this run" — e.g. a heartbeat that isn't overdue yet.
export type ProbeOutcome = MeasuredResult & { state?: Record<string, unknown>; skip?: boolean };

export type Config = Record<string, unknown>;

export const str = (c: Config, k: string, d = "") => (c[k] == null || c[k] === "" ? d : String(c[k]));
export const numOr = (c: Config, k: string, d: number) => {
  const n = Number(c[k]);
  return c[k] === "" || c[k] == null || !Number.isFinite(n) ? d : n;
};
export const bool = (c: Config, k: string, d = false) => (c[k] == null ? d : c[k] === true || c[k] === "true");

export const down = (message: string, extra: Partial<ProbeOutcome> = {}): ProbeOutcome => ({ status: "down", latencyMs: null, message, ...extra });
export const warn = (message: string, extra: Partial<ProbeOutcome> = {}): ProbeOutcome => ({ status: "warn", latencyMs: null, message, ...extra });
export const up = (message: string | null, extra: Partial<ProbeOutcome> = {}): ProbeOutcome => ({ status: "up", latencyMs: null, message, ...extra });

export const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
