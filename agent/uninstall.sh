#!/usr/bin/env bash
# Stops and removes the Looksee agent systemd service. Leaves the binary
# (/usr/local/bin/looksee-agent), config (/etc/looksee-agent/), and the
# looksee-agent system user in place by default — pass --purge to remove
# those too.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Must be run as root (try: sudo $0)" >&2
  exit 1
fi

systemctl disable --now looksee-agent 2>/dev/null || true
rm -f /etc/systemd/system/looksee-agent.service
systemctl daemon-reload

echo "Service removed."

if [ "${1:-}" = "--purge" ]; then
  rm -f /usr/local/bin/looksee-agent
  rm -rf /etc/looksee-agent
  userdel looksee-agent 2>/dev/null || true
  echo "Binary, config, and system user removed."
else
  echo "Binary and config left in place — re-run with --purge to remove those too."
fi
