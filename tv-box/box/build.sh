#!/usr/bin/env bash
# Packs the TV app into one installer file: box/install-tv.sh + the app files appended.
# Usage: bash box/build.sh [output]   (default: ../dist/install-tv.sh next to app/)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-../dist/install-tv.sh}"
mkdir -p "$(dirname "$OUT")"
cp box/install-tv.sh "$OUT.tmp"
PARTS=""; for d in tv remote shared term server agent termd games games-bin box/blank-cursor.mjs box/nature.mjs; do [ -e "$d" ] && PARTS="$PARTS $d"; done
# shellcheck disable=SC2086
tar -czf - --exclude='.*' --exclude='demo.html' --exclude='__pycache__' $PARTS | base64 -w 76 >> "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
chmod 755 "$OUT"
echo "built $OUT ($(du -h "$OUT" | cut -f1))"
