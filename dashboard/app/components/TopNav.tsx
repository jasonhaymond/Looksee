"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "../lib/api";
import { PushEnableButton } from "./PushEnableButton";

type NavItem = { href: string; label: string; hint?: string };
type NavGroup = { label: string; items: NavItem[] };

// Grouped so ~15 pages stay findable: the group names say what you're
// trying to do, the items say where it lives.
export const NAV: (NavItem | NavGroup)[] = [
  { href: "/", label: "Dashboards" },
  {
    label: "Monitoring",
    items: [
      { href: "/manage", label: "Checks", hint: "Everything being monitored" },
      { href: "/hosts", label: "Hosts", hint: "Machines running the agent" },
      { href: "/endpoints", label: "Endpoints", hint: "Groups / networks" },
      { href: "/discovery", label: "Discovery", hint: "Scan a subnet for devices" },
    ],
  },
  {
    label: "Alerting",
    items: [
      { href: "/channels", label: "Channels", hint: "Email, push, webhooks" },
      { href: "/maintenance", label: "Maintenance", hint: "Silence alerts on a schedule" },
    ],
  },
  {
    label: "Insights",
    items: [
      { href: "/reports", label: "SLA reports", hint: "Uptime over 7–365 days" },
      { href: "/events", label: "Traps & syslog", hint: "Received events" },
      { href: "/flows", label: "Top talkers", hint: "NetFlow / sFlow" },
      { href: "/status-pages", label: "Status pages", hint: "Public status pages" },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/backups", label: "Backups" },
      { href: "/logs", label: "Logs" },
    ],
  },
];

const isGroup = (n: NavItem | NavGroup): n is NavGroup => "items" in n;

export function TopNav({ active }: { active: string }) {
  const router = useRouter();
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpenGroup(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenGroup(null);
        setMobileOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  async function handleLogout() {
    await api.logout();
    router.push("/login");
  }

  const groupActive = (g: NavGroup) => g.items.some((i) => i.href === active);
  const linkClass = (on: boolean) => (on ? "text-[var(--text)]" : "text-[var(--muted)] hover:text-[var(--text)]");

  return (
    <div ref={ref} className="mb-6">
      <div className="flex items-center justify-between gap-3">
        <Link href="/" className="text-xl font-semibold">
          Looksee
        </Link>
        <nav className="hidden items-center gap-x-5 text-sm md:flex" aria-label="Main">
          {NAV.map((n) =>
            isGroup(n) ? (
              <div key={n.label} className="relative">
                <button onClick={() => setOpenGroup((g) => (g === n.label ? null : n.label))} aria-expanded={openGroup === n.label} className={`inline-flex items-center gap-1 ${linkClass(groupActive(n))}`}>
                  {n.label}
                  <span className="text-[9px]">▾</span>
                </button>
                {openGroup === n.label && (
                  <div className="absolute left-0 top-full z-40 mt-2 w-60 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-1 shadow-xl">
                    {n.items.map((i) => (
                      <Link key={i.href} href={i.href} onClick={() => setOpenGroup(null)} className={`block rounded-md px-3 py-2 hover:bg-[var(--border)]/40 ${i.href === active ? "bg-[var(--border)]/40" : ""}`}>
                        <span className="block text-[var(--text)]">{i.label}</span>
                        {i.hint && <span className="block text-xs text-[var(--muted)]">{i.hint}</span>}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <Link key={n.href} href={n.href} className={linkClass(n.href === active)}>
                {n.label}
              </Link>
            )
          )}
          <PushEnableButton />
          <button onClick={handleLogout} className="text-[var(--muted)] hover:text-[var(--text)]">
            Sign out
          </button>
        </nav>
        <button className="rounded-md border border-[var(--border)] px-3 py-1 text-sm md:hidden" aria-expanded={mobileOpen} aria-label="Menu" onClick={() => setMobileOpen((v) => !v)}>
          {mobileOpen ? "Close" : "Menu"}
        </button>
      </div>
      {mobileOpen && (
        <nav className="mt-3 space-y-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 text-sm md:hidden" aria-label="Main">
          {NAV.map((n) =>
            isGroup(n) ? (
              <div key={n.label}>
                <div className="mb-1 text-xs uppercase tracking-wide text-[var(--muted)]">{n.label}</div>
                <div className="grid grid-cols-2 gap-1">
                  {n.items.map((i) => (
                    <Link key={i.href} href={i.href} className={`rounded-md px-2 py-1.5 ${i.href === active ? "bg-[var(--border)]/50 text-[var(--text)]" : "text-[var(--text)]"}`}>
                      {i.label}
                    </Link>
                  ))}
                </div>
              </div>
            ) : (
              <Link key={n.href} href={n.href} className="block rounded-md px-2 py-1.5">
                {n.label}
              </Link>
            )
          )}
          <div className="flex items-center gap-4 border-t border-[var(--border)] pt-3">
            <PushEnableButton />
            <button onClick={handleLogout} className="text-[var(--muted)]">
              Sign out
            </button>
          </div>
        </nav>
      )}
    </div>
  );
}
