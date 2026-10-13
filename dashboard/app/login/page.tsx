"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import qrcode from "qrcode-generator";
import { startAuthentication } from "@simplewebauthn/browser";
import { api, ApiError, type LoginStep } from "../lib/api";
import { ThemeToggle } from "../components/ThemeToggle";

const field = "mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-3 py-2 outline-none focus:border-[var(--accent)]";
const primary = "w-full rounded-md bg-[var(--accent)] px-3 py-2 font-medium text-[var(--on-accent)] disabled:opacity-50";

function Qr({ text }: { text: string }) {
  const svg = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [text]);
  // QR codes need dark-on-light to scan, whatever the theme.
  return <div className="mx-auto w-48 rounded-md bg-white p-2" aria-label="QR code for your authenticator app" dangerouslySetInnerHTML={{ __html: svg }} />;
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<LoginStep | null>(null);
  const [code, setCode] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function run(fn: () => Promise<void>) {
    setError(null);
    setLoading(true);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed");
    } finally {
      setLoading(false);
    }
  }

  const password1 = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      setStep(await api.login(email, password));
      setCode("");
      setEmailCode("");
    });
  };

  const usePasskey = () => {
    if (!step?.passkey) return;
    run(async () => {
      let response;
      try {
        response = await startAuthentication({ optionsJSON: step.passkey! });
      } catch {
        throw new ApiError(400, "The passkey prompt was cancelled or timed out — try again, or use your authenticator code.");
      }
      await api.verifyLogin({ challengeId: step.challengeId, passkey: response, ...(step.emailCode ? { emailCode } : {}) });
      router.push("/");
    });
  };

  const verify = (e: React.FormEvent) => {
    e.preventDefault();
    if (!step) return;
    run(async () => {
      const res = await api.verifyLogin({ challengeId: step.challengeId, ...(useRecovery ? { recoveryCode: code } : { code }), ...(step.emailCode ? { emailCode } : {}) });
      if (res.recoveryCodes) setRecoveryCodes(res.recoveryCodes);
      else router.push("/");
    });
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-4 sm:p-6">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="surface w-full max-w-sm rounded-xl p-6">
        <h1 className="mb-1 text-xl font-semibold">Looksee</h1>

        {recoveryCodes ? (
          <div className="space-y-4 text-sm">
            <p className="text-[var(--muted)]">Two-factor authentication is set up. These recovery codes each sign you in once if you lose your phone — this is the only time they&apos;re shown.</p>
            <ul className="grid grid-cols-2 gap-1 rounded-md bg-[var(--code-bg)] p-3 font-mono text-sm">
              {recoveryCodes.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <button type="button" className="text-xs underline" onClick={() => navigator.clipboard.writeText(recoveryCodes.join("\n"))}>
              Copy all
            </button>
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} className="mt-1 accent-[var(--accent)]" />
              I&apos;ve saved these somewhere safe (a password manager), not just on this screen.
            </label>
            <button className={primary} disabled={!saved} onClick={() => router.push("/")}>
              Continue to Looksee
            </button>
          </div>
        ) : !step ? (
          <form onSubmit={password1}>
            <p className="mb-5 text-sm text-[var(--muted)]">Sign in</p>
            <label className="mb-3 block text-sm">
              Email
              <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className={field} />
            </label>
            <label className="mb-4 block text-sm">
              Password
              <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className={field} />
            </label>
            {error && <p className="mb-4 text-sm text-[var(--down)]">{error}</p>}
            <button type="submit" disabled={loading} className={primary}>
              {loading ? "Checking…" : "Continue"}
            </button>
          </form>
        ) : (
          <form onSubmit={verify} className="space-y-4 text-sm">
            {step.step === "enroll" && step.enroll ? (
              <>
                <p className="text-[var(--muted)]">Two-factor authentication is required. Scan this with an authenticator app (Microsoft or Google Authenticator, 1Password, Aegis…), then enter the 6-digit code it shows.</p>
                <Qr text={step.enroll.uri} />
                <details className="text-xs text-[var(--muted)]">
                  <summary className="cursor-pointer">Can&apos;t scan? Enter this key instead</summary>
                  <code className="mt-1 block break-all rounded bg-[var(--code-bg)] p-2 font-mono text-[var(--text)]">{step.enroll.secret.replace(/(.{4})/g, "$1 ").trim()}</code>
                </details>
              </>
            ) : (
              <p className="text-[var(--muted)]">{useRecovery ? "Enter one of your recovery codes." : step.passkey ? "Use your passkey or security key, or the 6-digit code from your authenticator app." : "Enter the 6-digit code from your authenticator app."}</p>
            )}
            {step.emailCode && (
              <label className="block">
                Code emailed to you <span className="text-xs text-[var(--muted)]">(new IP address)</span>
                <input inputMode="numeric" autoComplete="one-time-code" required value={emailCode} onChange={(e) => setEmailCode(e.target.value)} className={field} />
              </label>
            )}
            {step.passkey && !useRecovery && (
              <>
                <button type="button" onClick={usePasskey} disabled={loading || (step.emailCode && !emailCode)} className={primary}>
                  Use a passkey or security key
                </button>
                <div className="flex items-center gap-2 text-xs text-[var(--muted)]">
                  <span className="h-px flex-1 bg-[var(--border)]" />
                  or enter a code
                  <span className="h-px flex-1 bg-[var(--border)]" />
                </div>
              </>
            )}
            <label className="block">
              {useRecovery ? "Recovery code" : "Authenticator code"}
              <input autoFocus={!step.passkey} inputMode={useRecovery ? "text" : "numeric"} autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} placeholder={useRecovery ? "abcd-efgh" : "123 456"} className={field} />
            </label>
            {error && <p className="text-[var(--down)]">{error}</p>}
            <button type="submit" disabled={loading} className={primary}>
              {loading ? "Verifying…" : step.step === "enroll" ? "Turn on two-factor & sign in" : "Sign in"}
            </button>
            <div className="flex justify-between text-xs text-[var(--muted)]">
              <button type="button" className="underline" onClick={() => (setStep(null), setError(null))}>
                Start over
              </button>
              {step.step === "totp" && (
                <button type="button" className="underline" onClick={() => (setUseRecovery((v) => !v), setCode(""))}>
                  {useRecovery ? "Use authenticator code" : "Use a recovery code"}
                </button>
              )}
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
