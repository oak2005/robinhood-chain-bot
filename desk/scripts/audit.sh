#!/bin/sh
# Helper runner that ensures Nixpacks node is in PATH
export PATH="$PATH:/root/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/usr/local/bin"

if command -v node >/dev/null 2>&1; then
  node scripts/audit-bot.mjs "$@"
else
  # Find node binary in nix directories
  NODE_PATH=$(find /root/.nix-profile /nix/var/nix /nix/store -name node -type f 2>/dev/null | head -n 1)
  if [ -n "$NODE_PATH" ]; then
    "$NODE_PATH" scripts/audit-bot.mjs "$@"
  else
    echo "❌ Node binary could not be found in standard paths."
    echo "Current PATH: $PATH"
  fi
fi
