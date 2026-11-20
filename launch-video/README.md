# Eden launch trailer

A 64-second, 1920×1080 landscape trailer for Eden. Stock footage is cut with WebGL scenes (a tunnel through a user's sources, the
logo assembling from particles, a knowledge-graph flythrough, 3D chat and terminal panels). Every one of its 75 cuts
lands on the beat of a licensed track at 124 BPM.

## Script

| Beats   | Time      | On screen                                                                                       |
| ------- | --------- | ----------------------------------------------------------------------------------------------- |
| 0–8     | 0–3.9     | Hook: YOUR AI AGENT / IS BRILLIANT. / AND BLIND. It sends, pays, books, buys, knowing only what you tell it. |
| 8–28    | 3.9–13.5  | Your email, calendar, docs, CRM, notes, chats. The answer is already there; it doesn't know to look. Agents don't fail on reasoning, they fail on context. |
| 28–32   | 13.5–15.5 | (kick drops out) Every agent needs a context partner.                                           |
| 32–36   | 15.5–17.4 | Drop: EDEN. The context partner for AI agents.                                                  |
| 36–52   | 17.4–25.2 | 01 It watches every request. 02 It searches everything your user connected. 03 It hands your agent what it missed. Before it acts. Right the first time. Shown on a generic request: "Clear my morning tomorrow for deep work." |
| 52–64   | 25.2–31.0 | Under 100 ms, 0 model calls, $0 (Eden's demo). Already paid? Card blocked? Meeting moved? It knows. Nothing to add? It stays silent. |
| 64–96   | 31.0–46.4 | Speaks first. Send/pay/book: checked first. Read-only. Secrets redacted. Most turns: zero model calls. Mail, calendar, CRM, any MCP server. One line in front of your model. |
| 96–128  | 46.4–61.9 | Watches. Searches. Finds. Speaks first. Give your agent the context it didn't know to ask for. End card on the last hit. |

The music starts at the song's beat-28 phrase (13.569 s) and is spliced on a bar line (44.533 s → 60.014 s).

## Build

Needs Node with `playwright` (Chromium), Python 3 with `numpy` and `scipy`, and `ffmpeg`.

```bash
./build.sh
```

`fetch_assets.sh` downloads Three.js and the Mixkit footage, music and sound effects (free Mixkit licenses,
https://mixkit.co/license/). They are fetched by ID, not committed. Output: `build/eden-launch.mp4`.

## Editing

- `scripts/edit.py` is the edit decision list: every shot is placed in beats, with its clip, source offset, zoom,
  grade and text. Shot kinds other than `footage` are WebGL scenes in `web/index.html`; `phase` and `rate` pick which
  moment of a scene a short insert shows.
- `scripts/mix.py` places sound effects from the same list: whooshes on cuts, hits on title slams.
- Preview frames: serve `web/` on port 8778 and run `node scripts/snap.js <outdir> 16.9 21.5`.
