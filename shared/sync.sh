#!/bin/sh
# Copies shared/tab-pane.tsx into every mod that carries it; with --check, fails on a copy that drifted.
cd "$(dirname "$0")/.." || exit 1
status=0
for copy in $(find plugins -path '*/hooks/tab-pane.tsx' -not -path '*/node_modules/*'); do
  if [ "$1" = "--check" ]; then
    cmp -s shared/tab-pane.tsx "$copy" || { echo "out of sync: $copy"; status=1; }
  else
    cp shared/tab-pane.tsx "$copy"
  fi
done
exit $status
