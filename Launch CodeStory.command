#!/bin/zsh
set -eu
cd -- "$(dirname -- "$0")"
node_bin=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  if [[ -x "$candidate" ]]; then node_bin="$candidate"; break; fi
done
if [[ -z "$node_bin" ]]; then node_bin="$(command -v node || true)"; fi
if [[ -z "$node_bin" ]]; then
  print 'CodeStory needs Node.js 22.13 or later. Install it from https://nodejs.org, then open this launcher again.'
  read -r '?Press Return to close.'
  exit 1
fi
if ! "$node_bin" -e 'const [major,minor]=process.versions.node.split(".").map(Number);process.exit(major>22||(major===22&&minor>=13)?0:1)'; then
  print 'Please update Node.js to version 22.13 or later.'
  read -r '?Press Return to close.'
  exit 1
fi
"$node_bin" scripts/start-local.mjs --open
