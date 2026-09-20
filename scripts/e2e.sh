#!/bin/sh
# Run the E2E suite against throwaway config + library dirs, so a running
# Papyr instance and the real ~/Papyr library are never touched.
UD=$(mktemp -d)
LIB=$(mktemp -d)
WS=$(mktemp -d)
# a small workspace: root file, a project with a proposal and a dated entry, two day files
mkdir -p "$WS/projects/alpha/journal" "$WS/journal"
printf '# The question\n\nWhat now?\n' > "$WS/question.md"
printf '# Alpha proposal\n\nfirst version\n' > "$WS/projects/alpha/proposal.md"
printf -- '---\ndate: 2026-01-01\nproject: alpha\n---\nworked\n' > "$WS/projects/alpha/journal/2026-01-01.md"
printf -- '---\ndate: 2026-01-01\n---\n## Projects\n- [alpha](../projects/alpha/journal/2026-01-01.md): worked\n' > "$WS/journal/2026-01-01.md"
printf -- '---\ndate: 2026-01-02\n---\n## Projects\n' > "$WS/journal/2026-01-02.md"
OUT=${1:-/tmp/papyr-e2e-results.json}
trap 'rm -rf "$UD" "$LIB" "$WS"' EXIT

PAPYR_USER_DATA="$UD" PAPYR_LIBRARY="$LIB" PAPYR_WORKSPACE="$WS" PAPYR_E2E="$OUT" npx electron .
code=$?
if [ -f "$OUT" ]; then
  node -e "
    const rs = require('$OUT');
    console.log(rs.filter(r => r.ok).length + '/' + rs.length + ' passed');
    for (const r of rs.filter(r => !r.ok)) console.log('FAIL', r.name, '::', r.detail.slice(0, 200));
  "
fi
exit $code
