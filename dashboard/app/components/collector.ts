import type { Host } from "../lib/api";

// A collector polls the engine every ~15s; a minute of silence is worth
// flagging, three (the engine's own cut-off) means its checks go unknown.
export function collectorState(host: Host): { label: string; tone: "ok" | "warn" | "bad" } {
  if (!host.collectorLastSeenAt) {
    if (host.collectorError) return { label: `not running — ${host.collectorError}`, tone: "bad" };
    return { label: "waiting to start (needs agent 3.2.0+)", tone: "warn" };
  }
  const silent = (Date.now() - new Date(host.collectorLastSeenAt).getTime()) / 1000;
  if (silent > 180) return { label: `offline (last seen ${Math.round(silent / 60)} min ago)`, tone: "bad" };
  if (host.collectorError) return { label: `running with a problem — ${host.collectorError}`, tone: "warn" };
  if (silent > 60) return { label: "late checking in", tone: "warn" };
  return { label: `online${host.collectorVersion ? ` (v${host.collectorVersion})` : ""}`, tone: "ok" };
}
