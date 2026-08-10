#!/usr/bin/env sh
# Dev launcher for the Freebuff preview session.
#
# The preview port-forwards only the Vite port, and the SPA talks to Convex
# through Vite's same-origin /convex proxy. If the local Convex dev backend
# (port 3210) isn't running, the dashboard shows "Backend offline" forever.
# This script makes the preview command start BOTH services, so a container
# restart brings them back together instead of leaving Convex dead.
set -e
cd "$(dirname "$0")/.."

# Start the Convex dev backend in the background if it isn't already up.
if ! curl -s -m 2 -o /dev/null http://127.0.0.1:3210/ ; then
  echo "[dev.sh] Starting Convex backend..."
  nohup npx convex dev > /tmp/convex-dev.log 2>&1 &
fi

# Wait up to ~45s for Convex to become ready.
i=0
while [ $i -lt 45 ]; do
  if curl -s -m 2 -o /dev/null http://127.0.0.1:3210/ ; then
    echo "[dev.sh] Convex backend ready."
    break
  fi
  sleep 1
  i=$((i + 1))
done

# Start Vite in the foreground (this is what the preview session supervises).
exec node_modules/.bin/vite dev
