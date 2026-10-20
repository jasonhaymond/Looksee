// Next.js settings for the dashboard: security headers on every page, and
// redirects for addresses that moved in 5.0 (so old bookmarks still work).

import type { NextConfig } from "next";

// Defense-in-depth headers on every dashboard page. The CSP only covers
// what can't break the app (framing, plugins, base URL, form targets);
// Next's own inline scripts rule out a strict script-src without nonces.
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // 4.x called devices "hosts" and listed them at /hosts; 5.0 calls them
  // endpoints. (4.x's /endpoints meant networks — now /sites — but that
  // address is reused, so it can't be redirected.)
  async redirects() {
    return [{ source: "/hosts", destination: "/endpoints", permanent: false }];
  },
};

export default nextConfig;
