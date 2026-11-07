# CL8: the candidate packet's size

Status: 2026-11-07, branch `claude/cl8-packet-size` (from `claude/lucid-hypatia-v9wqk5` at `9b8354b5a`). Session CL8
of the cost-and-latency wave. **No engine change survives: every lever was measured and deleted** (D258–D260). Every
paid call went to the Anthropic API with `HAIKU_API_KEY`, `claude-haiku-5-5` in every role (agent, grader, cards,
intent), through the lab provider (D97), `OPENROUTER_API_KEY` unset, on one spend ledger (`.local/cl8/ledger.jsonl`)
with a hard cap of $2.5: **Anthropic-direct lab figures**. **Spent: $1.983.** Train only: no held-out suite was run.

## In plain words

- **The question.** With no reader call any more (D237), what Eden costs is the extra the agent reads: the candidate
  packet (up to 5 excerpts of ≤320 bytes) and `ask_context` answers. Can a smaller packet cut that without losing
  hidden facts?
- **No.** Four ways of making the packet smaller were tried; none is cheaper overall without a loss, so the default
  stays as it is (`pushCandidates` 5, 320-byte excerpts). The 200-byte and three-candidate arms also had the
  no-repeat switch on (below), which on its own changed nothing measurable:
  - **Shorter excerpts** (200 bytes, with no-repeat) lose the fact: the agent raised **12.8 points fewer hidden
    facts** (−20.5..−5.1; against no-repeat alone −10.7, −18.0..−3.3). At $0 the planted item's excerpt keeps 93% of
    the fact's words at 320 bytes, 70% at 200, 63% at 160, 48% at 120.
  - **Three candidates instead of five** (with no-repeat) is cheaper over a user's days (−$0.029/1k on the 1:1:8
    mix, −0.038..−0.020) but not one request at a time (−$0.003/1k, −0.019..+0.014), where it is **0.26 s slower**
    (+0.04..+0.50): with fewer items on a nothing-to-add request the agent calls `ask_context` more, and that extra
    model turn costs what the bytes saved.
  - **Five on a session's first request, three after** (aimed at the long-horizon saving) saved $0.008/1k
    (−0.017..+0.002) and lost 3 of 23 hidden facts (−13.0 points, −26.1..0.0).
  - **Not repeating an item another packet already gave in the same request** (36% of hidden tasks had one; a real
    race between the push and the rule paths) saved nothing measurable (−$0.003/1k long, +$0.002 short).
  - A **score floor** on the weak tail was dropped at $0: it took the planted item out of 49–68 of 272 packets.
- **What Eden's extra cost actually is, on Pi.** Not bytes: **prompt-cache writes.** Pi's agent with Eden has a
  short fixed prefix (the system prompt and one `ask_context` tool, about 565 tokens) that was never served from the
  cache across tasks in these runs (1,765 of 2,257 first requests read nothing); the agent with search tools has an
  867-token prefix that was. Why the shorter one was not cached is not established (the stated minimum for Haiku 5.5
  may be 512 tokens, below 565; pi-ai's breakpoint placement or how `in` is counted may explain it). The effect is
  measured: each Eden task writes most of its first prompt to the cache at 1.25 times the input price, where the
  tools agent reads most of its prompt at 0.1 times: **$0.14–0.19 per 1,000 tasks in cache writes against
  $0.06–0.07**, more than the whole gap. Re-priced as if the Eden agent's prefix were read from the cache (a
  counterfactual, not a run), the short horizon's 1:1:8 mix is **$0.362 for Eden against $0.370 for the agent
  alone** (billed: $0.399 against $0.370). Over a user's days the day's transcript is cached for both arms; it keeps
  the day's packets, which is why two fewer candidates a packet saved there (about 830 fewer cached tokens read a
  nothing-to-add task).
- **Ask answers** are about 800–1,050 bytes each and come 0.5–1.1 times a task (short), about as many bytes as the
  packet; their cost is the extra model turn an ask takes, not the answer's bytes. Not screened further.

## 1. Where the agent's extra cost goes (token accounting)

`packages/sim/lab/cl8/cache.py` splits each arm's billed agent cost by Anthropic token class from the pi-ab
timelines (Haiku 5.5: $0.1/M input, cache reads 0.1×, cache writes 1.25×, $0.5/M output). Short horizon, the clean
pair (`short2-pay-cache.txt`) and the five-arm run (`short-pay-cache.txt`), per task:

| Arm (run) | Kind | Requests | Cache read / write tokens | $/1k read + write + output | First request: read / write, read on |
| --- | --- | --- | --- | --- | --- |
| tools (5-arm) | neutral | 2.14 | 2,173 / 505 | 0.022 + 0.063 + 0.284 = 0.370 | 939 / 37, 100% |
| eden (5-arm) | neutral | 1.70 | 1,150 / 1,124 | 0.012 + 0.141 + 0.239 = 0.391 | 442 / 570, 47% |
| eden (clean) | neutral | 1.68 | 749 / 1,440 | 0.007 + 0.180 + 0.230 = 0.418 | 80 / 941, 12% |
| eden (clean) | control | 1.53 | 726 / 1,540 | 0.007 + 0.192 + 0.244 = 0.444 | 101 / 1,108, 14% |

- **The first request.** Of 2,257 first requests in the Eden arms (both short runs), 1,765 read nothing from the
  cache, 454 read the whole prompt (another arm had sent the same task's identical prompt), and 38 read a ~610-token
  prefix that included the same task's user turn. None read only the fixed prefix (tools + system, about 565 tokens:
  no-packet first prompts are 599–627 tokens with the user turn). The tools arm read its 867-token fixed prefix on
  140 first requests and the whole prompt on 225 (the same task's hidden, control and neutral variants share the
  request, so their prompts match); 1 of 366 missed. Whole-prompt reads are a lab artifact in both arms (several arms
  and variants send the same prompt); they lower both arms' billed cost. So a ~565-token prefix was not cached across
  tasks here and an 867-token one was. The cause is not established: the minimum cacheable prefix stated for Haiku
  5.5 may be 512 tokens, below 565; the ~565 is inferred from billed input (which may count tokens the API adds for
  tools), and pi-ai places its breakpoints on the last tool, the system prompt and the last user turn. A $0
  `count_tokens` check and a run with a longer prompt would settle it.
- **Counterfactual** (`cache.py --prefix 565`: a first request that read nothing reads 565 tokens instead of writing
  them; labelled, not measured): short mix $0.399 → **0.362** (five-arm run; tools 0.370) and $0.421 → **0.364**
  (clean run). Long: 0.326 → 0.323 (the day's transcript is already cached).
- **The packet** itself, written once: about 950 characters (neutral) to 1,450–1,600 (control, hidden) of packets
  a task (`asks.txt`), roughly 240–400 tokens: $0.03–0.05/1k at 1.25× on the first request, then 0.1× on each later
  one. Long horizon: the agent's transcript keeps the day's packets, so k 3 read 5,459 cached tokens a neutral task
  against the default's 6,286 (`long-pay-cache.txt`).
- **Asks** (`asks.txt`, from the `uptake` records). Short, per task, default: neutral 0.97–1.04 asks and 778–876 bytes
  of answers, hidden 0.51–0.60 and 507–587, control 0.83–0.85 and 709–765; 806–987 bytes an ask. Each ask is one more
  agent model request over the whole prompt.

## 2. The $0 screen (funnel, train seeds 41–42, `--neutral`, `--packets`)

`packages/sim/lab/cl8/funnel-screen.txt` (`screen/bytes.py`, `dups.py`, `keep.py`). Hidden/decoys in a packet before
the agent's first model call; packet and ask bytes a task (the funnel asks once with the request as the question).

| Arm | Hidden / decoys in packet | Neutral packet B | Neutral ask B | Hidden: packet + ask B | Planted line keeps the fact's words (mean / all) |
| --- | --- | --- | --- | --- | --- |
| default (k 5, 320 B) | 272 / 234 | 943 | 468 | 1,529 + 581 | 0.929 / 189 of 253 |
| 200 B | 272 / 234 | 901 | 503 | 1,286 + 776 | 0.702 / 86 |
| 160 B | 272 / 234 | 856 | 541 | 1,184 + 854 | 0.626 / 55 |
| 120 B | 272 / 234 | 780 | 603 | 1,067 + 939 | 0.483 / 24 |
| k 4 | 266 / 227 | 825 | 542 | 1,351 + 690 | 0.928 |
| k 3 | 254 / 215 | 715 | 610 | 1,169 + 800 | 0.930 |
| no repeats (dedup) | 272 / 234 | 911 | 468 | 1,386 + 581 | 0.929 |
| floor 0.3 / 0.5 / 0.7 of the best score | 223 / 218 / 204 | 765 / 741 / 706 | | | |

- **Bytes move to the ask.** The ask answers with `askDedup`, which says in full what a packet showed only in part:
  a smaller packet makes a longer answer (120 B: neutral packet −163 bytes, ask +135). Live, that is what happened:
  the agent asked more.
- **Shorter excerpts keep the same items but not the fact** (CL6 compared only which items went out).
- **Repeats.** 139 of 384 hidden tasks (43 neutral) had an item in two packets of the same request: the push and the
  rule paths look side by side, each tests the ledger before its awaits, and the slower one delivers what the faster
  just did. `pushCandidateDedup` tested again just before delivering; 0 repeats, nothing else changed.
- The planted item's place among the candidates (default): first in 152 of 253 packets, second 62, third 21, fourth
  12, fifth 6.

## 3. Live runs (Pi, train1–6, payload notices, direct profile, time scale 1, neutral on)

Short: the first 12 templates of each suite × hidden, control, neutral (216 tasks an arm a seed). Long: `--days 8`
(232 tasks an arm over users 41 and 42; 23 hidden, 23 control, 186 neutral). Arms: `tools`; `eden` (the default);
`dd` = `pushCandidateDedup`; `k3` = `pushCandidates` 3 with dedup; `b200` = `pushCandidateBytes` 200 with dedup;
`late` = `pushCandidatesLater` 3. Concerns in brackets: what a second Haiku pass kept (`regrade.ts --only-concerns`,
`concerns.txt`).

**The five-arm short run is partial and its wall times are not clean:** three processes at once drew 358 Anthropic
429s (seed 41: 303), and each process stopped at its $0.45 budget after 897 and 862 of 1,080 runs (pairs are by
task, over the tasks both arms finished). The clean short pair (`short2`, eden against k3, 0 retries) is the one to
quote for k3 and for wall time.

### Short horizon (one request per session)

Cost here is `pi-ab-report.ts`'s 1:1:8 mix (agent + Eden per task; background 0 while working, cards replayed).

| Arm (run) | Hidden | Control | Neutral | Mix $/1k: agent + Eden | Agent in tokens, neutral | Wall p50 / p90 mix s |
| --- | --- | --- | --- | --- | --- | --- |
| tools (5-arm) | 14/124 | 0/120 | 3/118 [3] | 0.372 + 0 | 2,699 | 5.23 / 10.10 |
| eden (5-arm) | 76/106 | 2/117 [2] | 1/118 [1] | 0.400 + 0 | 2,278 | 3.80 / 9.74 |
| dd (5-arm) | 78/110 | 2/105 [2] | 0/129 | 0.399 | 2,179 | 3.69 / 9.05 |
| k3 (5-arm) | 94/130 | 5/125 [5] | 2/108 [1] | 0.416 | 2,118 | 3.94 / 9.45 |
| b200 (5-arm) | 72/117 | 1/108 [1] | 1/111 [1] | 0.418 | 2,217 | 3.80 / 8.36 |
| eden (clean) | 101/144 | 4/144 [4] | 1/144 [1] | 0.421 + 0 | 2,193 | 3.40 / 5.71 |
| k3 (clean) | 99/144 | 4/144 [4] | 1/144 [1] | 0.418 | 2,131 | 3.57 / 6.23 |

(Eden's per-task spend is $0 in every Eden arm: no reader call. Cards were replayed; the few made live count as
one-time, $0.0005–0.0026 a user.)

### Long horizon (eight days a user, Eden kept, the agent's transcript reset daily)

Cost here is `pi-cost-report.ts`'s steady state (the run's tasks, close to 1:1:8). The paired rows below use
`arms.py`, which spreads background over Eden runs differently: k3 − eden is −0.024 from this table, −0.029 paired.

| Arm (run) | Hidden | Control | Neutral | Mix steady $/1k: agent + Eden + bg | Agent in tokens, neutral | Wall p50 / p90 mix s |
| --- | --- | --- | --- | --- | --- | --- |
| tools | 2/23 | 0/23 | 2/186 [1] | 0.307 + 0 + 0 = 0.307 | 7,448 | 2.77 / 4.89 |
| eden | 15/23 | 1/23 [1] | 1/186 [1] | 0.326 + 0 + 0.006 = 0.332 | 7,099 | 2.62 / 3.68 |
| dd | 14/23 | 1/23 [0] | 5/186 [4] | 0.324 + 0 + 0.001 = 0.324 | 6,807 | 2.68 / 3.84 |
| k3 | 13/23 | 0/23 | 6/186 [2] | 0.297 + 0 + 0.010 = 0.308 | 6,156 | 2.51 / 3.79 |
| b200 | 10/23 | 1/23 [1] | 2/186 [1] | 0.315 + 0 + 0.003 = 0.317 | 6,552 | 2.67 / 3.66 |
| eden (second run) | 16/23 | 1/23 [1] | 2/186 [2] | 0.323 + 0 + 0.011 = 0.333 | 7,138 | 2.64 / 3.76 |
| late (second run) | 13/23 | 1/23 [0] | 2/186 [2] | 0.315 + 0 + 0.010 = 0.325 | 6,628 | 2.51 / 3.90 |

### Paired differences (bootstrap 95%, `*` excludes zero)

Mix pairs from `arms.py` (1:1:8; $/1k agent + Eden + the run's background spread over its Eden runs); hidden and
concerns pooled by task over the runs named (`pooled.py`, `pooled.txt`).

k3 and b200 had `pushCandidateDedup` on too; their rows against `dd` isolate k and the excerpt size.

| Pair | Horizon (runs) | $/1k mix | Wall mean s, mix | Hidden (points) | Concerns ctl+neu, regraded |
| --- | --- | --- | --- | --- | --- |
| k3 − eden | short, clean | −0.003 (−0.019..+0.014) | **+0.26 (+0.04..+0.50)\*** | −1.4 (−9.0..+6.2) | 0.0 (−1.7..+1.7) |
| k3 − eden | short, 5-arm | +0.023 (−0.005..+0.050) | −0.05 (−1.31..+1.24) | | |
| k3 − eden | long | **−0.029 (−0.038..−0.020)\*** | −0.08 (−0.19..+0.04) | | |
| k3 − eden | all six runs | | | −3.0 (−9.0..+3.0) | +0.3 (−0.8..+1.4) |
| k3 − dd | short + long, 5-arm | | | −1.6 (−9.6..+5.6) | +0.2 (−1.2..+2.0) |
| late − eden | long, second run | −0.008 (−0.017..+0.002) | −0.02 (−0.12..+0.08) | −13.0 (−26.1..0.0) | −0.5 (−2.4..+1.0) |
| b200 − eden | short, 5-arm | **+0.025 (+0.001..+0.050)\*** | −0.16 (−1.55..+1.27) | | |
| b200 − eden | long | **−0.012 (−0.021..−0.002)\*** | +0.01 (−0.10..+0.11) | | |
| b200 − eden | short + long | | | **−12.8 (−20.5..−5.1)\*** | −0.2 (−1.7..+1.2) |
| b200 − dd | short + long | | | **−10.7 (−18.0..−3.3)\*** | −0.5 (−1.9..+1.0) |
| dd − eden | short, 5-arm | +0.002 (−0.025..+0.028) | −0.01 (−1.71..+1.69) | | |
| dd − eden | long | −0.003 (−0.013..+0.008) | +0.05 (−0.05..+0.15) | | |
| dd − eden | short + long | | | −2.5 (−10.2..+5.1) | +0.2 (−1.2..+1.7) |
| eden − tools | short, 5-arm | +0.027 (−0.004..+0.059) | −1.22 (−3.39..+1.01) | | |
| eden − tools | long | **+0.025 (+0.004..+0.045)\*** | −0.10 (−0.30..+0.11) | | |
| eden − tools | short + long | | | **+61.2 (+51.2..+70.2)\*** | +0.2 (−1.2..+1.6) |
| k3 − tools | long | −0.005 (−0.025..+0.016) | −0.18 (−0.39..+0.04) | | |

Per kind, clean short pair, k3 − eden: hidden −$0.033/1k (−0.053..−0.012)\*, control −$0.049 (−0.072..−0.026)\*,
neutral **+$0.007 (−0.014..+0.027)** with +0.062 model turns a task (−0.007..+0.132) and wall +0.32 s
(+0.04..+0.61)\*: the three tail items a nothing-to-add task loses send the agent to `ask_context` (asks a task 0.906
→ 1.002 on the mix). Neutral is 8 of 10 tasks on the assumed traffic, so the mix does not move.

Concerns read: k3's five short control concerns in the five-arm run are the agent reporting a look-alike approval
as met (`restricted-datastore-grant` twice, `month-end-change-freeze`), the known `commitment-already-purchased`
overlap, and one wrong-person hedge (`mum-no-ibuprofen`: an aunt's blood thinner raised for the user's mum); in the
clean pair both arms have 4 control and 1 neutral concern, all kept by the regrade.

Eden against the agent alone here: on train with these arms, the default's 1:1:8 mix is $0.025/1k dearer than
`tools` on the long horizon (+0.004..+0.045), where RealUse-3's heldout16 run measured it $0.049 cheaper (two days of
16 there, eight days of 12–19 here); both are billed figures that move with what the cache holds.

### Eval

`bun run eval` (no model): identical to the base tree (precision 0.8276, recall 0.48, falseFireRate 0, 122 planned
lookups); only the latency fields differ. The engine on this branch is the base tree's: nothing to re-run live.

## 4. Decisions

- **D258:** the excerpt size for candidates (`pushCandidateBytes`, measured with the no-repeat switch on), not
  repeating an item within a request
  (`pushCandidateDedup`) and a score floor on the candidates are deleted with their code and tests (code in commit
  `f58aae41`).
- **D259:** `pushCandidates` stays 5: k 3 (measured with the no-repeat switch on) and `pushCandidatesLater` 3 are
  rejected (code in `f459db44`).
- **D260:** on Pi, Eden's billed cost above the agent alone on the short horizon is the cache-write premium on a
  ~565-token prefix that was not cached across tasks in these runs (why is not established), not the packet's
  bytes. No engine change. The lab quotes the cache split (`cache.py`) beside billed figures in cost comparisons on
  Pi, and its counterfactual only as a counterfactual.

## Reproduce

On `f58aae41` (the D258 switches) for the five-arm runs and the screen, on `f459db44` for `late`:

```bash
cat packages/sim/lab/cards/cards-{v2,train,train-4344}.jsonl > .local/cl8/cards-all.jsonl
bun run funnel --suite train --seeds 41,42 --set '{"pushCandidateBytes":120}' --json .local/cl8/f-b120.json \
  -- --neutral --packets .local/cl8/f-b120.packets.jsonl            # and each arm of funnel-screen.txt
python3 -I packages/sim/lab/cl8/screen/{bytes,keep}.py ...; python3 -I packages/sim/lab/cl8/screen/dups.py ...
L=packages/sim/lab/cl8/run.sh; A=tools,eden,eden~dd,eden~k3,eden~b200
$L cl8-short-pay-41 payload $A --seeds 41 --variants hidden,control,neutral --limit 12 --budget 0.45   # and 42
$L cl8-long-pay-41 payload $A --seeds 41 --days 8 --budget 0.3                  # 42: --budget 0.35, run alone
$L cl8-short2-pay-41 payload eden,eden~k3 --seeds 41 --variants hidden,control,neutral --limit 12 --budget 0.3
$L cl8-long2-pay-41 payload eden,eden~late --seeds 41 --days 8 --budget 0.18    # and 42 for each
R=.local/cl8/runs; O=packages/sim/lab/cl8
python3 -I packages/sim/lab/cl7/arms.py --arms tools,eden,eden~dd,eden~k3,eden~b200 $R/cl8-short-pay-4{1,2}
bun packages/sim/src/lab/pi-cost-report.ts $R/cl8-long-pay-4{1,2}.json; bun packages/sim/src/lab/pi-ab-report.ts ...
python3 -I $O/cache.py --prefix 565 $R/cl8-short2-pay-4{1,2}
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results $R/cl8-short-pay-41.json \
  --graders claude-haiku-5-5 --only-concerns --spend-ledger .local/cl8/ledger.jsonl --spend-cap 2.5 \
  --spend-headroom 0.1 --run-label cl8-regrade-short-pay-41 --out $R/regrade-short-pay-41.json
python3 -I $O/pooled.py eden~k3 eden $R/cl8-short-pay-4{1,2} $R/cl8-short2-pay-4{1,2} $R/cl8-long-pay-4{1,2}
python3 -I $O/concerns.py $R/regrade-*.json
```

## Spend (`spend.txt`, ledger `.local/cl8/ledger.jsonl`)

| What | $ |
| --- | --- |
| short, five arms, seeds 41–42 (partial: budget stops) | 0.846 |
| long, five arms, users 41–42 | 0.498 |
| short, eden and k3, seeds 41–42 | 0.430 |
| long, eden and late, users 41–42 | 0.206 |
| concern regrades (Haiku) | 0.004 |
| **Total** | **1.983** |

## Caveats

- Train only, seeds 41–42 (the seeds CL6 chose k on). heldout14–16 were not run.
- The five-arm short run is partial (budget stops) and its wall times carry 358 rate-limit retries; its cost and
  quality pairs are by task over what both arms finished.
- The long horizon's hidden and control rates rest on 23 tasks of each a run.
- The cache finding is about Pi's minimal agent on Haiku 5.5 through Anthropic's API: what was cached is observed (a
  ~565-token prefix not across tasks, an 867-token one yes), its cause is not (the stated minimum may be 512). Where an
  agent's fixed prefix is cached, the packet costs its own tokens, written once and read cheaply after.
- Billed figures move with cache hits between runs, including hits from another arm sending the same prompt (454 of
  Eden's first requests): compare arms within a run.
