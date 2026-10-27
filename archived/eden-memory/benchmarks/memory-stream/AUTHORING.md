# StreamBench authoring spec (for stream authors)

You write the **text** of a stream of agent sessions. A planner already decided what happens: which turn states which memory item, which turn *needs* which item, and which turns are negatives. You make it read like real use. The labels come from the plan, never from your text. A mechanical checker (`assemble.py`) rejects text that breaks the rules below, so follow them exactly.

Read first:
- the world bible (`worlds/<world>/WORLD.md`);
- your batch brief (`briefs/<world>/bNN.json`): your sessions in order, each with its timestamp, kind, planned human turns (each with its beats), non-human events, triggers and compaction point, plus the items stated before your batch (for continuity);
- the items the beats name, with their full text.

## Output

Write **one JSON file** to the path your brief names:

```json
{"batch": "code-b03", "author": "<your author id from the brief>", "sessions": [
  {"id": "code-s030", "events": [ … ]}
]}
```

Events in order. Allowed event objects:

| `t` | Fields | Meaning |
|---|---|---|
| `human` | `k`, `text` | The user's prompt for planned turn `k`. Exactly one per planned turn, in order of `k` |
| `assistant` | `text` | The agent's reply or a progress message. **Every human turn and every trigger ends with one** |
| `tool` | `name` (`Read`, `Bash`, `Edit`, `Write`), `input`, `output`, optional `action: true` | A tool call and its result. `Read`: `input {"path"}`, `output` is the file text. `Bash`: `input {"command"}`, `output` is stdout. `Edit`: `input {"path","old","new"}`, `output` is `""`. `Write`: `input {"path","content"}`, `output` is `""` |
| `notification` | `task`, `report` | A background task the agent started earlier finishes. `task` is the one-line task, `report` is the subagent's final report (3–15 lines) |
| `peer` | `from`, `text` | A message from another agent (names in the bible) |
| `trigger` | `text` | Life world only. The host wakes the agent with no prompt from the user (the bible gives the formats) |
| `compact` | `summary` | Context compaction. The summary is what the agent keeps of the session so far (5–15 lines, like Claude Code's summaries) |

Place non-human events where the brief puts them: `"after": k` means after human turn `k`'s work, before turn `k+1`. A trigger with `"after": -1` comes before the first human turn. Put `compact` right after turn `compact_after`'s work.

## Realizing beats

Each planned human turn has one or more **beats**:

- **`state`** (`channel` = `user` | `tool` | `assistant`). The items' content must be **stated in full in this turn**: every name, number, value and condition in the item text. Paraphrase it naturally, but keep the specific tokens: names, numbers, versions, places, dates, product names.
  - `user`: the human text states it, often inside a bigger request ("btw we use pnpm 9 here, never npm or yarn — can you add zod to the api?").
  - `tool`: a tool output in this turn contains it (a file, a command's output, a calendar listing, an email).
  - `assistant`: the agent's reply states it as something it found or did.
  - With `corrects`, phrase it as a change ("we finally moved off yarn, it's pnpm 9 now").
  - The human text of a `tool`-channel turn is an ordinary request that leads the agent to read that output.
- **`need`**: the user creates a situation where a careful expert assistant would want the items. The `need_type` says how:
  - `direct`: asks about the item. It may reuse its topic words, but must not state the answer ("what port does the api run on locally?").
  - `indirect`: needs it without naming it ("spin up everything locally so I can test the webhook" → ports, docker compose, pnpm dev).
  - `proactive`: an ordinary task where the item changes how it should be done. The user never mentions its topic ("book dinner Friday with Sam" → Sam's diet; "add a date picker to invoices" → date-fns, moment banned).
  - `multi`: needs every listed item together.
  - `stale`: needs the current item, which corrected an older one (`forbidden`). Do not state either value.
  - **Never** put the needed item's content (its values, names or numbers) in the human text, or in anything earlier in the same turn.
  - The assistant's reply must not state it either. The agent does not remember: it asks, guesses generically, or does the task without the item. Keep the reply plausible.
  - With `action: true`, the agent takes an action in this turn (a `book`, `mail send`, `cal add`, `shop order`, a `git`/`pnpm` command, a file write…) where the item matters. Mark that tool event `"action": true`.
- **`neg`**: the turn needs no memory at all:
  - `task`: ordinary work in the world (fix a bug, write a function, draft an email, plan a weekend) that no item bears on. Do not involve any item's topic in a way that would make an item useful.
  - `ack`: "continue", "ok", "thanks", "yes do it", "lgtm", "perfect".
  - `general`: a general-knowledge question on the user's topics ("how do react server components stream?", "what's the capital of Portugal?" for someone planning Lisbon) whose answer does not depend on the user.
  - `other`: about another project or another person (coding: Jordan's Django side project `trailmix`; life: a friend's or colleague's problem unrelated to any item).
  - `paste`: a long paste (a stack trace, a log, an article, an email thread, 25–80 lines) with a short ask.
  - `restate`: the user restates the listed item, which was already said earlier in this session. It is in context, so nothing is needed.
  - `chitchat`: small talk ("long day lol", "how's it going").
  - `meta`: about the agent or the session ("can you be more concise", "what did we do so far?", "undo that").
- **triggers** (life): `need_type: "event"` with items means the trigger is a moment where the agent should surface them unasked. The trigger text must not state them ("[Calendar] 'Dinner with Sam' tonight 19:00 — reservation needed" → Sam's diet). A trigger with no items is routine and needs nothing ("[Scheduled 07:00] Morning check-in", weather, a delivery update). After it comes an `assistant` event (what the agent does), and optionally tools.

## Realism

- **Volume.** Most human turns get 1–6 tool calls with realistic outputs: code files 10–80 lines, command output, listings. A few turns have none (acks, chit-chat, general questions). Assistant replies run 1–8 sentences, longer for explanations.
- Agents start background tasks, so notifications have a reason. Peer messages are plausible (CI status, review comments, triage digests).
- Users are terse and inconsistent, make typos, switch topics, and come back after days. Coding prompts are often lower-case.
- **Continuity.** Respect the items stated before your batch: do not contradict them. Sessions in your batch follow each other in time, so later ones can refer to earlier work.
- Do not mention any item's content outside its `state` beat. One exception: after an item has been stated, later turns may naturally reuse it ("since we're on pnpm…"). Even then, never in a `need` turn for that item.
- No real people's private data, no real credentials or tokens, no URLs to real private resources. Use `example.com`-style domains for anything that looks like a link.
- Do not refer to the plan, beats, items or labels in any text.
