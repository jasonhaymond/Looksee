// ESLint configuration for the dashboard (the Next.js web app).
//
// ESLint reads the source code without running it and reports likely bugs and
// risky patterns. `npm run lint` (in this folder) checks everything below;
// the release security gate (scripts/security-check.sh) runs it as part of
// its static-analysis step.
//
// This is a "flat config": an array of settings objects applied in order,
// later entries overriding earlier ones for the files they match.
//
// Version pin: ESLint stays on 9.x here (package.json "eslint": "^9") because
// the React, import and accessibility plugins bundled by eslint-config-next
// only support ESLint up to 9. The engine, which has none of those, uses 10.

import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import security from "eslint-plugin-security";

export default defineConfig([
  // Next.js's recommended rules: React and hooks correctness, accessibility,
  // and the Core Web Vitals performance rules.
  ...nextVitals,
  // TypeScript-aware versions of the rules (typescript-eslint).
  ...nextTs,
  // Security rules from eslint-community: unsafe regexes, eval-like calls,
  // non-literal file paths and child-process arguments, timing-unsafe
  // comparisons, and similar. Its own "recommended" set reports these as
  // warnings, which the security gate lists for review.
  security.configs.recommended,
  // Generated or third-party output that isn't ours to lint.
  globalIgnores([".next/**", "out/**", "build/**", "next-env.d.ts", "public/sw.js"]),
]);
