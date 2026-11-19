# Eden launch film

A 98-second, 1080p60 launch video for Eden, built entirely from code: every frame is rendered from `index.html`, and
the score and sound design are synthesized in `scripts/score.py`. No stock footage, samples or voiceover.

## Story

| Time   | Act             | What happens                                                                                       |
| ------ | --------------- | -------------------------------------------------------------------------------------------------- |
| 0–8    | The failure     | An agent is told to pay Dean's invoice to the "new bank details". It does.                        |
| 8–14   | The warning     | Dean's email from Saturday: his inbox was compromised. The agent never knew to look.              |
| 14–24  | The haystack    | Zoom out to all 1,517 items in the user's sources. "Agents don't fail from weak reasoning."       |
| 24–30  | The question    | "What if it had a partner that read everything, and spoke first?"                                 |
| 30–38  | Reveal          | Dark to light, D minor resolves to D major, logo and wordmark.                                    |
| 38–58  | Replay          | Same request with Eden beside the agent: sources, cues, candidates, the warning injected first.   |
| 58–70  | Montage         | Already paid. Card blocked. Chatter gets silence.                                                  |
| 70–82  | Principles      | Not a subagent. Model as last resort. Read-only. Per-user and redacted. Any MCP read tools.       |
| 82–90  | Integration     | One line in front of your model; `bun run demo`.                                                   |
| 90–98  | End card        | Eden: context, before they ask.                                                                    |

The requests, emails and timings (85 ms, 9 ms, 8 ms, 5 ms, 0 model calls, $0) come from a real run of `bun run demo`
on the simulated user. The agent's "Hold on…" reply in the replay is dramatized: the demo shows what the agent
receives, not a model's answer. The film says so on screen.

## Build

Needs Node with `playwright` and Chromium, Python 3 with `numpy` and `scipy`, and `ffmpeg`.

```bash
./launch-video/build.sh
```

Writes `launch-video/build/eden-launch.mp4` (H.264 + AAC, loudness-normalized to -14 LUFS). `FPS=30` halves the
render time. To preview single frames while editing, serve the folder
(`python3 -m http.server 8777 --bind 127.0.0.1` from `launch-video/`) and run
`node scripts/snap.js <outdir> 3.0 31.0 45.5`.

## Editing

- Timing lives in two places: `cues.json` (typing segments and sound effects, read by both the page and the score)
  and the `scene(...)` calls in `index.html` (each takes its global start and end time in seconds).
- `renderFrame(t)` is a pure function of time, so any frame can be rendered in any order.
- The score runs at 120 BPM, so a bar is 2 seconds and every major cut lands on a bar line.

Fonts: Inter, Instrument Serif and JetBrains Mono (SIL Open Font License), from Fontsource.
