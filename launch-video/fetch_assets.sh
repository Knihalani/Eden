#!/usr/bin/env bash
# Downloads the film's third-party assets: Three.js, and the Mixkit footage, music and sound effects it cuts
# (Mixkit free licenses: https://mixkit.co/license/). They are fetched, not committed.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p media/clips media/music media/sfx web/lib
for f in build/three.module.js examples/jsm/postprocessing/{EffectComposer,RenderPass,UnrealBloomPass,ShaderPass,OutputPass,Pass,MaskPass}.js \
         examples/jsm/shaders/{CopyShader,LuminosityHighPassShader,OutputShader}.js; do
  mkdir -p "web/lib/$(dirname "$f")"; [ -s "web/lib/$f" ] || curl -fsS -o "web/lib/$f" "https://cdn.jsdelivr.net/npm/three@0.160.0/$f"
done
CLIPS="1711 1808 4240 4805 4808 4878 9736 21780 23219 23282 23466 25078 30565 31089 31413 34241 39782 41638 42041 46635 50989 50998"
for i in $CLIPS; do
  [ -s "media/clips/$i.mp4" ] && continue
  curl -fsS -A 'Mozilla/5.0' -o "media/clips/$i.mp4" "https://assets.mixkit.co/videos/$i/$i-1080.mp4" ||
    curl -fsS -A 'Mozilla/5.0' -o "media/clips/$i.mp4" "https://assets.mixkit.co/videos/$i/$i-720.mp4"
done
[ -s media/music/1091.mp3 ] || curl -fsS -A 'Mozilla/5.0' -o media/music/1091.mp3 https://assets.mixkit.co/music/1091/1091.mp3
for i in 166 490 1143 1465 1471 1489 1490 1491 1492 1714 2295 2350 2568 2589 2594 2782 2900; do
  [ -s "media/sfx/$i.mp3" ] || curl -fsS -A 'Mozilla/5.0' -o "media/sfx/$i.mp3" "https://assets.mixkit.co/active_storage/sfx/$i/$i-preview.mp3"
  sleep 0.3
done
echo "assets ready"
