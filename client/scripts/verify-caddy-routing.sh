#!/usr/bin/env bash
# Verifies the production routing contract in client/Caddyfile against a
# real `dist/` build, using a real `caddy` binary — the only way to
# meaningfully test this, since the logic lives entirely in Caddyfile
# directive ordering (route/rewrite/try_files/file_server), not in any
# JS/TS this repo's vitest suite could exercise.
#
# Not part of `npm test`: it needs a `caddy` binary and a completed
# `npm run build`, neither of which every environment running the fast
# unit-test suite is guaranteed to have. Run explicitly:
#   npm run build && ./scripts/verify-caddy-routing.sh
#
# Skips (exit 0) if `caddy` isn't on PATH, rather than failing — this is a
# routing-contract check for environments that have Caddy available (e.g.
# a dedicated CI job or local verification before a deploy), not a hard
# gate on every machine.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DIST_DIR="$CLIENT_DIR/dist"
CADDYFILE_SRC="$CLIENT_DIR/Caddyfile"
PORT="${VERIFY_CADDY_PORT:-8899}"
BASE="http://localhost:$PORT"

if ! command -v caddy >/dev/null 2>&1; then
  echo "caddy binary not found on PATH — skipping routing-contract verification."
  echo "Install: https://caddyserver.com/docs/install"
  exit 0
fi

if [ ! -d "$DIST_DIR" ]; then
  echo "client/dist not found — run 'npm run build' first." >&2
  exit 1
fi

RENDERED="$(mktemp)"
trap 'rm -f "$RENDERED"; [ -n "${CADDY_PID:-}" ] && kill "$CADDY_PID" 2>/dev/null || true' EXIT

# Render Railpack's Go-template placeholders to real local values — Caddy
# itself never sees {{.DIST_DIR}}, only Railpack's build-time templating
# does (see core/providers/node/spa.go in railwayapp/railpack). This
# mirrors that substitution for local testing only; the committed
# Caddyfile keeps the literal placeholders for Railpack to render.
sed \
  -e "s|{{.DIST_DIR}}|$DIST_DIR|g" \
  -e "s|{{if .IndexFallback}} /index.html{{end}}| /index.html|g" \
  "$CADDYFILE_SRC" > "$RENDERED"

echo "== caddy fmt check (must match what Railpack's 'caddy fmt --overwrite' produces at build time) =="
FMT_CHECK="$(mktemp)"
cp "$RENDERED" "$FMT_CHECK"
caddy fmt --overwrite "$FMT_CHECK" >/dev/null
if ! diff -q "$RENDERED" "$FMT_CHECK" >/dev/null; then
  echo "FAIL: client/Caddyfile is not caddy-fmt-clean. Run: caddy fmt --overwrite client/Caddyfile" >&2
  rm -f "$FMT_CHECK"
  exit 1
fi
rm -f "$FMT_CHECK"
echo "ok"

echo "== caddy validate =="
if ! caddy validate --config "$RENDERED" --adapter caddyfile >/tmp/verify-caddy-validate.log 2>&1; then
  cat /tmp/verify-caddy-validate.log >&2
  echo "FAIL: Caddyfile did not validate." >&2
  exit 1
fi
echo "ok"

echo "== starting caddy on :$PORT =="
PORT="$PORT" caddy run --config "$RENDERED" --adapter caddyfile >/tmp/verify-caddy-run.log 2>&1 &
CADDY_PID=$!
for _ in $(seq 1 20); do
  curl -fsS -o /dev/null "$BASE/" 2>/dev/null && break
  sleep 0.25
done

fail=0
assert_contains() {
  local desc="$1" url="$2" needle="$3"
  local body status
  body="$(curl -fsS -w '\n%{http_code}' "$url" 2>/dev/null || true)"
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [ "$status" != "200" ]; then
    echo "FAIL ($desc): $url returned HTTP $status"
    fail=1
    return
  fi
  if ! grep -qF "$needle" <<<"$body"; then
    echo "FAIL ($desc): $url did not contain '$needle'"
    fail=1
    return
  fi
  echo "ok  ($desc)"
}

assert_status() {
  local desc="$1" url="$2" expected="$3"
  local status
  status="$(curl -s -o /dev/null -w '%{http_code}' "$url" 2>/dev/null || true)"
  if [ "$status" != "$expected" ]; then
    echo "FAIL ($desc): $url returned HTTP $status, expected $expected"
    fail=1
    return
  fi
  echo "ok  ($desc)"
}

assert_no_redirect() {
  local desc="$1" url="$2"
  local redirects
  redirects="$(curl -s -o /dev/null -w '%{num_redirects}' "$url" 2>/dev/null || true)"
  if [ "$redirects" != "0" ]; then
    echo "FAIL ($desc): $url followed $redirects redirect(s), expected 0"
    fail=1
    return
  fi
  echo "ok  ($desc)"
}

assert_contains "desktop root serves desktop shell"        "$BASE/"                              '<title>GrowLink</title>'
assert_contains "desktop root links desktop manifest"       "$BASE/"                              'manifest.webmanifest'
assert_contains "/mobile serves mobile shell"                "$BASE/mobile"                        '<title>GrowLink Mobile</title>'
assert_contains "/mobile links mobile manifest"              "$BASE/mobile"                        'manifest-mobile.webmanifest'
assert_contains "/mobile has viewport-fit=cover"             "$BASE/mobile"                        'viewport-fit=cover'
assert_contains "/mobile/maintenance serves mobile shell"    "$BASE/mobile/maintenance"            '<title>GrowLink Mobile</title>'
assert_contains "/mobile/maintenance has viewport-fit=cover" "$BASE/mobile/maintenance"            'viewport-fit=cover'
assert_contains "/mobile/irrigation-log serves mobile shell" "$BASE/mobile/irrigation-log"         '<title>GrowLink Mobile</title>'
assert_contains "deep /mobile/* path serves mobile shell"    "$BASE/mobile/equipment/test-id-123"  '<title>GrowLink Mobile</title>'
assert_contains "unknown desktop path falls back to index"   "$BASE/some/unknown/desktop/route"    '<title>GrowLink</title>'
assert_contains "unknown deep mobile path falls back to mobile" "$BASE/mobile/some/deep/unknown"   '<title>GrowLink Mobile</title>'
assert_no_redirect "no redirect on /mobile/maintenance"      "$BASE/mobile/maintenance"
assert_status "sw.js is served"                              "$BASE/sw.js"                         200
assert_status "desktop manifest is served"                   "$BASE/manifest.webmanifest"          200
assert_status "mobile manifest is served"                    "$BASE/manifest-mobile.webmanifest"   200
assert_status "/health returns bare 200 (not swallowed by SPA fallback)" "$BASE/health"             200

REAL_ASSET="$(curl -fsS "$BASE/" | grep -oE '/assets/main-[^"]+\.js' | head -1)"
if [ -z "$REAL_ASSET" ]; then
  echo "FAIL: could not find a built main-*.js asset reference in /"
  fail=1
else
  ASSET_STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE$REAL_ASSET")"
  ASSET_CT="$(curl -s -o /dev/null -w '%{content_type}' "$BASE$REAL_ASSET")"
  if [ "$ASSET_STATUS" != "200" ] || [[ "$ASSET_CT" != text/javascript* ]]; then
    echo "FAIL: real static asset $REAL_ASSET returned status=$ASSET_STATUS content-type=$ASSET_CT"
    fail=1
  else
    echo "ok  (real static asset $REAL_ASSET served as JS, not HTML fallback)"
  fi
fi

if [ "$fail" -ne 0 ]; then
  echo ""
  echo "Routing contract verification FAILED."
  exit 1
fi

echo ""
echo "All routing contract checks passed."
