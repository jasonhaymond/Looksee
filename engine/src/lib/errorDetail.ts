// Turns a thrown error into a log-safe, useful one-paragraph description.
//
// Why this exists: when a database query fails, Drizzle (the ORM — the
// library that builds SQL from TypeScript) throws "Failed query: <SQL>
// params: <every value>". For an agent report those values are the machine's
// whole inventory — serial numbers, IP and MAC addresses, signed-in users,
// installed software — which then landed in the logs, while PostgreSQL's
// actual reason (e.g. "unsupported Unicode escape sequence") was hidden in
// the error's `cause`. This logs the reason and the SQL text (which only
// holds $1, $2… placeholders, never values) and drops the values.
//
// Used by the error handler in app.ts and by routes that catch their own
// database errors (routes/agent.ts).

/** What a database driver error carries (node-postgres's DatabaseError). */
type DbCause = { message?: unknown; code?: unknown; detail?: unknown };

/**
 * A short description of what went wrong, safe to write to the log:
 * - a failed database query → "Database query failed: <PostgreSQL's
 *   message> [SQLSTATE code] (<detail>) — query: <SQL, cut to 300 chars>"
 * - any other error → its own message (cut to 2000 chars)
 * Query parameter values are never included.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err).slice(0, 2000);
  const cause = (err as { cause?: unknown }).cause as DbCause | undefined;
  const query = (err as { query?: unknown }).query;
  // Drizzle's query error: has the SQL in .query and the driver's error in .cause.
  if (typeof query === "string" && cause && typeof cause === "object") {
    const code = typeof cause.code === "string" ? ` [${cause.code}]` : "";
    const detail = typeof cause.detail === "string" && cause.detail ? ` (${cause.detail.slice(0, 300)})` : "";
    return `Database query failed: ${String(cause.message ?? "unknown error").slice(0, 500)}${code}${detail} — query: ${query.replace(/\s+/g, " ").slice(0, 300)}`;
  }
  return err.message.slice(0, 2000);
}

/**
 * The error's stack trace (the list of "at file:line" frames saying where
 * it was thrown) without its message, which for a query error would repeat
 * the parameter values describeError leaves out. At most 12 frames.
 */
export function stackFrames(err: unknown): string {
  if (!(err instanceof Error) || !err.stack) return "";
  // Regex: lines that start with whitespace then "at " — the frame lines of
  // a V8 stack trace, e.g. "    at async file:///…/routes/agent.js:149:5".
  return err.stack
    .split("\n")
    .filter((line) => /^\s+at /.test(line))
    .slice(0, 12)
    .join("\n");
}
