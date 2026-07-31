#!/usr/bin/env bash
# Remove macOS/iCloud duplicate artifacts ("beam-config.server 2.ts").
#
# These are created by Finder/iCloud when a file is written while syncing.
# They are gitignored, so CI never sees them — but they DO reach the local
# typechecker, where a STALE copy of a since-changed file reports errors
# against code nobody is editing. Worse, a duplicated migration silently
# re-runs CREATE TABLE and blocks the whole chain, which has left schema
# tests passing against stale schema more than once.
#
# tsconfig `exclude` does not help: svelte-check walks the filesystem
# rather than only tsconfig's include set. Deleting is the honest fix —
# the file is never wanted.
set -euo pipefail
found=$(find . \
  -name '* [0-9].ts' -o -name '* [0-9].sql' -o -name '* [0-9].svelte' \
  -o -name '* [0-9].json' -o -name '* [0-9].js' \
  | grep -v node_modules | grep -v '\.git/' || true)
if [ -n "$found" ]; then
  echo "Removing macOS duplicate artifacts:"
  echo "$found" | sed 's/^/  /'
  echo "$found" | while IFS= read -r f; do rm -f "$f"; done
fi
