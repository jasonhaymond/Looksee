"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { api } from "../lib/api";
import { PushEnableButton } from "./PushEnableButton";

const LINKS = [
  { href: "/", label: "Dashboards" },
  { href: "/manage", label: "Manage" },
  { href: "/hosts", label: "Hosts" },
  { href: "/channels", label: "Channels" },
  { href: "/backups", label: "Backups" },
  { href: "/logs", label: "Logs" },
] as const;

export function TopNav({ active }: { active: (typeof LINKS)[number]["href"] }) {
  const router = useRouter();

  async function handleLogout() {
    await api.logout();
    router.push("/login");
  }

  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-y-2">
      <h1 className="text-xl font-semibold">Looksee</h1>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        {LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            className={active === link.href ? "text-[var(--text)]" : "text-[var(--muted)] hover:text-[var(--text)]"}
          >
            {link.label}
          </Link>
        ))}
        <PushEnableButton />
        <button onClick={handleLogout} className="text-[var(--muted)] hover:text-[var(--text)]">
          Sign out
        </button>
      </div>
    </div>
  );
}
