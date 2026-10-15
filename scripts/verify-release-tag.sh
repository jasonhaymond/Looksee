#!/usr/bin/env bash
# Checks that a release tag carries the developer's security-review approval
# before it may be deployed.
#
# Where this sits: scripts/update.sh calls this before deploying any version.
# The release process (see the README's "Releasing" section) records the
# approval of the security gate (scripts/security-check.sh) in the release's
# annotated git tag, as a line like:
#
#   Security review: approved 2026-10-14, report security-reports/v4.2.0-....md, accepted risks: 1 (...)
#
# This script refuses a tag that is missing, is a "lightweight" tag (a bare
# name with no message, so no approval can be recorded in it), or has no such
# line. That makes the review gate something the deploy tooling enforces, not
# just something to remember.
#
# Usage: scripts/verify-release-tag.sh <tag>
# Exit codes: 0 = approved (the approval line is printed), 1 = not approved
# (the reason is printed), 2 = bad usage.

set -euo pipefail

TAG="${1:-}"
if [ -z "$TAG" ]; then
  echo "Usage: $0 <tag>" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# The tag must exist locally (update.sh fetches tags from GitHub first).
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Tag $TAG doesn't exist (run 'git fetch --tags' first, or check the name)." >&2
  exit 1
fi

# "tag" = an annotated tag object, which has a message; "commit" = a
# lightweight tag pointing straight at a commit, which can't hold an approval.
if [ "$(git cat-file -t "refs/tags/$TAG")" != "tag" ]; then
  echo "Tag $TAG is a lightweight tag with no message, so it can't record a security-review approval." >&2
  exit 1
fi

# The tag message (subject + body). The approval line must start a line and
# carry a date, e.g. "Security review: approved 2026-10-14, ...".
APPROVAL="$(git tag -l --format='%(contents)' "$TAG" | grep -E '^Security review: approved [0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1 || true)"
if [ -z "$APPROVAL" ]; then
  echo "Tag $TAG has no 'Security review: approved <date>' line — this version didn't go through the security gate, or its approval wasn't recorded." >&2
  exit 1
fi

echo "$TAG — $APPROVAL"
