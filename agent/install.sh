#!/usr/bin/env bash
# Installs the Looksee agent as a systemd service on Linux. Usage:
#   sudo ./install.sh /path/to/looksee-agent-binary /path/to/looksee-agent.yaml
#
# Idempotent: safe to re-run (e.g. after rebuilding the binary) — it just
# overwrites the installed copies and restarts the service.
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

if ! id looksee-agent >/dev/null 2>&1; then
  echo "==> Creating dedicated system user 'looksee-agent'"
  useradd --system --no-create-home --shell /usr/sbin/nologin looksee-agent
fi

# The binary lives in the agent's own state directory, owned by its user, so
# the dashboard's "Update agent" can swap it in place (the hardened unit makes
# /usr/local/bin read-only to the agent). /usr/local/bin/looksee-agent stays
# as a symlink for running it by hand.
echo "==> Installing binary to /var/lib/looksee-agent/looksee-agent"
install -d -m 755 -o looksee-agent -g looksee-agent /var/lib/looksee-agent
install -m 755 -o looksee-agent -g looksee-agent "$BINARY_SRC" /var/lib/looksee-agent/looksee-agent
ln -sfn /var/lib/looksee-agent/looksee-agent /usr/local/bin/looksee-agent

echo "==> Installing config to /etc/looksee-agent/looksee-agent.yaml"
install -d -m 750 -o looksee-agent -g looksee-agent /etc/looksee-agent
install -m 600 -o looksee-agent -g looksee-agent "$CONFIG_SRC" /etc/looksee-agent/looksee-agent.yaml

echo "==> Installing systemd unit"
install -m 644 "$SCRIPT_DIR/looksee-agent.service" /etc/systemd/system/looksee-agent.service

systemctl daemon-reload
systemctl enable looksee-agent
# restart, not `enable --now`: on a re-install the agent is usually already
# running, and `--now` leaves a running service alone — it would keep using
# the old binary and the old (now revoked) key from memory.
systemctl restart looksee-agent

echo "==> Done. Check status with: systemctl status looksee-agent"
echo "    Logs: journalctl -u looksee-agent -f"
