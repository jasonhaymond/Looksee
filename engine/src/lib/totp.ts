// Time-based one-time codes (TOTP, RFC 6238) for the mandatory two-factor
// sign-in, plus the one-time recovery codes.
//
// Where this sits: routes/auth.ts enrolls an authenticator app (secret +
// otpauth:// link for the QR code) and checks codes at sign-in. Security: a
// code is accepted for its 30-second step and one step either side (clock
// drift), and each step can be used only once per user (consumeTotp), so a
// code seen over someone's shoulder can't be replayed.

import crypto from "node:crypto";

// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) — what every authenticator app
// (Google/Microsoft Authenticator, 1Password, Aegis…) uses by default.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const generateTotpSecret = () => base32Encode(crypto.randomBytes(20));

export function totpCode(secret: string, time = Date.now(), step = 30): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(time / 1000 / step)));
  const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 15;
  const bin = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 1_000_000).padStart(6, "0");
}

// The 30-second step a code belongs to (one step either side allows for
// phone/server clock drift), or null if it doesn't match.
export function totpStep(secret: string, code: string, time = Date.now()): number | null {
  const c = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  for (const d of [-1, 0, 1]) {
    const t = time + d * 30_000;
    if (crypto.timingSafeEqual(Buffer.from(totpCode(secret, t)), Buffer.from(c))) return Math.floor(t / 30_000);
  }
  return null;
}

export function verifyTotp(secret: string, code: string, time = Date.now()): boolean {
  return totpStep(secret, code, time) !== null;
}

// Each code is good once: a code seen over someone's shoulder (or replayed
// from a captured request) can't be used again within its validity window.
// In memory is enough — the window is 90 seconds and there's one engine.
const lastUsedStep = new Map<string, number>();
export function consumeTotp(userId: string, secret: string, code: string, time = Date.now()): boolean {
  const step = totpStep(secret, code, time);
  if (step === null) return false;
  if (step <= (lastUsedStep.get(userId) ?? -1)) return false;
  lastUsedStep.set(userId, step);
  return true;
}

export function otpauthUri(secret: string, account: string, issuer = "Looksee"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// Ten one-time codes like "k3f9-x2md", shown once at enrollment.
export function generateRecoveryCodes(n = 10): string[] {
  const chars = "abcdefghjkmnpqrstuvwxyz23456789";
  return Array.from({ length: n }, () => {
    const b = crypto.randomBytes(8);
    const s = [...b].map((x) => chars[x % chars.length]).join("");
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}
