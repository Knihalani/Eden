# G3: agent + Eden no dearer than the agent alone

Status: 2026-11-12, session G3, **closed: D1500 (finding; no lever passes, no engine change)**. Tuning suites only
(dev20, train); heldout20 is never read or run. No paid API: every model answer is **served by subagents (D1101)**,
and every $ and second is **[EST]** (the queue's request and answer sizes at four characters a token, Haiku 5.5 list
prices, an agent call's prompt before its last message and the check's fixed instructions read from cache on 90% of
calls; a call waits 596 ms + 2.93 ms an output token, H3's fit).

## 1. The bar (the owner's, through the integrator, 10:34 UTC; committed in dda46d36 before any run was read)

Measured in the multi-turn Pi harness (`packages/sim/lab/g3/run.sh`: F6's step 2b with several arms, one pi-ab
process an arm) on dev20 at 40 tasks a world, read by `packages/sim/lab/g3/report.py`:

- agent + Eden $ per 1,000 tasks is **at most the agent alone's** on first-party pricing at the lab's short Pi
  prompt, on Composio pricing ($0.30 per 1,000 connector calls), and at production prompt size (+10,000 and +30,000
  cached tokens a call);
- hidden raised falls by at most 0.5 points against the default;
- decoys handed and concerns (control and neutral) are not up against the default.

A lever that passes all of it is promoted; partial passes do not ship. Anything that trades a guard for cost is
reported as a trade, never taken silently.

## 2. What the pool looks like, at $0 (before any model run)

Dumps made on main 6e4bfb79 (before the rule sheet, D1180), no model call: every check fails open on an empty replay
cache.

```bash
bun run funnel --suite dev20 --seeds 41,42 --jobs 1 --allow-misses -- --neutral --check replay \
  --check-cache EMPTY --check-dump pools-dev20.jsonl          # and --suite train
python3 -I packages/sim/lab/g3/pool-rank.py pools-dev20.jsonl pools-train.jsonl
bun run funnel --suite dev20 --seeds 41,42 --jobs 1 --allow-misses --no-ask -- --neutral --check replay \
  --check-cache EMPTY --pool-dump pooldump-dev20.jsonl
python3 -I packages/sim/lab/g3/pool-like.py pooldump-dev20.jsonl
```

| | dev20 (661 checks) | train (1,134 checks) |
| --- | ---: | ---: |
| hidden checks with the planted fact in the pool | 156 of 224 | 339 of 380 |
| planted fact at rank 1 / within 5 / within 7 / within 10 | 49% / 82% / 89% / 95% | 56% / 91% / 94% / 97% |
| items read a check | 14.1 | 14.7 |
| items repeating an earlier item's source and title | 23.2% (5 of them the planted item) | 17.4% (2) |
| items repeating its shown text too | 6.1% (none planted) | 5.3% (none planted) |

On dev20, of the planted facts in a checked pool's first 15, 112 are constraint-like and 43 are not, and 67 name one
of the request's anchors while 88 do not. A checked pool holds 7.3 constraint-like items of 14.3 on hidden tasks
(6.4 on control, 6.0 on neutral).

What that rules out, before spending a model call:

- **A shorter pool.** Each rank past 7 still holds about 1% of the in-pool facts on dev20, so a cap of 10 loses 5%
  of them and a cap of 7 loses 11%. D1073's cap of 10 lost nothing on train because train's facts sit higher.
- **A pool of constraint-like items only.** 28% of dev20's in-pool facts are not constraint-like (D528 found the
  same shape saved only 14% of input on train).
- **Dropping same-titled copies.** On dev20 five of those copies are the planted item itself (a reply in the same
  thread). Only exact repeats of the shown text are safe to drop, and they are 6% of the pool.
- **A gate on the request's anchors** (D534's shape). 57% of dev20's in-pool facts name none of them: dev20 is built
  on indirect and non-English requests, where word matching fails.

These agree with the measured dead ends: pre-screens (D930), lexical pool cuts (D258, D273, D1050), the CPU skip
(D1270, D1272), the de-duplicated pool of ten (D1073, D1074).

## 3. The four arms (pre-registered in 556e6a73, report only; the bar in dda46d36)

dev20 seed 41, hidden, control and neutral, 40 tasks a world: 480 tasks an arm. Haiku-model subagents for the agent
and the check, Sonnet-model subagents for the grader, `--tenant-prompt`, `--push payload`, the `direct` profile at time
scale 1, shipped coverage, `--split 8`, the check's and the observe's waits lifted for the queue (0 checks landed
after the agent's first model call in any arm). Tree: main 1cac8a47 with F11's branch merged for `pushLookup`
(claude/g3-cost bd4713e2), so **with the rule sheet (D1180) and before the harness fix of D1155 (#315)**: F1 reports
that fix moves Eden-arm levels on this suite (hidden raised 43 → 77 on its run), so read the Eden arms' levels as
pre-fix and the differences between Eden arms as the finding. The run was not repeated on the fixed harness: the
account's subagent allowance was reserved for the final.

Arms: `raw` (the agent alone, `tools`), `D` (the default, `both+ask`), `LK` (F11's D1252: `pushLookup` 3,
`pushLookupAny`, `pushLookupQuiet`), `NC` (default minus the push check: the unchecked candidates of D237).

```bash
PREFIX=r2 LIMIT=40 SEEDS=41 ARMS="raw D LK NC" bash packages/sim/lab/g3/run.sh   # the session drives the queue
python3 -I packages/sim/lab/g3/report.py .local/g3/r2 --base D
```

| | raw | D (default) | LK | NC |
| --- | ---: | ---: | ---: | ---: |
| hidden raised (of 160) | 17 | 66 | 62 | 54 |
| look-alike handed, control (of 160) | 0 | 20 | 39 (25 in lookup packets) | 45 |
| concerns, control / neutral (of 160 each; the run's grader, not regraded) | 1 / 20 | 2 / 32 | 4 / 38 | 3 / 38 |
| agent model calls a task | 1.94 | 1.63 | 1.52 | 1.47 |
| agent connector calls a task | 1.30 | 0.80 | 0.66 | 0.59 |
| check calls a task | 0 | 0.69 | 0.69 | 0 |
| agent $ per 1,000 tasks: cached prefix / last message / output | 0.064 / 0.010 / 0.057 | 0.059 / 0.009 / 0.053 | 0.057 / 0.007 / 0.052 | 0.057 / 0.007 / 0.053 |
| agent $ per 1,000 tasks | 0.131 | 0.120 | 0.116 | 0.117 |
| check $ per 1,000 tasks, its sheet read from cache | 0 | 0.113 | 0.113 | 0 |
| check $ per 1,000 tasks, its sheet written on every call | 0 | 0.288 | 0.288 | 0 |
| **total, first-party, short prompt** | **0.131** | **0.233** | **0.228** | **0.117** |
| **total, Composio** (the agent's calls; Eden's own were not captured) | **0.520** | **0.472** | **0.426** | **0.292** |
| **total, prompt +10,000 tokens** | **0.548** | **0.583** | **0.555** | **0.433** |
| **total, prompt +30,000 tokens** | **1.381** | **1.284** | **1.209** | **1.067** |
| extra prompt tokens at which the arm equals raw | | 15,400 | 10,900 | 0 |
| wait a task (model calls, the check, measured searches) | 2.13 s | 2.10 s | 1.96 s | 1.57 s |

Paired differences (template-clustered 95% intervals, 480 tasks; 160 for hidden and for the look-alike):

| | D − raw | LK − raw | LK − D | NC − D |
| --- | --- | --- | --- | --- |
| hidden raised, points | +30.6 (+21.9..+38.8) | +28.1 (+20.0..+36.3) | −2.5 (−6.3..+1.3) | −7.5 (−13.1..−1.9) |
| look-alike handed, points | +12.5 (+7.5..+17.5) | +24.4 (+18.1..+31.3) | +11.9 (+6.9..+17.5) | +15.6 (+9.4..+21.9) |
| concerns, points | +4.1 (+0.3..+7.8) | +6.6 (+2.8..+10.3) | +2.5 (−0.6..+5.9) | +2.2 (−1.6..+5.9) |
| agent model calls a task | −0.31 (−0.38..−0.23) | −0.42 (−0.50..−0.34) | −0.11 (−0.16..−0.06) | −0.16 (−0.21..−0.10) |
| total $, short prompt | +0.102 (+0.089..+0.113) | +0.097 (+0.085..+0.109) | −0.004 (−0.008..−0.000) | −0.116 (−0.128..−0.104) |
| total $, Composio | −0.049 (−0.092..−0.004) | −0.094 (−0.140..−0.048) | −0.046 (−0.075..−0.018) | −0.179 (−0.214..−0.145) |
| total $, prompt +10,000 | +0.036 (+0.015..+0.058) | +0.008 (−0.014..+0.030) | −0.028 (−0.043..−0.013) | −0.150 (−0.171..−0.128) |
| total $, prompt +30,000 | −0.097 (−0.148..−0.044) | −0.171 (−0.225..−0.117) | −0.074 (−0.112..−0.037) | −0.217 (−0.261..−0.174) |
| wait, s | −0.04 (−0.16..+0.09) | −0.17 (−0.29..−0.05) | −0.14 (−0.21..−0.06) | −0.53 (−0.65..−0.40) |

## 4. Reading it against the bar

- **The default** is cheaper than the agent alone on Composio and at +30,000 prompt tokens, dearer at the short
  prompt (+$0.102 per 1,000 tasks) and at +10,000. It equals the agent alone at about 15,400 more prompt tokens.
- **`pushLookup`** (F11's) moves the break-even to about 10,900 tokens and is level at +10,000, but on dev20 it saves
  a third of what it saved on train (0.11 model calls a task against D), and it fails the guards against the default:
  its reference packets carry the look-alike on 25 control tasks the default kept it from, and hidden raised reads
  −2.5 points.
- **Default minus check** is the only arm at or below the agent alone on all three pricings, and 0.56 s a task
  faster. It fails hidden (−7.5 points against the default) and hands the look-alike on 45 control tasks against 20.
  It is the price of the cost target, not a lever. G2 confirms there is no no-model stand-in for the check (its
  funnel: the look-alike handed on 186 of 640 control tasks without the check, 37 with it).
- **No G3 lever passes, and none was built.** The agent's own bill falls by only $0.011–0.015 per 1,000 tasks with
  Eden at the short prompt: half of it is the cached prefix, which a saved call saves at a tenth of the input price,
  and the output is the same. The check costs $0.113 with its sheet read from cache. To match the agent alone at the
  short prompt the check would have to lose about 90% of its cost; §2 and the decisions it cites show no cut or skip
  of that size keeps the facts.
- **Where Eden already costs no more:** wherever a saved call is dear. That is a connector plan priced per call
  (Composio and dearer), or an agent whose cached prompt is about 11,000–15,000 tokens longer than the lab's 1,500.

## 5. The rule sheet's price (found on this run; F7 priced it, D1180's cost note)

The queue transport joins the rule sheet (D1180), a cached block of its own, to the check's request message, so a
pricer reading `size.messages` priced the sheet as uncached input: the check's message read about 3,300 characters
before the sheet and 10,900–13,000 with it (57 cards a sheet on this run). `batch.ts put` now keeps the sheet's
characters apart (`size.sheet`, #314), and report.py prices it read from cache and, for a user whose requests are
further apart than the cache's lifetime, written on every call (0.113 against 0.288 per 1,000 tasks above). F7's
`sheet-cache.py` and COST-MODEL hold the hit rates.

One cut left unbuilt: the sheet's fixed instructions (`SHEET_HEAD`, about 1,500 characters) open the per-user block,
so they are paid at the user's own cache rate; in the shared instructions every user's check would read them from
the common cache. About $0.015–0.03 per 1,000 tasks [EST: 384 tokens a check at the difference between the two
rates, 0.69 checks a task]. It changes the check's prompt, which subagents cannot judge (D1104), so it waits for the
API.

## 6. Driving notes

- One arm and role a take (`--single-arm`), or workers copy reply formats across arms (F7 §13).
- A sheeted check is about 13,000 characters, so a worker's context fills after two to four batches of eight: take
  four checks a batch (`--n 4 --role eden.check`) and expect to replace workers often.
- A worker that stops holding a batch does not release it: `batch.ts requeue --older-min 4` between rotations.
- Never leave the working tree mid-merge while workers run: a conflict marker in `batch.ts` stops every take and put.
- `CHECK_COLD=1 bun run check` needs `OPENROUTER_API_KEY` unset: with it set, six sim lab CLI tests fail on the lab
  guard (D818).
