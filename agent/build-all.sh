#!/usr/bin/env bash
# Cross-compiles the agent for every supported platform in one command,
# into bin/. Uses a local Go toolchain if there is one; falls back to the
# golang Docker image automatically otherwise (no separate flag needed —
# this is exactly the manual fallback documented in README.md, just
# detected instead of chosen by hand).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# GOOS-GOARCH pairs, matched to Go's own naming. linux/arm64 covers
# Raspberry Pi 3/4/5 and other 64-bit ARM boards in a homelab.
TARGETS=(
  "linux amd64"
  "linux arm64"
  "windows amd64"
  "darwin amd64"
  "darwin arm64"
)

mkdir -p bin

# Single source of truth for the agent's own version — stamped into every
# binary below so `-version` and every report to the engine reflect what's
# actually running, not just what's on disk in this directory.
VERSION="$(cat VERSION)"
LDFLAGS="-X main.version=$VERSION"

build_one() {
  local goos="$1" goarch="$2" out="$3"
  local ext=""
  [ "$goos" = "windows" ] && ext=".exe"
  echo "==> Building $goos/$goarch"
  # CGO_ENABLED=0: a native linux/amd64 build otherwise links glibc
  # dynamically and won't run on musl (Alpine) or old-glibc hosts.
  CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" go build -ldflags "$LDFLAGS" -o "bin/${out}${ext}" .
}

if command -v go >/dev/null 2>&1; then
  for target in "${TARGETS[@]}"; do
    read -r goos goarch <<< "$target"
    build_one "$goos" "$goarch" "looksee-agent-${goos}-${goarch}"
  done
else
  echo "No local Go toolchain found — building inside golang:1.22 via Docker instead."
  build_cmd=""
  for target in "${TARGETS[@]}"; do
    read -r goos goarch <<< "$target"
    ext=""
    [ "$goos" = "windows" ] && ext=".exe"
    build_cmd+="CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go build -ldflags \"$LDFLAGS\" -o bin/looksee-agent-${goos}-${goarch}${ext} . && "
  done
  build_cmd+="echo done"
  # Run as the invoking user (not the container's root) so bin/ stays owned
  # by whoever runs updates, with a persistent module/build cache so repeat
  # builds (every update.sh run) don't re-download dependencies.
  CACHE_DIR="${LOOKSEE_GO_CACHE:-$HOME/.cache/looksee-agent-build}"
  mkdir -p "$CACHE_DIR"
  docker run --rm --user "$(id -u):$(id -g)" \
    -e HOME=/tmp -e GOCACHE=/cache/build -e GOMODCACHE=/cache/mod -e GOFLAGS=-buildvcs=false \
    -v "$CACHE_DIR:/cache" -v "$SCRIPT_DIR:/agent" -w /agent golang:1.22 sh -c "$build_cmd"
fi

echo "==> Built:"
ls -la bin/
