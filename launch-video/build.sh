#!/usr/bin/env bash
# Renders the Eden launch film: frames from index.html (Playwright + Chromium),
# the score from scripts/score.py (numpy + scipy), muxed with ffmpeg.
# Needs: node with `playwright` resolvable, python3 with numpy+scipy, ffmpeg.
set -euo pipefail
cd "$(dirname "$0")"
FPS=${FPS:-60}; WORKERS=${WORKERS:-4}; OUT=${OUT:-build}
mkdir -p "$OUT"
python3 -m http.server 8777 --bind 127.0.0.1 >/dev/null 2>&1 & SRV=$!
trap 'kill $SRV' EXIT
sleep 1
DUR=$(python3 -c "import json;print(json.load(open('cues.json'))['duration'])")
PIDS=()
for i in $(seq 0 $((WORKERS-1))); do
  a=$(python3 -c "print($i*$DUR/$WORKERS)"); b=$(python3 -c "print(($i+1)*$DUR/$WORKERS)")
  node scripts/render.js "$OUT" "$FPS" "$a" "$b" "$i" > "$OUT/log_$i.txt" 2>&1 &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
python3 scripts/score.py cues.json "$OUT/score.wav"
: > "$OUT/list.txt"; for i in $(seq 0 $((WORKERS-1))); do echo "file 'chunk_$i.mkv'" >> "$OUT/list.txt"; done
ffmpeg -y -loglevel error -f concat -safe 0 -i "$OUT/list.txt" -i "$OUT/score.wav" \
  -filter_complex "[0:v]format=yuv420p[v];[1:a]loudnorm=I=-14:TP=-1.0:LRA=9[a]" \
  -map "[v]" -map "[a]" -c:v libx264 -preset slow -crf 19 -tune animation -profile:v high -movflags +faststart \
  -c:a aac -b:a 256k -ar 48000 "$OUT/eden-launch.mp4"
echo "wrote $OUT/eden-launch.mp4"
