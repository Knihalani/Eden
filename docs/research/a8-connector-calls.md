# A8: Eden's connector calls on per-call connector platforms

Status: 2026-11-07, branch `claude/a8-connector-calls` (from `claude/lucid-hypatia-v9wqk5` at `ae5757b75`, then merged
with its tips `8274294f` (A3's D272) and `07e881cd` (A5's D283)). Decisions D296–D299. Paid calls: Anthropic API only,
`HAIKU_API_KEY`, `claude-haiku-5-5` in every role, lab provider (D97), `OPENROUTER_API_KEY` unset, own ledger
(`.local/a8/ledger.jsonl`, hard cap $1.5): **Anthropic-direct lab figures**. Train only, seeds 41–42. **Spent:
$0.939.** Numbers marked **[EST]** are arithmetic, not measured; every other number comes from a command in this note.

## In plain words

- **The problem.** Some connector platforms bill every call: Composio $0.30, Unified.to $0.75, Arcade.dev $10,
  Pipedream $12, Zapier MCP $25.8 per 1,000 calls (`market.py`). A6 measured that over a user's days Eden's arm made
  **2.19 connector calls a task against the agent alone's 1.50**, mostly re-reading gmail and slack items it already
  held, even with notices that carry their items, where nothing should be in doubt.
- **The cause: the test harness, not Eden.** At the end of each simulated day, pi-ab moves the times of the day's
  planted items and tells Eden. Under `--push payload` it should send the moved items, as a real integration does
  (D210). It sent a bare "gmail changed" signal instead. A bare signal does not say which item changed, so Eden must
  doubt every gmail copy it read before it (D126) and re-read each one before handing it to the agent. Every one of
  those re-reads found the item unchanged. A3 found and fixed the same bug in parallel (D272); A8 reproduced it at $0
  and measured it live, paired task by task.
- **After the fix, over a user's days (live, Pi, 232 tasks):** Eden's connector calls fall from **2.33 to 0.16 a
  task** (−2.18, −2.44..−1.93), now below the agent alone's 1.69. Hidden facts 13/23 → 14/23, regraded concerns 1 → 1;
  Eden's wall p50 2.57 → 2.04 s. On Zapier MCP that is **$60.46 → $4.48 per 1,000 tasks** (the agent alone $43.94);
  on Composio $1.04 → $0.40 (agent alone $0.84).
- **What still costs calls, on real 24-hour days ($0 replay):** with payload notices Eden makes 0.09 calls a request
  (a once-a-day poll per source) plus about **11.7 background listings a user-day** (0.81 a request), almost all the
  **daily sweep** that re-lists every page to find deletions, plus **18 listings once per user** for the first sync.
  That is 0.90 calls a request: $0.27 per 1,000 tasks on Composio, $23 on Zapier MCP.
- **A cheaper sweep was built, measured and deleted (D297).** Sweeping weekly for sources whose notices carry their
  changes cut those 11.7 listings to 2.1. But a sweep is the backstop when a deletion notice is lost: with 10% of
  notices lost, deleted items cited rose from 1 to 12 (16 users). That weakens "a deleted item is never cited", so it
  went (D112).
- **A real engine waste, fixed (D298, A5's lead).** For MCP connectors, whose "not found" proves nothing, a re-read
  that found nothing was repeated by every later delivery and every other session of the user, for the same answer.
  Now a reply that simply lacked the record stands for that user until the source signals again, for at most 10
  minutes: 6 asks → 1 fetch, 4 sessions → 1 fetch. An MCP error result is never held (it may pass, and a changed
  copy behind it must be read next time). The lab's sources do report deletions, so it does not move the lab's
  numbers.
- **What to tell integrators on per-call platforms:** forward notices with their items (D210). Bare signals cost
  6.43 calls a task over a user's days (live), 40 times payload's 0.16, because every signal doubts the whole source.

## 1. The diagnosis

**Code path.** `pi-ab.ts` before D272, at each day's recap: `for (const id of touched) partner.sourceChanged(scope, id)`
whatever `--push` said. `Sync.changed` bumps the source's `noticedMark`; `ContextPartner.doubted` is then true for
every cached copy whose `readMark` is older; the push's candidates (`pushCandidates`, D237) and every ask's citations
go through `verifyItems` → `check` → `recheck` → `SourceFanout.fetchChecked`, one fetch per doubted item. A confirmed
re-read stores the copy under the new mark, so each item is re-read once per signal: over eight days, seven signals,
and the same items again after each.

**$0 reproduction** (`days-calls.ts`, new): the `--days` user (the same plan, world, day sizes, clock gaps and recap
moves) through a real `ContextPartner` on `DEFAULT_CONFIG`, cards and intent replayed, no agent and no model, one ask a
request, every connector call counted by phase. `packages/sim/lab/a8/days-calls-pi-clock.txt`:

| Recap notice under payload | Request-time calls a request | gmail fetch | slack fetch | Notice listings | Re-reads (confirmed unchanged) |
| --- | --- | --- | --- | --- | --- |
| bare signal (before D272) | 2.302 | 1.974 | 0.328 | 24 | 554 checked, 528 confirmed, 0 changed, 26 failed (sim errors) |
| the moved items (D272) | 0.000 | 0 | 0 | 0 | 0 |

Both: 20 + 21 items moved, 10 + 12 "updated:" packets handed to the agent (D205 holds), no stale copy held undoubted
at any request (D126 holds). `days-calls.test.ts` asserts this.

**Live** (Pi, `--days 8`, payload, direct profile, users 41–42, 232 tasks, the same tasks in each arm;
`packages/sim/lab/a8/long-pay-pair.txt`, `pair.py`): `old` is the eden arm with `--recap-notice signal` (before D272),
`new` with D272.

| Arm | Hidden raised | Concerns, control / neutral (regraded) | Mix $/1k tokens | Calls a task (mix) | Eden wall p50 |
| --- | --- | --- | --- | --- | --- |
| eden, old recap | 13/23 | 0 / 1 | 0.345 | 2.33 | 2.57 s |
| eden, fixed | 14/23 | 1 / 0 | 0.354 | 0.16 | 2.04 s |
| tools (agent alone) | 1/23 | 0 / 1 (graded 0 / 2) | 0.337 | 1.69 | 3.20 s |

Paired new − old: connector calls −2.18 a task (−2.44..−1.93) on the 1:1:8 mix, every kind excluding 0; hidden +0.043
(−0.087..+0.174); mix $/1k tokens +0.009 (+0.002..+0.017), all of it neutral tasks (+0.013, +0.005..+0.021; the agent's
own spend, Eden's is $0 a task in both). Old arm's Eden calls by op: gmail fetch 1.746, slack fetch 0.263, gmail list
0.246, slack list 0.052 a task (A6 measured 1.711, 0.224, 0.181, 0.052): the same effect. New: listings only (0.16).

## 2. Every other connector call, per task and per user-day

The live long run compresses eight days into about 36 hours of Eden's clock (2 h nights), so its background is about
one daily sweep a user. `days-calls.ts --night-h 20` gives 24-hour days (`days-calls-24h.txt`; 232 requests, 16
user-days, one ask a request, cards replayed):

| Notices | Request-time a request | Background a user-day (a request) | Steady a request | One-time a user |
| --- | --- | --- | --- | --- |
| payload (default) | 0.091 | 11.69 (0.806) | 0.897 | 18 |
| signals | 1.552 | 13.56 (0.935) | 2.487 | 18 |
| none | 0.978 | 11.31 (0.780) | 1.759 | 18 |

What they are, and what was done:

| Call | Payload, per user-day | Avoidable? |
| --- | --- | --- |
| Daily sweep (`syncSweepMs` 24 h, every page of every source; gmail 8.4 of the 11.7) | ~10 | Only by trusting notices to be complete: D297 measured and deleted |
| 24 h poll of a notifying source with no notice (`syncPushMaxStaleMs`, one page each) | ~1.3 at request time | No: the bound on a lost new-item notice (D125) |
| First sync (backfill) | 18 once | No: what the index is |
| Re-reads after a bare signal (signals only) | 1.55 a request | Not without per-item signals (D131); integrators should send items (D210) |
| Rate-based polls (no notices) | 0.98 a request | D57's design for sources that cannot notify |
| Repeated "unverifiable" re-reads (MCP, signals) | 0 in the lab (sim sources report deletions) | Yes: fixed, D298 |

## 3. The weekly sweep for item-carrying sources (built, measured, deleted: D297)

Trial `syncCarriedSweepMs` (code in `2089dc2f`): a notifying source whose notices carried items or removals swept
weekly instead of daily; a bare signal since the last complete sweep began, or an item the last sweep missed (its
second miss drops it, D57), kept the daily sweep (the reviewer's findings 1, 2 and 4, fixed before measuring).
`days-calls` 24 h payload: background 11.69 → 2.13 listings a user-day, steady 0.897 → 0.280 a request. quality-cli,
16 users × 20 sessions, `--updates 0.6 --deletes 0.1 --push payload --lost-notices L` (`lost-notices.txt`):

| Notices lost | Deleted delivered / cited, off | on | Stale / updated, off | on | Background listings, off → on |
| --- | --- | --- | --- | --- | --- |
| 0% | 0 / 0 | 0 / 0 | 16/160 | 16/159 | 1,096 → 175 |
| 10% | 0 / 1 | 2 / 12 | 20/161 | 23/160 | 1,096 → 183 |
| 20% | 8 / 5 | 11 / 31 | 23/161 | 27/161 | 1,096 → 194 |
| 30% | 11 / 12 | 15 / 50 | 24/162 | 34/162 | 1,096 → 223 |

Of 128 deletions applied. With no notice lost it is free; with any loss it cites deleted items a daily sweep would
have dropped. Webhooks are lost in practice (no measured rate), so it is not neutral on D126/D211's guarantee and is
deleted (D112). A cheaper backstop would have to find deletions without listing every page (none of the five sim
connectors offers one).

## 4. Repeated unverifiable re-reads (D298)

A5's lead, reproduced here first (`unverifiable-reread.test.ts`, failing before the fix): a re-read of a doubted item
from a source with `fetchReportsGone` false (every MCP source) that returns null is "unverifiable", and the item is
delivered and cited as held (D126, D211); but its read mark did not move, so `doubted` stayed true. `check` reuses an
outcome only for 30 s and only within the session, so 6 asks 31 s apart made 6 fetches, and 4 sessions of one user 4.
Fix: `ContextPartner.unverifiable` holds, per user (D9) and item, the read mark the null re-read began under and when;
`doubted` is false for the item until the source signals again (`Sync.signalledSince` on that mark) or 10 minutes pass
(`UNVERIFIABLE_HOLD_MS`). Only a reply that lacked the record is held: the second review found that `McpSource.fetch`
turned an MCP error result (`isError`: a 5xx, a quota message, often "not found") into the same null, so one transient
error pinned an edited item's old copy for every later ask until the next signal (a probe: the +31 s ask cited the old
text with 1 fetch, against the edited text with 2 before). `McpSource.fetch` now throws `FetchErrorResult` on
`isError`; `SourceFanout.fetchChecked` settles it as answered (breaker success, as its null was) and reports
`why: "error-result"`, which the engine treats as unverifiable and never holds; the 10-minute cap bounds a transient
error worded as prose. Answers are the same as before D298 for a lasting null (cited as held either way); a new signal
re-reads; failed, flaked or skipped re-reads are never held, so D211's strict retries are unchanged; a signal while the
null re-read is on the wire keeps the item doubted (the read mark is taken before the call); `forget` drops it;
bounded at 512 items a user and 4,096 users (eviction only costs a re-read). Tests: `unverifiable-reread.test.ts` (7:
the four counts, the error result then the edited copy, the 10-minute cap, the on-the-wire signal),
`mcp-source.test.ts` (an error result throws, and reads `error-result` through the fan-out). A delivery's fast path
now hands a held item straight from the cache, as it would any undoubted copy. quality-cli with sim sources made to behave as MCP
(`--null-proves-nothing`, new), 8 users × 20 sessions, `--updates 0.6 --deletes 0.05 --push signals`
(`unverifiable-quality.txt`): re-reads 765 → 761, everything else identical (stale 5/74, deleted delivered/cited 11/11,
precision 0.412, recall 0.540; 763 after the review fix): that sim spaces a user's sessions hours apart, so few repeats occur. A5's estimate of
5–20 calls a user-day on MCP with signal-only notices is A5's, not measured here.

## 5. Short horizon (one request at a time)

Pi, train1–6, `--limit 6` (hidden, control, neutral: 72 a kind over seeds 41–42), eden arm, direct profile; `base`
is the parent tip `8274294f` (D272 in, D298 not), `new` this branch, the same tasks (`short-{payload,signals}-pair.txt`,
`short-concerns.txt`). One request at a time there is no recap, so D272 does not act, and D298 is inert on sim
sources: this checks that nothing else moved.

| Notices | Arm | Hidden raised | Concerns control / neutral (regraded) | Mix $/1k tokens | Calls a task (mix) |
| --- | --- | --- | --- | --- | --- |
| payload | base | 54/72 | 4 / 1 | 0.416 | 0.00 |
| payload | new | 55/72 | 2 / 0 | 0.433 | 0.00 |
| signals | base | 51/72 | 4 / 2 | 0.370 | 8.77 |
| signals | new | 52/72 | 4 / 2 | 0.352 | 8.45 |

Paired new − base: hidden +0.014 (−0.069..+0.097) payload, +0.014 (−0.083..+0.111) signals; mix $/1k +0.016
(−0.010..+0.044) and −0.017 (−0.042..+0.008); calls −0.32 (−0.90..+0.28) under signals: all within noise. Under
signals one request at a time Eden's arm makes 8.45 calls a task (gmail fetch 3.63 of them): every hourly signal
doubts its source (D126), and on a per-call platform that is the most expensive way to integrate.

## 6. $ per 1,000 tasks per plan

Token $ (1:1:8 mix, from the runs) plus calls a task times the plan's price (`price.py`, `price-long.txt`):

| What | Tokens | Calls a task | First-party | Composio | Unified.to | Arcade.dev | Pipedream | Zapier MCP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Long, payload, eden, old recap (live) | 0.345 | 2.33 | 0.345 | 1.044 | 2.093 | 23.645 | 28.305 | 60.459 |
| Long, payload, eden, fixed (live) | 0.354 | 0.16 | 0.354 | 0.402 | 0.474 | 1.954 | 2.274 | 4.482 |
| Long, tools, agent alone (live) | 0.337 | 1.69 | 0.337 | 0.844 | 1.605 | 17.237 | 20.617 | 43.939 |
| Long, signals, eden (live) | 0.337 | 6.43 | 0.337 | 2.266 | 5.159 | 64.637 | 77.497 | 166.231 |
| 24 h days, payload, Eden's calls only ($0) | — | 0.897 | 0 | 0.269 | 0.673 | 8.970 | 10.764 | 23.143 |
| 24 h days, signals, Eden's calls only ($0) | — | 2.487 | 0 | 0.746 | 1.865 | 24.870 | 29.844 | 64.165 |
| Short, payload, eden, parent tip / this branch (live) | 0.416 / 0.433 | 0.00 | 0.416 / 0.433 | same | same | same | same | same |
| Short, signals, eden, this branch (live) | 0.352 | 8.45 | 0.352 | 2.887 | 6.689 | 84.852 | 101.752 | 218.362 |
| Short, payload, tools (A6's run, cross-run) | 0.364 | 3.34 | 0.364 | 1.366 | 2.869 | 33.764 | 40.444 | 86.536 |

One-time per user: 18 listing calls, $0.0054 on Composio, $0.46 on Zapier MCP. The live long rows count the calls
that land in a task's window, the compressed clock's ticks included; on 24-hour days the background is larger (the $0
rows): **[EST]** a payload user on Zapier MCP then costs about $0.354 + 0.897 × $25.8 ≈ $23.5 per 1,000 tasks with
Eden against the agent alone's $43.9 (its calls do not depend on the clock), at 14.5 tasks a day.

## 7. Checks

- `bun run eval` (no model) on the final code: identical to the parent tip `07e881cd` (precision 0.5909, recall
  0.52, falseFireRate 0; `eval-final.txt`).
- `bun run funnel --jobs 3` on the final code: hidden 305/384, decoys 267/384, `+0 −0` task by task against the parent
  tip (`funnel-final.txt`).
- After merging A5 (`07e881cd`): `days-calls` identical (`days-calls-*-a5.txt`); live, the long payload eden arm on
  the merged tree against the fixed-recap run above, same 232 tasks (`long-pay-a5-pair.txt`, `long-pay-a5-cost.txt`):
  connector calls 0.16 → 0.16 a task (all listings), hidden 14/23 → 16/23 (+0.087, −0.087..+0.261), mix $/1k tokens
  +0.001 (−0.007..+0.009), backfill 18 listings a user (now recorded by pi-ab).
- quality-cli freshness matrix, payload and signals, unchanged by D298 on sim sources (they report deletions).
- Tests: `days-calls.test.ts`, `unverifiable-reread.test.ts` (4, failing before the fix), `deletes.test.ts`
  (`lostNotices`), `connector-options.test.ts` (A3's `recapNotice`).
- `reviewer` on the code, first pass: REQUEST_CHANGES, eight findings on the trial and the lab flags; fixed, then
  the trial was deleted on its measurement. Second pass on the final diff: REQUEST_CHANGES, one correctness finding
  (an MCP error result held as unverifiable could pin a changed item's old copy, §4), fixed with tests; the untested
  on-the-wire case and the fast path covered or stated; funnel, eval and the tools arm's concerns committed
  (`funnel-final.txt`, `eval-final.txt`, `long-pay-concerns.txt`).

## Decisions

- **D296** (lab): A6's long-horizon re-reads were the recap's bare signal under payload (D272); A8's `$0`
  reproduction (`days-calls.ts`) and paired live run confirm it; `--recap-notice signal` keeps the old notice.
- **D297**: trial `syncCarriedSweepMs` opened and deleted the same day (§3).
- **D298**: an unverifiable re-read stands for the user until the source's next signal (bug fix, §4).
- **D299**: the remaining calls are kept (§2): the daily sweep, the 24 h poll, the backfill; signals' re-reads and
  rate-based polls are D126's and D57's designs. For per-call platforms the lever is the integration (D210).

## Reproduce

```bash
cat packages/sim/lab/cards/cards-train.jsonl packages/sim/lab/cards/cards-train-4344.jsonl \
  packages/sim/lab/cards/cards-v2.jsonl > .local/a8/cards-all.jsonl
C="--seeds 41,42 --days 8 --cards .local/a8/cards-all.jsonl --ask"
bun packages/sim/src/lab/days-calls.ts $C --push payload --recap-notice signal     # and without; --night-h 20
bun packages/sim/src/quality-cli.ts --users 16 --sessions 20 --updates 0.6 --deletes 0.1 --jobs 4 --push payload \
  --lost-notices 0.1 --config '{"sync":true}'                                    # D297 (the trial's code: 2089dc2f)
bun packages/sim/src/quality-cli.ts --users 8 --sessions 20 --updates 0.6 --deletes 0.05 --jobs 4 --push signals \
  --null-proves-nothing                                                          # D298
R=packages/sim/lab/a8/run.sh; S=.local/a8/runs
$R a8-long-pay-new-41 payload tools,eden --seeds 41 --days 8 --budget 0.3          # and 42
$R a8-long-pay-old-41 payload eden --seeds 41 --days 8 --budget 0.2 --recap-notice signal
$R a8-long-sig-41 signals eden --seeds 41 --days 8 --budget 0.2
python3 -I packages/sim/lab/a8/pair.py old=$S/a8-long-pay-old-41:eden,$S/a8-long-pay-old-42:eden \
  new=$S/a8-long-pay-new-41:eden,$S/a8-long-pay-new-42:eden \
  tools=$S/a8-long-pay-new-41:tools,$S/a8-long-pay-new-42:tools --pair old,new --pair tools,new
bun packages/sim/src/lab/pi-cost-report.ts $S/a8-long-pay-new-4{1,2}.json
env -u OPENROUTER_API_KEY bun packages/sim/src/lab/regrade.ts --results $S/a8-long-pay-new-41.json \
  --graders claude-haiku-5-5 --only-concerns --spend-ledger .local/a8/ledger.jsonl --spend-cap 1.5 \
  --spend-headroom 0.1 --run-label a8-regrade-long-pay-new-41 --out $S/regrade-long-pay-new-41.json   # each run
```

## Spend

| What | $ |
| --- | --- |
| long payload, fixed recap, tools + eden | 0.211 |
| long payload, old recap, eden | 0.107 |
| long signals, eden | 0.105 |
| long payload, eden, after merging A5 | 0.109 |
| short payload + signals, eden, parent tip and this branch | 0.406 |
| regrades (Haiku, concerns only) | 0.002 |
| **Total** | **0.939** |

Ledger `.local/a8/ledger.jsonl` (per run: `packages/sim/lab/a8/spend.txt`), cap $1.5.
