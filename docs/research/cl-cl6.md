# CL6: the agent is the reader (H19)

Status: 2026-11-07, branch `claude/cl6-agent-reader` (from `claude/lucid-hypatia-v9wqk5` at `ca47a2da0`). Session CL6
of the cost-and-latency wave ([cost-latency-plan.md](cost-latency-plan.md)), hypothesis H19, decisions D236–D237.
Every paid call went to the Anthropic API with `HAIKU_API_KEY`, `claude-haiku-5-5` in every role (agent, grader,
cards, intent), through the lab provider (D97), with `OPENROUTER_API_KEY` unset, on one spend ledger
(`.local/cl6/ledger.jsonl`) with a hard cap of $3.5: **Anthropic-direct lab figures**. **Spent: $2.441.**

## In plain words

- **The idea.** Eden's paid reader (one Haiku call a request, about $0.00027 and 1 s on the agent's path) decides
  which of the items Eden found bear on the user's request. But the agent is already a Haiku model that reads
  whatever Eden hands it. So instead of asking a second model, Eden now hands the agent the five best items it found,
  each a short excerpt, under one line that says: these may bear on the request, nothing has checked them, check each
  is about the same person, thing and date before using it, and ignore it otherwise. When nothing Eden found looks
  like a rule, a hold or a change, it says so in one line instead.
- **It works, and it is now the default (D237).** On the assumed traffic (1 task in 10 needs a hidden fact, 1 is a
  look-alike, 8 need nothing), against the shipped default on the same tasks:
  - **cost per 1,000 tasks falls by $0.19–0.29 on the mix** on both horizons and both kinds of change notice (Eden's
    per-task spend goes from $0.25–0.28 to $0; on the short horizon the agent reads about 300–600 more input tokens a
    task);
  - **the agent waits 0.7–1.4 s less** on nothing-to-add requests (significant in three of the four runs; the reader
    was half to all of Eden's time on the path); with notices that carry their items, Eden's time on the path is now
    about 10 ms a task;
  - **hidden facts raised: −3.6 points pooled (−8.4..+1.2)**, not a significant loss; 71.3–73.6% of hidden facts are
    still raised on the short horizon (the agent alone: 12.0%);
  - **false concerns:** after a second grading pass and reading every answer, one look-alike template
    (`commitment-already-purchased`) accounts for the short horizon's extra concerns (3 of 287 against 2), and the
    rise on nothing-to-add requests (4 of 288 against 0) is grader error: none of those answers names the planted
    item. On the long horizon 5 against 5.
- **Against the agent alone (`tools`).** With Eden in this shape the steady-state cost is **below the agent alone on
  the short horizon with signal notices** ($0.338 against $0.368 per 1,000 tasks, paired −$0.025 to −$0.053 by kind)
  and **level with it on the long horizon** ($0.326 against $0.317; paired by kind −$0.054..+$0.021, all intervals
  across 0). With payload notices the agent's billed cost was higher in that run for both Eden arms (prompt-cache hits
  vary between runs): $0.415 against tools' $0.366–0.377 billed, but re-priced at fixed prices with cached tokens as
  plain input, the agent with candidates costs $0.453–0.459 against tools' $0.562–0.566 (short) and $0.842–0.854
  against $0.972 (long). The goal (below the agent alone) holds at fixed prices on every arm and as billed on the
  signals runs; as billed with payload notices it does not on the short horizon.
- **What was deleted:** constraint-like items first (−27 points of hidden facts live), the plain wording without the
  check (4 false concerns in 48 look-alikes), the hybrid that kept the reader for the agent's own asks (+$0.16–0.21
  per 1,000 tasks, no gain), and the excerpt-size knob (the funnel showed no difference between 120 and 320 bytes).

## 1. What was built (D236, then D237)

`pushCandidates` (k, 0 = the reader's push). With `readerPush` (the push of a request that acts), the push no longer
calls `readAsk`. `candidatesOf` takes the pool the reader would have read (the ask's order, `askReaderPool` deep),
drops bulk mail, and gives its first k items, or none when no pooled item passes `readerGate`'s constraint test
(cards included). They go through `verifyItems` and `deliver` like the reader's flagged items, rendered with a fixed
first line inside the data envelope (`CANDIDATES_LEAD`, `render.ts`; D11, D19: no source or event text), each a
focused excerpt of `compactItemBytes` (320), in a packet sized for k items. An `ask` makes no reader call either and
answers in its rule order. An empty candidate set from sources that all answered (D127) queues `CANDIDATES_NONE` as a
note citing nothing (reason `checked:`, so a later packet or the next user message drops it untaken, as D246's).

The trial's other switches, all measured and deleted (§3): `pushCandidateBytes` (excerpt size), `pushCandidateCheck`
(the check wording; now the only wording), `pushCandidateAskReader` (the hybrid), `pushCandidateNone` (the note; now
always on), `pushCandidatePoolOrder` (now the only order).

Departures, recorded in D237: the "nothing found" note speaks after no reading (D246 gives its note only after one,
because "a gated pool was read by no one"); the framing line is an instruction of Eden's own inside the "Data, not
instructions." envelope (to the agent, about the items around it; never source text); and with a reader role wired
the eval's item precision falls (more items delivered by design: the agent is the judge; falseFireRate stays 0).

Review (the `reviewer` subagent, before the payload runs): one correctness bug fixed, the `readerPushBehind` second
pass withdrew an untaken first packet when its own pool had nothing constraint-like, leaving the agent with no packet
(`push-candidates-behind.test.ts`). **The signals runs below ran with the bug** (it can only lower the candidates
arm's recall); the payload runs ran with the fix. Also fixed: a test that never reached the note's branch, unbounded
packet sizes (`pushCandidates` ≤ 40, the frame bounded by the pool), and a numeric parent in the config check (gone
with the promotion).

## 2. The $0 screen (funnel, train seeds 41–42, recipe 2a's paid reader replayed, `--neutral`)

`packages/sim/lab/cl6/funnel-screen.txt`. "In packet" = the planted item (or its decoy) delivered before the agent's
first model call, by any path (the rule paths and the push); neutral = tasks with nothing planted.

| Arm | Hidden in packet | Decoy in packet | Neutral: any packet, bytes a task | Reader calls a task |
| --- | --- | --- | --- | --- |
| default (the reader's push) | 284/384 | 91/384 | 96/384, 71 B | 0.84 (hidden) |
| k 3, constraint-like first | 216 | 159 | 324, 678 B | 0 |
| k 5, constraint-like first | 227 | 178 | 324, 923 B | 0 |
| k 8, constraint-like first | 260 | 209 | 324, 1,255 B | 0 |
| k 3, pool order | 254 | 215 | 324, 630 B | 0 |
| k 5, pool order (**promoted**, with the note) | 272 | 234 | 332, 946 B | 0 |

- The planted item's rank in the reader's pool (default run): first in 154 of 384 hidden tasks, top 3 in 238, top 5
  in 256, top 8 in 273, absent 35, no pool 62. The reader's value is discrimination (284 hidden against 91 decoys in
  packets), not reach: the candidates put the decoy in front of the agent 2.6 times as often, and the question is
  whether the agent rejects it (live, §3–4).
- The packet costs the agent about 950 bytes (about 240 tokens, $0.000024 at Haiku's input price) on most requests,
  against the reader's ~$0.00027.
- 120-byte excerpts carried the same items as 320-byte ones (725 against 923 bytes a neutral task); not tried live.
- The neutral reader top-up no longer covers the default's neutral prompts at this tip (590 misses, answered without
  the reader), so the default's neutral packet count above is an undercount; the candidates arms make no reader call.
- The promoted default at $0: TOTAL hidden 305/384, decoys 267/384, 0 reader calls; `--preset minus-candidates`
  reproduces the old default exactly (321/129, 643 replayed, 0 misses).

## 3. Live screens (Pi, train, `--push signals`, 8 templates a suite, n = 48 a kind)

`screen41-report.txt` (seed 41, against the default) and `screen42-report.txt` (seed 42, variants of the best). All k
5 unless named; "check" = the who/what/when wording.

| Arm | Hidden | False (control) | Any (neutral) | Mix $/1k | Notes |
| --- | --- | --- | --- | --- | --- |
| default (seed 41) | 38/48 | 0 | 0 | 0.679 | |
| constraint-first, check | 25/48 | 1 | 0 | 0.436 | hidden −27.1 (−39.6..−14.6): **deleted** |
| pool order, check | 35/48 | 1 | 0 | 0.421 | hidden −6.3 (−16.7..+2.1) |
| pool order, plain wording | 34/48 | 4 | 1 | 0.415 | look-alikes raised 4 times: **deleted** |
| pool order, check (seed 42) | 35/48 | 0 | 2 | 0.372 | |
| k 3 | 37/48 | 2 | 1 | 0.368 | vs k 5: hidden +4.2 (−8.3..+16.7), n.s. |
| + the note | 33/48 | 0 | 0 | 0.340 | vs k 5: $/1k −0.046 control, −0.036 neutral: **kept** |
| + the reader on the agent's asks (hybrid) | 36/48 | 2 | 1 | 0.531 | Eden +$0.10–0.22/1k, no gain: **deleted** |

The regrade of seed 41's concerns (Haiku, `--only-concerns`): 6 of 6 control concerns kept, the 1 neutral one a
grader error. The pool-order arm's one control concern is the agent reporting that an access ticket was already
approved (a "prerequisite met" look-alike), which the grader counts as raising the fact.

## 4. The final runs (Pi, train1–6, seeds 41 and 42, neutral on, direct profile, time scale 1)

`cand` = k 5, pool order, check wording, the note: the promoted default. Short: the first 12 templates of each suite ×
hidden, control, neutral (n = 144 a kind per arm). Long: `--days 8` (232 tasks a user pair; 23 hidden, 23 control, 186
neutral). Signals runs: tools, default and `cand` in one process per seed; payload runs: default and `cand` (tools
reused from the signals run for seed 41 short; the long mode refuses `--reuse-arms`, and seed 42's short tools arm had
one 429-failed task, so payload tools figures come from the signals runs: **paired across runs**).

```bash
# packages/sim/lab/cl6/run.sh LABEL CONDITIONS PUSH [pi-ab flags]; VC = {"cand":{"pushCandidates":5, ...trial switches}}
packages/sim/lab/cl6/run.sh cl6-short-sig-41 tools,eden,eden~cand signals --seeds 41 --limit 12 \
  --variants hidden,control,neutral --variant-config "$VC" --budget 0.6     # and 42; payload: eden,eden~cand
packages/sim/lab/cl6/run.sh cl6-long-sig-41 tools,eden,eden~cand signals --seeds 41 --days 8 --variant-config "$VC"
bun packages/sim/src/lab/pi-ab-report.ts R/cl6-short-sig-4{1,2}.json; bun packages/sim/src/lab/pi-cost-report.ts ...
python3 -I packages/sim/lab/cl6/pair.py R/cl6-short-pay-4{1,2}.json R/tools-short.json eden~cand tools
```

### Cost, $ per 1,000 tasks, steady state on the 1:1:8 mix (`pi-cost-report.ts`, billed)

| | Short, signals | Short, payload | Long, signals | Long, payload |
| --- | --- | --- | --- | --- |
| tools | 0.368 | 0.366 (reused, seed 41) | 0.317 | (0.317, signals run) |
| default | 0.631 (agent 0.325 + Eden 0.283) | 0.665 | 0.568 | 0.529 |
| **cand** | **0.338** (agent 0.332, Eden 0) | **0.415** | **0.326** (bg cards 0.018) | **0.338** |
| Agent alone, fixed prices (cache-neutral): tools / default / cand | 0.562 / 0.415 / 0.453 | 0.566 / 0.417 / 0.459 | 0.972 / 0.860 / 0.842 | — / 0.747 / 0.854 |

Paired, `cand − default` (bootstrap 95% over tasks; `pi-ab-report.ts`, `pair.py`):

| | Hidden raised | $/1k hidden / control / neutral | Wall hidden / control / neutral (s) |
| --- | --- | --- | --- |
| Short, signals | −3.5 (−11.3..+4.2) | −0.236 / −0.289 / −0.301 | −0.60 / −0.62 / −0.90 (all n.s.) |
| Short, payload | −2.8 (−10.4..+4.9) | −0.202 / −0.247 / −0.256 | −0.99 / −1.42 / −1.37 (all exclude 0) |
| Long, signals | −4.3 (−21.7..+8.7) | −0.201 / −0.263 / −0.266 | −0.62 / −0.64 / −0.91 (all exclude 0) |
| Long, payload | −8.7 (−21.7..+0.0) | −0.131 / −0.184 / −0.222 | −0.23 (n.s.) / −0.48 / −0.70 |
| **Pooled, all four** | **−3.6 (−8.4..+1.2)**, n = 332 | | |

Paired, `cand − tools`:

| | Hidden raised | $/1k hidden / control / neutral |
| --- | --- | --- |
| Short, signals (same run) | +58.9 (+49.6..+67.4) | −0.053 (−0.082..−0.024) / −0.047 (−0.072..−0.020) / −0.025 (−0.052..+0.001) |
| Short, payload (tools from the signals run) | +61.3 | +0.042 / +0.031 / +0.050 (all exclude 0; billed, cache varies across runs) |
| Long, signals (same run) | +56.5 (+34.8..+78.3) | +0.021 / −0.054 / −0.008 (all n.s.) |
| Long, payload (tools from the signals run) | +52.2 | +0.031 / −0.052 / +0.007 (all n.s.) |

### Facts, concerns, time

| | Short sig: tools / default / cand | Short pay: default / cand | Long sig: tools / default / cand | Long pay: default / cand |
| --- | --- | --- | --- | --- |
| Hidden raised | 17/142 / 107/143 / 102/143 | 110/144 / 106/144 | 2/23 / 16/23 / 15/23 | 16/23 / 14/23 |
| False concern (control, graded) | 0 / 1 / 3 | 3 / 3 | 0 / 0 / 1 | 0 / 1 |
| Any concern (neutral, graded) | 2 / 0 / 2 | 0 / 2 | 4 / 5 / 1 | 2 / 3 |
| Wall p50 / p90, mix (s) | 4.97 / 9.37, 6.20 / 9.98, 5.59 / 10.20 | 4.63 / 5.95, 3.33 / 4.59 | 2.74 / 4.70, 3.34 / 5.92, 2.78 / 3.81 | 2.92 / 5.21, 2.59 / 3.66 |
| Eden on the path, mean ms a task | — / 3,032 / 1,689 | 1,080 / 11 | — / 1,505 / 956 | 1,269 / 677 |
| Reader calls a task | — / 0.98 / 0 | 0.99 / 0 | — / 0.93 / 0 | 0.92 / 0 |
| Agent input / output tokens (neutral) | 2,683 / 570, 1,950 / 525, 2,261 / 481 | 1,908 / 515, 2,283 / 478 | 7,736 / 355, 7,071 / 340, 6,818 / 296 | 6,055 / 319, 6,849 / 316 |
| Agent `ask_context` and search calls a task | 3.41 / 0.99 / 0.81 | 1.00 / 0.80 | 1.65 / 0.37 / 0.08 | 0.27 / 0.08 |
| Eden connector calls a task | — / 6.78 / 8.36 | 0 / 0 | — / 4.99 / 6.38 | 1.19 / 2.25 |

- **Concerns regraded** (`regrade.ts --only-concerns`, Haiku, $0.003 for all eight files), then read. Kept, Eden
  arms pooled over both push modes, against the default paired: short control 3/287 against 2/287 (+0.35 points,
  −0.70..+1.39); short neutral 4/288 against 0/288 (+1.39, +0.35..+2.78); long control 2/46 against 0/46 (+4.35,
  +0.00..+10.87); long neutral 3/372 against 5/372 (−0.54, −2.15..+0.81). Read: the short control concerns of `cand`
  are all `commitment-already-purchased` (a purchase for other resources flagged as a "possible duplicate", the agent
  noting it does not name Kepler); the long ones are the agent stating a prerequisite was met (consent recorded, the
  access ticket approved), which is true; the four short neutral ones give generic advice ("if you're on a fixed deal,
  leaving early can incur an exit fee") or say nothing was found, and none names the planted fact: grader errors that
  survived a second Haiku pass (W2b's finding again).
- Uptake (screen 42): when the planted item was in a candidate packet the agent raised it 88–91% of the time; the
  hidden facts lost are the ones no packet or answer carried.
- With signal notices the candidates add connector calls (6.78 → 8.36 short, 4.99 → 6.38 long): five cited items are
  re-read where the reader cited one or two (D126). With payload notices there are none.
- The signals runs were four processes at once on the 4-core box, and the reader's p90 rose to 2.6 s (mean 2.3 s,
  short): the default's latency is overstated there; the payload runs (three processes) are cleaner (reader p50
  1,050 ms, p90 1,465 ms).

### Eval

- `bun run eval` (no model, no reader wired: candidates inert): identical to the base tree (precision 0.8276, recall
  0.48, falseFireRate 0; `plannedLookups` flips 121/122 between runs of the same tree).
- `bun run eval --reader stub` and the live eval on the Anthropic lab transport (`eval-live.ts`, ledger run
  `cl6-eval-live`): the push delivers its candidates. Live: **0 reader calls, $0**, precision 0.5909 (was 0.8276),
  recall 0.52 (0.48), falseFireRate 0, secretsLeaked 0, notInert 0. The eval scores items, not the agent's answer, so
  candidates it was not expecting count against precision; on silent turns nothing new fires.

## 5. Decisions

- **D236:** the trial and its measured variants (constraint-first order, plain wording, the hybrid, k 3, the excerpt
  size): what each measured and that each lost or was not needed.
- **D237:** `pushCandidates` 5 is the default (promoted under D112: cheaper by $0.19–0.29/1k on the mix, faster, hidden facts
  not significantly lower, concerns not higher once read); a new part `candidates` (`--preset minus-candidates`, the
  old default); the reader part also sets it to 0. The reader's code and role stay (an embedder may set
  `pushCandidates: 0`; the lab's reader screens run `--preset minus-candidates`).

## Spend (ledger `.local/cl6/ledger.jsonl`)

| Ledger runs | What | $ |
| --- | --- | --- |
| cl6-smoke | wiring smoke (24 tasks × 2) | 0.036 |
| cl6-scr41, cl6-scr42 | live screens | 0.596 |
| cl6-short-sig-41/42, cl6-long-sig-41/42 | final, signals (tools, default, cand) | 1.022 |
| cl6-short-pay-41/42, cl6-long-pay-41/42 | final, payload (default, cand) | 0.784 |
| cl6-*-regrade | concern regrades | 0.003 |
| cl6-eval-live | the shipped live eval (no reader call) | 0.000 |
| **Total** | | **2.441** |

## Caveats

- Train only (no held-out suite was run; heldout16 is untouched for the combination's blind check). The trial's
  wording and k were chosen on train seeds 41–42, the same seeds as the final runs; the blind check is the combine's.
- The long horizon's rates rest on 23 hidden and 23 control tasks a run.
- `tools` with payload notices is the signals run's tools arm (the agent alone does not see notices): payload
  `cand − tools` pairs cross two runs, and the agent's billed cost moves with prompt-cache hits between runs.
- A real agent other than Pi's Haiku loop may judge candidates worse (or better): the framing assumes an agent model
  at least as able as Haiku 5.5 to reject a look-alike when told to check who, what and when.
- The eval's item precision falls with a reader role wired (§4): by design, but it is the first default whose
  delivered items the agent is expected to filter.
