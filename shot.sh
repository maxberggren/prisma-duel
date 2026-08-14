#!/usr/bin/env bash
# shot.sh <out.png> [width] [height] [ms] [file]
OUT="${1:-/home/max/Code/lazer/shots/shot.png}"
W="${2:-1600}"; H="${3:-900}"; MS="${4:-2500}"
SRC="${5:-/home/max/Code/lazer/index.html}"
mkdir -p "$(dirname "$OUT")"
rm -f "$OUT"
timeout 180 chromium --headless=new --disable-gpu --enable-unsafe-swiftshader \
  --use-gl=angle --use-angle=swiftshader --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=$W,$H --screenshot="$OUT" --virtual-time-budget=$MS \
  --enable-logging=stderr --v=0 "file://$SRC" 2>&1 | grep -Ei "error|warn|exception|shader" | grep -v "GL Driver Message" | head -30
ls -la "$OUT" 2>/dev/null || echo "NO SCREENSHOT"
