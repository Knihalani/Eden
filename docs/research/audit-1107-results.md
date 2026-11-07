# Audit and fix, 2026-11-07 afternoon (A wave): results

Status: 2026-11-07 evening. Owner's ask: for 6.5 hours, find and fix what holds Eden back on cost, speed, quality and
scale (up to ~1,000 connectors a user and many users a server), with connector pricing counted, and the reasons a
team would not adopt it. Plan: [audit-1107-plan.md](audit-1107-plan.md). 30 sessions (A1–A30), each with its own note
and decision block; this page is the summary. Every paid call went to the Anthropic API with `HAIKU_API_KEY`
(`claude-haiku-5-5`; Sonnet only to regrade concerns) through the lab provider: **Anthropic-direct lab figures**, not
the OpenRouter route the servers ship.

## In plain words

- **Blind check (heldout17, never run before; [a29-heldout17.md](a29-heldout17.md)).** On Pi with the house rules
  cached in every arm: the agent with Eden raises the hidden fact in **73% of tasks against 5%** one request a session
  and 7 of 8 against 0 of 8 over a user's days (pooled **+70.8 points, +59.7..+81.9**); **no rise in false concerns**
  after a Sonnet regrade; **0.62 s faster** one request a session and 0.45 s over days. **Cost: dearer by
  $0.06–0.09 per 1,000 tasks when connector calls are free** (the packet is new text the agent's prompt cache must
  write), **far cheaper on every per-call connector plan** (Composio −$0.39/1k, Zapier MCP −$41/1k). The pre-registered
  verdict is "not confirmed" on that one cost clause. On Hermes the same shape: **70% against 6%**, 1 s faster, no
  concerns, cheaper on every paid connector plan.
- **After the blind check, A30** split that gap by token class: it is the packet written to the cache on a task's
  first request (and earlier packets read back over a day), nothing else. Handing two candidates instead of five when
  they already settle the request (D400/D404) took $0.008–0.013/1k off with hidden facts not worse (+5.8, −0.6..+12.3);
  the rest of the gap is the packet's own bytes, and every earlier way to shrink them lost hidden facts.
- **Speed.** Under signal-only change notices Eden was 41–43% of the agent's wait (re-reading changed items). A new
  notice that names the changed items (`/v1/sources/refs`, D347) takes it to **3%** (request p50 1,013 → 6 ms) and
  tasks run 1.3–1.6 s faster. Elsewhere Eden's own path is ~10 ms.
- **Quality.** The ask nudge (D317, +9 points on train, **+12.5 blind**), plan-conflict alerts for facts that arrive
  later (D301, 7 of 16 late facts raised against 0), "updated:" packets that name the times that no longer stand
  (D342). Tried and deleted: link lines, re-show, retrieval moonshots, ask rewording.
- **Scale, many connectors.** At 1,000 sources: hidden facts held (75/74 of 96 against 76/76 at 5, $0), card calls
  −94%, unused sources swept weekly instead of daily where a get tool exists (D356: −46% connector calls a user-day,
  Zapier $47.7 → $25.7 a user a day). **Open:** live, a 1,000-source user still costs ~39 connector calls and 2.2 s
  a task (A21); a budget halved the calls but lost hidden facts and did not move the path (A28, deleted): the path
  needs every live search off the push, not most.
- **Scale, many users.** Idle users are frozen into one compressed blob and thawed on use (D325); the sync's id sets
  are compact (D371); a cold-start storm no longer stalls warm users (D328/D370: p99 1,180 → 48 ms). About **2,280
  users at the 3,000-item cap on a 4-core/16 GB box, ~$65 per 1,000 users a month** (AWS list prices via third-party
  pages, not checked on AWS's own).
- **Adoption.** No-key push (D276), `/v1/explain`, a Python client, a Dockerfile, an OpenAI-compatible proxy with
  shadow mode, a demo and digest, a threat model, connector presets; a fresh-eyes walkthrough fixed every stumble on
  three paths (a TypeScript client that could not be installed outside the repo, silent proxy mistakes, stack traces
  for config errors) with a smoke test each (A23).
- **Safety.** A live prompt-injection suite (A10): Eden adds a small real risk (4 of 432 attacks succeeded against 0
  with tools alone, all ordinary-worded asks folded into a requested action). Text filters did not reduce it (kept
  as off trials); an action check on recipients only a packet named is the fitting control (A25). A security review
  fixed a browser-origin bypass of the no-key mode and a redaction gap (A20).
- **Bugs.** Two bug hunts, a seeded state-machine fuzz with hostile worlds, and reviewer passes on every merge; the
  final interaction review approved the merged tree and its five low findings were fixed with tests.

## What changed in the default

Promoted (each measured better or neutral at no extra paid cost, D112): `planConflict` (D301), `askNudge` (D317),
`revisionDiff` (D342), `pushCandidatesSettled` 2 (D404), the no-key push (D276), `syncBackfillLanes`/`syncPollWidth`
(D262–D263), `syncLocalComplete`/`routeLocalHits` (D264–D265), `cardsSourceAware`, `syncKeepCut`, `routeSketch`,
`syncEngagedDeep` (D320–D323), `syncUnusedSweepMs` one week (D356), idle-user freezing (D325), `syncIngestTurns` with
its card drain (D370), compact id sets (D371). New routes: `/v1/sources/refs` (D347), `/v1/usage` (D326),
`/v1/explain` (D277).

Left as off trials: `guardLine`, `quarantineInstructions` (D306–D307), spend leases (D327), `actionCheck` (D69), and
A25's recipient check if merged as a trial.

## Numbers that moved (gates on the final tree)

- `bun run check`: all green (2,360 tests before A25).
- `bun run eval` (no model): precision 0.5909 → **0.65** (A30's two-candidate cut: fewer items delivered, 44 → 40),
  recall 0.52, falseFireRate 0.
- `bun run funnel` (no model, train1–6 seeds 41–42): hidden 314/384, decoys 273/384, unchanged since the morning's
  base. A22 measured that a second sample of the background intent requests alone moves 43 hidden tasks: no-model
  deltas of a few tasks are within that noise.

## Owner action items

1. **OpenRouter probes** (not run: testing was Anthropic-only): the reader's `stop` (D240) and prompt caching
   (`anthropicCache`, D145) on the route the servers ship.
2. **Connectors with a get tool.** The weekly sweep (D356) needs `fetchTool` on a connector; the shipped presets have
   none, so they stay daily until integrators wire one.
3. **Integrations: send ref notices** (`sourceChanged(id, {refs})`) where the connector says which items changed,
   and on Hermes give Eden in place of the source tools, not beside them.
4. **The 1,000-source path** (A28, D391): the next lever must take every live search off the push.
5. **Frozen-user persistence** (A14): restarts still re-sync every user; persisting the blobs needs a decision
   against D8.

## Spend

Itemised from the session notes and the coordinator's runs: **$19.34** (A3 1.231, A6 2.171, A7 0.629, A9 2.406, A10
1.22, A12 1.469, A15 1.392, A16 0.930, A17 2.352, A18 0.287, A19 0.034, A21 0.410, A22 1.580, A26 0.759, A27 0.012,
A28 0.366, A29 0.487, A30 0.533; Hermes runs 0.317, 0.465, 0.288). A2, A8 and A25 are in their own notes and not
itemised here; A1, A4, A5, A11, A13, A14, A20, A23 and A24 were $0 or near it.
