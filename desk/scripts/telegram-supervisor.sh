#!/bin/sh
cd /workspace || exit 1
export NODE_DISABLE_COMPILE_CACHE=1
mkdir -p /workspace/data
while true; do
  node --experimental-strip-types src/lib/telegram/standalone.ts >>/workspace/data/bot.log 2>&1 || true
  printf '%s bot exited — starting again\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>/workspace/data/bot.log
  sleep 1
done
