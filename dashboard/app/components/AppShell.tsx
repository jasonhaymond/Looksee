// The frame around every page: the left navigation, the page itself, and
// the corner list of actions still running in the background.
//
// Where this sits: the root layout (app/layout.tsx) wraps every page in this.
// Pages that must stand alone — the sign-in page and public status pages,
// which visitors see without signing in — get no navigation at all.
//
// "use client" makes this run in the browser, where usePathname (Next.js's
// "which page is showing") is available.

"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";
import { BackgroundTasks } from "./BackgroundTasks";

// Paths shown without the navigation frame.
const BARE = [/^\/login(\/|$)/, /^\/status\//];

/**
 * Renders the sidebar and offsets the page to its right on wide screens
 * (the sidebar is 18rem / w-72 wide), plus the background-action list; or
 * the page alone for bare paths.
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (BARE.some((r) => r.test(pathname))) return <>{children}</>;
  return (
    <>
      <Sidebar />
      <div className="lg:pl-72">{children}</div>
      <BackgroundTasks />
    </>
  );
}
