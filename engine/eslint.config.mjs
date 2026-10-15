// ESLint configuration for the engine (the Node/Express API, scheduler,
// probes and site collector).
//
// ESLint reads the source code without running it and reports likely bugs and
// risky patterns. `npm run lint` (in this folder) checks everything below;
// the release security gate (scripts/security-check.sh) runs it as part of
// its static-analysis step.
//
// This is a "flat config": an array of settings objects applied in order,
// later entries overriding earlier ones for the files they match.

import { defineConfig, globalIgnores } from "eslint/config";
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";
import globals from "globals";

export default defineConfig([
  // ESLint's own recommended rules for JavaScript.
  js.configs.recommended,
  // The TypeScript-aware equivalents (typescript-eslint): understands types,
  // `import type`, and TypeScript-only syntax.
  ...tseslint.configs.recommended,
  // Security rules from eslint-community: unsafe regexes, eval-like calls,
  // non-literal file paths and child-process arguments, timing-unsafe
  // comparisons, and similar. Its own "recommended" set reports these as
  // warnings, which the security gate lists for review.
  security.configs.recommended,
  {
    // The engine runs on Node, so Node's built-in globals (process, Buffer,
    // __dirname, ...) are known rather than reported as undefined.
    languageOptions: { globals: { ...globals.node } },
  },
  // Build output, downloaded runtimes and generated migrations aren't ours to lint.
  globalIgnores(["dist/**", "collector-dist/**", "drizzle/**", "node_modules/**"]),
]);
