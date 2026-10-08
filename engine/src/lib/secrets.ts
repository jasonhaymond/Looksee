// Check config keys that hold credentials. They're write-only through the
// API (global security baseline): reads return MASK in their place, and a
// write that sends MASK back (or omits the key) keeps the stored value.
export const SECRET_KEYS = new Set([
  "password",
  "authKey",
  "privKey",
  "tokenSecret",
  "token",
  "bearerToken",
  "smtpPassword",
  "imapPassword",
  "bindPassword",
  "passphrase",
  "extraEnv",
  "uri",
]);

export const MASK = "••••••••";

export function maskConfig(config: unknown): Record<string, unknown> {
  const c = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) out[k] = SECRET_KEYS.has(k) && v !== "" && v != null ? MASK : v;
  return out;
}

export function mergeSecrets(incoming: Record<string, unknown>, existing: unknown): Record<string, unknown> {
  const prev = (existing && typeof existing === "object" ? existing : {}) as Record<string, unknown>;
  const out = { ...incoming };
  for (const key of SECRET_KEYS) {
    if (out[key] === MASK || (out[key] === undefined && prev[key] !== undefined)) {
      if (prev[key] !== undefined) out[key] = prev[key];
      else delete out[key];
    }
  }
  return out;
}

export function maskCheck<T extends { config: unknown }>(check: T): T {
  return { ...check, config: maskConfig(check.config) };
}
