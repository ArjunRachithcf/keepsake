#!/usr/bin/env bash
# Builds the image and starts it both ways: standalone with docker-compose.yml, and with the environment of the
# HomersLab manifest (contracts/homerslab-app.yaml). Each must answer /api/health in its mode with the security headers.
# Uses its own compose project (keepsake-m0test-*, or $KEEPSAKE_SMOKE_PROJECT) and removes everything it started.
set -euo pipefail
cd "$(dirname "$0")/.."
tag="keepsake:smoke-$$"
work="$(mktemp -d)"
project="${KEEPSAKE_SMOKE_PROJECT:-keepsake-m0test-$$}"
hl="$project-hl"
dc() { KEEPSAKE_IMAGE="$tag" docker compose -p "$project" --project-directory "$work" -f "$PWD/docker-compose.yml" "$@"; }
cleanup() {
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  docker rm -f "$hl" >/dev/null 2>&1 || true
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

# 1. Standalone, as a household would run it.
mkdir -p "$work/data"
port=$((20000 + $$ % 20000))
KEEPSAKE_PORT="$port" KEEPSAKE_UID="$(id -u)" KEEPSAKE_GID="$(id -g)" dc up -d --no-build
wait_health "http://127.0.0.1:$port/api/health" standalone
# published on 127.0.0.1 only, as the non-root user, with a read-only root
[ "$(docker port "$(dc ps -q keepsake)" 8080/tcp)" = "127.0.0.1:$port" ] || { echo "published beyond 127.0.0.1" >&2; exit 1; }
[ "$(dc exec -T keepsake id -u)" != 0 ] || { echo "runs as root" >&2; exit 1; }
dc exec -T keepsake sh -c 'touch /app/x' 2>/dev/null && { echo "the root is writable" >&2; exit 1; }
dc exec -T keepsake sh -c 'touch /data/x && rm /data/x' || { echo "/data is not writable" >&2; exit 1; }

# 2. HomersLab: the manifest's image settings (port, volume, env).
env_args=()
while IFS= read -r line; do env_args+=(-e "$line"); done < <(
  awk '/^env:/{f=1;next} f&&/^[^ ]/{f=0} f&&/^  [A-Z_]+:/{sub(/^  /,""); sub(/ *#.*/,""); sub(/: */,"="); print}' contracts/homerslab-app.yaml)
[ "${#env_args[@]}" -gt 0 ] || { echo "no env in the manifest" >&2; exit 1; }
port2=$((port + 1))
# KEEPSAKE_EDGE_IDENTITY, KEEPSAKE_TRUSTED_PROXY and KEEPSAKE_ORIGIN are HomersLab's to give; stand-ins here.
docker run -d --name "$hl" "${env_args[@]}" -e KEEPSAKE_EDGE_IDENTITY=homerslab-v1 -e KEEPSAKE_TRUSTED_PROXY=127.0.0.1 -e KEEPSAKE_ORIGIN=https://keepsake.example.org \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true \
  -v "$hl-data:/data" -p "127.0.0.1:$port2:8080" "$tag" >/dev/null
wait_health "http://127.0.0.1:$port2/api/health" homerslab
echo "smoke: both modes healthy"
