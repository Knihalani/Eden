# A30: which tokens Eden's agent pays for that the agent alone does not, and one lever that cuts them

Status: 2026-11-07, branch `claude/a30-token-gap` (from `claude/lucid-hypatia-v9wqk5` at `caad18c1`). Decisions
D400–D404. Train only (heldout9–17 are all read; none was run). Every paid call went to Anthropic with
`HAIKU_API_KEY` (`claude-haiku-5-5` in every role, `claude-sonnet-5-5` only to regrade concerns), `env -u
OPENROUTER_API_KEY`, one ledger `.local/a30/ledger.jsonl` with a hard cap of $2. Anthropic-direct lab figures (D97).

## In plain words

**Spent: $0.533** of the $2 cap (4,272 calls, `spend.txt`); one live eval on top (`eval-live.ts`, under its own
$0.05 cap).

- **Where the extra money goes.** On train with the house rules (`--tenant-prompt`), the agent with Eden costs
  **+$0.054 per 1,000 tasks** more than the agent alone one request a session and **+$0.059** over a user's days
  (`gap.py`, 1:1:8 mix). Split by token class:
  - **One request a session:** +$0.040 is the **packet written to the prompt cache on the first request** (the eden
    arm writes 327–577 tokens there, the agent alone 27–59), and +$0.018 is **ask answers written on later requests**.
    Output, cache reads and plain input are level (±$0.002).
  - **Over days:** +$0.051 is the packet written on the first request, +$0.026 is **earlier packets read back** on
    later tasks of the day (they stay in the transcript, D336), +$0.018 is a **longer first answer** (Eden's agent
    answers in one call, 1.0–1.1 requests a task against 1.3–1.6); the agent alone's extra requests and tool results
    give back −$0.035.
  - So the gap is the packet's own bytes, as A3 found (D271, D273); what is new is the exact split, and that nothing
    else (no cache miss, no re-written prefix) contributes.
- **Two cache-layout levers have nothing to buy (D401, D402), both checked at $0 on the runs' own usage records.**
  - Moving the agent's cache mark off the first request's user turn, so a one-call task pays 1x instead of 1.25x for
    the packet, **costs** more: +$0.021/1k one request a session, +$0.066 over days. Most tasks (53–72% one request
    a session, nearly all over days) read that text again, and then it is written at 1.25x instead of read at 0.1x.
  - A byte-stable packet across a session's requests is already what runs: of 826 later requests in a task (57 over days) and 339
    next-task first requests over days, **none** read less from the cache than its predecessor had cached (the only
    drops are the day resets).
- **One lever works: fewer candidates when they already settle the request (D400, promoted by D404).** When the
  request names a person, thing or day and the push's candidates hold every kind of anchor it names (`settle.ts`, the
  test askNudge already uses), the push hands the first two candidates (through the first that settles it) instead
  of five. Paired against the default on Pi, train seeds 41–42:
  - **hidden facts +5.8 points (−0.6..+12.3)**, pooled over the short and long runs (n 155): not worse;
  - **billed $/1k −0.008 one request a session (−0.023..+0.007), −0.013 over days (−0.024..−0.001)**;
  - wall −0.07 s (−0.17..+0.02) short, +0.02 s (−0.05..+0.09) long; connector calls unchanged;
  - false concerns after the Haiku + Sonnet regrade: +0.8 points (0.0..+1.8), 3 against 0 of 392; read by hand all
    three are grader errors (§4);
  - at $0: funnel 314/273 unchanged (11 planted items move from the packet to the ask's answer); `bun run eval`
    precision **0.5909 → 0.65**, recall 0.52 and falseFireRate 0 unchanged.
- **What the gap is after it:** +$0.046/1k short, +$0.047 over days on first-party prices (from +$0.054/+0.059 in the
  same runs). It does not close the gap: the packet is still most of what Eden costs the agent, and the earlier cuts
  that would shrink it further lose hidden facts (D258, D259, D273). On every per-call connector plan Eden's arm is
  still far cheaper (Composio −$0.60/1k short, −$0.23 over days; Zapier MCP −$55.6 and −$24.1, steady mix).

## 1. Runs

`packages/sim/lab/a30/run.sh` (A3's run.sh with A30's ledger and the trial arm). Arms `tools`, `eden` (the default
as of `caad18c1`) and `eden~few2` (`{"pushCandidatesSettled": 2}`) in one process per seed, so the pairs share
worlds, cards and timing.

| run | flags | spent |
| --- | --- | --- |
| `a30-short-41`, `-42` | payload, `--variants hidden,control,neutral --limit 12` (144 tasks a kind an arm) | $0.418 |
| `a30-long-41`, `-42` | payload, `--days 4` (one user per seed, 59 and 56 tasks an arm) | $0.105 |
| regrades | `regrade.ts --only-concerns --graders claude-haiku-5-5,claude-sonnet-5-5` on all four | $0.010 |

0 ungraded, 0 retries. The long runs are 4 days, not A3's 8, to keep the session short; their intervals are wider.

## 2. The gap by token class (D403)

`gap.py` (new, `packages/sim/lab/a30/`) reads each task's requests from the timeline and splits the agent's bill into
cache read (0.1x), cache write (1.25x), plain input and output, for the first request of a task and the later ones.
Haiku 5.5: $0.10/M in, $0.50/M out.

One request a session (`short-gap.txt`), $/1k on the mix:

| arm | read1 | write1 | plain1 | out1 | readN | writeN | plainN | outN | total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tools | 0.015 | 0.007 | 0.000 | 0.088 | 0.013 | 0.039 | 0.000 | 0.067 | 0.229 |
| eden | 0.012 | 0.046 | 0.000 | 0.088 | 0.011 | 0.057 | 0.000 | 0.068 | 0.283 |
| eden − tools | −0.002 | **+0.040** | 0.000 | −0.001 | −0.002 | **+0.018** | 0.000 | +0.001 | +0.054 |
| eden~few2 − tools | −0.003 | +0.041 | 0.000 | −0.002 | −0.002 | +0.015 | 0.000 | −0.002 | +0.046 |

Over days (`long-gap.txt`):

| arm | read1 | write1 | plain1 | out1 | readN | writeN | plainN | outN | total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| tools | 0.034 | 0.023 | 0.000 | 0.068 | 0.015 | 0.015 | 0.000 | 0.025 | 0.181 |
| eden | 0.060 | 0.074 | 0.000 | 0.086 | 0.002 | 0.009 | 0.000 | 0.009 | 0.240 |
| eden − tools | **+0.026** | **+0.051** | 0.000 | **+0.018** | −0.013 | −0.006 | 0.000 | −0.016 | +0.059 |
| eden~few2 − tools | +0.022 | +0.045 | 0.000 | +0.018 | −0.013 | −0.008 | 0.000 | −0.016 | +0.047 |

Per task, short: the first request writes 327–577 tokens in `eden` (the user turn and the packet before it) against
27–59 in `tools` (the user turn alone); `tools`' system prompt and tools (≈1,460 tokens) are read from the cache by
every task, Eden's (≈1,180–1,240) too. Later requests, per task: `eden` writes 257–494 tokens (mostly `ask_context`
answers), `tools` 308–348 (its search results). On neutral tasks, 80% of the mix, `eden` makes slightly fewer requests
(1.74 against 1.81 a task, 0.94 asks) but writes 494 tokens against 308: an ask answer is longer than a search
result, so later writes are +$0.018 on the mix. The per-kind token table is in
`short-gap.txt` and `long-gap.txt`.

## 3. Levers

### 3.1 The cache mark before the packet (D401, rejected at $0)

Pi (pi-ai) marks the last message for the cache; on a task's first request that is the user turn, with Eden's packet
placed just before it, so both are written at 1.25x. The counterfactual in `gap.py` (`lever1 delta`) bills that first
write plain (1x) and, when any later request reads it (a later request of the task, or over days the next task of
the same day, whose transcript keeps it), writes it on that request instead of reading it (1.25x instead of 0.1x).
Result on the mix: `eden` **+$0.021/1k** short, **+$0.066** over days (`tools` +0.004 and +0.021). It saves 0.25x on
one-call tasks and costs 1.15x on the rest; 53–72% of `eden`'s short tasks and nearly all of its tasks over days are
the rest. No live run: the sign does not depend on the agent's behaviour, only on how often a later request reads
the text, which the records give.

### 3.2 A byte-stable packet across a session's requests (D402, nothing to build)

pi-ab places every packet a request has taken before the user turn and keeps it there (D336's `kept` layout); a
later packet joins those already placed. Checked on the records: a later request that read less from the cache than
the request before it had cached or written: 0 of 826 within tasks one request a session (eden 235, few2 236, tools
355), 0 of 57 within tasks over days; next-task first requests over days that read less than the previous task's
last request had: only the 3 day resets per arm per seed (the transcript is reset each day by design). The packet is
already byte-stable; the gap is not a cache miss.

### 3.3 Fewer candidates when the request is settled (D400 trial, D404 promoted)

`pushCandidatesSettled` (config.ts, `candidatesOf` in partner.ts): when the request has an anchor (an entity, or a
day) and the handed candidates settle it (`settles`, the test `askNudge` runs), hand the first
`pushCandidatesSettled` candidates, extended through the first candidate that settles the request on its own. A
request with no anchor, or one the candidates do not settle (which askNudge then nudges), keeps five. No model call,
no source call. Why this is not D259 (k 3 everywhere, rejected): it cuts only where the packet itself shows it holds
what the request names, and keeps that item.

$0 screen (`bun run funnel`, train1–6 seeds 41–42, `funnel-few2.txt`): surfaced hidden 314/384, decoys 273/384,
task-by-task identical to the default (`--baseline`: +0 −0); delivered by the candidates path 242 hidden / 207
decoys against 253 / 217, the 11 hidden and 10 decoys then cited by the ask instead (listed only 53 / 49 against
42 / 39).

Live, paired `eden~few2 − eden` (`short-arms.txt`, `long-arms.txt`, `pooled.txt`, `concerns.txt`):

| measure | short | over days | pooled |
| --- | --- | --- | --- |
| hidden raised | +6.2 points (0.0..+13.2), hidden kind | +0.0 (mix) | **+5.8 (−0.6..+12.3)**, n 155 |
| billed $/1k, mix | −0.008 (−0.023..+0.007) | **−0.013 (−0.024..−0.001)** | |
| wall mean s, mix | −0.073 (−0.167..+0.020) | +0.017 (−0.053..+0.089) | |
| concerns, regraded (control + neutral) | +0.35 (0.0..+1.0) | | +0.8 (0.0..+1.8), n 392 |
| asks a task (neutral) | 0.85 against 0.94 | | |

Connector plans (`short-cost.txt`, `long-cost.txt`, steady mix, eden arm minus tools):

| plan | short eden | short few2 | days eden | days few2 |
| --- | --- | --- | --- | --- |
| first-party (quota only) | +0.054 | +0.046 | +0.069 | +0.056 |
| Composio (overage) | −0.594 | −0.601 | −0.212 | −0.225 |
| Unified.to (Pro) | −1.565 | −1.573 | | |
| Arcade.dev (Team) | −21.530 | −21.537 | | |
| Pipedream Connect (overage) | −25.846 | −25.854 | | |
| Zapier MCP (10k tasks) | −55.631 | −55.639 | −24.069 | −24.082 |

(The days rows for Unified.to, Arcade and Pipedream are in `long-cost.txt`. pi-cost-report's first-party row books
Eden's own per-task spend too, so it differs from `gap.py`'s agent-only figures by Eden's cents.)

By the task's rule (promote only if hidden facts are not worse and billed $/1k falls): hidden not worse (interval
includes zero, point +5.8), billed falls on both horizons (significant over days). **Promoted (D404).**

## 4. The concerns, read by hand

Regraded, the trial arm keeps 3 of 392 control and neutral answers, the default 0 (Haiku alone: 2 and 1).

- `w41:train3-control:restricted-datastore-grant` (short) and `w42:…:restricted-datastore-grant` (long, Haiku drops,
  Sonnet keeps): the control world holds ACC-4471 already approved; both answers say the ticket is approved by
  Security and the data owner and ready to provision. That is the decoy's content stated correctly, not the hidden
  concern (that the grant needs an approved ticket); our reading, labelled so.
- `w41:train5-control:leaving-drinks-pub-refit` (long): "The Lantern & Oak, 400m down Mill Lane from The Crown &
  Kettle, which is closed for a refit … so it's a sensible option". The closed pub in the control world is The Crown
  & Kettle; the answer is right and both graders misread the relative clause.

## 5. Decisions

- **D400**: `pushCandidatesSettled` built as a trial (0 = off), screened at $0 and live.
- **D401**: the cache mark moved off the packet's request is rejected at $0 (+$0.021/1k short, +$0.066 over days).
- **D402**: a byte-stable packet across a session's requests: already so (0 cache drops beyond day resets); nothing
  to build.
- **D403**: the gap by token class (§2): first-request packet writes (+0.040 short, +0.051 days), ask answers written
  (+0.018 short), earlier packets re-read and a longer one-call answer over days (+0.026, +0.018), less of the agent
  alone's later requests (−0.035 days). `gap.py` is the instrument.
- **D404**: `pushCandidatesSettled` 2 promoted into the default (part `fewer`); `bun run eval` precision 0.5909 →
  0.65 (recall, falseFireRate unchanged), funnel 314/273 unchanged.

## 6. What was not done

- No Hermes run (A27's gap is the same shape; `gap.py` reads hermes-ab's tasks.jsonl only after a path change).
- One value of the switch (2). 1 or 3 were not tried.
- The long runs are 4 days a user (A3 ran 8); seeds 43–44 not run.
- No blind check: every held-out suite is read. The next new suite should check D404 blind.

## 7. Reproduce

```bash
cat packages/sim/lab/cards/cards-{v2,train,train-4344}.jsonl > .local/a30/cards-all.jsonl
L=packages/sim/lab/a30/run.sh
$L a30-short-41 payload tools,eden,eden~few2 --seeds 41 --variants hidden,control,neutral --limit 12 --budget 0.3  # and 42
$L a30-long-41 payload tools,eden,eden~few2 --seeds 41 --days 4 --budget 0.2                                       # and 42
R=.local/a30/runs
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results $R/a30-short-41.json \
  --graders claude-haiku-5-5,claude-sonnet-5-5 --only-concerns --spend-ledger .local/a30/ledger.jsonl \
  --spend-cap 2 --spend-headroom 0.1 --run-label a30-regrade-short-41 --out $R/a30-short-41.regrade.json  # each run
python3 -I packages/sim/lab/a30/gap.py $R/a30-short-4{1,2}                    # short-gap.txt
python3 -I packages/sim/lab/a30/gap.py --days $R/a30-long-4{1,2}              # long-gap.txt
python3 -I packages/sim/lab/cl7/arms.py --arms tools,eden,eden~few2 $R/a30-short-4{1,2}   # short-arms.txt (long same)
python3 -I packages/sim/lab/cl4/pooled.py eden~few2 eden $R/a30-{short,long}-4{1,2}       # pooled.txt
python3 -I packages/sim/lab/realuse-3/pi/concerns.py eden~few2 eden $R/a30-{short,long}-4{1,2}  # concerns.txt
bun packages/sim/src/lab/pi-cost-report.ts $R/a30-short-4{1,2}.json            # short-cost.txt (long same)
bun run funnel --jobs 2 --set '{"pushCandidatesSettled":2}' --baseline <default.json>   # before D404
```

The run's trial arm ran on this branch before the promotion (the switch at 0 in `DEFAULT_CONFIG`); after D404 the
`eden` arm is what `eden~few2` was.
