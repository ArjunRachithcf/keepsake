#!/usr/bin/env bash
# Builds the image and starts it both ways: standalone with docker-compose.yml, and with the environment of the
# HomersLab manifest (contracts/homerslab-app.yaml). Each must answer /api/health in its mode with the security headers,
# let nobody in without a person (a forged X-HomersLab-* from anywhere but the trusted proxy included), and standalone
# must write its one-time setup link to the data folder (0600) instead of making the first visitor admin, and make the
# keys that seal the draws and sign pushes in keys/ (0600), never in data/ and never in the log. homerslab mode must refuse to start
# without its three settings, and run without a sealing key (draws off).
# Uses its own compose project (keepsake-m1test-*, or $KEEPSAKE_SMOKE_PROJECT) and removes everything it started.
set -euo pipefail
cd "$(dirname "$0")/.."
tag="keepsake:smoke-$$"
work="$(mktemp -d)"
project="${KEEPSAKE_SMOKE_PROJECT:-keepsake-m1test-$$}"
# Never another project: cleanup runs `down -v --remove-orphans`, which would remove every container of a live one.
[[ $project =~ ^keepsake-[a-z0-9-]+$ ]] || { echo "smoke: project must start with keepsake-: $project" >&2; exit 2; }
hl="$project-hl"
dc() { KEEPSAKE_IMAGE="$tag" docker compose -p "$project" --project-directory "$work" -f "$PWD/docker-compose.yml" "$@"; }
cleanup() {
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -fv "$hl" "$hl-bare" >/dev/null 2>&1 || true
  docker volume rm "$hl-data" >/dev/null 2>&1 || true
  docker image rm "$tag" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

docker build -q -t "$tag" . >/dev/null

wait_health() { # url mode: the body on one line, the CSP on the next
  local probe="fetch('$1').then(async r=>console.log(await r.text()+'\\n'+r.headers.get('content-security-policy')),()=>process.exit(1))"
  for _ in $(seq 1 30); do
    if out="$(docker run --rm --network host "$tag" node -e "$probe" 2>/dev/null)"; then
      if grep -q "\"mode\":\"$2\"" <<<"$out" && grep -q '"ok":true' <<<"$out"; then
        grep -q "frame-ancestors 'none'" <<<"$out" || { echo "no frame-ancestors 'none': $out" >&2; return 1; }
        echo "$out"
        return 0
      fi
    fi
    sleep 1
  done
  echo "no healthy answer from $1 in $2 mode" >&2
  return 1
}

status() { # url [headers as a JS object] [method]: the HTTP status from this host (through -p, so not from inside the container)
  local headers="${2:-null}"
  docker run --rm --network host "$tag" node -e "fetch('$1',{method:'${3:-GET}',headers:$headers||{}}).then(r=>console.log(r.status),()=>process.exit(1))"
}
FORGED="{'x-homerslab-person':'hl-someone','x-homerslab-name':'Someone','x-homerslab-role':'admin'}"

# 1. Standalone, as a household would run it.
mkdir -p "$work/data" "$work/keys"
chmod 755 "$work/data" "$work/keys" # as `mkdir data keys` would make them
port=$((20000 + $$ % 20000))
KEEPSAKE_PORT="$port" KEEPSAKE_UID="$(id -u)" KEEPSAKE_GID="$(id -g)" dc up -d --no-build
wait_health "http://127.0.0.1:$port/api/health" standalone
# published on 127.0.0.1 only, as the non-root user, with a read-only root
[ "$(docker port "$(dc ps -q keepsake)" 8080/tcp)" = "127.0.0.1:$port" ] || { echo "published beyond 127.0.0.1" >&2; exit 1; }
[ "$(dc exec -T keepsake id -u)" != 0 ] || { echo "runs as root" >&2; exit 1; }
dc exec -T keepsake sh -c 'touch /app/x' 2>/dev/null && { echo "the root is writable" >&2; exit 1; }
dc exec -T keepsake sh -c 'touch /data/x && rm /data/x' || { echo "/data is not writable" >&2; exit 1; }
# no first-visitor admin: a setup link in the data folder, readable by Keepsake's user only, and nobody signed in
[ "$(stat -c %a "$work/data/setup-link.txt")" = 600 ] || { echo "no private setup link in data/" >&2; exit 1; }
grep -Eq '^http://localhost:[0-9]+/setup#[A-Za-z0-9_-]{43}$' "$work/data/setup-link.txt" || { echo "the setup link looks wrong" >&2; exit 1; }
[ -s "$work/data/keepsake.sqlite" ] || { echo "no database in data/" >&2; exit 1; }
# the household's data for Keepsake's user only, although data/ was made with the usual umask
for f in "$work/data/keepsake.sqlite" "$work/data/keepsake.sqlite-wal" "$work/data/keepsake.sqlite-shm"; do
  [ ! -e "$f" ] || [ "$(stat -c %a "$f")" = 600 ] || { echo "$f is not 0600" >&2; exit 1; }
done
[ "$(stat -c %a "$work/data")" = 700 ] || { echo "data/ is not 0700" >&2; exit 1; }
[ "$(status "http://127.0.0.1:$port/api/household")" = 401 ] || { echo "standalone lets someone in without a passkey" >&2; exit 1; }
[ "$(status "http://127.0.0.1:$port/api/household" "$FORGED")" = 401 ] || { echo "standalone believes a HomersLab header" >&2; exit 1; }
[ "$(status "http://127.0.0.1:$port/api/guest")" = 401 ] || { echo "standalone lets a guest in without a link" >&2; exit 1; }
dc logs keepsake 2>&1 | grep -q '/setup#' && { echo "the setup link reached the log" >&2; exit 1; }
# the draws' key: made once in keys/ for Keepsake's user only, 32 bytes, not in data/, not in the log
[ "$(stat -c %a "$work/keys/sealing.key")" = 600 ] || { echo "no private sealing key in keys/" >&2; exit 1; }
[ "$(stat -c %a "$work/keys")" = 700 ] || { echo "keys/ is not 0700" >&2; exit 1; }
[ "$(base64 -d "$work/keys/sealing.key" | wc -c)" = 32 ] || { echo "the sealing key is not 32 bytes" >&2; exit 1; }
grep -rqF "$(cat "$work/keys/sealing.key")" "$work/data" && { echo "the sealing key is in data/" >&2; exit 1; }
dc logs keepsake 2>&1 | grep -qF "$(cat "$work/keys/sealing.key")" && { echo "the sealing key reached the log" >&2; exit 1; }
# Web Push's key (ADR 0010): the same rules, keys/vapid.key, 32 bytes, base64url
[ "$(stat -c %a "$work/keys/vapid.key")" = 600 ] || { echo "no private VAPID key in keys/" >&2; exit 1; }
[ "$(tr '_-' '/+' < "$work/keys/vapid.key" | tr -d '\n' | sed 's/$/=/' | base64 -d 2>/dev/null | wc -c)" = 32 ] || { echo "the VAPID key is not 32 bytes" >&2; exit 1; }
grep -rqF "$(cat "$work/keys/vapid.key")" "$work/data" && { echo "the VAPID key is in data/" >&2; exit 1; }
dc logs keepsake 2>&1 | grep -qF "$(cat "$work/keys/vapid.key")" && { echo "the VAPID key reached the log" >&2; exit 1; }
# the PWA's files are served; the service worker with the security headers
[ "$(status "http://127.0.0.1:$port/sw.js")" = 200 ] || { echo "no service worker" >&2; exit 1; }
[ "$(status "http://127.0.0.1:$port/site.webmanifest")" = 200 ] || { echo "no web app manifest" >&2; exit 1; }
[ "$(status "http://127.0.0.1:$port/api/notices")" = 401 ] || { echo "notices without a person" >&2; exit 1; }

# 2. HomersLab: the manifest's image settings (port, volume, env).
env_args=()
while IFS= read -r line; do env_args+=(-e "$line"); done < <(
  awk '/^env:/{f=1;next} f&&/^[^ ]/{f=0} f&&/^  [A-Z_]+:/{sub(/^  /,""); sub(/ *#.*/,""); sub(/: */,"="); print}' contracts/homerslab-app.yaml)
[ "${#env_args[@]}" -gt 0 ] || { echo "no env in the manifest" >&2; exit 1; }
port2=$((port + 1))
# Without HomersLab's three settings it must not start.
docker run --name "$hl-bare" "${env_args[@]}" --read-only --tmpfs /tmp --cap-drop ALL "$tag" >/dev/null 2>&1 \
  && { echo "homerslab mode started without its settings" >&2; exit 1; }
docker logs "$hl-bare" 2>&1 | grep -q 'KEEPSAKE_ORIGIN must be set' || { echo "homerslab mode failed for another reason" >&2; docker logs "$hl-bare" >&2; exit 1; }
# KEEPSAKE_EDGE_IDENTITY, KEEPSAKE_TRUSTED_PROXY and KEEPSAKE_ORIGIN are HomersLab's to give; stand-ins here. The
# requests below arrive through -p (docker-proxy or the bridge's gateway), never from 127.0.0.1 inside the container:
# so they are untrusted, and a forged identity must get nowhere.
docker run -d --name "$hl" "${env_args[@]}" -e KEEPSAKE_EDGE_IDENTITY=homerslab-v1 -e KEEPSAKE_TRUSTED_PROXY=127.0.0.1 -e KEEPSAKE_ORIGIN=https://keepsake.example.org \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$hl-data:/data" -p "127.0.0.1:$port2:8080" "$tag" >/dev/null
wait_health "http://127.0.0.1:$port2/api/health" homerslab
docker logs "$hl" 2>&1 | grep -q 'no sealing key' || { echo "homerslab mode without a sealing key did not say draws are off" >&2; exit 1; }
docker logs "$hl" 2>&1 | grep -q 'no VAPID key' || { echo "homerslab mode without a VAPID key did not say push is off" >&2; exit 1; }
[ "$(status "http://127.0.0.1:$port2/api/household" "$FORGED")" = 401 ] || { echo "homerslab believes a header from outside the proxy" >&2; exit 1; }
[ "$(status "http://127.0.0.1:$port2/api/guest" "$FORGED")" = 401 ] || { echo "homerslab lets a guest in without a link" >&2; exit 1; }
[ "$(status "http://127.0.0.1:$port2/api/auth/sign-in/options" null POST)" = 403 ] || { echo "a change without Origin was not refused" >&2; exit 1; }
echo "smoke: both modes healthy, nobody let in"
