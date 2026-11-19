# Eden launch trailer

A 79-second, 1080p trailer for Eden. It cuts real stock footage together with WebGL graphics (a card-storm tunnel
through 1,517 items, the logo assembling from about 25,000 particles, a knowledge-graph flythrough, 3D chat and
terminal panels). Every cut lands on the beat of a licensed music track.

## Structure (124 BPM, one bar = 1.935 s)

| Time      | Section      | What happens                                                                              |
| --------- | ------------ | ----------------------------------------------------------------------------------------- |
| 0–9.7     | Intro        | Footage: what agents do for us. Then the request: "Pay Dean's £3,800 invoice…". "DONE."   |
| 11.6–27.1 | The miss     | WRONG ACCOUNT. Dean's warning email. A storm of 1,517 items. "A CONTEXT PROBLEM."         |
| 27.1–29.0 | The dip      | The kick drops out: "What if your agent had a partner that spoke first?"                  |
| 29.0–44.5 | Drop 1       | The logo assembles. Graph flythrough finds Dean's warning; context injected; 85 ms, 0, $0 |
| 44.5–75.5 | Drop 2       | Principles, sources orbit, the one-line proxy, open source, end card on the last hit      |

The music is spliced on bar lines: song 0–44.533 s, then 60.014 s to the end (exactly 8 bars removed).

The requests, emails and timings (85 ms, 0 model calls, $0) come from `bun run demo` on the simulated user. The agent's
"Hold on…" reply is dramatized: the demo shows what the agent receives, not a model's answer.

## Build

Needs Node with `playwright` (Chromium), Python 3 with `numpy` and `scipy`, and `ffmpeg`.

```bash
./build.sh
```

`fetch_assets.sh` downloads Three.js and the Mixkit footage, music and sound effects (free Mixkit licenses,
https://mixkit.co/license/). They are fetched by ID, not committed. Output: `build/eden-launch.mp4`.

## Editing

- `scripts/edit.py` is the edit decision list: every shot is placed in beats on the music's grid, with its clip,
  source offset, zoom, color grade and text. Shot kinds other than `footage` are WebGL scenes in `web/index.html`.
- `scripts/mix.py` places every sound effect on the same beat grid.
- Preview single frames: serve `web/` on port 8778 and run `node scripts/snap.js <outdir> 29.4 35.0`.
- `renderFrame(t)` is a pure function of time, so frames render in any order and in parallel.
