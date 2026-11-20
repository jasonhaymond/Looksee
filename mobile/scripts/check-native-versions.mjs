#!/usr/bin/env node
// mobile/scripts/check-native-versions.mjs
// Refuses an Android build whose lockfile would install an Expo native package from a
// different SDK than the app's. Such a package builds fine, then crashes the app the moment
// it starts, because its native code calls into an expo-modules-core it wasn't built against.
//
//   node scripts/check-native-versions.mjs [ref]   # default: the working tree
//
// It compares the lockfile at `ref` (what the build server installs) against the SDK's own
// version list (bundledNativeModules.json of the locked expo version, from node_modules, or
// from unpkg.com where nothing's installed). build-android.mjs also runs it.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// ROOT: the app folder (mobile/); REPO: the repository root, where git runs.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ROOT, '..');

// Versions npm will install from the lockfile, for every copy of each package.
function lockedVersions(ref) {
  const text = ref
    ? execSync(`git show ${ref}:mobile/package-lock.json`, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    : readFileSync(join(ROOT, 'package-lock.json'), 'utf8');
  const out = new Map();
  for (const [path, entry] of Object.entries(JSON.parse(text).packages || {})) {
    const name = path.split('node_modules/').pop();
    if (!name || !entry.version) continue;
    if (!out.has(name)) out.set(name, []);
    out.get(name).push({ path, version: entry.version });
  }
  return out;
}

// '~12.0.13' → does 12.0.x (≥ .13) match; '^1.2.0' → 1.x.
function satisfies(version, range) {
  const [vMaj, vMin, vPatch] = version.split('.').map((n) => parseInt(n, 10));
  const op = /^[~^]/.test(range) ? range[0] : '';
  const [rMaj, rMin, rPatch] = range.replace(/^[~^]/, '').split('.').map((n) => parseInt(n, 10));
  if (op === '') return version === range.replace(/^=/, '');
  if (vMaj !== rMaj) return false;
  if (op === '~' && vMin !== rMin) return false;
  if (vMin !== rMin) return op === '^' && vMin > rMin;
  return (vPatch || 0) >= (rPatch || 0);
}

async function sdkVersions(expoVersion) {
  const local = join(ROOT, 'node_modules/expo/bundledNativeModules.json');
  if (existsSync(local) && JSON.parse(readFileSync(join(ROOT, 'node_modules/expo/package.json'), 'utf8')).version === expoVersion) {
    return JSON.parse(readFileSync(local, 'utf8'));
  }
  const res = await fetch(`https://unpkg.com/expo@${expoVersion}/bundledNativeModules.json`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Couldn't fetch Expo ${expoVersion}'s package versions (${res.status}).`);
  return res.json();
}

// Only packages with Android code can crash it this way (react-dom, say, can't).
const NATIVE = /^(expo|expo-.+|@expo\/.+|react-native-(?!web$).+|@react-native-.+|@react-native\/.+)$/;

export async function checkNativeVersions(ref = null) {
  const locked = lockedVersions(ref);
  const expo = (locked.get('expo') || []).find((e) => e.path === 'node_modules/expo');
  if (!expo) return ['expo is not in the lockfile'];
  const sdk = await sdkVersions(expo.version);
  const problems = [];
  const native = (name) => NATIVE.test(name);
  for (const [name, range] of Object.entries(sdk)) {
    if (!native(name)) continue;
    for (const { path, version } of locked.get(name) || []) {
      if (!satisfies(version, range)) problems.push(`${path} is ${version}, but this Expo SDK needs ${range}`);
    }
  }
  return problems;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const problems = await checkNativeVersions(process.argv[2] || null);
  if (problems.length) {
    console.error('✖ Native packages from a different Expo SDK — the app would crash on launch:');
    problems.forEach((p) => console.error(`  - ${p}`));
    console.error('Fix: npx expo install <package> (makes it a direct dependency at the right version).');
    process.exit(1);
  }
  console.log('✔ Every Expo native package matches the SDK.');
}
