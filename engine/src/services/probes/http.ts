import http from "node:http";
import https from "node:https";
import { type Config, type ProbeOutcome, bool, down, errMsg, numOr, str } from "./types.js";

// "Name: value" per line, as typed into the check form's headers textarea.
// Blank lines and lines without a colon are skipped rather than erroring,
// so a stray trailing newline doesn't break the check.
export function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (name) headers[name] = value;
  }
  return headers;
}

export type HttpResponse = { status: number; headers: http.IncomingHttpHeaders; body: string; latencyMs: number; finalUrl: string; redirects: string[] };

// One code path for http and https (and insecure https), with redirects
// followed by hand so the chain and final URL can be checked (A5) — fetch
// hides both and can't skip TLS verification per request.
export async function httpRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string; insecure?: boolean; followRedirects?: boolean; maxRedirects?: number; timeoutMs?: number; maxBodyBytes?: number }
): Promise<HttpResponse> {
  const start = Date.now();
  const redirects: string[] = [];
  let current = url;
  let method = opts.method ?? "GET";
  let body = opts.body;
  const max = opts.maxRedirects ?? 10;
  for (;;) {
    const res = await singleRequest(current, { ...opts, method, body });
    const location = res.headers.location;
    if (opts.followRedirects !== false && location && res.status >= 300 && res.status < 400) {
      if (redirects.length >= max) throw new Error(`More than ${max} redirects`);
      const next = new URL(location, current).toString();
      redirects.push(next);
      // 303 (and, by browser convention, 301/302 after a POST) switch to GET.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      current = next;
      continue;
    }
    return { ...res, latencyMs: Date.now() - start, finalUrl: current, redirects };
  }
}

function singleRequest(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string; insecure?: boolean; timeoutMs?: number; maxBodyBytes?: number }) {
  const u = new URL(url);
  const lib = u.protocol === "https:" ? https : http;
  const maxBody = opts.maxBodyBytes ?? 2_000_000;
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = lib.request(
      u,
      {
        method: opts.method ?? "GET",
        headers: { "User-Agent": "Looksee-Monitor", ...(opts.headers ?? {}) },
        rejectUnauthorized: !opts.insecure,
        timeout: opts.timeoutMs ?? 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= maxBody) chunks.push(chunk);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf-8") }));
        res.on("error", reject);
      }
    );
    req.once("timeout", () => req.destroy(new Error("Request timed out")));
    req.once("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// Minimal JSONPath: $.a.b[0].c / a.b.0.c / $["key with space"]. Enough for
// "is this health field ok" without pulling in a full JSONPath engine.
export function jsonPathGet(obj: unknown, path: string): unknown {
  const tokens: string[] = [];
  const re = /\[\s*(?:"([^"]*)"|'([^']*)'|(\d+))\s*\]|\.?([^.[\]]+)/g;
  const cleaned = path.trim().replace(/^\$/, "");
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) tokens.push(m[1] ?? m[2] ?? m[3] ?? m[4]);
  let cur: unknown = obj;
  for (const t of tokens) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[t];
  }
  return cur;
}

export function compareJson(actual: unknown, operator: string, expected: string): boolean {
  const aNum = Number(actual);
  const eNum = Number(expected);
  const aStr = typeof actual === "object" ? JSON.stringify(actual) : String(actual);
  switch (operator) {
    case "exists":
      return actual !== undefined;
    case "not_equals":
      return aStr !== expected;
    case "contains":
      return aStr.includes(expected);
    case "gt":
      return Number.isFinite(aNum) && aNum > eNum;
    case "lt":
      return Number.isFinite(aNum) && aNum < eNum;
    default:
      return aStr === expected;
  }
}

function statusMatches(status: number, expected: string): boolean {
  if (!expected) return status < 400;
  return expected.split(",").some((part) => {
    const p = part.trim();
    const range = p.match(/^(\d{3})\s*-\s*(\d{3})$/);
    if (range) return status >= Number(range[1]) && status <= Number(range[2]);
    if (/^\dxx$/i.test(p)) return Math.floor(status / 100) === Number(p[0]);
    return status === Number(p);
  });
}

export async function probeHttp(config: Config): Promise<ProbeOutcome> {
  const url = str(config, "url");
  if (!url) return { status: "warn", latencyMs: null, message: "Missing url" };
  let res: HttpResponse;
  try {
    res = await httpRequest(url, {
      method: str(config, "method", "GET"),
      headers: parseHeaders(str(config, "headers")),
      body: str(config, "body") || undefined,
      insecure: bool(config, "insecureSkipVerify"),
      followRedirects: bool(config, "followRedirects", true),
      maxRedirects: numOr(config, "maxRedirects", 10),
      timeoutMs: numOr(config, "timeoutSeconds", 10) * 1000,
    });
  } catch (err) {
    return down(errMsg(err));
  }
  const details = { statusCode: res.status, finalUrl: res.finalUrl, redirects: res.redirects };
  const fail = (message: string) => ({ status: "down" as const, latencyMs: res.latencyMs, message, details });

  if (!statusMatches(res.status, str(config, "expectedStatus"))) return fail(`HTTP ${res.status}`);
  const contains = str(config, "bodyContains");
  if (contains && !res.body.includes(contains)) return fail(`Response didn't contain "${contains}"`);
  const notContains = str(config, "bodyNotContains");
  if (notContains && res.body.includes(notContains)) return fail(`Response contained "${notContains}"`);
  const regex = str(config, "bodyRegex");
  if (regex) {
    let re: RegExp;
    try {
      re = new RegExp(regex, "m");
    } catch {
      return { status: "warn", latencyMs: res.latencyMs, message: `Invalid regex: ${regex}` };
    }
    if (!re.test(res.body)) return fail(`Response didn't match /${regex}/`);
  }
  const finalUrl = str(config, "expectedFinalUrl");
  if (finalUrl && res.finalUrl !== finalUrl && res.finalUrl.replace(/\/$/, "") !== finalUrl.replace(/\/$/, "")) {
    return fail(`Ended at ${res.finalUrl}, expected ${finalUrl}`);
  }
  const maxRedirectsAllowed = config.maxRedirectsAllowed;
  if (maxRedirectsAllowed !== "" && maxRedirectsAllowed != null && res.redirects.length > Number(maxRedirectsAllowed)) {
    return { status: "warn", latencyMs: res.latencyMs, message: `${res.redirects.length} redirects (allowed ${maxRedirectsAllowed})`, details };
  }

  let value: number | null = null;
  const path = str(config, "jsonPath");
  if (path) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      return fail("Response isn't valid JSON");
    }
    const actual = jsonPathGet(parsed, path);
    const op = str(config, "jsonOperator", "equals");
    const expected = str(config, "jsonExpected");
    if ((expected !== "" || op === "exists") && !compareJson(actual, op, expected)) {
      return fail(`${path} is ${actual === undefined ? "missing" : JSON.stringify(actual)}, expected ${op} ${expected}`.trim());
    }
    if (typeof actual === "number" || (typeof actual === "string" && actual.trim() !== "" && Number.isFinite(Number(actual)))) value = Number(actual);
  }
  return { status: "up", latencyMs: res.latencyMs, message: value != null ? `${path} = ${value}` : null, value, details };
}
