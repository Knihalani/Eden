#!/usr/bin/env bash
# Builds build/eden-launch.mp4: frames from web/index.html at 60 fps (Playwright + Chromium), the audio mix, then mux.
# Needs node with `playwright`, python3 with numpy+scipy, ffmpeg. About 5 minutes on 4 cores.
set -euo pipefail
cd "$(dirname "$0")"
FPS=${FPS:-60}; WORKERS=${WORKERS:-4}; END=46.2
./fetch_assets.sh
mkdir -p build
python3 scripts/mix.py media build/mix.wav
(cd web && exec python3 -m http.server 8778 --bind 127.0.0.1 >/dev/null 2>&1) & SRV=$!
trap 'kill $SRV' EXIT
sleep 1
TOTAL=$(python3 -c "print(round($END*$FPS))")
PIDS=()
for i in $(seq 0 $((WORKERS-1))); do
  node scripts/render.js build "$FPS" $((i*TOTAL/WORKERS)) $(((i+1)*TOTAL/WORKERS)) "$i" > "build/log_$i.txt" 2>&1 &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
: > build/list.txt; for i in $(seq 0 $((WORKERS-1))); do echo "file 'chunk_$i.mkv'" >> build/list.txt; done
ffmpeg -y -loglevel error -f concat -safe 0 -i build/list.txt -i build/mix.wav -map 0:v -map 1:a \
  -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -movflags +faststart \
  -af "loudnorm=I=-14:TP=-2:LRA=11,alimiter=limit=0.85:level=false" -c:a aac -b:a 256k -ar 48000 -shortest build/eden-launch.mp4
echo "wrote build/eden-launch.mp4"
