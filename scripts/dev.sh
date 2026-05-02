#!/usr/bin/env bash
# Pre-flight: kill anything still bound to port 5000 from a previous run.
# Replit's runtime doesn't reliably honor SO_REUSEPORT, so a crashed dev
# process can hold the port and break the next `npm run dev` with EADDRINUSE.
# Port 5000 is the only legal port for the app (see server/index.ts), so
# unconditionally evicting any holder is safe.
set -e
PORT=5000
if command -v lsof >/dev/null 2>&1; then
  lsof -ti ":${PORT}" | xargs -r kill -9 2>/dev/null || true
elif command -v fuser >/dev/null 2>&1; then
  fuser -k "${PORT}/tcp" 2>/dev/null || true
fi
exec tsx server/index.ts
