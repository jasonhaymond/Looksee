#!/data/data/com.termux/files/usr/bin/bash
# Installs (or removes) the Looksee agent on an Android phone or tablet, inside
# Termux — a Linux terminal app for Android. Run it in Termux, not adb:
#
#   curl -fsSL https://looksee.example.com/install/agent-android.sh | bash -s -- https://looksee.example.com <agent-key>
#   curl -fsSL https://looksee.example.com/install/agent-android.sh | bash -s -- --uninstall
#
# What it does (everything stays inside Termux's own folders; nothing needs
# root, and nothing outside Termux is changed):
#   1. Downloads the agent for this phone's processor from the engine
#      (the same static Linux build servers use — Android's kernel is Linux).
#   2. Writes ~/.looksee/looksee-agent.yaml with the engine address and the
#      agent key (readable only by Termux's own user). Asks before replacing
#      an existing config.
#   3. Writes ~/.looksee/run-agent.sh, which keeps the agent running: it holds
#      a wake lock (so Android doesn't freeze Termux in the background) and
#      restarts the agent if it stops — including after a self-update.
#   4. Adds ~/.termux/boot/looksee-agent so the Termux:Boot app starts the
#      agent when the phone restarts.
#   5. Starts the agent now and waits for its first check-in.
#
# Before running: install Termux and Termux:Boot from F-Droid (the Play Store
# versions are outdated), open Termux:Boot once, and in Android's settings set
# Termux's battery usage to "Unrestricted". Optional: Termux:API (app + `pkg
# install termux-api`) for battery readings. See agent/README.md → Android.
set -euo pipefail

DIR="$HOME/.looksee"
BOOT_DIR="$HOME/.termux/boot"
BIN="$DIR/looksee-agent"
CONFIG="$DIR/looksee-agent.yaml"
RUNNER="$DIR/run-agent.sh"
LOG="$DIR/looksee-agent.log"

# --uninstall: stop the agent and remove everything this script created.
if [ "${1:-}" = "--uninstall" ]; then
  echo "==> Stopping the agent"
  # pkill -f matches the full command line: the runner loop first, then the agent.
  pkill -f "$RUNNER" 2>/dev/null || true
  pkill -f "$BIN" 2>/dev/null || true
  command -v termux-wake-unlock >/dev/null && termux-wake-unlock || true
  rm -f "$BOOT_DIR/looksee-agent"
  rm -rf "$DIR"
  echo "Removed. Also delete the endpoint (or its agent key) in Looksee if you won't reinstall."
  exit 0
fi

ENGINE_URL="${1:?Usage: install-android.sh <engine-url> <agent-key>  (or --uninstall)}"
AGENT_KEY="${2:?Usage: install-android.sh <engine-url> <agent-key>}"
# The engine URL must be http(s)://host[:port] with nothing that could break
# out of the config file it's written into (no spaces or quotes).
if ! printf '%s' "$ENGINE_URL" | grep -Eq '^https?://[^[:space:]"]+$'; then
  echo "The engine URL must look like https://looksee.example.com (got '$ENGINE_URL')" >&2
  exit 1
fi
# Agent keys are letters, digits, - and _ only.
if ! printf '%s' "$AGENT_KEY" | grep -Eq '^[A-Za-z0-9_-]+$'; then
  echo "That doesn't look like an agent key (letters, digits, - and _ only)." >&2
  exit 1
fi

# Must be Termux: it sets $PREFIX to its own folder.
if [ -z "${PREFIX:-}" ] || [ ! -d "$PREFIX" ] || ! printf '%s' "$PREFIX" | grep -q com.termux; then
  echo "Run this inside the Termux app on Android (see agent/README.md → Android)." >&2
  exit 1
fi
for tool in curl pkill; do
  if ! command -v "$tool" >/dev/null; then
    echo "==> Installing $tool"
    pkg install -y "$( [ "$tool" = pkill ] && echo procps || echo curl )"
  fi
done

case "$(uname -m)" in
  aarch64|arm64) PLATFORM=linux-arm64 ;;
  x86_64) PLATFORM=linux-amd64 ;;
  *)
    echo "Unsupported processor: $(uname -m). The agent runs on 64-bit ARM (almost every phone since 2016) and x86-64." >&2
    exit 1
    ;;
esac

mkdir -p "$DIR" "$BOOT_DIR"
chmod 700 "$DIR"

echo "==> Downloading looksee-agent ($PLATFORM)"
curl -fsSL "$ENGINE_URL/install/agent/$PLATFORM" -o "$BIN.new"
chmod 700 "$BIN.new"
mv "$BIN.new" "$BIN"
"$BIN" -version

if [ -f "$CONFIG" ]; then
  # Reading from /dev/tty: stdin is the piped script itself under curl | bash.
  printf 'A config already exists at %s. Replace it with this engine and key? [y/N] ' "$CONFIG"
  read -r answer < /dev/tty || answer=""
  case "$answer" in
    y|Y|yes) WRITE_CONFIG=1 ;;
    *) WRITE_CONFIG=0; echo "    Keeping the existing config." ;;
  esac
else
  WRITE_CONFIG=1
fi
if [ "$WRITE_CONFIG" = 1 ]; then
  umask 077
  cat > "$CONFIG" <<CFG
engine_url: "$ENGINE_URL"
agent_key: "$AGENT_KEY"
interval_seconds: 60
CFG
  echo "==> Wrote $CONFIG"
fi

# The runner: hold a wake lock, then run the agent in a loop. The agent
# exits after installing an update (LOOKSEE_SUPERVISED=1 tells it something
# will restart it); the loop starts the new binary.
cat > "$RUNNER" <<'RUN'
#!/data/data/com.termux/files/usr/bin/bash
# Keeps the Looksee agent running inside Termux (written by install-android.sh).
DIR="$HOME/.looksee"
command -v termux-wake-lock >/dev/null && termux-wake-lock
export LOOKSEE_SUPERVISED=1
while true; do
  "$DIR/looksee-agent" -config "$DIR/looksee-agent.yaml" -log-file "$DIR/looksee-agent.log"
  sleep 10
done
RUN
chmod 700 "$RUNNER"

# Termux:Boot runs every script in ~/.termux/boot when the phone starts.
cat > "$BOOT_DIR/looksee-agent" <<BOOT
#!/data/data/com.termux/files/usr/bin/bash
# Starts the Looksee agent at boot (written by install-android.sh).
nohup "$RUNNER" >/dev/null 2>&1 &
BOOT
chmod 700 "$BOOT_DIR/looksee-agent"

echo "==> Starting the agent"
pkill -f "$RUNNER" 2>/dev/null || true
pkill -f "$BIN" 2>/dev/null || true
nohup "$RUNNER" >/dev/null 2>&1 &

# Wait up to a minute for the first successful report in the log.
for _ in $(seq 1 12); do
  sleep 5
  if grep -q "report accepted\|checked in" "$LOG" 2>/dev/null; then
    echo "==> The agent checked in. It shows as online on the Endpoints page."
    exit 0
  fi
done
echo "The agent is running but hasn't checked in yet. Last log lines ($LOG):"
tail -n 10 "$LOG" 2>/dev/null || echo "(no log yet)"
echo "See agent/README.md → Android → Troubleshooting."
