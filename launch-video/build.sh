#!/usr/bin/env bash
# Builds build/eden-launch.mp4: edit list -> footage frames -> WebGL frames (Playwright) -> audio mix -> mux.
# Needs node with `playwright`, python3 with numpy+scipy, ffmpeg. Software WebGL is slow: about 25 min on 4 cores.
set -euo pipefail
cd "$(dirname "$0")"
FPS=${FPS:-30}; WORKERS=${WORKERS:-4}
./fetch_assets.sh
mkdir -p build
python3 scripts/edit.py
python3 scripts/extract.py
python3 scripts/mix.py edit.json media build/mix.wav
(cd web && exec python3 -m http.server 8778 --bind 127.0.0.1 >/dev/null 2>&1) & SRV=$!
trap 'kill $SRV' EXIT
sleep 1
END=$(python3 -c "import json;print(json.load(open('edit.json'))['END'])")
TOTAL=$(python3 -c "print(round($END*$FPS))")
PIDS=()
for i in $(seq 0 $((WORKERS-1))); do
  node scripts/render.js build "$FPS" $((i*TOTAL/WORKERS)) $(((i+1)*TOTAL/WORKERS)) "$i" > "build/log_$i.txt" 2>&1 &
  PIDS+=($!)
done
for p in "${PIDS[@]}"; do wait "$p"; done
: > build/list.txt; for i in $(seq 0 $((WORKERS-1))); do echo "file 'chunk_$i.mkv'" >> build/list.txt; done
ffmpeg -y -loglevel error -f concat -safe 0 -i build/list.txt -i build/mix.wav \
  -map 0:v -map 1:a -c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p -movflags +faststart \
  -af loudnorm=I=-14:TP=-1.0:LRA=11 -c:a aac -b:a 256k -ar 48000 -shortest build/eden-launch.mp4
echo "wrote build/eden-launch.mp4"
