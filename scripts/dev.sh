#!/usr/bin/env bash
# Pre-flight: aggressively evict anything still bound to port 5000 from a
# previous run. Replit's runtime doesn't reliably honor SO_REUSEPORT, and the
# container's `lsof` can't always see sockets across PIDs, so we layer
# multiple eviction strategies and never fail the script. We deliberately
# avoid `set -e` so each strategy is best-effort.
PORT=5000

kill_via_lsof() {
  command -v lsof >/dev/null 2>&1 || return 1
  local pids
  pids=$(lsof -ti ":${PORT}" 2>/dev/null || true)
  [ -z "$pids" ] && return 1
  echo "[dev.sh] lsof: killing PIDs on :${PORT}: $pids"
  echo "$pids" | xargs -r kill -9 2>/dev/null || true
  return 0
}

kill_via_fuser() {
  command -v fuser >/dev/null 2>&1 || return 1
  echo "[dev.sh] fuser: killing :${PORT}/tcp"
  fuser -k "${PORT}/tcp" 2>/dev/null || true
  return 0
}

kill_via_ss() {
  # ss + grep — works in containers where lsof is blind.
  command -v ss >/dev/null 2>&1 || return 1
  local pids
  pids=$(ss -ltnp "sport = :${PORT}" 2>/dev/null \
    | grep -oE 'pid=[0-9]+' \
    | cut -d= -f2 \
    | sort -u || true)
  [ -z "$pids" ] && return 1
  echo "[dev.sh] ss: killing PIDs on :${PORT}: $pids"
  echo "$pids" | xargs -r kill -9 2>/dev/null || true
  return 0
}

kill_via_proc_scan() {
  # /proc-based fallback for the case where ALL of lsof/fuser/ss are missing
  # or blind. Resolves the listener inode for port 5000 from /proc/net/tcp,
  # then walks /proc/<pid>/fd for the matching socket inode.
  [ -r /proc/net/tcp ] || return 1
  # Port 5000 in hex is 1388. Match :1388 in column 2 (local addr).
  local inodes
  inodes=$(awk '$2 ~ /:1388$/ && $4 == "0A" {print $10}' /proc/net/tcp 2>/dev/null | sort -u)
  [ -z "$inodes" ] && return 1
  local killed=0
  for pid in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do
    [ -r "/proc/$pid/fd" ] || continue
    for ino in $inodes; do
      if ls -l "/proc/$pid/fd" 2>/dev/null | grep -q "socket:\[$ino\]"; then
        echo "[dev.sh] /proc: killing PID $pid (listener inode $ino)"
        kill -9 "$pid" 2>/dev/null || true
        killed=1
        break
      fi
    done
  done
  [ "$killed" -eq 1 ] && return 0
  return 1
}

kill_via_pkill_server_index() {
  # Last-resort: nuke any process whose cmdline references server/index.ts.
  # On Replit the live cmdline is `node --require .../tsx/dist/preflight.cjs
  # ... server/index.ts`, so matching `tsx server/index.ts` literally would
  # miss it — match the entry file instead.
  command -v pkill >/dev/null 2>&1 || return 1
  if pgrep -u "$(id -u)" -f 'server/index\.ts' >/dev/null 2>&1; then
    echo "[dev.sh] pkill: terminating stale server/index.ts processes"
    pkill -9 -u "$(id -u)" -f 'server/index\.ts' 2>/dev/null || true
    return 0
  fi
  return 1
}

# Try every strategy, in order. Continue regardless of individual failures.
kill_via_lsof || true
kill_via_fuser || true
kill_via_ss || true
kill_via_proc_scan || true
kill_via_pkill_server_index || true

# Brief settle so the kernel actually releases the socket before we bind.
sleep 0.5

exec tsx server/index.ts
