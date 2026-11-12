# F9: the subagent transport (queue) and how far it agrees with the real API

D1101. Lab only. Packages: `packages/sim/src/lab/queue-transport.ts`, `packages/sim/lab/subagent/` (batcher, driver
procedure), `pi-ab --agent-sim single`.

## Why

The Anthropic account behind `HAIKU_API_KEY` has no credit and will not get any; OpenRouter is forbidden for the lab
(D818). Seven sessions (F1–F3, F5–F8) were blocked on paid lab runs. The owner's instruction: use haiku subagents to
simulate. The queue transport lets every existing lab harness run unchanged, with each model call answered by a Claude
Code subagent through files.

## What it is

See packages/sim/lab/subagent/README.md for the commands. In short: `EDEN_LAB_QUEUE=DIR` replaces the global `fetch`
for Anthropic's Messages API in every lab process; a call is keyed by role, model and normalised body; a hit in
`DIR/done/` answers at once, a miss is written to `DIR/pending/` and waited for; `batch.ts take|prompt|put` hands
batches to haiku subagents and validates their answers. Zero usage is reported, so the spend ledger books $0, and
every call is logged with `transport: subagent-sim`.

## First runs (train1, seed 41)

- `bun run funnel --suite train1 --seeds 41 -- --check live --check-cache …` with `EDEN_LAB_QUEUE` set: 64 push-check
  calls, answered by 7 haiku subagents in batches of 8–10 (47–83 s a batch, about 75,000 characters each), 64 of 64
  valid on the first `put`, `CHECK … 64 calls of 64 asked, 0 failed`, $0. TOTAL hidden 24/32, decoys 26/32; the run
  took 263 s, most of it waiting for subagents.
- `pi-ab --agent-sim single --limit 3` on train1 seed 41 (hidden and control, arms tools and eden, every role on the
  queue, one looping haiku worker): 46 calls (16 cards, 12 agent, 12 grader, 6 push check), 12 runs, 0 ungraded, $0.
  Hidden fact raised: eden 3/3, tools 0/3; control false concerns 0/3 in both arms. Three tasks: a smoke test, not
  a measurement.

## Fidelity

**Cards against recorded Haiku 5.5 cards.** `cards-distill.ts export --seeds 41` (train1–6) holds out 16 batches
(191 items) of the exact card prompt with Haiku's own `intent-v2` card and requests as the target. Two haiku
subagents answered the 16 prompts; `cards-distill.ts score`:

| measure | subagents vs Haiku |
|---|---|
| batches and items that parse | 16/16, 191/191 |
| constraint flag agreement | 0.932 |
| flag recall / precision (all items) | 0.958 / 0.657 (24 Haiku flags, 35 subagent flags) |
| flag precision on items the default keeps a card for | 0.885 (26 flags against 24) |
| card kind agreement (all items) | 0.869 |
| on items both flag (n 23): kind, actions, span, limit | 0.478, 0.391, 0.652, 0.957 |
| entities Jaccard / requests Jaccard | 0.569 / 0.288 |

The subagents flag more than Haiku (35 against 24), mostly items the default's prefilter drops anyway; they agree on
which items bind but word the card's kind, actions and requests differently. Intent requests (Jaccard 0.29) are the
weakest part: runs that lean on replayed requests should keep the recorded `intent-v2` file, not re-make them.

**The push check: no recorded API pools to compare.** No push-check prompt with its Haiku reply is in git (the
recorded check caches and F2's pools live in `.local/`, which is not pushed), so the subagents could not be scored
against Haiku on the same prompts. What was measured instead is the subagents' own repeat agreement, beside Haiku's
(D931: the same prompt asked of Haiku again agrees on speak/silent 90.9%, names the same items 75.4–78.8%, keeps a
silence 89.2–91.2%). The 64 train1 seed 41 check prompts of the first funnel run were answered a second time by four
fresh haiku subagents (`check-agree.py`): speak/silent agreement 0.969 (62/64), same items 0.812, a silence kept
24/26; 38 and 40 of 64 prompts spoke. The subagents repeat themselves at least as closely as Haiku does, which says
the simulated check is stable, not that it matches Haiku's choices. A session with recorded check pools (F2) should
answer them through the queue and report act/keep agreement with Haiku before reading small check effects.

**How to read numbers from the queue.** Compare arms within one queue-served run. A difference between arms that is
smaller than these disagreement rates (about 7% of card flags, 3% of check speak/silent decisions between two samples)
needs repeat samples; a level (hidden raised, false concerns) is the subagents' level, not Haiku's.
