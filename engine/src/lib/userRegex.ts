// Regular expressions typed by an admin into a check's settings — "response
// body must match", "only interfaces matching", "banner must match",
// "expected output matches", Prometheus label matchers.
//
// Why not JavaScript's own RegExp: its matcher can take exponential time on
// some patterns ("catastrophic backtracking", e.g. (a+)+$ against a long
// line), and because the engine runs everything on one thread, one such
// pattern would freeze all monitoring. These patterns are run by RE2 (the
// re2js package), which matches in time proportional to the text's length
// whatever the pattern — the same engine the Go agent already uses. The
// trade-off: RE2 has no look-ahead/look-behind or back-references; a
// pattern using them is reported as invalid.
//
// Limits: patterns over 1000 characters are refused, and at most 1 MB of
// text is searched.

import { RE2JS } from "re2js";

const MAX_PATTERN = 1000;
const MAX_TEXT = 1_000_000;

/** A compiled admin-supplied pattern. */
export type UserRegex = {
  /** Whether the pattern occurs anywhere in the text. */
  test(text: string): boolean;
  /** The first match and its groups ([whole, group1, …]), or null. */
  exec(text: string): (string | null)[] | null;
};

/**
 * Compiles a pattern typed by an admin.
 *
 * @param pattern the regular expression (RE2 syntax)
 * @param opts ignoreCase (i), multiline (^ and $ match at every line — m),
 *   whole (the pattern must match the entire text)
 * @throws Error with a readable message when the pattern is invalid or too long
 */
export function compileUserRegex(pattern: string, opts: { ignoreCase?: boolean; multiline?: boolean; whole?: boolean } = {}): UserRegex {
  if (pattern.length > MAX_PATTERN) throw new Error(`Pattern is longer than ${MAX_PATTERN} characters`);
  const flags = (opts.ignoreCase ? RE2JS.CASE_INSENSITIVE : 0) | (opts.multiline ? RE2JS.MULTILINE : 0);
  let re: ReturnType<typeof RE2JS.compile>;
  try {
    re = RE2JS.compile(opts.whole ? `^(?:${pattern})$` : pattern, flags);
  } catch (err) {
    throw new Error(`Invalid pattern: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  const cap = (text: string) => (text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text);
  return {
    test: (text) => re.matcher(cap(text)).find(),
    exec: (text) => {
      const m = re.matcher(cap(text));
      if (!m.find()) return null;
      const out: (string | null)[] = [];
      for (let g = 0; g <= m.groupCount(); g++) out.push(m.group(g));
      return out;
    },
  };
}
