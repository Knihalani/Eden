# H3: the push check, leaner

Status: 2026-11-11, branch `claude/h3-pushcheck-lean` (from main 793a4c47), session H3. Train only; heldout19 is
never read or run. Paid calls go to Anthropic directly with `HAIKU_API_KEY` through the lab's spend ledger
(`.local/h3/ledger.jsonl`, D97): **Anthropic-direct lab figures**. Cap $15. Numbers marked **[EST]** are arithmetic
or judgement; every other number comes from a command in this note.

Goal (the parent's brief): cut the push check's paid cost per 1,000 tasks, or its added latency, by at least 20%,
with quality held.

**Verdict: rejected (D1073).** Reading the pool less its same-titled copies, ten items at most
(`pushCheckDedupe` 10), cut the push check's cost per 1,000 tasks by 27% on Pi with the same call rate, and facts were
level at the point estimate, but the Sonnet-graded interval's lower bound (−2.3 points) missed the pre-registered
−1.5. The switch, its code and its tests are deleted (the code is in commit 7e528b60); the lab kit and the findings
stay. Anthropic $7.94 of the $15 cap. No Modal.

## 0. In plain words

- **The push check's latency is mostly fixed.** On 368 calls a call took about 600 ms plus 2.9 ms an output token
  (an empty reply still about 650 ms; time to first token about 450 ms whatever the reply). Cutting the reply only
  moves the smaller part (§3a).
- **Splitting the pool into two or three concurrent calls does not make the check faster** (p50 0.96 → 1.00–1.01 s)
  and costs 20–35% more. Dead (§3a).
- **A line reply instead of JSON made the reply longer, not shorter:** Haiku ignored the six-entry cap in that format
  and added prose. Dead before its screen (§3a).
- **What the check reads holds copies.** 15% of the items it read on train seed 42 repeat an earlier item's source and
  title (a recurring event's bookings, one thread's notices); the planted fact was never one of them. Dropping them,
  and reading ten items at most, cut $ a check by 25% on recorded pools with planted, look-alike and neutral answers
  level (§2).
- **On Pi it held the cost cut (−27%) but not the bar.** Hidden facts −0.4 points (−2.3..+1.5) by Sonnet's grade
  (+0.8, −1.1..+2.8 by Haiku's), confirmed concerns 3 → 0, wall −0.06 s. The pre-registered bar was a lower bound
  above −1.5 points, so it is deleted. A powered re-test (about 3× the pairs) is the parent's call (§4).

## 1. Pre-registration (committed before the screen's and the Pi pair's paid calls)

### 1a. The screen

Base: `bun run funnel --suite train --seeds 42 --jobs 1 -- --neutral --check live --check-dump base42.dump.jsonl`
(the shipped default, live Haiku 5.5 check; 563 recorded checks). `packages/sim/lab/h3/split-screen.ts` re-asks every
recorded pool live under each arm, the arms interleaved row by row in the same lanes:

- **W**: the shipped check (15 items of 200 characters).
- **D**: the 15 less any item whose source and title (case folded) an earlier item already has (`pushCheckDedupe`).
- **D12, D11, D10**: D's first 12, 11 and 10 items.

**Rule.** The arm that reads fewest items among those that pass goes to Pi. An arm passes if its $ a check is at
most 0.80 of W's in the same run, and against W: planted named on hidden rows at least W − 4, the look-alike named
on control rows at most W + 4, and neutral rows given any yes at most W + 4. None passes: no Pi run, the switch and
its code are deleted, the findings kept.

### 1b. The Pi pair (only if an arm passes; its exact command is an addendum committed before its first call)

`pi-ab`, P3's recipe as M13's (`packages/sim/lab/m13/pi.sh`): Haiku 5.5 agent, grader, card, reader and check
models, cards replayed, `--tenant-prompt`, payload notices, the `direct` profile; `eden` against `eden~D` (the arm's
settings). **Bar:** hidden facts raised, template-clustered 95% lower bound above −1.5 points (Sonnet regrade of the
hidden answers if the Haiku grade's bound falls under it); Sonnet-confirmed concerns on control and neutral not up;
the check's $ per 1,000 tasks at least 20% lower (or its wait 20% lower) on the pair's own ledger. Pass: the arm's
settings join `DEFAULT_CONFIG` (D814). Fail: the switch, its code and tests are deleted.

## 2. The screen's result, and the Pi pair's addendum (before its first call)

**Screen** (`split-screen.ts`, base42's recorded pools re-asked live, 553 rows with a recorded answer: 189 hidden,
183 control, 181 neutral; five arms interleaved, 16 lanes; $0.000234 a check for W):

| Arm | $ a check (vs W) | Wall p50 / p90 s | Planted named | Look-alike named | Neutral with a yes | Items named | Unreadable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| W (shipped) | 0.000234 | 0.89 / 1.34 | 149 | 36 | 53 / 179 | 598 | 7 |
| D | 0.000204 (−12.8%) | 0.87 / 1.23 | 153 | 36 | 44 / 179 | 474 | 5 |
| D12 | 0.000194 (−17.1%) | 0.87 / 1.24 | 150 | 34 | 49 / 178 | 490 | 7 |
| D11 | 0.000184 (−21.4%) | 0.86 / 1.19 | 152 | **41** | 52 / 181 | 484 | 0 |
| D10 | **0.000175 (−25.2%)** | 0.86 / 1.21 | 151 | 35 | 52 / 180 | 452 | 7 |

D12 fails the cost clause (bar 0.000187), D11 the look-alike clause (41 against a ceiling of 40). **D10 passes**
every clause and goes to Pi as `pushCheckDedupe: 10`.

**Pi pair, exactly** (`packages/sim/lab/h3/pi.sh LABEL 10 …`, one process a run, two at a time, in this order):
`train` and `reworded` (`--suite train` / `--suite reworded`), seeds 41, 42, 43, 44 (`--seeds N`),
`--variants hidden,control,neutral`; 8 runs. Then `bun packages/sim/src/lab/i3-regrade.ts --results <the runs'
out.json> --conditions eden,eden~D --spend-ledger .local/h3/ledger.jsonl --spend-cap 15 --run-label h3-sonnet`, and
`python3 -I packages/sim/lab/p3/report.py --pair eden~D:eden --cluster template <run dirs>`. If the deadline (04:00
UTC) would cut the run, the pair is read on whole seeds (both suites) finished by 03:00 UTC, the rest unrun.

Read (§1b's bar): hidden raised (Sonnet), D − default, clustered lower bound > −1.5 points; Sonnet-confirmed concerns
(control and neutral) not up; the check's $ per 1,000 tasks from the pair's ledger (role `eden.check`, by arm) at
least 20% lower. Reported beside it: the check's p50 and p90, Eden's and the agent's $ per 1,000 tasks, wall, asks.

Amended before any result was read: pi-ab's per-process cap defaults to $0.60, about one run's cost (M13: $0.62–0.65
a run), so the first two runs were stopped after about 30 seconds and restarted with `--budget 1.2` (`pi.sh`); their
partial output was deleted unread.


## 3. Results

### 3a. Levers measured and stopped before the screen

**Latency fit** (`.local/h3/ledger.jsonl`, the first 368 check calls of this session, base42 and the smokes): a
least-squares line of latency on output tokens reads **596 ms + 2.93 ms an output token**; by output tokens 0–19 (64
calls) p50 647 ms, 20–59 779 ms, 60–119 821 ms, 120–199 1,057 ms, 200+ 1,332 ms; time to first token p50 433–458 ms
in every band. So a 20% cut of the check's wait needs about 63 fewer output tokens a call (of about 110–141): more
than any reply format kept compare-first could give (D822).

**Concurrent split** (`split-screen.ts --arms W,S2,S3`, 40 recorded pools, interleaved): W $0.000243 a check, p50 0.96
s, p90 1.34 s; S2 (two halves at once) $0.000292, 1.00 s, 1.52 s; S3 $0.000328, 1.01 s, 1.26 s. Planted named 28, 28,
27 of 32. Each call's fixed part does not shrink with its pool, and the push waits for the slowest. Stopped.

**Line reply** (the same instructions with the JSON replaced by `<n> | on | hits | yes or no` lines; built, smoked on
40 pools, deleted): $0.000248 a check against W's $0.000244, 8 of 40 replies unreadable, planted named 21 against 29.
Read by hand, Haiku listed every gym booking in a pool of them (433 output tokens), and once wrote a paragraph
correcting itself before its final lines. Stopped; not a screen arm.

**Rejected entries and a stop** (base42's 193 first replies): entries that are not a yes are 46% of the reply's
characters, but 5 of 94 named planted facts sit after the first such entry (a stop there keeps 80% of the characters).
D822's finding stands.

**Bulk mail in the check's input** (`candidatesOf` never hands a bulk item, yet the check reads them): 0 of 5,826
items read on base42 had a bulk title. Nothing to cut in the lab; not built.

### 3b. The Pi pair (§2's plan, run at 7bb06143 with `--budget 1.2`; 8 runs, 9,216 task runs, 0 ungraded)

| | `eden` | `eden~D` (`pushCheckDedupe` 10) |
| --- | --- | --- |
| Hidden raised, Sonnet | 1,081 / 1,536 (70.4%) | 1,075 / 1,536 (70.0%) |
| Hidden raised, Haiku | 1,080 (70.3%) | 1,093 (71.2%) |
| Planted handed at its request | 1,309 (85%) | 1,298 (85%) |
| Control concerns, Haiku; Sonnet-confirmed | 14; 3 | 17; 0 |
| Neutral concerns, Haiku; Sonnet-confirmed | 6; 0 | 8; 0 |
| Neutral given a packet; items a packet | 691 (45%); 2.2 | 675 (44%); 1.7 |
| Check calls a task | 0.961 | 0.961 |
| Check $ a call; input / output tokens | 0.000231; 2,738 / 129 | 0.000175; 2,255 / 113 |
| Check call p50 / p90 s | 0.86 / 1.30 | 0.83 / 1.17 |
| **Check $ per 1,000 tasks (1:1:8)** | **0.2058** | **0.1500 (−27.1%)** |

Paired (`report.py --pair eden~D:eden --cluster template`, 1,536 pairs, 384 template clusters): **hidden raised −0.4
points (−2.3..+1.5) by Sonnet**, +0.8 (−1.1..+2.8) by Haiku; both handed: raised 1,046 against 1,046. `n5/mix.py`
(1:1:8, 4,608 pairs): Eden $/1k −0.056 (−0.059..−0.052) on a base of 0.206, agent $/1k −0.002 (−0.006..+0.003), total
−0.057 (−0.063..−0.052) on 0.487, wall −0.059 s (−0.087..−0.031) on 3.16 s, agent turns −0.002, tools −0.009.

**Against the bar:** cost −27.1% (bar −20%): pass. Confirmed concerns 3 → 0: pass. Hidden lower bound −2.3 (bar
> −1.5): **fail**. The half-width was 1.9 points: a change with no effect passes this bar only when its estimate lands
above +0.4 [EST]. No seed was added after the result was read.

## 4. Decisions and what is left

- **D1072 (finding):** the check's wait is mostly fixed; split calls and a line reply do not cut it (§3a).
- **D1073 (rejected):** `pushCheckDedupe` stopped on its Pi clause; deleted with its code and tests (commit
  7e528b60 holds them). The trial was opened and closed in this session, so the trials table keeps no row.
- **For the parent:** the cost cut is real and large (−$0.056 per 1,000 tasks on the mix, −27% of the check), facts
  are level at the estimate and concerns did not rise, but this run cannot rule out a 2-point loss. A re-test powered
  for the margin (seeds 41–52 on train and reworded, about 3× the pairs, about $15 with the regrade [EST]) would
  decide it; it needs a fresh pre-registration. Two cheaper variants were in the screen: D (copies out, 15 at most)
  cut 12.8% and D12 17.1%, under this brief's 20%.

## 5. Reproduce

```bash
unset OPENROUTER_API_KEY; L="--spend-ledger .local/h3/ledger.jsonl --spend-cap 15 --spend-headroom 0.2"
bun run funnel --suite train --seeds 42 --jobs 1 --json base42.json -- --neutral --check live \
  --check-cache check-cache.jsonl --check-dump base42.dump.jsonl $L --run-label base42
bun packages/sim/lab/h3/split-screen.ts --lanes 16 --arms W,D,D12,D11,D10 --out screen.jsonl $L base42.dump.jsonl
# the Pi pair needs the switch: check out 7e528b60's packages/engine first
packages/sim/lab/h3/pi.sh h3-train-41 10 --suite train --seeds 41 --variants hidden,control,neutral  # … reworded, 42–44
bun packages/sim/src/lab/i3-regrade.ts --results <8 out.json> --conditions eden,eden~D $L --run-label h3-sonnet
python3 -I packages/sim/lab/p3/report.py --pair eden~D:eden --cluster template .local/h3/pi/h3-*
python3 -I packages/sim/lab/h3/checks.py .local/h3/pi/h3-*
python3 -I packages/sim/lab/n5/mix.py --base eden --arms 'eden~D' .local/h3/pi/*/out.json
```

## 6. The powered re-test (the parent's call after D1073; pre-registered here, before any of its paid calls)

The parent asked for one more clean read of `pushCheckDedupe` 10 on fresh seeds at about 3× the hidden pairs, cap
$16 more ($24 in all on `.local/h3/ledger.jsonl`). The trial is restored from 7e528b60 onto main b3d8edc4 (off at 0,
a row in the trials table).

**Runs** (`packages/sim/lab/h3/pi.sh LABEL 10 --suite S --seeds N --variants V`, two processes at a time, in this
order): seeds 45, 46, 47, 48 on `train` and `reworded` with `--variants hidden,control,neutral` (8 runs: 1,536
hidden, 1,536 control and 1,536 neutral pairs); then seeds 49–56 on `train` and `reworded` with `--variants hidden`
(16 runs: 3,072 more hidden pairs). In all 4,608 hidden pairs, 3× the first pair's 1,536 within the cap (hidden-only
runs cost about a third of a full one). **The 41–44 pairs are not pooled in.**

**Grading:** `i3-regrade.ts` (Sonnet 5.5, Message Batches) on every hidden answer and every concern the Haiku grader
flagged, of both arms, in batches small enough for the ledger's worst-case reservation.

**Rule:** `report.py --pair eden~D:eden --cluster template` over the 24 run dirs. **Pass** if the Sonnet-graded hidden
raised difference has its template-clustered 95% lower bound above −1.5 points **and** Sonnet-confirmed concerns
(control and neutral, seeds 45–48) are not up (`eden~D` ≤ `eden`). Pass: `pushCheckDedupe` 10 joins `DEFAULT_CONFIG`
(D814; default switches 74 → 75; full gates; the reviewer once on the engine diff). Fail: the switch is deleted again.
The check's $ per 1,000 tasks and its p50 and p90 are reported from the full runs (`checks.py`, `n5/mix.py`). If the
deadline would cut the runs, the pair is read on the runs finished by 03:15 UTC (whole seeds, both suites), the rest
unrun; no seed is added after a result is read.
