#!/usr/bin/env bash
# Self-hosted Convex backend on this Mac, served to the LAN over HTTPS so the iPhone app can use it.
#
#   scripts/local-convex.sh setup       install/refresh everything, start the services, push functions
#   scripts/local-convex.sh status      services + endpoint health
#   scripts/local-convex.sh start | stop | restart
#   scripts/local-convex.sh env         print exports:  eval "$(scripts/local-convex.sh env)"
#   scripts/local-convex.sh convex …    Convex CLI against the local backend (dev, env, logs, export, …)
#   scripts/local-convex.sh expo …      Expo with EXPO_PUBLIC_CONVEX_URL pointing at the local backend
#   scripts/local-convex.sh migrate     copy env vars + data from a cloud deployment (CLOUD_DEPLOY_KEY=…)
#   scripts/local-convex.sh remote      public HTTPS address through Tailscale Funnel, for the phone off Wi-Fi
#   scripts/local-convex.sh uninstall   stop and remove the launch agents (data stays)
#
# Layout: convex-local-backend on 127.0.0.1:3210 (API) / :3211 (HTTP actions), Caddy terminates TLS on
# :3443 for the LAN with a leaf cert from a private CA that is name-constrained to *.local, localhost and
# private IP ranges, and serves that CA on http://<host>.local:3480 for the iPhone to install.
# `remote` adds tailscaled (userspace networking, so it runs as this user with no system extension) and
# funnels https://<name>.<tailnet>.ts.net to the backend with a publicly trusted certificate. Once set,
# that address is the backend's origin (file URLs) and the one the app is built against.
# State lives in $ANOMALY_CONVEX_HOME (default ~/.anomaly-convex): outside the repo so launchd can read it
# (~/Downloads is privacy-protected) and data survives a fresh checkout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${ANOMALY_CONVEX_HOME:-$HOME/.anomaly-convex}"
INSTANCE="anomaly"
BACKEND_PORT=3210
SITE_PORT=3211
HTTPS_PORT=3443
CA_PORT=3480
LABEL_BACKEND="dev.anomaly.convex-backend"
LABEL_PROXY="dev.anomaly.convex-https"
LABEL_TUNNEL="dev.anomaly.tailscale"
TS_VERSION="1.104.2"
TS_HOSTNAME="${ANOMALY_TS_HOSTNAME:-anomaly}"
AGENTS="$HOME/Library/LaunchAgents"
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

lan_ip() {
  local ifc
  ifc="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}')"
  ipconfig getifaddr "${ifc:-en0}" 2>/dev/null || true
}
mdns_name() { echo "$(scutil --get LocalHostName | tr '[:upper:]' '[:lower:]').local"; }
# Address the phone uses. Defaults to the LAN IP: <name>.local depends on mDNS, which this Mac doesn't
# always answer. Give the Mac a DHCP reservation on the router so the IP stays put.
detect_host() {
  if [ -n "${ANOMALY_CONVEX_HOST:-}" ]; then echo "$ANOMALY_CONVEX_HOST"
  elif [ -n "$(lan_ip)" ]; then lan_ip
  else mdns_name; fi
}
# Address the running backend was configured with (its storage/upload URLs use it).
host() { if [ -s "$HOME_DIR/host" ]; then cat "$HOME_DIR/host"; else detect_host; fi; }
public_url() { echo "https://$(host):$HTTPS_PORT"; }
# Internet address from `remote`, when set up. The app is built against it, on Wi-Fi or not.
remote_url() { [ -s "$HOME_DIR/public_origin" ] && cat "$HOME_DIR/public_origin"; }
app_url() { remote_url || public_url; }
ts() { "$HOME_DIR/bin/tailscale" --socket="$HOME_DIR/tailscale/tailscaled.sock" "$@"; }
admin_key() { [ -s "$HOME_DIR/admin_key" ] || die "not set up yet: run scripts/local-convex.sh setup"; cat "$HOME_DIR/admin_key"; }

# Convex CLI env for the local backend. The CLI goes through the HTTPS proxy (trusting the local CA) so
# the URL `convex dev` writes to .env.local as EXPO_PUBLIC_CONVEX_URL is the one the phone can reach.
# CONVEX_DEPLOYMENT is set empty so a cloud value in .env.local (which the CLI loads without
# overriding) can't conflict with the self-hosted vars.
use_local() {
  export CONVEX_SELF_HOSTED_URL
  CONVEX_SELF_HOSTED_URL="$(public_url)"
  export NODE_EXTRA_CA_CERTS="$HOME_DIR/tls/ca.pem"
  CONVEX_SELF_HOSTED_ADMIN_KEY="$(admin_key)"
  export CONVEX_SELF_HOSTED_ADMIN_KEY
  export CONVEX_DEPLOYMENT=""
  export CONVEX_DEPLOY_KEY=""
  export EXPO_PUBLIC_CONVEX_URL
  EXPO_PUBLIC_CONVEX_URL="$(app_url)"
}
convex_local() { (use_local && cd "$ROOT" && npx convex "$@"); }

install_backend() {
  local bin="$HOME_DIR/bin/convex-local-backend"
  if [ -x "$bin" ] && [ -z "${UPGRADE:-}" ]; then return; fi
  local arch asset url tmp
  arch="$(uname -m)"; [ "$arch" = arm64 ] && arch=aarch64
  asset="convex-local-backend-$arch-apple-darwin.zip"
  url="$(curl -fsSL "https://api.github.com/repos/get-convex/convex-backend/releases?per_page=30" |
    ASSET="$asset" node -e '
      let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
        for (const r of JSON.parse(s)) {
          const a = r.assets.find((x) => x.name === process.env.ASSET);
          if (a) return console.log(a.browser_download_url);
        }
      });')"
  [ -n "$url" ] || die "no $asset in recent convex-backend releases"
  say "Downloading $url"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/backend.zip" "$url"
  unzip -o -q "$tmp/backend.zip" -d "$tmp"
  mkdir -p "$HOME_DIR/bin"
  mv -f "$tmp/convex-local-backend" "$bin"
  chmod +x "$bin"
  xattr -d com.apple.quarantine "$bin" 2>/dev/null || true
  rm -rf "$tmp"
}

make_keys() {
  local bin="$HOME_DIR/bin/convex-local-backend"
  if [ ! -s "$HOME_DIR/instance_secret" ]; then
    (umask 077 && openssl rand -hex 32 >"$HOME_DIR/instance_secret")
  fi
  if [ ! -s "$HOME_DIR/admin_key" ]; then
    (umask 077 && "$bin" keygen admin-key --instance-name "$INSTANCE" \
      --instance-secret "$(cat "$HOME_DIR/instance_secret")" | tail -n 1 >"$HOME_DIR/admin_key")
  fi
}

# Private CA (created once, 10 years) + leaf cert re-issued whenever the host/IP changes or it nears expiry.
# iOS rejects leaf certs valid for more than 825 days, so the leaf gets 800.
make_certs() {
  local h="$1" ip="$2" d="$HOME_DIR/tls" sans mdns
  mdns="$(mdns_name)"
  mkdir -p "$d" "$HOME_DIR/public"
  chmod 700 "$d"
  if [ ! -s "$d/ca.key" ]; then
    say "Creating local CA"
    cat >"$d/ca.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3_ca
[dn]
CN = Anomaly Local CA ($mdns)
O = Anomaly (self-hosted)
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;DNS:local, permitted;DNS:localhost, permitted;IP:127.0.0.0/255.0.0.0, permitted;IP:10.0.0.0/255.0.0.0, permitted;IP:172.16.0.0/255.240.0.0, permitted;IP:192.168.0.0/255.255.0.0
EOF
    (umask 077 && openssl req -x509 -new -nodes -newkey rsa:2048 -sha256 -days 3650 \
      -keyout "$d/ca.key" -out "$d/ca.pem" -config "$d/ca.cnf" 2>/dev/null)
  fi
  sans="DNS:$mdns,DNS:localhost,IP:127.0.0.1${ip:+,IP:$ip}"
  case "$h" in
    "$mdns" | "$ip") ;;
    *[!0-9.]*) sans="$sans,DNS:$h" ;;
    *) sans="$sans,IP:$h" ;;
  esac
  if [ ! -s "$d/server.pem" ] || [ "$(cat "$d/server.sans" 2>/dev/null)" != "$sans" ] ||
    ! openssl x509 -checkend 2592000 -noout -in "$d/server.pem" >/dev/null; then
    say "Issuing TLS cert for $sans"
    cat >"$d/server.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = $h
[v3]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = $sans
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
EOF
    (umask 077 && openssl req -new -nodes -newkey rsa:2048 -sha256 -keyout "$d/server.key" \
      -out "$d/server.csr" -config "$d/server.cnf" 2>/dev/null)
    openssl x509 -req -in "$d/server.csr" -CA "$d/ca.pem" -CAkey "$d/ca.key" -CAcreateserial \
      -days 800 -sha256 -extfile "$d/server.cnf" -extensions v3 -out "$d/server.pem" 2>/dev/null
    echo "$sans" >"$d/server.sans"
  fi
  openssl x509 -in "$d/ca.pem" -outform der -out "$HOME_DIR/public/anomaly-ca.cer"
}

write_public_page() {
  local h="$1"
  cat >"$HOME_DIR/public/index.html" <<EOF
<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Anomaly local backend</title>
<body style="font:17px -apple-system,sans-serif;background:#000;color:#eee;padding:24px;line-height:1.5">
<h2>Anomaly local backend</h2>
<p>Trust this Mac's certificate once on the iPhone (open this page in Safari):</p>
<ol>
<li><a style="color:#8ab4ff" href="/anomaly-ca.cer">Download the certificate</a> and tap Allow.</li>
<li>Settings &rarr; General &rarr; VPN &amp; Device Management &rarr; Anomaly Local CA &rarr; Install.</li>
<li>Settings &rarr; General &rarr; About &rarr; Certificate Trust Settings &rarr; turn on Anomaly Local CA.</li>
<li>Check: <a style="color:#8ab4ff" href="https://$h:$HTTPS_PORT/version">https://$h:$HTTPS_PORT/version</a> loads without a warning.</li>
</ol>
<p style="color:#888">The certificate only works for *.local, localhost and private network addresses.</p>
</body>
EOF
}

write_services() {
  local h="$1" ip="$2" caddy sites mdns
  mdns="$(mdns_name)"
  caddy="$(command -v caddy)" || die "caddy missing: brew install caddy"
  mkdir -p "$HOME_DIR/logs" "$HOME_DIR/data/storage" "$AGENTS"
  echo "$h" >"$HOME_DIR/host"

  cat >"$HOME_DIR/run-backend.sh" <<EOF
#!/bin/bash
set -euo pipefail
D="$HOME_DIR"
LOG="\$D/logs/backend.log"
if [ -f "\$LOG" ] && [ "\$(stat -f%z "\$LOG")" -gt 52428800 ]; then mv -f "\$LOG" "\$LOG.1"; fi
exec >>"\$LOG" 2>&1
ORIGIN="https://\$(cat "\$D/host"):$HTTPS_PORT"
if [ -s "\$D/public_origin" ]; then ORIGIN="\$(cat "\$D/public_origin")"; fi
cd "\$D/data"
exec "\$D/bin/convex-local-backend" \\
  --instance-name "$INSTANCE" \\
  --instance-secret "\$(cat "\$D/instance_secret")" \\
  --interface 127.0.0.1 --port $BACKEND_PORT --site-proxy-port $SITE_PORT \\
  --convex-origin "\$ORIGIN" \\
  --convex-site "http://127.0.0.1:$SITE_PORT" \\
  --local-storage "\$D/data/storage" \\
  --disable-beacon \\
  "\$D/data/convex_local_backend.sqlite3"
EOF

  cat >"$HOME_DIR/run-https.sh" <<EOF
#!/bin/bash
set -euo pipefail
D="$HOME_DIR"
LOG="\$D/logs/https.log"
if [ -f "\$LOG" ] && [ "\$(stat -f%z "\$LOG")" -gt 10485760 ]; then mv -f "\$LOG" "\$LOG.1"; fi
exec >>"\$LOG" 2>&1
exec "$caddy" run --config "\$D/Caddyfile" --adapter caddyfile
EOF
  chmod 700 "$HOME_DIR/run-backend.sh" "$HOME_DIR/run-https.sh"

  sites="https://$mdns:$HTTPS_PORT, https://localhost:$HTTPS_PORT, https://127.0.0.1:$HTTPS_PORT${ip:+, https://$ip:$HTTPS_PORT}"
  case "$h" in "$mdns" | "$ip") ;; *) sites="$sites, https://$h:$HTTPS_PORT" ;; esac
  cat >"$HOME_DIR/Caddyfile" <<EOF
{
	admin off
	auto_https disable_redirects
	skip_install_trust
	default_sni $mdns
}

$sites {
	tls $HOME_DIR/tls/server.pem $HOME_DIR/tls/server.key
	reverse_proxy 127.0.0.1:$BACKEND_PORT {
		flush_interval -1
	}
}

http://:$CA_PORT {
	root * $HOME_DIR/public
	header /anomaly-ca.cer Content-Type application/x-x509-ca-cert
	file_server
}
EOF

  plist "$LABEL_BACKEND" "$HOME_DIR/run-backend.sh"
  plist "$LABEL_PROXY" "$HOME_DIR/run-https.sh"
}

plist() {
  cat >"$AGENTS/$1.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$1</string>
	<key>ProgramArguments</key><array><string>/bin/bash</string><string>$2</string></array>
	<key>WorkingDirectory</key><string>$HOME_DIR</string>
	<key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>ThrottleInterval</key><integer>5</integer>
</dict>
</plist>
EOF
}

loaded() { launchctl print "gui/$(id -u)/$1" >/dev/null 2>&1; }
start() {
  for l in "$LABEL_BACKEND" "$LABEL_PROXY"; do
    [ -f "$AGENTS/$l.plist" ] || die "not set up yet: run scripts/local-convex.sh setup"
    loaded "$l" || launchctl bootstrap "gui/$(id -u)" "$AGENTS/$l.plist"
  done
  wait_healthy
}
# bootout returns before the job is gone; wait so an immediate start doesn't see it as still loaded.
stop() {
  local l i
  for l in "$LABEL_PROXY" "$LABEL_BACKEND"; do
    loaded "$l" || continue
    launchctl bootout "gui/$(id -u)/$l" 2>/dev/null || true
    for i in $(seq 1 50); do loaded "$l" || break; sleep 0.2; done
  done
}
restart() { stop; start; }

wait_healthy() {
  local i
  for i in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$BACKEND_PORT/version" >/dev/null 2>&1 &&
      curl -fsS --cacert "$HOME_DIR/tls/ca.pem" "$(public_url)/version" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  die "backend not healthy after 60s; see $HOME_DIR/logs/"
}

status() {
  local h now
  h="$(host)"; now="$(detect_host)"
  for l in "$LABEL_BACKEND" "$LABEL_PROXY"; do
    if loaded "$l"; then echo "$l: loaded"; else echo "$l: not loaded"; fi
  done
  printf 'backend  http://127.0.0.1:%s  ' "$BACKEND_PORT"
  curl -fsS -m 3 "http://127.0.0.1:$BACKEND_PORT/version" 2>/dev/null || printf 'DOWN'; echo
  printf 'phone    %s  ' "$(public_url)"
  curl -fsS -m 3 --cacert "$HOME_DIR/tls/ca.pem" "$(public_url)/version" 2>/dev/null || printf 'DOWN'; echo
  echo "CA page  http://$h:$CA_PORT"
  if [ -f "$AGENTS/$LABEL_TUNNEL.plist" ]; then
    if loaded "$LABEL_TUNNEL"; then echo "$LABEL_TUNNEL: loaded"; else echo "$LABEL_TUNNEL: not loaded"; fi
  fi
  if remote_url >/dev/null; then
    printf 'internet %s  ' "$(remote_url)"
    curl -fsS -m 10 "$(remote_url)/version" 2>/dev/null || printf 'DOWN'; echo
  fi
  if [ "$now" != "$h" ]; then
    echo "note: this Mac is now at $now but the backend is configured for $h; run setup again"
  fi
}

push() {
  say "Pushing functions"
  convex_local dev --once
}

setup() {
  local h ip
  h="$(detect_host)"; ip="$(lan_ip)"
  command -v caddy >/dev/null || { say "Installing Caddy"; brew install caddy; }
  [ -d "$ROOT/node_modules/convex" ] || (cd "$ROOT" && npm install)
  mkdir -p "$HOME_DIR"
  chmod 700 "$HOME_DIR"
  install_backend
  make_keys
  make_certs "$h" "$ip"
  write_public_page "$h"
  write_services "$h" "$ip"
  stop
  start
  push
  say "Setting deployment env"
  (use_local && cd "$ROOT" && node scripts/setup-convex-env.mjs)
  echo
  status
  echo
  say "iPhone: open http://$h:$CA_PORT in Safari once and trust the certificate."
  say "App:    npm run start:local   (EXPO_PUBLIC_CONVEX_URL=$(app_url))"
}

# Homebrew has no Intel bottle for this macOS, so both binaries are built with a private Go toolchain.
install_tailscale() {
  if [ -x "$HOME_DIR/bin/tailscaled" ] && [ -x "$HOME_DIR/bin/tailscale" ] && [ -z "${UPGRADE:-}" ]; then
    return
  fi
  local go="$HOME/.local/go/bin/go" v arch
  if [ ! -x "$go" ]; then
    v="$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -1)"
    case "$(uname -m)" in arm64) arch=arm64 ;; *) arch=amd64 ;; esac
    say "Downloading $v"
    mkdir -p "$HOME/.local"
    curl -fsSL "https://go.dev/dl/$v.darwin-$arch.tar.gz" | tar -xz -C "$HOME/.local"
  fi
  say "Building Tailscale $TS_VERSION"
  mkdir -p "$HOME_DIR/bin"
  (cd /tmp && GOTOOLCHAIN=auto GOBIN="$HOME_DIR/bin" GOFLAGS=-trimpath "$go" install \
    "tailscale.com/cmd/tailscale@v$TS_VERSION" "tailscale.com/cmd/tailscaled@v$TS_VERSION")
}

write_tunnel_service() {
  mkdir -p "$HOME_DIR/tailscale" "$HOME_DIR/logs" "$AGENTS"
  chmod 700 "$HOME_DIR/tailscale"
  cat >"$HOME_DIR/run-tailscale.sh" <<EOF
#!/bin/bash
set -euo pipefail
D="$HOME_DIR"
LOG="\$D/logs/tailscale.log"
if [ -f "\$LOG" ] && [ "\$(stat -f%z "\$LOG")" -gt 10485760 ]; then mv -f "\$LOG" "\$LOG.1"; fi
exec >>"\$LOG" 2>&1
exec "\$D/bin/tailscaled" --tun=userspace-networking --statedir="\$D/tailscale" \\
  --socket="\$D/tailscale/tailscaled.sock"
EOF
  chmod 700 "$HOME_DIR/run-tailscale.sh"
  plist "$LABEL_TUNNEL" "$HOME_DIR/run-tailscale.sh"
}

# Signing in prints a login URL and waits; so does turning Funnel on for the tailnet the first time.
remote() {
  local i name url
  install_tailscale
  write_tunnel_service
  loaded "$LABEL_TUNNEL" || launchctl bootstrap "gui/$(id -u)" "$AGENTS/$LABEL_TUNNEL.plist"
  for i in $(seq 1 30); do [ -S "$HOME_DIR/tailscale/tailscaled.sock" ] && break; sleep 1; done
  ts up --hostname="$TS_HOSTNAME"
  ts funnel --bg "http://127.0.0.1:$BACKEND_PORT"
  name="$(ts status --json | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,"")))')"
  [ -n "$name" ] || die "Tailscale reported no DNS name; is MagicDNS on for the tailnet?"
  url="https://$name"
  echo "$url" >"$HOME_DIR/public_origin"
  write_services "$(host)" "$(lan_ip)"
  restart
  say "Waiting for $url (the first certificate can take a minute)"
  for i in $(seq 1 90); do curl -fsS -m 10 "$url/version" >/dev/null 2>&1 && break; sleep 2; done
  status
  say "App: build with EXPO_PUBLIC_CONVEX_URL=$url"
}

migrate() {
  [ -n "${CLOUD_DEPLOY_KEY:-}" ] ||
    die "set CLOUD_DEPLOY_KEY to a deploy key of the cloud deployment (dashboard → Settings → Deploy keys)"
  local stamp tmp backups
  stamp="$(date +%Y%m%d-%H%M%S)"; backups="$HOME_DIR/backups"; tmp="$(mktemp -d)"
  mkdir -p "$backups"
  cloud() { (cd "$ROOT" && env -u CONVEX_SELF_HOSTED_URL -u CONVEX_SELF_HOSTED_ADMIN_KEY \
    CONVEX_DEPLOYMENT="" CONVEX_DEPLOY_KEY="$CLOUD_DEPLOY_KEY" npx convex "$@"); }
  say "Exporting cloud env + data"
  cloud env list >"$tmp/env"
  cloud export --include-file-storage --path "$backups/cloud-$stamp.zip"
  say "Backing up local data"
  convex_local export --include-file-storage --path "$backups/local-before-migrate-$stamp.zip"
  say "Copying env vars"
  local line name
  while IFS= read -r line || [ -n "$line" ]; do
    name="${line%%=*}"
    [[ "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
    convex_local env set "$name" -- "${line#*=}" >/dev/null
    echo "+ $name"
  done <"$tmp/env"
  rm -rf "$tmp"
  push
  say "Importing data (replaces local tables)"
  convex_local import --replace-all -y "$backups/cloud-$stamp.zip"
  say "Done. Backups in $backups"
}

uninstall() {
  stop
  if loaded "$LABEL_TUNNEL"; then launchctl bootout "gui/$(id -u)/$LABEL_TUNNEL" 2>/dev/null || true; fi
  rm -f "$AGENTS/$LABEL_BACKEND.plist" "$AGENTS/$LABEL_PROXY.plist" "$AGENTS/$LABEL_TUNNEL.plist"
  echo "Launch agents removed. Data, keys and certs remain in $HOME_DIR."
}

cmd="${1:-status}"; shift || true
case "$cmd" in
  setup) setup ;;
  start) start && status ;;
  stop) stop ;;
  restart) restart && status ;;
  status) status ;;
  env)
    use_local
    printf 'export CONVEX_SELF_HOSTED_URL=%q\nexport CONVEX_SELF_HOSTED_ADMIN_KEY=%q\nexport NODE_EXTRA_CA_CERTS=%q\nexport CONVEX_DEPLOYMENT=\nexport EXPO_PUBLIC_CONVEX_URL=%q\n' \
      "$CONVEX_SELF_HOSTED_URL" "$CONVEX_SELF_HOSTED_ADMIN_KEY" "$NODE_EXTRA_CA_CERTS" "$EXPO_PUBLIC_CONVEX_URL" ;;
  convex) convex_local "$@" ;;
  expo) (use_local && cd "$ROOT" && npx expo "$@") ;;
  migrate) migrate ;;
  remote) remote ;;
  tailscale) ts "$@" ;;
  uninstall) uninstall ;;
  *) sed -n '2,13p' "$0"; exit 1 ;;
esac
