#!/usr/bin/env bash
# Builds what agents download when their host is made a site collector:
#   agent/bin/collector/collector.cjs           the collector bundle
#   agent/bin/collector/node-<ver>-<plat>.gz   official Node.js runtimes
#   agent/bin/collector/manifest.json          versions + SHA-256 of each
#
# Runtimes come from nodejs.org, are verified against its SHASUMS256.txt, and
# are cached in ~/.cache/looksee-collector so a re-run (every update) only
# downloads when engine/src/collector/NODE_VERSION changes. Run from the repo
# root; scripts/update.sh calls it on every update.
#
# COLLECTOR_PLATFORMS (space-separated, default: all five) limits which
# runtimes are fetched, e.g. COLLECTOR_PLATFORMS="linux-amd64 windows-amd64"
# when no collector will ever run on a Mac or ARM box.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="agent/bin/collector"
NODE_VERSION="$(tr -d '[:space:]' < engine/src/collector/NODE_VERSION)"
PLATFORMS="${COLLECTOR_PLATFORMS:-linux-amd64 linux-arm64 windows-amd64 darwin-amd64 darwin-arm64}"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/looksee-collector/$NODE_VERSION"
DIST="https://nodejs.org/dist/$NODE_VERSION"

mkdir -p "$OUT" "$CACHE"

echo "==> Bundling the site collector"
(cd engine && node scripts/bundle-collector.mjs)

sha256() { sha256sum "$1" | cut -d' ' -f1; }

if [ ! -s "$CACHE/SHASUMS256.txt" ]; then
  curl -fsSL "$DIST/SHASUMS256.txt" -o "$CACHE/SHASUMS256.txt.tmp"
  mv "$CACHE/SHASUMS256.txt.tmp" "$CACHE/SHASUMS256.txt"
fi

# Agent platform name -> the file nodejs.org publishes for it.
node_dist_file() {
  case "$1" in
    linux-amd64) echo "node-$NODE_VERSION-linux-x64.tar.gz" ;;
    linux-arm64) echo "node-$NODE_VERSION-linux-arm64.tar.gz" ;;
    darwin-amd64) echo "node-$NODE_VERSION-darwin-x64.tar.gz" ;;
    darwin-arm64) echo "node-$NODE_VERSION-darwin-arm64.tar.gz" ;;
    windows-amd64) echo "win-x64/node.exe" ;;
    *) echo "unknown collector platform: $1" >&2; return 1 ;;
  esac
}

for plat in $PLATFORMS; do
  target="$OUT/node-$NODE_VERSION-$plat.gz"
  if [ -s "$target" ] && [ -s "$target.sha256" ]; then
    echo "==> Node $NODE_VERSION for $plat already prepared"
    continue
  fi
  file="$(node_dist_file "$plat")"
  cached="$CACHE/$(echo "$file" | tr '/' '_')"
  if [ ! -s "$cached" ]; then
    echo "==> Downloading Node $NODE_VERSION for $plat"
    curl -fsSL --retry 3 "$DIST/$file" -o "$cached.tmp"
    mv "$cached.tmp" "$cached"
  fi
  expected="$(awk -v f="$file" '$2 == f { print $1 }' "$CACHE/SHASUMS256.txt")"
  actual="$(sha256 "$cached")"
  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    rm -f "$cached"
    echo "Checksum mismatch for $file (expected ${expected:-nothing listed}, got $actual) — refusing to use it." >&2
    exit 1
  fi
  binary="$CACHE/node-$plat"
  case "$file" in
    *.tar.gz) tar -xzOf - "${file%.tar.gz}/bin/node" < "$cached" > "$binary" ;;
    *) cp "$cached" "$binary" ;;
  esac
  sha256 "$binary" > "$target.sha256.tmp"
  gzip -9 -c "$binary" > "$target.tmp"
  mv "$target.tmp" "$target"
  mv "$target.sha256.tmp" "$target.sha256"
  rm -f "$binary"
done

# Runtimes for Node versions no longer pinned are dead weight.
for old in "$OUT"/node-*.gz; do
  [ -e "$old" ] || continue
  case "$old" in "$OUT/node-$NODE_VERSION-"*) ;; *) rm -f "$old" "$old.sha256" ;; esac
done

echo "==> Writing $OUT/manifest.json"
# shellcheck disable=SC2016 # JavaScript template literals, not shell expansions
BUNDLE_SHA="$(sha256 "$OUT/collector.cjs")" OUT="$OUT" NODE_VERSION="$NODE_VERSION" PLATFORMS="$PLATFORMS" node -e '
const fs = require("fs");
const { OUT, NODE_VERSION, PLATFORMS, BUNDLE_SHA } = process.env;
const runtimes = {};
for (const p of PLATFORMS.split(/\s+/).filter(Boolean)) {
  const file = `node-${NODE_VERSION}-${p}.gz`;
  runtimes[p] = { file, sha256: fs.readFileSync(`${OUT}/${file}.sha256`, "utf-8").trim() };
}
const version = require("./engine/package.json").version;
fs.writeFileSync(`${OUT}/manifest.json.tmp`, JSON.stringify({ version, node: NODE_VERSION, bundle: { file: "collector.cjs", sha256: BUNDLE_SHA }, runtimes }, null, 2));
fs.renameSync(`${OUT}/manifest.json.tmp`, `${OUT}/manifest.json`);
'
echo "Site collector v$(node -p "require('./engine/package.json').version") ready (Node $NODE_VERSION: $PLATFORMS)."
