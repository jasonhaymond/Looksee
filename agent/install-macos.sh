#!/usr/bin/env bash
# Installs the Looksee agent as a launchd system daemon on macOS (runs
# regardless of login, matching Linux's system-level systemd service).
# Usage:
#   sudo ./install-macos.sh /path/to/looksee-agent-binary /path/to/looksee-agent.yaml
#
# Idempotent: safe to re-run (e.g. after rebuilding the binary) — it just
# overwrites the installed copies and reloads the daemon.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Must be run as root (try: sudo $0 ...)" >&2
  exit 1
fi

BINARY_SRC="${1:?Usage: $0 /path/to/looksee-agent-binary /path/to/looksee-agent.yaml}"
CONFIG_SRC="${2:?Usage: $0 /path/to/looksee-agent-binary /path/to/looksee-agent.yaml}"
[ -f "$BINARY_SRC" ] || { echo "No such binary: $BINARY_SRC" >&2; exit 1; }
[ -f "$CONFIG_SRC" ] || { echo "No such config file: $CONFIG_SRC" >&2; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST=/Library/LaunchDaemons/com.looksee.agent.plist

echo "==> Installing binary to /usr/local/bin/looksee-agent"
install -m 755 "$BINARY_SRC" /usr/local/bin/looksee-agent

echo "==> Installing config to /usr/local/etc/looksee-agent/looksee-agent.yaml"
install -d -m 755 /usr/local/etc/looksee-agent
install -m 600 "$CONFIG_SRC" /usr/local/etc/looksee-agent/looksee-agent.yaml

echo "==> Installing launchd daemon"
install -m 644 "$SCRIPT_DIR/com.looksee.agent.plist" "$PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load -w "$PLIST"

echo "==> Done. Check status with: launchctl list | grep com.looksee.agent"
echo "    Logs: /var/log/looksee-agent.log"
