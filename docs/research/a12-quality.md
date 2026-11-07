# A12: a powered hidden-fact measurement, and a nudge to ask

Status: 2026-11-07 (session A12, after [a2-quality.md](a2-quality.md)). Decisions D315–D318. Every paid call went to
the Anthropic API with `HAIKU_API_KEY` through the lab provider, on the ledger `.local/a12/ledger.jsonl` (cap $3):
**Anthropic-direct lab figures**, not the OpenRouter route the servers ship. Train only (seeds 41–44); no held-out
suite was run.

## In plain words

- **How good the default really is.** On the 91 train templates where the push's candidates matter most, over four
  seeds (364 hidden tasks an arm), with a stronger grader (Sonnet 5.5) checking the cheap one (Haiku 5.5): the shipped
  default gets the hidden fact into the agent's answer **70% of the time (65–74%)**. The old setup, where a model
  read every candidate first, gets **78% (74–82%)**, and an agent with only its own search tools **11%**. So the
  candidates default (D237) gave up about **8 points** of hidden facts against the reader (−12 to −4), more than A2's
  Haiku-graded estimate of 4–5. Haiku's "raised" calls are mostly right (Sonnet agreed on 172 of 180 checked); its
  misses are not (Sonnet called 35 of 199 of them raised).
- **The lever: tell the agent to ask when the packet does not pin the request down.** If none of the five items Eden
  hands over names both the person or thing the request names and its date (a no-model check), the packet's fixed line
  now ends: *"They may not cover the person, thing or date this request names: before answering, call ask_context with
  those specifics, if you have it."* An ask in that same request also lists the push pool's deeper items (its 6th to
  15th) that name the request's person, thing or day. This is the opposite of D257's "nothing found" note, which made
  the agent skip asks and lost facts.
- **It works: +9 points of hidden facts, level with the reader, at a fifth of the reader's extra cost.** Sonnet-graded,
  **+9.2 points (+6.0..+12.6)** over the default; against the reader setup **+1.3 (−3.1..+5.4)**. The gain is the
  agent's own asks: planted facts found only by asking rose from 20 to 43 tasks. Concerns (look-alikes stated as
  facts) did not rise: 2 against 2 of 364 control tasks after Sonnet's check, 1 against 0 of 182 neutral (a grader
  artefact). The price: about one more ask every three tasks, **+$0.061 per 1,000 tasks on the 1:1:8 mix (about
  +16%)**, **+0.35 s** a task, and **no connector call** (the asks answer from the synced index). It is now in the
  default (D317); `minus-nudge` takes it out.
- **After review** the deeper look takes at most half the answer's seats (an answer still cites at most `maxItems`),
  and names next to "." or "-" count. A smaller live check of the fixed version (seeds 41–42) gave **+8.0 points
  (+3.7..+12.4)**, level with the measured one; its cost and time deltas came out higher (+$0.05/1k, +0.6 s) against
  a baseline run two hours earlier, so read the trade as +$0.04–0.07 per 1,000 tasks and +0.3–0.6 s.
- **The third idea, more intent requests at card time, loses facts at $0** (D318): letting the intent index read more
  item kinds crowds the planted item's request out (316 → 303–313 hidden of 384). Not built.

## 1. The measurement (D315)

Setup: `packages/sim/lab/a12/run.sh` (A2's, with arms `reader` = `pushCandidates` 0 and `nudge` = `askNudge`): Pi,
Haiku 5.5 agent and in-run grader, cards and intent replayed (`.local/a12/cards-all.jsonl`, 5,817–5,857 cards; the
few new ones made live), payload notices, direct profile, time scale 1. Runs: `a12-m-4{1..4}` (eden, eden~reader;
hidden and control), `a12-t-4{1..4}` (tools; hidden only, to save cost: tools raises almost nothing on control),
`a12-n-4{1..4}` (eden~nudge; hidden and control, an hour after `a12-m`), `a12-neu-41/42` (eden and eden~nudge on
neutral, in one run).

Grading: Sonnet 5.5 regraded **every Haiku miss** of the eden, reader and nudge arms (`regrade.ts --only-misses`),
**a fixed sample of Haiku's "raised"** (`--only-raised --sample 30` per seed file, 15 for the nudge's), tools the
other way round (every raised, a sample of 15 misses a seed), and every control or neutral concern
(`--only-concerns`). An answer Sonnet did not see counts at its arm's sampled agreement (`hidden.py`). New regrade
flags: `--kinds`, `--only-raised`, `--sample N` (a hash of task and arm: the same sample on every rerun).

| arm | hidden n | Haiku | Sonnet-corrected (95%) | Sonnet's check of Haiku |
| --- | --- | --- | --- | --- |
| tools | 364 | 0.102 | **0.108** (0.079..0.139) | misses called raised: 1/60 |
| eden (the default before D317) | 364 | 0.698 | **0.698** (0.654..0.742) | raised agreed 53/57; misses called raised 18/110 |
| eden~reader (`pushCandidates` 0) | 364 | 0.755 | **0.778** (0.737..0.818) | raised agreed 61/63; misses called raised 17/89 |
| eden~nudge | 364 | 0.755 | **0.791** (0.750..0.829) | raised agreed 58/60 |

Paired by task (bootstrap 95%, 5,000 draws), points:

| pair | Sonnet-corrected | Haiku |
| --- | --- | --- |
| eden − tools | +59.0 (+53.9..+64.1) | +59.6 |
| reader − eden | **+8.0 (+3.6..+12.3)** | +5.8 (+1.4..+10.2) |
| nudge − eden | **+9.2 (+6.0..+12.6)** | +5.8 (+1.9..+9.9) |
| nudge − reader | +1.3 (−3.1..+5.4) | +0.0 (−4.7..+4.7) |

Power: a paired interval over 364 tasks is about ±4 points (±3.3 for nudge − eden, whose arms agree on most tasks).
Seeing a 3-point lever at 95% would take about twice as many tasks; the setup tells a 6-point lever from noise.

Concerns (Haiku, then Sonnet's regrade of Haiku's concerns): control eden 5 → 2, nudge 5 → 2, reader 4 → 0 (of 364);
neutral eden 0, nudge 1 → 1 (of 182; the answer flags a suspicious "Account Team" mail on a task whose fact has no
text).

## 2. The nudge (D316, D317)

`settle.ts`: a request's anchors are its entities (the cue's), its time window's days and any date it writes out
("30 October", "Nov 2nd", "12–14 November"). A candidate holds an entity as a participant (`namesParticipant`) or as
whole words in its title or text, and a day as its start day or written out ("Fri 30th", "30/10"). The packet settles
the request when one candidate holds every kind of anchor the request has. Unsettled, the lead adds `ASK_NUDGE`, and
the session remembers the push pool past the handed items for that request; an ask before the next user message adds
up to `maxItems` of them that hold any anchor.

Where it fires ($0 funnel, train seeds 41–44, `--ask`; `nudge-screen.py`): 422 of the 636 hidden tasks with a packet
(the planted item was handed in 322 of those, in the pool's 6th–15th in 43), 428 of 636 control. Live, the nudge line
was in a packet on 517 of 728 hidden and control tasks (71%). The funnel's gain is only the deeper look (its asks are
the request itself, asked once): hidden +22 −0, decoys +13 −0 over four seeds; ask answers +23% in bytes. On the
standard funnel (seeds 41–42): 305/267 → **316/274**; `--preset minus-nudge` gives back 305/267 exactly.

Where the live gain comes from (`a2/uptake.py`; raised as Haiku graded):

| | packet | ask only | neither |
| --- | --- | --- | --- |
| eden (four seeds) | 238/274 | 16/20 | 0/70 |
| eden~nudge | 242/273 | 33/43 | 0/48 |

Cost and time (agent + Eden per task, paired nudge − eden; Eden makes no model call either way):

| kind | n | asks a task | $/1k | wall s |
| --- | --- | --- | --- | --- |
| hidden | 364 | 0.49 → 0.81 (+0.32) | 0.431 → 0.468 (+0.038, +0.022..+0.054) | 2.91 → 3.26 (+0.35) |
| control | 364 | 0.74 → 0.95 (+0.20) | 0.440 → 0.460 (+0.020, +0.005..+0.034) | 2.97 → 3.21 (+0.24) |
| neutral | 182 | 0.81 → 1.19 (+0.38) | 0.359 → 0.428 (+0.069, +0.051..+0.087) | 3.05 → 3.43 (+0.38) |
| 1:1:8 mix | | | 0.374 → 0.435 (**+0.061**, ≈ +16%) | +0.36 |

For comparison the reader arm costs 0.641 and 0.660 $/1k on hidden and control (+0.21 over the default) and 4.1–4.3 s.

Connectors (`pi-cost-report`): 0.00 calls a task in both arms (the asks answer from the synced index under payload
notices), the same one-time backfill (108 calls a user on neutral, 216 on the hidden/control runs); every plan's price
moves by the token cost alone (neutral: Composio all-in 0.715 → 0.784, Zapier MCP 30.98 → 31.05 $/1k). Tools alone,
on hidden: 3.52 connector calls a task, $0.389/1k in tokens, 1.445 on Composio, 91.19 on Zapier MCP.

Eval (no model): unchanged (precision 0.591, recall 0.52, falseFireRate 0; latency only).

### After review

The reviewer found the ask's deeper look could cite up to twice `maxItems` (the protocol's bound is `maxItems`), that
an entity next to "." or "-" did not match, and that a settled second-pass packet left the deeper look on. Fixed: the
deeper items take at most `ceil(maxItems / 2)` seats from the end; entities match on letter and number boundaries; a
settled packet clears `Session.nudged`. At $0 (seeds 41–44) the nudge fires as often (421 of 636 hidden packets, 423
control), the deeper look gains hidden +18 −0 and decoys +12 −0 (was +22, +13), ask answers +10% in bytes (was
+23%); seeds 41–42: 314/273. Live, `a12-n2-41/42` (the default after D317, hidden and control):

| | n | Sonnet-corrected | paired, points | concerns (regraded) | asks | $/1k | wall s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fixed nudge, hidden | 182 | 0.783 (0.725..0.837) | +8.0 (+3.7..+12.4) vs eden; +0.6 (−3.8..+4.9) vs the measured nudge | | 0.79 (+0.29) | 0.491 (+0.059) | 3.52 (+0.62) |
| fixed nudge, control | 182 | | | 1 | 0.93 (+0.22) | 0.477 (+0.046) | 3.40 (+0.52) |

The asks a task match the measured version; the cost and time run higher than both it and the baseline at the same
ask rate, which points at drift between runs made hours apart (prompt-cache hits, API latency), not the fix. Read the
trade as a range: +$0.04–0.07 per 1,000 tasks a kind and +0.3–0.6 s.

## 3. More intent requests at card time (D318)

A2 found 50 hidden facts in no pool, mostly sharing no word with the request, and 16 whose intent request was not yet
held. The cheapest $0 test of "requests for more item kinds" is to let the intent index read what it now skips, with
the checked-in requests replayed (they cover 8,868 of 8,904 items): over the new default on train 41–42 (316/274),

| `--set` | hidden / decoys | against the default |
| --- | --- | --- |
| `cardsLean` false (every item) | 307/266 | hidden +5 −14, decoys +8 −16 |
| `intentByKind` false (every carded kind) | 313/274 | hidden +1 −4, decoys +1 −1 |
| both | 303/264 | hidden +4 −17, decoys +9 −19 |

More requests in the index crowd the planted item's out of the fused seats. Not built; the agent's ask, now nudged,
is the reader of meaning that reaches these facts.

## Reproduce

```bash
cat packages/sim/lab/cards/cards-{v2,train,train-4344}.jsonl > .local/a12/cards-all.jsonl
T=$(cat packages/sim/lab/a2/targeted-templates.txt); L=packages/sim/lab/a12/run.sh
$L a12-m-41 payload eden,eden~reader --seeds 41 --variants hidden,control --templates $T --budget 0.3   # 41..44
$L a12-t-41 payload tools --seeds 41 --variants hidden --templates $T --budget 0.15                    # 41..44
$L a12-n-41 payload eden~nudge --seeds 41 --variants hidden,control --templates $T --budget 0.2         # 41..44
$L a12-neu-41 payload eden,eden~nudge --seeds 41 --variants neutral --templates $T --budget 0.12        # 41, 42
R=packages/sim/lab/a12/regrade.sh
$R a12-m-41 miss-m-41 --only-misses; $R a12-m-41 raised-m-41 --only-raised --sample 30; $R a12-m-41 conc-m-41 --only-concerns
$R a12-n-41 miss-n-41 --only-misses; $R a12-n-41 raised-n-41 --only-raised --sample 15; $R a12-n-41 conc-n-41 --only-concerns
$R a12-t-41 raised-t-41 --only-raised; $R a12-t-41 miss-t-41 --only-misses --sample 15
$L a12-n2-41 payload eden --seeds 41 --variants hidden,control --templates $T --budget 0.15  # after D317; 41, 42
python3 -I packages/sim/lab/a12/hidden.py .local/a12/runs        # → packages/sim/lab/a12/hidden.txt
bun run funnel --seeds 41,42,43,44 --jobs 4 --set '{"askNudge":false}' --json base.json  # then without, and:
python3 -I packages/sim/lab/a12/nudge-screen.py nudge.json base.json
bun run funnel --jobs 4 --set '{"cardsLean":false}' --baseline default.json
```

(The `askNudge` runs above were made while the trial was off by default; with D317 the default is the nudge arm.)

## Spend

| What | $ |
| --- | --- |
| smoke (18 runs) | 0.015 |
| eden and reader, seeds 41–44 (1,456 runs) | 0.898 |
| tools, seeds 41–44 (364 runs) | 0.165 |
| nudge, seeds 41–44 (728 runs) | 0.391 |
| neutral, eden and nudge, seeds 41–42 (364 runs) | 0.170 |
| Sonnet regrades (misses, raised samples, concerns; 4 arms) | 0.823 |
| fixed nudge, seeds 41–42 (364 runs) and its Sonnet regrades | 0.316 |
| **Total (ledger)** | **2.777** |

## Caveats

- Train only; the nudge's wording, its anchors and the deeper look were chosen once, not tuned, but the blind
  held-out check is still to run.
- The targeted templates are the ones whose packet A2's re-rank changed, so their rates are not the suite's; arms are
  compared on the same tasks.
- The nudge arm's hidden and control runs were made an hour after the default's (paired by task, not in one
  process); the neutral pair ran in one process. Wall times across the two runs carry any API latency drift.
- "Sonnet-corrected" leans on samples for Haiku's "raised" (57–63 an arm) and tools' misses (60).
- The live gain is Haiku as the agent; A2's Sonnet-agent check (D270) did not cover the nudge.
