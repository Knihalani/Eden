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
fresh haiku subagents (`fidelity/check-agree.py`): speak/silent agreement 0.969 (62/64), same items 0.812, a silence kept
24/26; 38 and 40 of 64 prompts spoke. The subagents repeat themselves at least as closely as Haiku does, which says
the simulated check is stable, not that it matches Haiku's choices. A session with recorded check pools (F2) should
answer them through the queue and report act/keep agreement with Haiku before reading small check effects.

**Recipes on the cards (F9 round 2).** The integrator relayed F2's finding: on 120 recorded check rows, subagents kept
22 of the 31 planted facts the API check dropped, and named 2 look-alikes where the API named 10. F7 adds that
subagent replies run shorter (42 output tokens a call against 68). Together these say the stand-in is a more careful
judge than the API. On the cards, the only API replies this session holds, the recipes compare as follows. The same
16 held-out batches (191 items) were scored against Haiku's recorded cards:

| recipe | runs | flag agreement | flag precision | flag recall | kind | chars a reply (Haiku 1,688) |
|---|---|---|---|---|---|---|
| careful (the v1 prompt), batches of 8 | 1 | 0.932 | 0.657 | 0.958 | 0.869 | 1,427 |
| fast (`--recipe fast`), batches of 8 | 2 | 0.953, 0.932 | 0.742, 0.667 | 0.958, 0.917 | 0.895, 0.890 | 950, 1,003 |
| fast, one request an agent (first 4 batches) | 1 | 0.855 (careful 0.909, fast in a batch 0.909) | 0.533 | 0.889 | 0.800 | 1,505 |

The two fast runs differ from each other by as much as fast differs from careful (2 points of flag agreement). On
cards, then, neither the recipe nor the batch size moves fidelity beyond run-to-run noise.

**The push check against the recorded API check (F2's rows, `claude/f2-pilot-data`).** Two samples, both scored by
`fidelity/check-fidelity.py` with the shipped parser:

1. F2's 120 pilot rows. These are stratified on the API's own answer: all 31 hidden rows where the API dropped the
   planted fact, 29 where it kept it, 30 control and 30 neutral rows. Four recipes, each over all 120 rows:

   | arm | API-dropped planted named | kept | look-alike named | neutral any yes | speak/silent with API | same items |
   |---|---|---|---|---|---|---|
   | API (recorded) | 0/31 | 29/29 | 10/30 | 8/30 | — | — |
   | F2's subagents W, W2 (24 a batch) | 22, 23 | 28, 29 | 2, 5 | 6, 6 | 0.775, 0.825 | 0.483, 0.525 |
   | careful, 24 a batch | 23 | 29 | 4 | 7 | 0.817 | 0.500 |
   | fast, 24 a batch | 23 | 28 | 3 | 7 | 0.792 | 0.500 |

   The recipe changes nothing: careful against fast and F2's own prompt are within one row of each other on every
   stratum. The 31 dropped rows were chosen because the API erred there, and an API re-asked on its own errors
   would also rescue many of them (D931: Haiku keeps its own recorded answer about 77–90% of the time). So this
   sample overstates the gap.
2. **A random 96 of the 2,267 recorded API rows** (`fidelity/random-rows.ts`, seed 7: 35 hidden, 24 control, 37
   neutral; careful recipe, 24 a batch). This is the unbiased reading:

   | | API (recorded) | subagents |
   |---|---|---|
   | planted named (hidden) | 29/35 | 32/35 |
   | look-alike named (control) | 4/24 | 3/24 |
   | neutral with any yes | 12/37 | 8/37 |
   | items named in all | 116 | 81 |
   | speak/silent agreement with the API | — | 0.823 (Haiku with itself, D931: 0.909) |
   | same items as the API | — | 0.625 (Haiku with itself: 0.754–0.788) |
   | API silent, subagent silent / API spoke, subagent spoke | — | 37/41, 42/55 |

**Diagnosis.** The subagent is a stricter, better-aimed judge than Haiku on the API. It names 30% fewer items. It
falls silent on a quarter of the pools where the API spoke (13 of 55), mostly by leaving out the items the API
named with a loose `hits`. It still names the planted fact a little more often. Asking it to be fast and
uncareful, giving it one prompt at a time (cards), or batching 24 changes none of this. The cause is the model
behind it, not the procedure: a Claude Code subagent reads the whole prompt with the session's full attention and
cannot be told into the API's thinking-off sloppiness. The residual gap is 9 points of speak/silent agreement and 13–16
points of same-items agreement beyond Haiku's own repeat noise.

**What it means for subagent-served numbers.**

- **Levels are optimistic for Eden.** Against the API, the stand-in's check sends about a third fewer neutral packets
  (8 against 12 of 37) and slightly more planted facts (+3 of 35). Read a queue run's neutral-packet and false-concern
  rates as a lower bound and its hidden rate as an upper bound.
- **Arm differences that do not change the check's prompt** (retrieval, ranking, packets, the agent's prompt) carry
  over: both arms see the same stand-in check, and the content-hash cache gives paired arms the same verdict.
- **Arm differences in the check's own prompt or rule** (F2's act-rule arms) do not carry over. The stand-in already
  behaves like a stricter check, so an arm that makes the check stricter or looser moves it from a different start.
  Those decisions need the API or a re-reading of the recorded API replies (F2's `offline.py`), not the queue.
- Cards: flag agreement 0.93–0.95 and kind 0.87–0.90. A card-driven difference smaller than about 5% of flags
  needs repeat samples.

**How to read numbers from the queue.** Compare arms within one queue-served run. A difference between arms that is
smaller than these disagreement rates (about 7% of card flags, 3% of check speak/silent decisions between two samples)
needs repeat samples; a level (hidden raised, false concerns) is the subagents' level, not Haiku's.

## API-faithful check replay (D1104)

The integrator asked for a way to read push-check *prompt* arms (F5's sheet, F10's band) despite the stand-in's gap:
speak/silent agreement of at least 0.90 and same items of at least 0.75, Haiku-against-itself level. All numbers below
come from F2's recorded Haiku-API check rows (`claude/f2-pilot-data`: `base-dumps-4142.jsonl.gz`, 2,267 answered
rows; `screen-rows.jsonl.gz`, the API under the shipped prompt W and arms A and R on the same rows).

**1. Exact replay** (`packages/sim/src/lab/check-api-replay.ts`, tested). It rebuilds each recorded row's Messages API
body as the shipped check sends it (`checkMessages`, 500 tokens, JSON, thinking off) and writes the API's raw reply
under the queue key. A queue run then reads the API's own answer on every check prompt the API answered. The
rebuilt prompt matches the shipped one byte for byte (system and user turn checked on a live funnel request). On
current main, though, a train1 seed 41 funnel matched none: F8's world-clock coverage (D1102) changed which items
reach the pool. It serves runs whose pools match the recording (the same coverage and commit range) and arms that
leave the check's prompt alone. A changed check prompt never hits.

**2. A calibrated recipe** (`fidelity/recipes/`). It was tuned on the `tune` half of a fixed split (`halfOf`: md5 of
the row) and measured on a seeded 96 rows of the `test` half (`fidelity/random-rows.ts --half`):

| recipe | half | speak/silent | same items | items named (API) |
|---|---|---|---|---|
| careful (default prompt), random 96 of all rows | both | 0.823 | 0.625 | 81 (116) |
| L1: the API's habits (policies count, names loose, list generously) | tune 72 | 0.833 | 0.458 | 138 (102) |
| L2: base rates plus 12 recorded API examples (tune half, outside the sample) | tune 72 | 0.931 | 0.625 | 62 (102) |
| L3: L2 asking for 2–3 items when speaking | tune 72 | 0.889 | 0.611 | 77 (102) |
| **L2 on the held-out half** | test 96 | **0.844** | **0.656** | 72 (84) |
| API with itself (D931; F2's twice-asked W rows) | — | 0.909–0.917 | 0.754–0.781 | — |

L2's tune score was a small-sample high. On the held-out half it sits within noise of the plain prompt, short of
both targets.

**3. Paired delta** (`fidelity/paired-delta.py`). This estimates the API's answer under an arm as its recorded
shipped-prompt answer, changed only where the subagent's own answer changes between the shipped prompt and the arm.
It was run on 96 of the 277 rows where the API answered W, A and R (52 hidden, 44 control; F2's screen had no neutral
rows), with subagents on all three prompts:

| | speak/silent vs the API under the arm | same items | planted named (hidden), effect | look-alike named (control), effect |
|---|---|---|---|---|
| API, W asked twice (noise floor) | 0.917 | 0.781 | — | — |
| arm A: the API's real effect | — | — | 45 → 48 (+3) | 12 → 11 (−1) |
| A: subagent alone | 0.875 | 0.552 | −1 | −1 |
| A: "no change" (the API's W answer) | 0.927 | 0.667 | 0 | 0 |
| A: paired delta | 0.917 | 0.594 | −1 | −1 |
| arm R: the API's real effect | — | — | 45 → 48 (+3) | 12 → 13 (+1) |
| R: subagent alone | 0.844 | 0.458 | −1 | +3 |
| R: "no change" | 0.875 | 0.552 | 0 | 0 |
| R: paired delta | 0.885 | 0.552 | −1 | 0 |

The API's own effects (+3 of 52) are about the size of its disagreement with itself on the same prompt (8% of
speak/silent calls). The subagents move the other way on planted facts (−1), so the paired delta inherits the wrong
sign. Assuming "no change" agrees with the API's arm answers as well as the API agrees with itself.

**Conclusion.** No lever measured here reads a check-prompt arm faithfully. Subagents do not respond to a change in
the check's wording the way the API does, and the effects these arms aim at are as small as the API's own noise. A
check-prompt arm can be decided only on the API: with credit, or by a structural re-reading of recorded replies
(F2's `offline.py` for parse-rule arms). What remains usable: exact replay for prompts the API answered, and the
D1101 reading rules for everything else.
