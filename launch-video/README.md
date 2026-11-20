# Eden launch film

A 46-second, 1920×1080, 60 fps launch film for Eden, built entirely in code (`web/index.html`), cut to a live-band
track. No stock footage.

## Structure (145 BPM, one beat = 0.414 s)

| Beats  | Section        | On screen                                                                                   |
| ------ | -------------- | ------------------------------------------------------------------------------------------- |
| 0–16   | The problem    | YOUR AI AGENT / IS BRILLIANT. / AND BLIND. A cold searchlight sweeps a field of 1,517 items. Posters: sends · pays · books · buys; YOUR [email, calendar, docs…]; "Agents don't fail on reasoning. They fail on context." |
| 16–28  | The break      | The band drops out; a single point of light grows. "Every agent needs a context partner."  |
| 28–34  | Introducing    | The band returns: light bursts, EDEN, the context partner for AI agents.                     |
| 34–54  | How it works   | 01 It watches. 02 It searches (a mint beam sweeps the field). 03 It finds. Before it acts. One product moment: the context card lands before the model call. |
| 54–62  | Measured       | <100 ms · 0 model calls · $0 (Eden's demo)                                                 |
| 62–70  | By design      | Speaks first. Read-only. Redacted. Any MCP source.                                         |
| 70–96  | Integration, scale | One line in front of your model. Every agent. Every request. Context, before they ask. |
| 96–    | End            | Eden poster.                                                                                |

Two layers share one design system (Inter 900 display, JetBrains Mono labels, ink/paper/mint/indigo, a running header
with section and progress): a WebGL light layer (a parallax data field, volumetric beams, a flare on the one item that
matters, god rays, scan rings) and full-bleed Swiss-grid posters for the statements.

Sound: "Carry On" (Mixkit, rock) from song beat 112, plus recorded foley (impacts, paper, keys, clicks) on the cuts.

## Build

Needs Node with `playwright` (Chromium), Python 3 with `numpy` and `scipy`, and `ffmpeg`. About 12 minutes on 4 cores.

```bash
./build.sh
```

`fetch_assets.sh` downloads Three.js, the track and the sound effects (free Mixkit licenses,
https://mixkit.co/license/). Output: `build/eden-launch.mp4`.
