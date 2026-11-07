# RealUse-2: the RealUse-1 fixes, confirmed blind

Status: 2026-11-07. Final confirmation of the fix effort in [realuse-1-weak-points.md](realuse-1-weak-points.md), on
the tree at `e484dfc66` (wave 1, the wave-1 review fixes, W2a and W2b). Every paid call went to the Anthropic API with
`HAIKU_API_KEY`, `claude-haiku-5-5` in every role, through the lab provider (D97), on spend ledgers with hard caps:
**Anthropic-direct lab figures**. The servers ship the same model through OpenRouter (D12), which nothing here called.

The suite is `heldout15`, written blind for this round ([fix-s3b-lab.md](fix-s3b-lab.md) §1) and run here for the first
time: 32 templates, `hidden`, `control` and `neutral` variants. It is now spent. RealUse-1 ran on `heldout14`, a
different suite, so the comparisons below are side by side, not before and after on the same tasks.

Detail: [realuse-2/pi-heldout15.md](realuse-2/pi-heldout15.md) (Pi, every arm and interval) and
`packages/sim/lab/realuse-2/hermes/hermes-heldout15-report.txt` (Hermes Agent).

## In plain words

- **Eden still multiplies how often the agent raises the fact it needed, now about 4.6 times (Pi) and 5.5 times
  (Hermes).** Pi: 16.4% alone, 75.8% with Eden (+59.4 points, +50.8..+68.0). Hermes Agent: 12.5% alone, 68.8% with
  Eden (+56.3, +43.8..+68.8). On RealUse-1's blind suite the Pi figures were 20.3% and 65.6%.
- **It costs less than it did.** On the assumed mix (1 task in 10 needs a fact, 1 is a look-alike, 8 need nothing),
  a Haiku agent on Pi goes from $0.345 to $0.663 per 1,000 tasks with Eden (+$0.319, +0.290..+0.346); RealUse-1 measured
  $0.349 to $0.848. Hermes: $0.398 to $0.630.
- **False alarms did not rise.** Pi: false concerns on look-alikes 1/128 alone and 2/128 with Eden; on neutral tasks
  8/128 alone and 3/128 with Eden (every interval crosses zero). Hermes: 0/64 and 1/64 on look-alikes, 1/64 and 4/64 on
  neutral tasks (+4.7, −1.6..+12.5). W2b found that about two in five Haiku-graded concerns are grader errors.
- **Latency did not improve on this suite.** Pi's mix adds 0.91 s per task (+0.62..+1.20) against 0.60 s in
  RealUse-1; Eden is 39% of Pi's critical path on hidden tasks. Hermes adds 0.62 s on hidden tasks (n.s.), 0.87 s on
  look-alikes and 1.03 s on neutral tasks. The reader is 51–68% of Eden's path on Hermes (p50 1,090 ms).
- **Eden beside the agent's own tools still trails Eden alone.** With `ask_context` (the shape integrators ship) Pi
  raised 68.8%, 7.0 points below Eden alone (−13.3..−0.8); without the ask 59.4% (−16.4). On heldout14 the ask closed
  the gap (a tie); here it closes most of it.

## Headline

| | Pi alone (tools) | Pi + Eden | Pi tools + Eden + ask | Hermes alone | Hermes + Eden |
| --- | --- | --- | --- | --- | --- |
| Hidden facts raised | 16.4% | 75.8% | 68.8% | 12.5% | 68.8% |
| False concerns, look-alikes | 0.8% | 1.6% | 0.8% | 0.0% | 1.6% |
| Any concern, nothing planted | 6.2% | 2.3% | 4.7% | 1.6% | 6.3% |
| $ per 1k tasks, mix | 0.345 | 0.663 | 0.637 (hidden) | 0.398 | 0.630 |
| Wall p50, hidden | 5.12 s | 4.83 s | 5.05 s | 5.48 s | 5.06 s |
| n per kind | 128 | 128 | 128 | 64 | 64 |

Pi: seeds 41–44, 1,536 runs, 0 errors, 0 ungraded, $1.021. Hermes Agent (commit 06433066f4, run in the parent
session: the cloud sessions cannot run it, RealUse-1 part C): seeds 41–42, 384 runs, 0 errors, 0 ungraded, $0.267.
Both used the market `direct` connector profile, change notifications on (`--push signals`), time scale 1.

The $0 blind funnel on heldout15 (no model, reader stub): hidden surfaced 104/128, decoys 80/128; neutral tasks with
any packet 24/128 (heldout14 in RealUse-1: 100/128, 84/128, 55/128).

## What each issue came to

| # | Issue | Outcome | Decisions |
| --- | --- | --- | --- |
| 1 | Full cost on turns with nothing to add | Push reading reused by the ask (D193); re-reads only for what the reader names (D192). S1 live mix: $/1k 0.856 → 0.628, −0.49 s, −2.45 connector calls a task, neutral reader calls 1.78 → 0.88. Evidence gate, no-wait and short schema measured and deleted | D190–D194 |
| 2 | False concerns | Rule-path veto, retirement and labels did nothing (S2, deleted). W2b traced every concern: none invented by the agent, ~2/5 grader errors, the rest reader-flagged look-alikes and unread information asks; two answer notes did nothing (deleted). heldout15 shows no rise. Open: the reader's look-alike judgements; reading information asks needs a cost decision | D195–D197, D230–D231 |
| 3 | Recall: facts never surfaced | Per-card-kind intent cut (D200): replay 311/137 → 315/133, +$0.036/1k, live +2.3 (n.s.). Agent-phrased intent requests rejected (D201) | D200–D202 |
| 4 | Eden beside the agent's tools | `both+ask` arm built: on heldout14 it tied Eden alone; on heldout15 7.0 points below. Still open | — |
| 5 | Connector calls | Payload notices are the documented default and the client sends items (D210: −23% calls in the simulation); poll window and recency caps deleted | D210, D213, D214 |
| 6 | Latency | As issue 1 (−0.49 s on heldout14); the short schema did not help. heldout15's mix wall is +0.91 s: not solved | D192–D194 |
| 7 | Scale (memory) | Graph memo released per put (D215, 1.10–1.22x less held memory), then the graph itself deleted (D225). Ingest worker 1.46x, under the bar, deleted (D216) | D215, D216, D225 |
| 8 | An ask citing a deleted item | Strict ask verification (D211): 1 → 0 in 360; the wave-1 review closed its last gap (a refusal by our own breaker or rate limit now leaves the item out) | D211 |
| 9 | Coarse robustness | A connector's 429 reads "rate-limited" (D212, 1,064 of 1,064) | D212 |
| 10 | Privacy gaps | New Relic keys and presigned signatures redacted (49/50 formats); one line sanitiser for every packet, answer and prompt line, the forgery probe a standing test | D220, D221 |
| 11 | Parts with no measured value | Every part ablated with the paid reader replayed: graph, askVerdicts, anticipate and slowPathQueue deleted (53 files, about 6,080 lines); judge out of `PARTS`; the rest kept with reasons. Live: no significant loss | D225–D229 |
| 12 | Benchmark gaps | heldout15 written blind and run here; Sonnet regrade agreed 370/384; synced `sim:perf` memory (4.1 MB RSS per user); a multi-day mode (`--day`) that found stale recaps, fixed by revision notices (D205); cold start $0.021 a user. Not done: the OpenRouter route (the owner tests on Anthropic only) | D205 |

The wave-1 review (an independent reviewer on the merged diff) found five defects, all fixed with tests: the strict ask's gap above (high), a revision missed while a packet waited in the queue (medium), revision
polls outliving `stopSync`, a reader call an ask could not wait for, and the client reporting success on malformed
items (low). A second review of those fixes, after the heldout15 runs, found that the first two went too far or not far
enough (ordinary rate-limit spend left live items out of quick asks; an update could follow a packet the push withdrew;
a session handed nothing before missed its update). They were reworked as D232 with four more tests; the eval and the
paid-reader replay (313/127) are unchanged, so the heldout15 figures stand for the final tree.

## What is still open

- **Latency.** Eden is a third of the agent's wait on Pi; the reader is most of it. Nothing tried in S1 cut the
  reader's own time.
- **Eden beside the agent's tools** trails Eden alone on heldout15 (−7.0 with the ask).
- **False concerns** have no measured fix; the remaining real ones are look-alikes the reader flags and information
  asks no reading checks.
- **The OpenRouter route** the servers ship is unmeasured.

## Spend

| Part | $ (Anthropic) |
| --- | --- |
| Wave 1: S1 1.99, S2 3.01, S3a 1.79, S3b 1.97, S4 0.48, S7 1.21, S5 and S6 0 | 10.45 |
| W2a parts | 1.144 |
| W2b false concerns | 3.319 |
| RealUse-2 Pi on heldout15 | 1.021 |
| RealUse-2 Hermes on heldout15 | 0.267 |
| **Total for the fix effort** | **16.20** |

## Reproduce

```bash
# Pi: see realuse-2/pi-heldout15.md. Hermes (HERMES = a hermes-agent checkout with its .venv):
HERMES=/path/to/hermes-agent bash packages/sim/lab/realuse-2/hermes/run.sh
bun packages/sim/src/lab/pi-ab-report.ts .local/r2/h15-41.json .local/r2/h15-42.json
```
