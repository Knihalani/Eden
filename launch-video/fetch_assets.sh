#!/usr/bin/env bash
# Downloads the film's third-party audio: the Mixkit track and recorded sound effects (free Mixkit licenses,
# https://mixkit.co/license/). They are fetched by ID, not committed. Three.js (WebGL light layer) is fetched too.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p media/music media/sfx web/lib
for p in build/three.module.js examples/jsm/postprocessing/{EffectComposer,RenderPass,UnrealBloomPass,ShaderPass,OutputPass,Pass,MaskPass}.js examples/jsm/shaders/{CopyShader,LuminosityHighPassShader,OutputShader}.js; do
  mkdir -p "web/lib/$(dirname "$p")"; [ -s "web/lib/$p" ] || curl -fsS -o "web/lib/$p" "https://cdn.jsdelivr.net/npm/three@0.160.0/$p"
done
[ -s media/music/1091.mp3 ] || curl -fsS -A 'Mozilla/5.0' -o media/music/1091.mp3 https://assets.mixkit.co/music/1091/1091.mp3
for i in 490 1104 1109 1143 1471 1492 1714 2295 2350 2367 2369 2376 2533 2541 2542 2568 2782 2900 2998 3124 3194 3196; do
  [ -s "media/sfx/$i.mp3" ] || curl -fsS -A 'Mozilla/5.0' -o "media/sfx/$i.mp3" "https://assets.mixkit.co/active_storage/sfx/$i/$i-preview.mp3"
  sleep 0.3
done
echo "assets ready"
