#!/usr/bin/env bash
# SSH to the Mac mini from any network, so `npm run convex:deploy` works away from the home Wi-Fi.
#
#   scripts/mini-remote.sh setup       join this Mac to the mini's tailnet and route `ssh macmini` over it
#   scripts/mini-remote.sh status      Tailscale here, and the path `ssh macmini` takes
#   scripts/mini-remote.sh uninstall   stop Tailscale here and put `ssh macmini` back on the LAN only
#
# The mini already runs Tailscale (scripts/local-convex.sh remote) in userspace mode, which hands
# connections from the tailnet to its own local ports, sshd included. This Mac runs the same
# open-source tailscaled as this user, also in userspace mode: no app, system extension or admin
# rights, and nothing on this Mac is routed over the tailnet except what asks for it. ssh reaches the
# mini through `tailscale nc`; it goes over the tailnet while Tailscale is up here, and straight to
# the LAN address otherwise. Login is still the key in ~/.ssh/id_ed25519_macmini: the tailnet only
# adds a way to reach the mini, never another way in. The mini's sshd isn't exposed to the internet.
# Shields are up here, so no other tailnet device can reach this Mac's ports (Metro, dev servers).
set -euo pipefail

TS_VERSION="1.104.2" # the mini's version
D="${ANOMALY_TAILSCALE_HOME:-$HOME/.anomaly-tailscale}"
LABEL="dev.anomaly.tailscale-client"
AGENTS="$HOME/Library/LaunchAgents"
ALIAS="macmini"
SSH_CONFIG="$HOME/.ssh/config"
MARK="scripts/mini-remote.sh"
MINI_TS="\$HOME/.anomaly-convex/bin/tailscale --socket=\$HOME/.anomaly-convex/tailscale/tailscaled.sock"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
ts() { "$D/bin/tailscale" --socket="$D/tailscaled.sock" "$@"; }
loaded() { launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; }

# The mini's tailnet address, read once over the LAN (Tailscale addresses don't change).
mini_ip() {
  if [ ! -s "$D/mini_ip" ]; then
    local ip
    ip="$(ssh -o BatchMode=yes -o ConnectTimeout=6 -o ProxyCommand=none "$ALIAS" "$MINI_TS ip -4")" ||
      die "can't reach the mini over 'ssh $ALIAS'. Run setup once on the home Wi-Fi."
    [[ "$ip" =~ ^100\.[0-9.]+$ ]] || die "the mini reported no tailnet address ('$ip'); is its Tailscale up?"
    mkdir -p "$D" && echo "$ip" >"$D/mini_ip"
  fi
  cat "$D/mini_ip"
}

# No Homebrew here, so both binaries are built with a private Go toolchain, as on the mini.
install_tailscale() {
  [ -x "$D/bin/tailscaled" ] && [ -x "$D/bin/tailscale" ] && [ -z "${UPGRADE:-}" ] && return
  local go="$HOME/.local/go/bin/go" v arch
  if [ ! -x "$go" ]; then
    v="$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -1)"
    case "$(uname -m)" in arm64) arch=arm64 ;; *) arch=amd64 ;; esac
    say "Downloading $v"
    mkdir -p "$HOME/.local"
    curl -fsSL "https://go.dev/dl/$v.darwin-$arch.tar.gz" | tar -xz -C "$HOME/.local"
  fi
  say "Building Tailscale $TS_VERSION"
  mkdir -p "$D/bin"
  (cd /tmp && GOTOOLCHAIN=auto GOBIN="$D/bin" GOFLAGS=-trimpath "$go" install \
    "tailscale.com/cmd/tailscale@v$TS_VERSION" "tailscale.com/cmd/tailscaled@v$TS_VERSION")
}

write_service() {
  mkdir -p "$D/state" "$D/logs" "$AGENTS"
  chmod 700 "$D" "$D/state"
  cat >"$D/run-tailscaled.sh" <<EOF
#!/bin/bash
set -euo pipefail
LOG="$D/logs/tailscaled.log"
if [ -f "\$LOG" ] && [ "\$(stat -f%z "\$LOG")" -gt 10485760 ]; then mv -f "\$LOG" "\$LOG.1"; fi
exec >>"\$LOG" 2>&1
exec "$D/bin/tailscaled" --tun=userspace-networking --statedir="$D/state" --socket="$D/tailscaled.sock"
EOF
  chmod 700 "$D/run-tailscaled.sh"
  cat >"$AGENTS/$LABEL.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key><array><string>/bin/bash</string><string>$D/run-tailscaled.sh</string></array>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>5</integer>
</dict>
</plist>
EOF
  # ssh's ProxyCommand: over the tailnet while Tailscale is up here, else the LAN address ssh was given.
  cat >"$D/ssh-proxy.sh" <<EOF
#!/bin/sh
# ProxyCommand for 'Host $ALIAS' in ~/.ssh/config, written by $MARK.
if "$D/bin/tailscale" --socket="$D/tailscaled.sock" status >/dev/null 2>&1; then
  exec "$D/bin/tailscale" --socket="$D/tailscaled.sock" nc "\$(cat "$D/mini_ip")" "\$2"
fi
exec /usr/bin/nc "\$1" "\$2"
EOF
  chmod 700 "$D/ssh-proxy.sh"
}

start_service() {
  loaded || launchctl bootstrap "gui/$(id -u)" "$AGENTS/$LABEL.plist"
  local i
  for i in $(seq 1 30); do [ -S "$D/tailscaled.sock" ] && ts version >/dev/null 2>&1 && return; sleep 1; done
  die "tailscaled didn't start; see $D/logs/tailscaled.log"
}

# Prints a login URL the first time: sign in with the account the mini's tailnet belongs to.
login() {
  ts status >/dev/null 2>&1 && return
  local name
  name="$(scutil --get LocalHostName | tr '[:upper:]' '[:lower:]')"
  say "Sign in with the same account as the Mac mini's Tailscale:"
  ts up --hostname="$name" --shields-up --timeout="${TS_UP_TIMEOUT:-0s}"
}

# Adds the ProxyCommand to the existing 'Host macmini' block, once.
route_ssh() {
  grep -q "^Host $ALIAS\$" "$SSH_CONFIG" 2>/dev/null ||
    die "no 'Host $ALIAS' in $SSH_CONFIG; set up LAN ssh first (connect-from-other-machine.sh)"
  grep -q "$MARK" "$SSH_CONFIG" && return
  cp "$SSH_CONFIG" "$SSH_CONFIG.before-mini-remote"
  awk -v alias="$ALIAS" -v proxy="$D/ssh-proxy.sh" -v mark="$MARK" '
    { print }
    $0 == "Host " alias {
      print "  # Over Tailscale from any network, the LAN otherwise (" mark ")"
      print "  ProxyCommand " proxy " %h %p"
    }' "$SSH_CONFIG.before-mini-remote" >"$SSH_CONFIG"
  chmod 600 "$SSH_CONFIG"
}

unroute_ssh() {
  grep -q "$MARK" "$SSH_CONFIG" 2>/dev/null || return 0
  local tmp
  tmp="$(mktemp)"
  awk -v mark="$MARK" -v proxy="$D/ssh-proxy.sh" 'index($0, mark) || index($0, proxy) { next } { print }' \
    "$SSH_CONFIG" >"$tmp"
  cat "$tmp" >"$SSH_CONFIG" && rm -f "$tmp"
}

status() {
  if ! loaded; then
    echo "Tailscale here: not set up (run: scripts/mini-remote.sh setup)"
  elif ts status >/dev/null 2>&1; then
    echo "Tailscale here: up as $(ts ip -4)"
    ts status | grep -F "$(cat "$D/mini_ip" 2>/dev/null || echo none)" || echo "  the mini isn't in this tailnet"
  else
    echo "Tailscale here: $(ts status 2>&1 | head -1)"
  fi
  local t0 t1
  t0="$(date +%s)"
  if ssh -o BatchMode=yes -o ConnectTimeout=15 "$ALIAS" true 2>/dev/null; then
    t1="$(date +%s)"
    echo "ssh $ALIAS: OK ($((t1 - t0))s, $(ts status >/dev/null 2>&1 && echo "over the tailnet" || echo "over the LAN"))"
  else
    echo "ssh $ALIAS: failed"
    return 1
  fi
}

setup() {
  local ip
  ip="$(mini_ip)"
  install_tailscale
  write_service
  start_service
  login
  route_ssh
  say "Checking ssh $ALIAS over the tailnet ($ip)"
  ssh -o BatchMode=yes -o ConnectTimeout=20 "$ALIAS" 'echo "  reached $(hostname)"' ||
    die "ssh over the tailnet failed; is the mini's Tailscale up? (scripts/local-convex.sh status on the mini)"
  status
  say "Done. 'ssh $ALIAS' and 'npm run convex:deploy' now work from any network."
}

uninstall() {
  unroute_ssh
  if loaded; then
    ts down 2>/dev/null || true
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  fi
  rm -f "$AGENTS/$LABEL.plist"
  echo "Tailscale stopped here and 'ssh $ALIAS' is LAN-only again. Binaries and login stay in $D."
}

cmd="${1:-status}"
shift || true
case "$cmd" in
  setup) setup ;;
  status) status ;;
  uninstall) uninstall ;;
  tailscale) ts "$@" ;;
  *) die "usage: scripts/mini-remote.sh setup | status | uninstall | tailscale …" ;;
esac
