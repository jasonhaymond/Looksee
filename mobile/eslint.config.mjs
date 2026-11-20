// ESLint configuration for the Looksee Android app (React Native / Expo).
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
import reactHooks from "eslint-plugin-react-hooks";
import security from "eslint-plugin-security";
import globals from "globals";

export default defineConfig([
  // ESLint's own recommended rules for JavaScript.
  js.configs.recommended,
  // The TypeScript-aware equivalents (typescript-eslint).
  ...tseslint.configs.recommended,
  // React hooks correctness: hooks called in the same order every render, and
  // effects listing what they depend on.
  reactHooks.configs.flat["recommended-latest"],
  // Security rules from eslint-community: unsafe regexes, eval-like calls,
  // non-literal file paths, timing-unsafe comparisons, and similar. Reported
  // as warnings, which the security gate lists for review.
  security.configs.recommended,
  {
    // Build scripts and config files run on Node; the app itself runs in
    // React Native, which provides fetch, timers and similar browser-like globals.
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // Metro's and Expo's config files are CommonJS (require/module.exports),
    // which is what those tools load.
    files: ["metro.config.js", "app.config.js"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  // Generated native projects, build output and dependencies aren't ours to lint.
  globalIgnores(["android/**", "ios/**", "dist/**", "dist-check/**", "dist-android/**", ".expo/**", "node_modules/**", "expo-env.d.ts"]),
]);
