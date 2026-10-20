#!/usr/bin/env bash
# Installs the Looksee agent as a systemd service on Linux.
#
# Usage:
#   sudo ./install.sh /path/to/looksee-agent-binary /path/to/looksee-agent.yaml [--minimal] [--no-docker]
#
# What it does:
#   1. creates the dedicated, unprivileged system user "looksee-agent";
#   2. installs the binary into the agent's state directory and the config
#      into /etc/looksee-agent (readable by that user only);
#   3. installs the hardened systemd unit (looksee-agent.service);
#   4. by default, grants the access the agent's checks need — while it still
#      runs as its own non-root user:
#        - reading the systemd journal and /var/log (journal and log checks,
#          failed-login counts): the systemd-journal and adm groups;
#        - SMART drive health and read-only access to /home (file checks,
#          lock files): the drop-in looksee-agent-privileged.conf;
#        - the Docker socket, when Docker is installed (container checks):
#          the docker group. Docker access is effectively root access on this
#          host — use --no-docker to leave it out;
#      --minimal skips all of step 4 (most checks still work; the rest report
#      "permission denied" with a pointer to agent/README.md → Privileges);
#   5. starts (or restarts) the service.
#
# Idempotent: safe to re-run (e.g. after rebuilding the binary) — it just
# overwrites the installed copies and restarts the service. Re-running with
# --minimal removes the drop-in again (group memberships stay; see the README
# for removing them).
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Must be run as root (try: sudo $0 ...)" >&2
  exit 1
fi

BINARY_SRC="${1:?Usage: $0 /path/to/looksee-agent-binary /path/to/looksee-agent.yaml [--minimal] [--no-docker]}"
CONFIG_SRC="${2:?Usage: $0 /path/to/looksee-agent-binary /path/to/looksee-agent.yaml [--minimal] [--no-docker]}"
[ -f "$BINARY_SRC" ] || { echo "No such binary: $BINARY_SRC" >&2; exit 1; }
[ -f "$CONFIG_SRC" ] || { echo "No such config file: $CONFIG_SRC" >&2; exit 1; }
shift 2

# Options after the two paths.
MINIMAL=0
DOCKER=1
for arg in "$@"; do
  case "$arg" in
    --minimal) MINIMAL=1 ;;
    --no-docker) DOCKER=0 ;;
    *) echo "Unknown option: $arg (use --minimal or --no-docker)" >&2; exit 1 ;;
  esac
done

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

DROPIN=/etc/systemd/system/looksee-agent.service.d/privileged.conf
if [ "$MINIMAL" -eq 1 ]; then
  echo "==> --minimal: leaving out extra access"
  rm -f "$DROPIN"
else
  # Groups that exist on this system only (adm is Debian/Ubuntu's log group).
  for group in systemd-journal adm; do
    if getent group "$group" >/dev/null; then
      echo "==> Adding looksee-agent to '$group' (read the journal / logs)"
      usermod -aG "$group" looksee-agent
    fi
  done
  if [ "$DOCKER" -eq 1 ] && getent group docker >/dev/null; then
    echo "==> Adding looksee-agent to 'docker' (container checks — effectively root access; re-run with --no-docker to skip)"
    usermod -aG docker looksee-agent
  fi
  if [ -f "$SCRIPT_DIR/looksee-agent-privileged.conf" ]; then
    echo "==> Installing $DROPIN (SMART drive health, read-only /home)"
    install -D -m 644 "$SCRIPT_DIR/looksee-agent-privileged.conf" "$DROPIN"
  else
    echo "    (looksee-agent-privileged.conf not found next to this script — SMART and /home access not granted)"
  fi
fi

systemctl daemon-reload
systemctl enable looksee-agent
# restart, not `enable --now`: on a re-install the agent is usually already
# running, and `--now` leaves a running service alone — it would keep using
# the old binary and the old (now revoked) key from memory. A restart also
# picks up new group memberships.
systemctl restart looksee-agent

echo "==> Done. Check status with: systemctl status looksee-agent"
echo "    Logs: journalctl -u looksee-agent -f"
