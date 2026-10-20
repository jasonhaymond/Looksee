import { and, isNotNull, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { checkResults, events, flowRecords, endpointMetrics, ipBlocks, loginChallenges, securityEvents, sessions } from "../db/schema.js";

const days = (env: string | undefined, fallback: number) => {
  const n = Number(env);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const ago = (d: number) => new Date(Date.now() - d * 86_400_000);

// Daily cleanup of the time-series tables. check_results rows are kept long
// enough for yearly SLA reports, but their bulky `details` blobs (interface
// tables, hop lists) only for a week.
export async function pruneData() {
  await db.delete(checkResults).where(lt(checkResults.checkedAt, ago(days(process.env.CHECK_RESULT_RETENTION_DAYS, 400))));
  await db.update(checkResults).set({ details: null }).where(and(lt(checkResults.checkedAt, ago(7)), isNotNull(checkResults.details)));
  await db.delete(endpointMetrics).where(lt(endpointMetrics.recordedAt, ago(days(process.env.HOST_METRICS_RETENTION_DAYS, 30))));
  await db.delete(events).where(lt(events.receivedAt, ago(days(process.env.EVENT_RETENTION_DAYS, 30))));
  await db.delete(flowRecords).where(lt(flowRecords.bucket, ago(days(process.env.FLOW_RETENTION_DAYS, 7))));
  await db.delete(securityEvents).where(lt(securityEvents.createdAt, ago(days(process.env.SECURITY_EVENT_RETENTION_DAYS, 180))));
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  await db.delete(loginChallenges).where(lt(loginChallenges.expiresAt, new Date()));
  await db.delete(ipBlocks).where(and(isNotNull(ipBlocks.until), lt(ipBlocks.until, ago(1))));
}
