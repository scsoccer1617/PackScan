#!/usr/bin/env bash
# Fast local dev: build the production bundle once, then serve it from dist/.
# Loads in 1-3s vs minutes for `npm run dev` Vite cold-starts on Replit.
# Use this when you're NOT actively editing code. Use `npm run dev` when
# you need HMR for active development.
PORT=5000

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

# Build + run.
echo "[dev-fast.sh] building production bundle..."
npm run build

echo "[dev-fast.sh] starting server from dist/ (NODE_ENV=production so Vite middleware stays off)..."
# NODE_ENV must be production at runtime — server/index.ts mounts Vite
# middleware (and re-optimizes deps) when NODE_ENV=development, which both
# defeats the purpose of dev:fast and OOMs the Replit container.
NODE_ENV=production exec node dist/index.js
