# Eden launch film

A 46-second, 1920×1080, 60 fps launch film for Eden, built entirely in code (`web/index.html`), cut to a live-band
track. No stock footage.

## Structure (145 BPM, one beat = 0.414 s)

A poster film: every shot is a full-bleed Swiss-grid poster, hard-cut on the beat.

| Beats  | Posters                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------ |
| 0–5    | Hook: YOUR · AI · AGENT · IS *brilliant.* · AND BLIND. (a redaction bar slams over "blind")     |
| 5–15   | Sends · pays · books · buys. YOUR email, calendar, docs… Agents don't fail on reasoning. They fail on *context.* |
| 15–28  | The band's break: Eden's mark is drawn from construction lines. "Every agent needs a context partner." |
| 28–34  | EDEN, the context partner for AI agents, on the band's return.                                   |
| 34–46  | 01 It *watches.* 02 It *searches.* 03 It *finds.* Before it *acts.*                             |
| 46–54  | Without Eden / with Eden, side by side.                                                          |
| 54–70  | <100 ms · 0 model calls · $0 (Eden's demo). Speaks first. Read-only. Redacted. Any MCP source.   |
| 70–96  | One line in front of your model. Every agent. Every request. Context, before they ask.          |
| 96–    | End: the mark, Eden, the context partner for AI agents.                                         |

Type: Archivo variable (expanded caps for statements, condensed for blocks), Instrument Serif italic for emphasis,
JetBrains Mono for labels. Colors: ink, paper, mint, indigo. The logo appears as a one-color mark (`web/assets/mark.png`,
derived from the logo's luminance) so it sits inside the system.

Sound: "Carry On" (Mixkit, rock) from song beat 112, plus recorded foley on the cuts.

## Build

Needs Node with `playwright` (Chromium), Python 3 with `numpy` and `scipy`, and `ffmpeg`. About 6 minutes on 4 cores.

```bash
./build.sh
```

`fetch_assets.sh` downloads the track and the sound effects (free Mixkit licenses,
https://mixkit.co/license/). Output: `build/eden-launch.mp4`.
