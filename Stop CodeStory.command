#!/bin/zsh
set -eu
cd -- "$(dirname -- "$0")"
node_bin=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  if [[ -x "$candidate" ]]; then node_bin="$candidate"; break; fi
done
if [[ -z "$node_bin" ]]; then node_bin="$(command -v node || true)"; fi
if [[ -z "$node_bin" ]]; then
  print 'Node.js was not found.'
  exit 1
fi
"$node_bin" scripts/stop-local.mjs
