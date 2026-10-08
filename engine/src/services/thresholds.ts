export type Status = "up" | "down" | "warn" | "unknown";

const RANK: Record<Status, number> = { up: 0, unknown: 1, warn: 2, down: 3 };

export function worst(a: Status, b: Status): Status {
  return RANK[a] >= RANK[b] ? a : b;
}

function num(v: unknown): number | undefined {
  if (v === "" || v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export type ValueThresholds = { warnBelow?: number; criticalBelow?: number; warnAbove?: number; criticalAbove?: number };

export function readValueThresholds(config: Record<string, unknown>): ValueThresholds {
  return {
    warnBelow: num(config.warnBelow),
    criticalBelow: num(config.criticalBelow),
    warnAbove: num(config.warnAbove),
    criticalAbove: num(config.criticalAbove),
  };
}

export function hasThresholds(t: ValueThresholds): boolean {
  return t.warnBelow != null || t.criticalBelow != null || t.warnAbove != null || t.criticalAbove != null;
}

// Four independent optional directions rather than one operator — some
// values are bad when LOW (battery %, free GB, days left) and others when
// HIGH (temperature, latency), and a check may care about both.
export function evaluateValue(value: number, t: ValueThresholds, unit = ""): { status: Status; message: string | null } {
  const v = `${round(value)}${unit}`;
  if (t.criticalBelow != null && value < t.criticalBelow) return { status: "down", message: `${v} is below critical threshold ${t.criticalBelow}${unit}` };
  if (t.criticalAbove != null && value > t.criticalAbove) return { status: "down", message: `${v} is above critical threshold ${t.criticalAbove}${unit}` };
  if (t.warnBelow != null && value < t.warnBelow) return { status: "warn", message: `${v} is below warn threshold ${t.warnBelow}${unit}` };
  if (t.warnAbove != null && value > t.warnAbove) return { status: "warn", message: `${v} is above warn threshold ${t.warnAbove}${unit}` };
  return { status: "up", message: null };
}

export function round(n: number): number {
  return Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
}

export type MeasuredResult = {
  status: Status;
  latencyMs: number | null;
  message: string | null;
  value?: number | null;
  details?: unknown;
};

// Applied to every result, engine- or agent-measured, so a threshold means
// the same thing on every check type: value thresholds against `value`,
// latencyWarnMs/latencyCriticalMs against `latencyMs`. Only ever makes a
// result worse — a down from the probe itself is never upgraded.
export function applyThresholds<T extends MeasuredResult>(result: T, config: Record<string, unknown>, unit = ""): T {
  let { status, message } = result;
  const notes: string[] = [];

  const t = readValueThresholds(config);
  if (result.value != null && hasThresholds(t) && status !== "down") {
    const v = evaluateValue(result.value, t, unit);
    if (RANK[v.status] > RANK[status]) {
      status = v.status;
      if (v.message) notes.push(v.message);
    }
  }

  const latWarn = num(config.latencyWarnMs);
  const latCrit = num(config.latencyCriticalMs);
  if (result.latencyMs != null && status !== "down") {
    if (latCrit != null && result.latencyMs > latCrit) {
      status = "down";
      notes.push(`Response took ${result.latencyMs}ms (critical over ${latCrit}ms)`);
    } else if (latWarn != null && result.latencyMs > latWarn && RANK[status] < RANK.warn) {
      status = "warn";
      notes.push(`Response took ${result.latencyMs}ms (warn over ${latWarn}ms)`);
    }
  }

  if (notes.length) message = [notes.join("; "), message].filter(Boolean).join(" — ");
  return { ...result, status, message };
}
