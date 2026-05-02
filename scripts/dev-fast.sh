#!/usr/bin/env bash
# Fast local dev: build the production bundle once, then serve it from dist/.
# Loads in 1-3s vs minutes for `npm run dev` Vite cold-starts on Replit.
# Use this when you're NOT actively editing code. Use `npm run dev` when
# you need HMR for active development.
PORT=5000

# CLI args: --force/-f skips the freshness check and always rebuilds.
FORCE_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE_BUILD=1 ;;
  esac
done

# Pre-flight kill (same layered approach as scripts/dev.sh).
PORT_PID_KILL_LIB=""
if [ -f scripts/dev.sh ]; then
  # Reuse the helper functions from scripts/dev.sh by sourcing the kill block.
  # We can't `source` the existing file because it ends with `exec tsx`, so
  # inline the same strategies here.
  :
fi

kill_via_lsof() {
  command -v lsof >/dev/null 2>&1 || return 1
  local pids
  pids=$(lsof -ti ":${PORT}" 2>/dev/null || true)
  [ -z "$pids" ] && return 1
  echo "[dev-fast.sh] lsof: killing PIDs on :${PORT}: $pids"
  echo "$pids" | xargs -r kill -9 2>/dev/null || true
  return 0
}
kill_via_fuser() {
  command -v fuser >/dev/null 2>&1 || return 1
  echo "[dev-fast.sh] fuser: killing :${PORT}/tcp"
  fuser -k "${PORT}/tcp" 2>/dev/null || true
  return 0
}
kill_via_pkill_server_index() {
  command -v pkill >/dev/null 2>&1 || return 1
  if pgrep -u "$(id -u)" -f 'server/index' >/dev/null 2>&1; then
    echo "[dev-fast.sh] pkill: terminating stale server/index processes"
    pkill -9 -u "$(id -u)" -f 'server/index' 2>/dev/null || true
    return 0
  fi
  return 1
}
kill_via_lsof || true
kill_via_fuser || true
kill_via_pkill_server_index || true
sleep 0.5

# Skip the build when dist/ is already up to date relative to source. The
# production bundle is deterministic given the inputs we watch below, so when
# nothing has changed we can go straight to running the existing artifact.
needs_build() {
  # Missing artifacts → must build.
  [ -f dist/index.js ] || return 0
  [ -f dist/public/index.html ] || return 0

  # Sanity-check that we can actually read the dist mtime (covers GNU + BSD stat).
  local dist_mtime
  dist_mtime=$(stat -c %Y dist/index.js 2>/dev/null || stat -f %m dist/index.js 2>/dev/null || echo 0)
  [ "$dist_mtime" -eq 0 ] && return 0

  # Any source file newer than dist/index.js means we need to rebuild. We watch
  # the source trees plus root build configs; node_modules is covered by
  # package-lock.json.
  local newest_src
  newest_src=$(find \
    client server shared db \
    package.json package-lock.json \
    vite.config.ts tailwind.config.ts postcss.config.js tsconfig.json \
    drizzle.config.ts theme.json \
    -type f \
    -newer dist/index.js \
    -print 2>/dev/null \
    | head -1)

  if [ -n "$newest_src" ]; then
    echo "[dev-fast.sh] source change detected: $newest_src" >&2
    return 0
  fi

  return 1
}

if [ "$FORCE_BUILD" -eq 1 ] || needs_build; then
  echo "[dev-fast.sh] building production bundle (source changed since last build)..."
  npm run build
else
  echo "[dev-fast.sh] skipping build — dist/ is fresh relative to source (use --force to rebuild)"
fi

echo "[dev-fast.sh] starting server from dist/ (NODE_ENV=production so Vite middleware stays off)..."
# NODE_ENV must be production at runtime — server/index.ts mounts Vite
# middleware (and re-optimizes deps) when NODE_ENV=development, which both
# defeats the purpose of dev:fast and OOMs the Replit container.
NODE_ENV=production exec node dist/index.js
