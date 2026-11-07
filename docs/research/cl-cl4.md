# CL4: Eden's push and ask path, measured for latency and cost

Status: 2026-11-07, branch `claude/cl4-path-latency` (from `claude/lucid-hypatia-v9wqk5` at `2c65a6f9a`). Session
CL4 of the cost-and-latency wave ([cost-latency-plan.md](cost-latency-plan.md), hypotheses H8–H13), decisions
D246–D250. Every paid call went to the Anthropic API with `HAIKU_API_KEY`, `claude-haiku-5-5` in every role (agent,
grader, cards, intent, reader), through the lab provider (D97), with `OPENROUTER_API_KEY` unset, on one spend ledger
capped at $3: **Anthropic-direct lab figures**. Spent: **$2.281**.

## In plain words

- **Where Eden's time goes on Pi.** Two pieces, about 1 s each. The observe on the user's message waits for the
  reader's reading of the request (p50 about 1.0–1.1 s; 1.15–1.40 s per task with a reading, 3–240 ms without one).
  Each `ask_context` takes about 1.4–1.6 s, and **almost all of it is connector re-reads**, not search or the reader:
  every ask re-reads 4–5 of the items it cites, because a change notice (`--push signals`) has put their whole source
  in doubt and D211 does not let an ask cite a doubted copy unread. Search is under 0.3 s and the reader under 0.3 s
  of an ask (it reuses the push's reading, D193).
- **With payload notices the ask's re-reads disappear.** The same neutral tasks with `--push payload` (the notice
  carries the changed items, D210's documented integration) took 0.19 s per ask instead of 1.59 s, Eden's path fell
  from 2.3 s to 0.83 s a task, and connector calls from 8.3 to 0.6 a task (one seed, a separate run, not paired). The
  lab's `signals` setting is the slow case; the ask path itself is fast.
- **Five levers were tried; one survives as a trial.**
  - **H8, "nothing found" (`pushChecked`, D246), survives as a trial switch, off.** When the push read the request and
    flagged nothing, the agent gets one line in the data envelope saying Eden read the user's sources for this request
    and nothing in them bears on it. Over a day of requests it saved the agent a turn on look-alike tasks: control
    wall −0.74 s (−1.18..−0.29) and −$0.068 per 1,000 tasks (−0.112..−0.023), asks 0.75 → 0.31 a task. One request
    per session it did nothing measurable, and the agent still asks for information it needs on neutral tasks (1.25 →
    1.11 asks). Pooled over three paired runs, hidden facts raised −4.2 points (−10.4..+2.1, not significant) and
    false concerns on look-alikes −2.6 points (−5.2..−0.5). The combine stage should measure it with more hidden
    tasks before promoting it.
  - **H13, a closing line on the push's packet (`pushCovered`, D250): deleted.** Nothing measurable on its own.
  - **H9, the ask answering from the push's search (`askFromPush`, D247): deleted.** The ask's search was already
    0.1–0.3 s, and ranking without it changed a few ask pools (6 new reader prompts in the replay), so it bought no
    time and a few more reader calls; $0 screen identical (313/127).
  - **Own lever, re-reading ahead after the push (`pushVerifyAhead`, D249): deleted.** Each ask got about 0.25 s
    faster, but the agent's question ranks other items than the push did, so asks still re-read about 4 items, and
    every task paid 1.5 more connector calls (+1.49, +0.79..+2.30, mix) with no significant wall change.
  - **H10, not waiting for the push (speculation, D248): deleted.** The agent's first model request goes out at once
    and is re-sent with the packet if one lands. Eden's path fell by 1.0 s in the mix, but wall time did not
    (−0.14 s, −0.52..+0.28): about half the first calls were re-sent, and those re-sent cost +$0.058/1k. Re-sending
    only when the first call ended with an answer was worse: without a packet the agent calls `ask_context` first (hidden
    asks 0.50 → 1.61 a task), +$0.118/1k and hidden wall +1.1 s. D98 and D191 again: the packet before the first call
    is what keeps the agent from asking.
  - **H11/H12 (start earlier, adaptive wait): nothing to build.** The server already replies when its work is done:
    without a reading coming the observe returned at p50 3–240 ms, p90 0.7–1.1 s (its own lookup), never near the
    client's 3,000 ms cap. Starting the push on a typing event needs drafts no harness sends (not tried).
- **Against the agent alone.** Eden still costs more than `tools` per task in every arm here (short mix +$0.26/1k,
  +0.22..+0.31; the agent itself is cheaper with Eden, $0.338 against $0.365, but the reader adds $0.23). Nothing in
  the push and ask path closes that gap: it is the reader's per-task cost (CL1, CL2).

## 1. Runs

All Pi (`@earendil-works/pi-agent-core@1.3.0`), `--source-profile .../market-profiles/direct.json --push signals`,
time scale 1, default wait, parallel tools, through `packages/sim/lab/cl4/run.sh` (the shape of fix-s3b and
realuse-2's Pi commands; cards from `cards-train.jsonl`/`cards-v2.jsonl` plus each run's live top-up). Train suites
for every decision; heldout14 (read before, RealUse-1) only for the cost and latency of neutral turns, never to tune.

| run | suites, seeds | horizon | arms | n per kind | $ |
| --- | --- | --- | --- | --- | --- |
| `m-train41` | train1–6, seed 41, first 16 templates | short | tools, eden, eden~note, eden~path, eden~path+spec | 96 | 0.592 |
| `m-h14n41`, `m-h14n42` | heldout14 neutral, 41, 42 | short | the same | 64 | 0.218 |
| `s2-train41` | train1–6, 41, first 12 | short | eden, eden+specend, eden~note+specend | 72 | 0.325 |
| `s2-h14n41` | heldout14 neutral, 41 | short | the same | 32 | 0.069 |
| `d-train42` | train1–6, 42, first 8, `--day 4` | long | tools, eden, eden~note, eden~note+specend | 48 | 0.343 |
| `d-h14n41` | heldout14 neutral, 41, `--day 4` | long | the same | 32 | 0.080 |
| `d2-train41` | train1–6, 41, first 8, `--day 4` | long | eden, eden+pushChecked, eden+pushCovered, eden~note | 48 | 0.300 |
| `p-h14n41` | heldout14 neutral, 41, `--push payload` | short | eden | 32 | 0.020 |

`note` = `pushChecked` + `pushCovered`; `path` = `askFromPush` + `pushVerifyAhead`; `+spec`/`+specend` were pi-ab
harness flags (speculation, deleted with D248). Screens and smokes: $0.334 (n = 24/16, not quoted). 0 errors and 0
ungraded in every run.

## 2. Short horizon (one request per session)

`packages/sim/lab/cl4/m-arms.txt` (`arms.py`): rate = hidden raised, false concern (control), any concern (neutral);
all-in $/1k = agent + Eden per task + background cards spread over the file's Eden runs; Eden path = the union of the
observe and every `ask_context` on the critical path. Hidden and control: train seed 41; neutral: heldout14 41–42.

| arm | kind | rate | wall p50/p90/mean s | all-in $/1k | Eden path ms (observe, ask) | turns | asks | reader | conn |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tools | hidden | 0.146 | 5.13 / 7.41 / 5.18 | 0.394 | 0 | 2.20 | 0 | 0 | 3.39 |
| tools | control | 0.010 | 4.90 / 7.38 / 5.05 | 0.391 | 0 | 2.18 | 0 | 0 | 3.36 |
| tools | neutral | 0.000 | 5.17 / 7.51 / 4.99 | 0.359 | 0 | 2.12 | 0 | 0 | 3.27 |
| eden | hidden | 0.708 | 4.35 / 7.24 / 4.80 | 0.518 | 1,831 (1,398, 433) | 1.25 | 0.40 | 0.91 | 5.70 |
| eden | control | 0.010 | 5.83 / 7.77 / 5.45 | 0.598 | 2,091 (1,147, 944) | 1.59 | 1.02 | 0.98 | 6.91 |
| eden | neutral | 0.047 | 5.80 / 7.98 / 5.69 | 0.646 | 2,295 (894, 1,400) | 1.78 | 1.25 | 0.89 | 8.33 |
| eden~note | hidden | 0.688 | 4.38 / 7.29 / 4.86 | 0.550 | 1,964 (1,490, 475) | 1.25 | 0.41 | 0.94 | 5.60 |
| eden~note | control | 0.000 | 5.21 / 7.71 / 5.25 | 0.580 | 2,003 (1,203, 800) | 1.50 | 0.82 | 0.96 | 6.31 |
| eden~note | neutral | 0.000 | 5.65 / 7.84 / 5.59 | 0.649 | 2,180 (890, 1,289) | 1.73 | 1.11 | 0.91 | 7.73 |
| eden~path | hidden | 0.688 | 4.30 / 7.67 / 4.92 | 0.560 | 1,931 (1,463, 468) | 1.29 | 0.50 | 0.95 | 7.67 |
| eden~path | control | 0.010 | 5.70 / 7.56 / 5.40 | 0.625 | 2,049 (1,149, 900) | 1.66 | 1.05 | 1.04 | 8.23 |
| eden~path | neutral | 0.016 | 5.70 / 7.48 / 5.59 | 0.682 | 2,165 (850, 1,315) | 1.84 | 1.30 | 0.95 | 9.78 |
| eden~path+spec | hidden | 0.719 | 4.39 / 7.28 / 4.78 | 0.616 | 362 (2, 360) | 2.15 | 0.42 | 0.93 | 7.54 |
| eden~path+spec | control | 0.000 | 4.93 / 7.27 / 5.04 | 0.641 | 734 (2, 732) | 2.29 | 1.01 | 1.00 | 7.72 |
| eden~path+spec | neutral | 0.016 | 5.54 / 7.79 / 5.56 | 0.700 | 1,389 (2, 1,386) | 2.34 | 1.31 | 0.97 | 9.95 |

Mix (1 hidden : 1 control : 8 neutral, an assumption; each kind resampled on its own, 5,000 draws):

| pair | raised | wrong | all-in $/1k | wall mean s | Eden path ms | conn |
| --- | --- | --- | --- | --- | --- | --- |
| eden − tools | **+0.056 (+0.046..+0.067)** | +0.038 (+0.000..+0.086) | **+0.263 (+0.219..+0.307)** | **+0.56 (+0.09..+1.02)** | **+2,228** | **+4.64** |
| eden~note − eden | −0.002 (−0.009..+0.005) | **−0.039 (−0.080..−0.001)** | +0.004 (−0.030..+0.038) | −0.09 (−0.42..+0.24) | −87 (−280..+98) | −0.54 (−1.18..+0.08) |
| eden~path − eden | −0.002 (−0.010..+0.006) | −0.025 (−0.076..+0.024) | **+0.036 (+0.000..+0.075)** | −0.07 (−0.40..+0.27) | −98 (−310..+113) | **+1.49 (+0.79..+2.30)** |
| eden~path+spec − eden | +0.001 (−0.005..+0.007) | −0.026 (−0.076..+0.023) | **+0.058 (+0.022..+0.098)** | −0.14 (−0.52..+0.28) | **−1,007 (−1,272..−726)** | **+1.57 (+0.80..+2.38)** |

Restart-at-the-end speculation (`s2-arms.txt`, train 41 n = 72 and heldout14 neutral 41 n = 32): eden+specend − eden
mix $/1k **+0.118 (+0.055..+0.183)**, wall +0.05 (−0.37..+0.53); hidden asks 0.50 → 1.61, hidden wall **+1.14 s
(+0.64..+1.65)**.

## 3. Long horizon (`--day 4`: four requests and a recap per agent session)

`d-arms.txt` (train 42, heldout14 neutral 41) and `d2-arms.txt` (train 41).

| arm | kind | rate | wall p50/p90/mean s | all-in $/1k | Eden path ms (observe, ask) | turns | asks | reader | conn |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tools (d) | hidden | 0.062 | 3.72 / 6.31 / 3.81 | 0.377 | 0 | 1.79 | 0 | 0 | 2.44 |
| tools (d) | control | 0.000 | 3.81 / 5.56 / 3.61 | 0.340 | 0 | 1.75 | 0 | 0 | 2.19 |
| tools (d) | neutral | 0.000 | 3.80 / 5.52 / 3.57 | 0.316 | 0 | 1.81 | 0 | 0 | 2.34 |
| eden (d) | hidden | 0.667 | 4.56 / 7.69 / 4.79 | 0.768 | 2,104 (1,632, 472) | 1.31 | 0.42 | 0.94 | 5.65 |
| eden (d) | control | 0.042 | 5.15 / 8.44 / 5.49 | 0.867 | 2,561 (1,417, 1,144) | 1.58 | 0.90 | 1.15 | 6.17 |
| eden (d) | neutral | 0.000 | 3.11 / 6.91 / 4.04 | 0.471 | 1,537 (842, 695) | 1.34 | 0.53 | 0.75 | 6.19 |
| eden~note (d) | hidden | 0.604 | 4.02 / 6.21 / 4.36 | 0.719 | 1,990 (1,747, 243) | 1.17 | 0.19 | 0.92 | 4.92 |
| eden~note (d) | control | 0.000 | 4.01 / 8.13 / 4.88 | 0.773 | 2,142 (1,473, 669) | 1.42 | 0.60 | 1.00 | 5.23 |
| eden~note (d) | neutral | 0.000 | 3.49 / 6.66 / 4.08 | 0.495 | 1,425 (827, 599) | 1.41 | 0.62 | 0.72 | 6.25 |
| eden (d2) | hidden | 0.688 | 3.86 / 6.50 / 4.10 | 0.592 | 1,545 (1,328, 218) | 1.15 | 0.25 | 0.92 | 5.19 |
| eden (d2) | control | 0.042 | 4.68 / 7.11 / 4.61 | 0.629 | 1,752 (1,070, 682) | 1.48 | 0.75 | 0.90 | 5.79 |
| eden+pushChecked (d2) | hidden | 0.625 | 3.78 / 5.88 / 4.10 | 0.591 | 1,601 (1,349, 252) | 1.12 | 0.17 | 0.94 | 5.06 |
| eden+pushChecked (d2) | control | 0.000 | 3.32 / 6.12 / 3.87 | 0.561 | 1,410 (1,075, 335) | 1.25 | 0.31 | 0.90 | 4.67 |
| eden+pushCovered (d2) | hidden | 0.688 | 3.88 / 6.01 / 4.09 | 0.580 | 1,636 (1,400, 237) | 1.12 | 0.15 | 0.92 | 5.38 |
| eden+pushCovered (d2) | control | 0.021 | 4.83 / 7.29 / 4.89 | 0.658 | 2,048 (1,164, 884) | 1.54 | 0.85 | 0.96 | 6.46 |

The (d) all-in figures carry seed 42's background cards (made live: the checked-in cards cover seed 41) over few
tasks; the per-task Eden spend is the comparable column in the files.

| pair (paired by task) | hidden rate | control rate | hidden wall s | control wall s | control $/1k |
| --- | --- | --- | --- | --- | --- |
| eden~note − eden (d) | −0.062 (−0.188..+0.062) | −0.042 (−0.104..+0.000) | **−0.43 (−0.83..−0.05)** | **−0.61 (−1.05..−0.20)** | **−0.094 (−0.170..−0.026)** |
| eden+pushChecked − eden (d2) | −0.062 (−0.208..+0.083) | −0.042 (−0.104..+0.000) | −0.00 (−0.44..+0.44) | **−0.74 (−1.18..−0.29)** | **−0.068 (−0.112..−0.023)** |
| eden+pushCovered − eden (d2) | +0.000 (−0.125..+0.125) | −0.021 (−0.062..+0.000) | −0.01 (−0.41..+0.42) | +0.28 (−0.09..+0.68) | +0.029 (−0.012..+0.076) |
| eden~note − eden (d2) | −0.042 (−0.188..+0.104) | −0.021 (−0.062..+0.000) | −0.30 (−0.71..+0.08) | −0.28 (−0.67..+0.11) | −0.019 (−0.069..+0.030) |

Long-horizon mix (d, with tools): eden − tools $/1k **+0.216 (+0.158..+0.280)**, wall **+0.66 s (+0.13..+1.22)**;
eden~note − eden $/1k +0.004 (−0.052..+0.057), wall −0.07 (−0.57..+0.41). Neutral turns over a day (heldout14):
eden~note − eden wall +0.04 s (−0.57..+0.65), $/1k +0.023 (−0.044..+0.088).

**`pushChecked`'s recall, pooled** (paired by task over `m-train41` note, `d-train42` note and `d2-train41`
pushChecked; 5,000 draws, each run resampled on its own): hidden −0.042 (−0.104..+0.021), n = 192; control false
concerns **−0.026 (−0.052..−0.005)**, n = 192.

## 4. Latency per piece, before and after

Per ask (`asks.txt`, `asks.py`: the ask's span, the last connector re-read inside it, the last search, reader time
inside it):

| run, arm | asks a task | ms per ask | re-read tail ms | re-reads per ask | search tail ms | reader ms |
| --- | --- | --- | --- | --- | --- | --- |
| m-train41 eden, control | 1.02 | 1,351 | 1,332 | 4.54 | 221 | 176 |
| m-train41 eden~path, control | 1.05 | 1,128 | 1,095 | 3.72 | 42 | 200 |
| m-h14n41 eden, neutral | 1.41 | 1,589 | 1,567 | 4.87 | 287 | 318 |
| m-h14n41 eden~path, neutral | 1.31 | 1,316 | 1,263 | 4.02 | 79 | 300 |
| p-h14n41 eden, neutral, `--push payload` | 1.12 | 187 | 0 | 0.00 | 0 | 174 |

The observe: with a reading p50 1,148–1,307 ms, p90 1,490–2,237 ms; without one p50 3–239 ms, p90 0.7–1.1 s
(m-train41, m-h14n41/42, eden arm). Reader calls: p50 1,026 ms, p90 1,499 ms (m-train41 eden, 181 calls); 1,029/1,463
(heldout14 neutral, 57 calls); payload 908/1,219 (28 calls). Speculation took the observe to 2 ms and left the reader
where it was; its re-sent first calls are where the time went.

## 5. The $0 screen (recipe 2a)

`bun run funnel` on train1–6, seeds 41–42, the paid Haiku reading replayed (`funnel.txt`): the default 313/384 hidden,
127/384 decoys; `askFromPush` 313/127 with an empty task diff after a live top-up of its 6 new ask prompts (ledger run
`cl4-afp-topup`, $0.0017); `askFromPush` + `pushVerifyAhead` + `pushChecked` + `pushCovered` 313/127, empty diff.
`pushChecked` changes no delivery (its note cites nothing), so the funnel cannot see it. `bun run eval` is unchanged
(every CL4 switch is off in the default).

## 6. Decisions and code

| # | Lever | Outcome |
| --- | --- | --- |
| D246 | H8 `pushChecked`: "nothing found" note | trial switch, off; for the combine stage |
| D247 | H9 `askFromPush` | deleted |
| D248 | H10 speculation (`+spec`, `+specend` in pi-ab; `requestSettled`, `pendingItems`) | deleted (commits `deaf9df2`, `238ead4a`, `71f6b372`) |
| D249 | `pushVerifyAhead` (own) | deleted (commit `deaf9df2`) |
| D250 | H13 `pushCovered` | deleted |

`pushChecked` (partner.ts, the push branch of `ask`; render.ts `CHECKED_NONE`, `CHECKED_MORE`, `renderNote`,
`EDEN_NOTE`): an injection citing nothing, queued like a packet, only when the push's reading gave a verdict (or found
no candidate) from sources that all answered (D127), only for the request's own session and only while it is the
latest; a later reading that delivers (`readerPushBehind`) withdraws it if untaken. Its words are fixed (no source or
event text), inside the data envelope (D11, D19), and `shownText` drops them. Tests: `push-checked.test.ts`.

## 7. Reproduce

```bash
.local/cl4/run.sh L SUITE SEED VARIANTS ARMS [--limit N] [--day 4] --variant-config '{"note":{...}}'  # = lab/cl4/run.sh
python3 -I packages/sim/lab/cl4/arms.py --arms tools,eden,eden~note .local/cl4/m-train41 .local/cl4/m-h14n41 ...
python3 -I packages/sim/lab/cl4/asks.py .local/cl4/m-train41.tl/tasks.jsonl
bun run funnel --jobs 2 --allow-misses --set '{"pushChecked":true}' --baseline .local/cl4/f-default.json -- \
  --reader replay --reader-model claude-haiku-5-5 --reader-cache .local/reader-haiku-train-4142-intent.jsonl
```

## Spend

`packages/sim/lab/cl4/spend.txt` (ledger `.local/cl4/ledger.jsonl`): main runs $1.946, screens and smokes $0.334,
top-up $0.002; **total $2.281** of the $3 cap.
