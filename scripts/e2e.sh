#!/bin/sh
# Run the E2E suite against throwaway config + library dirs, so a running
# Papyr instance and the real ~/Papyr library are never touched.
UD=$(mktemp -d)
LIB=$(mktemp -d)
OUT=${1:-/tmp/papyr-e2e-results.json}
trap 'rm -rf "$UD" "$LIB"' EXIT

PAPYR_USER_DATA="$UD" PAPYR_LIBRARY="$LIB" PAPYR_E2E="$OUT" npx electron .
code=$?
if [ -f "$OUT" ]; then
  node -e "
    const rs = require('$OUT');
    console.log(rs.filter(r => r.ok).length + '/' + rs.length + ' passed');
    for (const r of rs.filter(r => !r.ok)) console.log('FAIL', r.name, '::', r.detail.slice(0, 200));
  "
fi
exit $code
