#!/usr/bin/env bash
# Stops and removes the Looksee agent launchd daemon. Leaves the binary
# (/usr/local/bin/looksee-agent) and config (/usr/local/etc/looksee-agent/)
# in place by default — pass --purge to remove those too.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Must be run as root (try: sudo $0)" >&2
  exit 1
fi

PLIST=/Library/LaunchDaemons/com.looksee.agent.plist

launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"

echo "Daemon removed."

if [ "${1:-}" = "--purge" ]; then
  rm -f /usr/local/bin/looksee-agent
  rm -rf /usr/local/etc/looksee-agent
  echo "Binary and config removed."
else
  echo "Binary and config left in place — re-run with --purge to remove those too."
fi
