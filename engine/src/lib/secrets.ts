// Check config keys that hold credentials. They're write-only through the
// API (global security baseline): reads return MASK in their place, and a
// write that sends MASK back (or omits the key) keeps the stored value.

import { deleteOwn, own, setOwn } from "../lib/own.js";
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
  // DNS zone check: the TSIG key that authorizes zone transfers.
  "tsigSecret",
]);

export const MASK = "••••••••";

export function maskConfig(config: unknown): Record<string, unknown> {
  const c = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(c)) setOwn(out, k, SECRET_KEYS.has(k) && v !== "" && v != null ? MASK : v);
  return out;
}

export function mergeSecrets(incoming: Record<string, unknown>, existing: unknown): Record<string, unknown> {
  const prev = (existing && typeof existing === "object" ? existing : {}) as Record<string, unknown>;
  const out = { ...incoming };
  for (const key of SECRET_KEYS) {
    const sent = own(out, key);
    const stored = own(prev, key);
    if (sent === MASK || (sent === undefined && stored !== undefined)) {
      if (stored !== undefined) setOwn(out, key, stored);
      else deleteOwn(out, key);
    }
  }
  return out;
}

export function maskCheck<T extends { config: unknown }>(check: T): T {
  return { ...check, config: maskConfig(check.config) };
}
