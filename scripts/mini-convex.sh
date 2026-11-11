#!/usr/bin/env bash
# Convex CLI on this machine, pointed at the self-hosted backend on the Mac mini.
#
#   scripts/mini-convex.sh dev        watch convex/ and push every save   (npm run convex)
#   scripts/mini-convex.sh deploy     typecheck and push once             (npm run convex:deploy)
#   scripts/mini-convex.sh status     check the backend answers and accepts the admin key
#   scripts/mini-convex.sh <cmd> …    any other Convex command: env list, logs, data, run, export, …
#
# Needs `ssh macmini` to work without a password (ssh-macmini/README.md); from other networks too
# once scripts/mini-remote.sh setup has put this machine on the mini's tailnet. The admin key is read over
# SSH on each run and only kept in this process's environment. The Mac mini's CA certificate (public)
# is cached in ~/.anomaly-mini so Node trusts the backend's LAN certificate.
# The CLI uses the backend's internet address when `local-convex.sh remote` has set one up, so the
# EXPO_PUBLIC_CONVEX_URL it writes to .env.local works on cellular too; otherwise the LAN address.
# Overrides: MINI_SSH (default macmini), MINI_URL.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SSH_HOST="${MINI_SSH:-macmini}"
CACHE="$HOME/.anomaly-mini"
HTTPS_PORT=3443

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# One SSH round trip: LAN address, admin key, internet address (may be empty), then the CA certificate.
use_mini() {
  local out host key origin
  out="$(ssh -o BatchMode=yes -o ConnectTimeout=5 "$SSH_HOST" \
    'D=$HOME/.anomaly-convex; printf "%s\n%s\n%s\n" "$(cat "$D/host")" "$(cat "$D/admin_key")" "$(cat "$D/public_origin" 2>/dev/null)"; cat "$D/tls/ca.pem"')" ||
    die "can't read the backend settings over 'ssh $SSH_HOST'. Is the Mac mini on? Off the home Wi-Fi, 'ssh $SSH_HOST' needs Tailscale here: scripts/mini-remote.sh status"
  host="$(sed -n 1p <<<"$out")"
  key="$(sed -n 2p <<<"$out")"
  origin="$(sed -n 3p <<<"$out")"
  [ -n "$host" ] && [ -n "$key" ] || die "the Mac mini has no backend set up (~/.anomaly-convex)"
  mkdir -p "$CACHE"
  chmod 700 "$CACHE"
  sed -n '4,$p' <<<"$out" >"$CACHE/ca.pem"
  grep -q 'BEGIN CERTIFICATE' "$CACHE/ca.pem" || die "the Mac mini sent no CA certificate"

  export CONVEX_SELF_HOSTED_URL="${MINI_URL:-${origin:-https://$host:$HTTPS_PORT}}"
  export CONVEX_SELF_HOSTED_ADMIN_KEY="$key"
  export NODE_EXTRA_CA_CERTS="$CACHE/ca.pem"
  # Empty, not unset: the CLI loads .env.local without overriding, and a cloud CONVEX_DEPLOYMENT
  # there would otherwise clash with the self-hosted variables.
  export CONVEX_DEPLOYMENT=""
  export CONVEX_DEPLOY_KEY=""
}

status() {
  local version
  version="$(curl -fsS -m 5 --cacert "$NODE_EXTRA_CA_CERTS" "$CONVEX_SELF_HOSTED_URL/version")" ||
    die "$CONVEX_SELF_HOSTED_URL is not answering"
  echo "backend  $CONVEX_SELF_HOSTED_URL  ($version)"
  if npx convex data >/dev/null 2>&1; then
    echo "admin key accepted"
  else
    die "the backend rejected the admin key"
  fi
}

cmd="${1:-status}"
shift || true
use_mini
cd "$ROOT"
case "$cmd" in
  status) status ;;
  dev) exec npx convex dev "$@" ;;
  deploy) exec npx convex deploy "$@" ;;
  *) exec npx convex "$cmd" "$@" ;;
esac
