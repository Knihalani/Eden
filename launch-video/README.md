# Eden launch trailer

A 50-second, 1920×1080 landscape trailer for Eden, built from code. Stock footage never runs full-screen: it lives
in animated panels (splits, grids, triptychs, cards beside type, insets over 3D) on a custom stage, cut together with
WebGL scenes (a tunnel through a user's sources, the logo assembling from particles, a knowledge-graph flythrough,
3D chat and terminal panels). Type mixes condensed caps, serif italic, heavy grotesk and mono labels, with line
reveals, slot-machine word rolls and outline-to-fill titles. Every cut sits on the grid of a live-band rock track.

## Script

| Beats   | Time      | On screen                                                                                     |
| ------- | --------- | --------------------------------------------------------------------------------------------- |
| 0–4     | 0–1.7     | Hook: YOUR AI AGENT *is brilliant.* / AND BLIND. (music drops out for a beat)                 |
| 4–24    | 1.7–9.9   | Sends, pays, books, buys. YOUR [EMAIL. CALENDAR. DOCS. CRM…] The answer is already there, but your agent doesn't know where to look. Agents don't fail on reasoning. THEY FAIL ON CONTEXT. |
| 24–36   | 9.9–14.9  | The band's break: *Every agent needs a context partner.* The logo assembles; EDEN on the return |
| 36–54   | 14.9–22.3 | The context partner for AI agents. [01] It watches every request. [02] It searches everything you connect. [03] It hands over what your agent missed. RIGHT THE FIRST TIME. |
| 54–92   | 22.3–38.1 | <100 ms · 0 model calls · $0 (Eden's demo). Already paid? Card blocked? Meeting moved? IT KNOWS. It stays silent. A subagent waits to be asked; Eden speaks first. Send? Pay? Book? CHECKED FIRST. Read-only, redacted, per-user, milliseconds. Any MCP server. ONE LINE. |
| 92–120  | 38.1–49.6 | Give your agent the context it didn't know to ask for. End card on the song's last hit.       |

Music: "Carry On" (Mixkit, rock, 145 BPM), from song beat 104 (43.48 s). Every sound is a recorded file.

## Build

Needs Node with `playwright` (Chromium), Python 3 with `numpy` and `scipy`, and `ffmpeg`.

```bash
./build.sh
```

`fetch_assets.sh` downloads Three.js and the Mixkit footage, music and sound effects (free Mixkit licenses,
https://mixkit.co/license/). They are fetched by ID, not committed. Output: `build/eden-launch.mp4`.

## Editing

- `scripts/edit.py` is the edit decision list, in beats: each shot is a `layout` of footage panels (pixel rects,
  entry direction, grade, duotone, tile words) or a WebGL scene, plus its type (`stack`, `roll`, `mega`, ...).
- `scripts/mix.py` places sound effects from the same list.
- Preview frames: serve `web/` on port 8778 and run `node scripts/snap.js <outdir> 17.9 24.4`.
