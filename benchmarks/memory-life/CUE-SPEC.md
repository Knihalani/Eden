# LifeBench cue specification

For cue authors. Read `WORLD.md` and `fixture/memories.json` (one user's memory store: 315 rows, 37 of them superseded by a newer row named in `superseded_by`). Write cues: situations in which an AI agent serving Riya either needs some of these memories, or needs none. "Now" is Monday 2026-10-19 09:00 Toronto unless the cue sets `now`.

## Schema (one JSON object per cue)

```json
{"id": "d001", "cat": "proactive", "channel": "user", "cue": "Book us a table somewhere nice on Friday, me and Sam.",
 "prev_turn": "", "context": "", "now": "2026-10-19T09:00",
 "gold": ["a002"], "allowed": ["a003"], "forbidden": ["a001"],
 "author": "claude-subagent:cue-author-D", "note": "Sam is pescatarian now; the vegetarian row is stale"}
```

- `channel`: `user` (Riya typed it) or `event` (a proactive agent woke with no prompt; `cue` is the trigger text, e.g. `Calendar: "Lunch with Priya" starts in 60 min at Bar Isabel`, `Incoming message from Hannah: "are we still on for the bake sale?"`, `Time: Sunday 18:00`).
- `prev_turn`: the previous thing Riya typed in this conversation, if any. `context`: the agent's last reply, if it matters. Leave both empty for most cues.
- `gold`: live memory ids the agent **needs** to act or answer well (missing one would make the answer worse or wrong). Never a superseded id.
- `allowed`: live ids that would be relevant and harmless if shown, but are not needed. Use sparingly.
- `forbidden`: ids that would be **wrong** to show: the superseded row of a corrected fact, a plan that has already happened or was moved.
- `note`: one short line on why the gold is needed (for reviewers).

## Categories

| cat | What it is |
|---|---|
| `direct` | Riya asks about the memory's content directly; may reuse its words ("What's Leo's teacher's name again?") |
| `para` | Riya needs the memory but uses **none of its content words** (checked by `tools/check_cues.py`: no shared word, no shared stem, no shared 4-letter prefix with any gold row's subject or text) |
| `proactive` | Riya asks for a task and never mentions what the memory is about; the memory changes how the task should be done ("book dinner Friday with Sam" → Sam's diet; "draft a note to Tom" → Tom's email preferences; "plan Saturday" → a commitment that day) |
| `event` | `channel: "event"`: a trigger with no prompt; the agent should surface the memory unasked |
| `multi` | needs 2–4 memories together |
| `stale` | the answer depends on a fact or plan that was corrected or moved: `gold` the current row, `forbidden` the old one(s) |
| `neg-hard` | needs **no** memory, but shares names, places, topics or words with the store ("What's the capital of Portugal?", "How do beagles differ from bassets?", "Explain how a TFSA works", an event like `Calendar: "Focus time"`). Must truly need nothing personal: if any memory would change a good answer, it is not a negative |
| `neg-general` | needs no memory and shares little with the store (chit-chat, maths, trivia, generic tasks) |

## Rules

- Write the way Riya actually writes: short, casual, typos sometimes, no memory ids, no "remember that…".
- Spread cues across the whole store (people, work, Spanish, health, home, money, routines, plans, instructions). Do not write more than 3 cues whose gold is the same row.
- Noise rows (`episode`, `tool`) are rarely gold; only when a cue really needs one ("what did that flight search show?").
- Plans dated before now are past: a cue about "this week" must not need them; they may be `forbidden`.
- Run `python3 benchmarks/memory-life/tools/check_cues.py FILE` (from the repo root) until it prints 0 problems.
