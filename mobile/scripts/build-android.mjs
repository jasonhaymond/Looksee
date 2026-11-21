#!/usr/bin/env node
// mobile/scripts/build-android.mjs
// Builds the Looksee Android app on the self-hosted build server and downloads the APK to
// mobile/dist-android/. The build server clones the repository from GitHub (the app is the
// mobile/ folder of it), so it builds what has been pushed, never this folder's files.
// Run it where the build server credentials live: they stay on that machine.
//
//   npm run build:android                       # release build of the version tag at HEAD (arm64)
//   npm run build:android -- --ref v5.8.0       # release build of that version tag
//   npm run build:android -- --abi x86_64       # another processor type (x86_64 = emulators)
//   npm run build:android -- --debug            # a debug build of the pushed HEAD (or --ref)
//   npm run build:android -- --debug --allow-http   # debug build that may use http:// (local test engine)
//   npm run build:android -- --status <id>      # re-check or download an earlier build
//
// Settings come from the gitignored mobile/.env (see .env.example). A release build is signed
// by the key stored on the build server, referred to only by its name: Android only installs
// an update signed with the same key as the installed app, so that key must never change.
//
// Checks before submitting (each stops the build with the reason):
// - a release must be an approved version: an annotated tag whose message records the
//   security review (the same check scripts/update.sh makes before deploying);
// - the commit must be on GitHub, and the app's version must equal the engine's (lockstep);
// - Android's versionCode must follow the version (MAJOR×10000 + MINOR×100 + PATCH);
// - every Expo native package must match the SDK (a mismatch builds, then crashes).
// --allow-http is refused for release builds: release APKs only ever talk HTTPS.

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNativeVersions } from './check-native-versions.mjs';

// ROOT: the app folder (mobile/); REPO: the repository root, where git runs.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(ROOT, '..');
const ALL_ABIS = ['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64'];
const DEFAULT_ABIS = ['arm64-v8a'];
const OUT_DIR = join(ROOT, 'dist-android');
const POLL_MS = 15000;

/** Prints an error and stops. In: the message. */
function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

/**
 * Reads mobile/.env. Out: an object of its settings. Each line is matched as NAME=value
 * (e.g. BUILD_SERVER_API_KEY=abs_123), with optional surrounding quotes removed from the value.
 */
function readEnv() {
  const path = join(ROOT, '.env');
  const env = {};
  if (!existsSync(path)) return env;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

const git = (args) => execSync(`git ${args}`, { cwd: REPO, encoding: 'utf8' }).trim();

/**
 * Checks the version numbers at a git ref: the app's version (mobile/app.config.js) must
 * equal the engine's (lockstep), and Android's versionCode must follow it, because Android
 * refuses an update with a lower number (5.8.0 → 50800).
 * In: a git ref. Out: a problem message, or null if they're right.
 */
function versionProblem(ref) {
  const config = git(`show ${ref}:mobile/app.config.js`);
  // Matches the two lines in app.config.js, e.g.  version: "5.8.0",  and  versionCode: 50800,
  const version = config.match(/^\s*version:\s*"(\d+\.\d+\.\d+)"/m)?.[1];
  const code = Number(config.match(/^\s*versionCode:\s*(\d+)/m)?.[1]);
  if (!version || !code) return 'Could not read version / versionCode from mobile/app.config.js.';
  const engine = JSON.parse(git(`show ${ref}:engine/package.json`)).version;
  if (engine !== version) return `The app is version ${version} but the engine is ${engine}; they must match.`;
  const [major, minor, patch] = version.split('.').map(Number);
  const expected = major * 10000 + minor * 100 + patch;
  return code === expected ? null : `versionCode is ${code}, but version ${version} needs ${expected}.`;
}

/** Works out the repo's public https address from the origin remote. */
function githubHttpsUrl() {
  // Matches the owner and name at the end of either remote style:
  // git@github.com:owner/repo.git  or  https://github.com/owner/repo(.git)
  const match = git('remote get-url origin').match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) fail('Could not work out the GitHub repo from the origin remote.');
  return `https://github.com/${match[1]}/${match[2]}.git`;
}

/**
 * Turns a failed fetch into a readable reason, e.g. "ENOTFOUND: getaddrinfo ENOTFOUND
 * builds.example.com" or "UNABLE_TO_VERIFY_LEAF_SIGNATURE: unable to verify the first certificate".
 * In: the error fetch threw. Out: a short text.
 */
function networkReason(err) {
  const cause = err?.cause;
  if (!cause) return err?.message || String(err);
  return [cause.code, cause.message].filter(Boolean).join(': ') || String(cause);
}

/**
 * Calls the build server's API.
 * In: config, a path, and fetch options. Out: the parsed answer. Throws on an error status.
 */
async function request(config, path, options = {}) {
  let res;
  try {
    res = await fetch(`${config.apiUrl}${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${config.apiKey}`, ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
    });
  } catch (err) {
    // Node's fetch only says "fetch failed"; the real reason (DNS name not found, connection
    // refused, certificate problem, timeout) is in err.cause, so it's shown here.
    throw new Error(`Couldn't reach the build server at ${config.apiUrl} (${networkReason(err)}). Check BUILD_SERVER_API_URL in mobile/.env, and that this machine can reach that address.`, { cause: err });
  }
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch { /* Plain text, which is what logs are. */ }
  if (!res.ok) throw new Error(`build server ${options.method || 'GET'} ${path} answered ${res.status}: ${body?.error || text}`);
  return body;
}

/**
 * Works out the saved file name, which always says which processors the APK runs on, so a
 * phone build and an emulator build can't be mixed up (an x86_64 APK on a phone fails with
 * "not compatible"). Build server 2.10.0+ already names files that way, e.g.
 * Looksee-v5.8.1-arm64-v8a-release.apk, and that name is kept. An older build server's
 * name (Looksee-v5.8.1-release.apk) gets the processor part inserted before -release/-debug.
 * In: the checked plain name, and the processor tag ("arm64-v8a", "x86_64", "all"…, or ''
 * when unknown, as for --status). Out: the file name to save as.
 */
function labelledName(name, abiTag) {
  if (!abiTag || name.includes(`-${abiTag}-`)) return name;
  // Matches the end of the name: an optional -debug/-release and then .apk
  return name.replace(/(-debug|-release)?\.apk$/, `-${abiTag}$1.apk`);
}

/**
 * Waits for a build to finish, then downloads its APK.
 * In: config, the build id, and the processor tag for the file name (see labelledName).
 * Side effects: writes to mobile/dist-android/.
 */
async function waitAndDownload(config, id, abiTag = '') {
  let last = '';
  for (;;) {
    const build = await request(config, `/api/v1/builds/${id}`);
    if (build.status !== last) {
      console.log(`  ${new Date().toLocaleTimeString()}  ${build.status}`);
      last = build.status;
    }
    if (build.status === 'completed') break;
    if (build.status === 'failed' || build.status === 'cancelled') {
      const logs = await request(config, `/api/v1/builds/${id}/logs`).catch(() => '');
      console.error(String(logs).split('\n').slice(-40).join('\n'));
      fail(`Build ${build.status}${build.failureReason ? `: ${build.failureReason}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const { artifacts } = await request(config, `/api/v1/builds/${id}/artifacts`);
  if (!artifacts?.length) fail('The build completed but produced no files.');
  mkdirSync(OUT_DIR, { recursive: true });
  for (const artifact of artifacts) {
    let res;
    try {
      res = await fetch(artifact.downloadUrl);
    } catch (err) {
      fail(`Downloading ${artifact.filename} failed (${networkReason(err)}).`);
    }
    if (!res.ok) fail(`Downloading ${artifact.filename} failed (${res.status}).`);
    // The file name comes from the build server, so only a plain name is accepted
    // (letters, digits, dot, dash, underscore — e.g. Looksee-release.apk): a name
    // like ../../x could otherwise write outside dist-android/.
    const name = basename(String(artifact.filename));
    if (!/^[\w.-]+$/.test(name) || name !== artifact.filename) fail(`The build server sent an unexpected file name: ${artifact.filename}`);
    const file = join(OUT_DIR, labelledName(name, abiTag));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- file is OUT_DIR plus the checked plain name above
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log(`\n✔ ${file} (${(artifact.size / 1e6).toFixed(1)} MB)`);
  }
}

/** Reads the arguments, runs the checks, submits the build, and waits for it. */
async function main() {
  const args = process.argv.slice(2);
  const env = readEnv();
  const config = {
    apiUrl: (env.BUILD_SERVER_API_URL || '').replace(/\/+$/, ''),
    apiKey: env.BUILD_SERVER_API_KEY,
    signingKey: (env.BUILD_SERVER_SIGNING_KEY || '').trim(),
  };
  if (!config.apiUrl) fail('BUILD_SERVER_API_URL is not set in mobile/.env. See .env.example.');
  if (!config.apiKey) fail('BUILD_SERVER_API_KEY is not set in mobile/.env. See .env.example.');

  const statusIndex = args.indexOf('--status');
  if (statusIndex !== -1) {
    if (!args[statusIndex + 1]) fail('Usage: npm run build:android -- --status <build id>');
    await waitAndDownload(config, args[statusIndex + 1]);
    return;
  }

  const variant = args.includes('--debug') ? 'debug' : 'release';
  const allowHttp = args.includes('--allow-http');
  if (allowHttp && variant === 'release') fail('--allow-http is only for debug builds: a release APK only uses HTTPS.');
  if (variant === 'release' && !config.signingKey) fail('BUILD_SERVER_SIGNING_KEY is not set in mobile/.env, or use --debug.');

  const abiIndex = args.indexOf('--abi');
  const abiArg = abiIndex !== -1 ? String(args[abiIndex + 1] || '').trim() : '';
  const abis = !abiArg ? DEFAULT_ABIS : abiArg === 'all' ? ALL_ABIS : abiArg.split(',').map((a) => a.trim()).filter(Boolean);
  if (!abis.length || abis.some((a) => !ALL_ABIS.includes(a))) fail(`--abi takes all, or a comma-separated list of: ${ALL_ABIS.join(', ')}`);
  // The same processor tag the build server puts in its file names: "all" or the list joined with "-".
  const abiTag = abis.length === ALL_ABIS.length ? 'all' : abis.join('-');

  const refIndex = args.indexOf('--ref');
  let ref = refIndex !== -1 ? args[refIndex + 1] : null;
  if (variant === 'release') {
    // Fetches the tags first, then requires an exact version tag (v1.2.3). That exact shape
    // is also what makes it safe to place on the command line below.
    git('fetch --quiet --tags origin');
    if (!ref) {
      try { ref = git('describe --tags --exact-match HEAD'); } catch { fail('A release build needs a version tag: tag this commit, or use --ref vX.Y.Z or --debug.'); }
    }
    if (!/^v\d+\.\d+\.\d+$/.test(ref)) fail(`A release build must be a version tag such as v5.8.0, not "${ref}". Use --debug for anything else.`);
    try {
      execSync(`bash scripts/verify-release-tag.sh ${ref}`, { cwd: REPO, stdio: 'inherit' });
    } catch {
      fail(`${ref} has no recorded security approval, so it can't be built as a release.`);
    }
    // Builds the exact commit the tag points to, so a branch named like the tag can't change it.
    ref = git(`rev-list -n 1 refs/tags/${ref}`);
  } else {
    if (!ref) {
      if (git('status --porcelain')) fail('There are uncommitted changes. The build server builds from GitHub, not this folder.');
      ref = git('rev-parse HEAD');
    }
    // A debug ref is only accepted as a full commit hash or a plain name, before it goes on a command line.
    if (!/^[0-9A-Za-z._/-]+$/.test(ref)) fail(`"${ref}" isn't a valid git ref.`);
  }
  git('fetch --quiet origin');
  if (git(`branch -r --contains ${ref}`) === '') fail(`${ref} hasn't been pushed to GitHub yet.`);

  const versionIssue = versionProblem(ref);
  if (versionIssue) fail(versionIssue);
  const mismatched = await checkNativeVersions(ref);
  if (mismatched.length) fail(`Native packages from a different Expo SDK:\n${mismatched.map((m) => `  - ${m}`).join('\n')}\nFix with: npx expo install <package>`);

  console.log(`Submitting Looksee: ${ref}, ${variant}, ${abis.join(', ')}${allowHttp ? ', http allowed' : ''}${variant === 'release' ? `, signed with "${config.signingKey}"` : ''}`);
  const build = { platform: 'android', variant, artifact: 'apk', env: { ANDROID_ABI: abis.join(','), ...(allowHttp ? { LOOKSEE_ALLOW_HTTP: '1' } : {}) } };
  if (variant === 'release') build.signing = { key: config.signingKey };
  const { id } = await request(config, '/api/v1/builds', {
    method: 'POST',
    body: JSON.stringify({ project: { name: 'Looksee', source: { type: 'git', url: githubHttpsUrl(), ref }, projectRoot: 'mobile' }, build }),
  });
  console.log(`  Build id ${id}. Safe to Ctrl+C. Resume with: npm run build:android -- --status ${id}\n`);
  await waitAndDownload(config, id, abiTag);
}

main().catch((err) => fail(err.message));
