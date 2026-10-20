// Shared types and small helpers for probes: what a probe receives (config,
// context with its previous state) and returns, and safe readers for config
// values (str, numOr, bool — own properties only, lib/own.ts).

import type { MeasuredResult } from "../thresholds.js";
import { own } from "../../lib/own.js";

export type ProbeContext = {
  checkId: string;
  endpointId: string | null;
  siteId?: string | null;
  intervalSeconds: number;
  // The check's persisted state from its previous run (checks.state).
  state: Record<string, unknown>;
  createdAt?: Date;
};

// `state`, when returned, replaces checks.state. `skip` means "nothing to
// record this run" — e.g. a heartbeat that isn't overdue yet.
export type ProbeOutcome = MeasuredResult & { state?: Record<string, unknown>; skip?: boolean };

export type Config = Record<string, unknown>;

// Answers from device and app APIs (Redfish, Proxmox, Nextcloud, Pi-hole…)
// are third-party JSON read field by field with optional chaining
// (data?.a?.b) and checked before use, so they're typed loosely — here, in
// one place.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped third-party JSON, read defensively
export type ApiJson = any;

export const str = (c: Config, k: string, d = "") => {
  const v = own(c, k);
  return v == null || v === "" ? d : String(v);
};
export const numOr = (c: Config, k: string, d: number) => {
  const v = own(c, k);
  const n = Number(v);
  return v === "" || v == null || !Number.isFinite(n) ? d : n;
};
export const bool = (c: Config, k: string, d = false) => {
  const v = own(c, k);
  return v == null ? d : v === true || v === "true";
};

export const down = (message: string, extra: Partial<ProbeOutcome> = {}): ProbeOutcome => ({ status: "down", latencyMs: null, message, ...extra });
export const warn = (message: string, extra: Partial<ProbeOutcome> = {}): ProbeOutcome => ({ status: "warn", latencyMs: null, message, ...extra });
export const up = (message: string | null, extra: Partial<ProbeOutcome> = {}): ProbeOutcome => ({ status: "up", latencyMs: null, message, ...extra });

export const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));
