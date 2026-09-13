"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "../lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await api.login(email, password);
      router.push("/");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={handleSubmit} className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--panel)] p-6">
        <h1 className="mb-6 text-xl font-semibold">Looksee</h1>
        <label className="mb-3 block text-sm">
          Email
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-3 py-2 outline-none focus:border-[var(--up)]"
          />
        </label>
        <label className="mb-4 block text-sm">
          Password
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-3 py-2 outline-none focus:border-[var(--up)]"
          />
        </label>
        {error && <p className="mb-4 text-sm text-[var(--down)]">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-[var(--up)] px-3 py-2 font-medium text-black disabled:opacity-50"
        >
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </main>
  );
}
