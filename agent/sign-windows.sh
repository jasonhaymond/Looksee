#!/usr/bin/env bash
# Authenticode-signs the Windows agent binaries in bin/ after build-all.sh
# builds them. Does nothing (exit 0) until signing is configured, so builds
# keep working unsigned — see docs/windows-agent-security.md for why
# signing matters (Smart App Control, SmartScreen, WDAC) and how to get a
# certificate.
#
# Configure in agent/signing.env (gitignored; copy signing.env.example).
# One of three methods:
#
#   SIGN_METHOD=azure          Azure Artifact Signing (formerly Trusted Signing)
#     AZURE_SIGNING_ENDPOINT=https://eus.codesigning.azure.net
#     AZURE_SIGNING_ACCOUNT=my-account
#     AZURE_SIGNING_PROFILE=my-profile
#     (needs the Azure CLI signed in: az login, with the "Artifact Signing
#      Certificate Profile Signer" role on the account)
#
#   SIGN_METHOD=jsign          a certificate whose key lives in an HSM, token or
#                              cloud key service (how public OV/EV code-signing
#                              certificates are issued since June 2023)
#     SIGN_JSIGN_STORETYPE=AZUREKEYVAULT | DIGICERTONE | GOOGLECLOUD | YUBIKEY | PKCS11 | ...
#     SIGN_JSIGN_KEYSTORE=...  SIGN_JSIGN_ALIAS=...  SIGN_JSIGN_STOREPASS=...
#     SIGN_JSIGN_CERTFILE=...  (when the keystore doesn't hold the chain)
#     (see https://ebourg.github.io/jsign/ for each store type's values)
#
#   SIGN_METHOD=pfx            a .pfx file — an internal/enterprise CA's
#                              certificate, or an older public one
#     SIGN_PFX=/path/cert.pfx
#     SIGN_PFX_PASSWORD_FILE=/path/password.txt   (or SIGN_PFX_PASSWORD=...)
#
# SIGN_TIMESTAMP_URL overrides the RFC 3161 timestamp server. Timestamping
# keeps signatures valid after the certificate itself expires.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# shellcheck source=/dev/null
[ -f signing.env ] && set -a && . ./signing.env && set +a
METHOD="${SIGN_METHOD:-}"
if [ -z "$METHOD" ]; then
  echo "==> Windows signing not configured (agent/signing.env) — binaries stay unsigned."
  exit 0
fi

shopt -s nullglob
FILES=(bin/*.exe)
if [ ${#FILES[@]} -eq 0 ]; then
  echo "==> No Windows binaries in bin/ to sign."
  exit 0
fi

# osslsigncode/jsign come from a container when they aren't installed, the
# same way build-all.sh falls back to the golang image.
TOOL_IMAGE="looksee-signing-tools:1"
ensure_image() {
  if ! docker image inspect "$TOOL_IMAGE" >/dev/null 2>&1; then
    echo "==> Building the signing tools image (one-time)"
    docker build -q -t "$TOOL_IMAGE" - <<'DOCKERFILE' >/dev/null
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends osslsigncode default-jre-headless curl ca-certificates \
 && curl -fsSL -o /usr/local/lib/jsign.jar https://github.com/ebourg/jsign/releases/download/7.1/jsign-7.1.jar \
 && rm -rf /var/lib/apt/lists/*
DOCKERFILE
  fi
}
run_tool() {
  if [ "$1" = "osslsigncode" ] && command -v osslsigncode >/dev/null 2>&1; then
    "$@"
  else
    ensure_image
    local mounts=(-v "$SCRIPT_DIR:/agent")
    [ -n "${SIGN_PFX:-}" ] && mounts+=(-v "$(cd "$(dirname "$SIGN_PFX")" && pwd):/certs:ro")
    docker run --rm --user "$(id -u):$(id -g)" "${mounts[@]}" -w /agent "$TOOL_IMAGE" "$@"
  fi
}

case "$METHOD" in
  pfx)
    : "${SIGN_PFX:?SIGN_PFX must point at the .pfx certificate}"
    PASS="${SIGN_PFX_PASSWORD:-}"
    [ -n "${SIGN_PFX_PASSWORD_FILE:-}" ] && PASS="$(cat "$SIGN_PFX_PASSWORD_FILE")"
    TS="${SIGN_TIMESTAMP_URL:-http://timestamp.digicert.com}"
    PFX_PATH="$SIGN_PFX"
    command -v osslsigncode >/dev/null 2>&1 || PFX_PATH="/certs/$(basename "$SIGN_PFX")"
    for f in "${FILES[@]}"; do
      echo "==> Signing $f (certificate file)"
      run_tool osslsigncode sign -pkcs12 "$PFX_PATH" -pass "$PASS" -n "Looksee agent" -i "https://github.com/jasonhaymond/Looksee" -t "$TS" -h sha256 -in "$f" -out "$f.signed"
      mv "$f.signed" "$f"
    done
    ;;
  azure)
    : "${AZURE_SIGNING_ENDPOINT:?}" "${AZURE_SIGNING_ACCOUNT:?}" "${AZURE_SIGNING_PROFILE:?}"
    TOKEN="$(az account get-access-token --resource https://codesigning.azure.net --query accessToken -o tsv)"
    TS="${SIGN_TIMESTAMP_URL:-http://timestamp.acs.microsoft.com}"
    for f in "${FILES[@]}"; do
      echo "==> Signing $f (Azure Artifact Signing)"
      run_tool java -jar /usr/local/lib/jsign.jar --storetype TRUSTEDSIGNING --keystore "$AZURE_SIGNING_ENDPOINT" \
        --storepass "$TOKEN" --alias "$AZURE_SIGNING_ACCOUNT/$AZURE_SIGNING_PROFILE" \
        --tsaurl "$TS" --tsmode RFC3161 --name "Looksee agent" --url "https://github.com/jasonhaymond/Looksee" "$f"
    done
    ;;
  jsign)
    : "${SIGN_JSIGN_STORETYPE:?}" "${SIGN_JSIGN_KEYSTORE:?}" "${SIGN_JSIGN_ALIAS:?}"
    TS="${SIGN_TIMESTAMP_URL:-http://timestamp.digicert.com}"
    extra=()
    [ -n "${SIGN_JSIGN_CERTFILE:-}" ] && extra+=(--certfile "$SIGN_JSIGN_CERTFILE")
    for f in "${FILES[@]}"; do
      echo "==> Signing $f (jsign, $SIGN_JSIGN_STORETYPE)"
      run_tool java -jar /usr/local/lib/jsign.jar --storetype "$SIGN_JSIGN_STORETYPE" --keystore "$SIGN_JSIGN_KEYSTORE" \
        --storepass "${SIGN_JSIGN_STOREPASS:-}" --alias "$SIGN_JSIGN_ALIAS" "${extra[@]}" \
        --tsaurl "$TS" --tsmode RFC3161 --name "Looksee agent" --url "https://github.com/jasonhaymond/Looksee" "$f"
    done
    ;;
  *)
    echo "SIGN_METHOD must be azure, jsign or pfx (got: $METHOD)" >&2
    exit 1
    ;;
esac

# Confirm each file now carries a signature. "verify" also checks the
# chain; a self-signed test certificate fails that part, which is expected.
for f in "${FILES[@]}"; do
  if run_tool osslsigncode verify -in "$f" 2>&1 | grep -q "Signature verification: ok"; then
    echo "==> $f: signed and verified"
  elif run_tool osslsigncode extract-signature -in "$f" -out /tmp/sig.der >/dev/null 2>&1; then
    echo "==> $f: signed (chain not trusted on this machine — expected for a test certificate)"
  else
    echo "==> $f: NOT signed" >&2
    exit 1
  fi
done
