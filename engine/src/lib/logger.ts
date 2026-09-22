import { lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { logs } from "../db/schema.js";

type Metadata = Record<string, unknown>;

function write(level: string, source: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${source}] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

// Never awaited by callers — a logging failure must never break the request/
// job that triggered it. Failures here go to stdout only, not recursively
// back through this same logger.
function persist(level: "debug" | "info" | "warn" | "error", source: string, message: string, humanMessage: string | null, metadata?: Metadata): void {
  db.insert(logs)
    .values({ level, source, message, humanMessage, metadata: metadata ?? null })
    .catch((err) => console.error(`[logger] failed to persist a ${level} log entry:`, err));
}

function debug(source: string, message: string, metadata?: Metadata): void {
  write("debug", source, message);
  persist("debug", source, message, null, metadata);
}

function info(source: string, message: string, human: string, metadata?: Metadata): void {
  write("info", source, message);
  persist("info", source, message, human, metadata);
}

function warn(source: string, message: string, human: string, metadata?: Metadata): void {
  write("warn", source, message);
  persist("warn", source, message, human, metadata);
}

function error(source: string, message: string, human: string, metadata?: Metadata): void {
  write("error", source, message);
  persist("error", source, message, human, metadata);
}

export const logger = { debug, info, warn, error };

// Keeps the logs table from growing unbounded — mirrors the retention
// pattern the Borg backup pruning already uses in this codebase, just
// time-based instead of count-based. Called on a daily cron from index.ts.
export async function pruneLogs(): Promise<void> {
  const retentionDays = Number(process.env.LOOKSEE_LOG_RETENTION_DAYS ?? 30);
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  await db.delete(logs).where(lt(logs.createdAt, cutoff));
}
