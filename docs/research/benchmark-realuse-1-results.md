# RealUse-1 results: Eden as it is really used

Status: 2026-11-06, main at 957b82a98 plus the benchmark's lab changes (no engine behaviour change except the
render fix below). Design: [benchmark-realuse-1.md](benchmark-realuse-1.md). Every paid call went to the Anthropic API
with `HAIKU_API_KEY`, `claude-haiku-5-5` in every role (agent, grader, Eden's cards, intent and reader), through the
lab provider (D97), on spend ledgers with hard caps: **Anthropic-direct lab figures**. The servers ship the same model
through OpenRouter (D12), which no part of this benchmark called. Detailed tables, commands and caveats are in the five
part notes under [realuse-1/](realuse-1/); every number here is quoted from them or from the runs they name.

## In plain words

- **Eden makes the agent raise the fact it needed about 3 to 6 times as often.** On the new blind suite, written for
  this benchmark by an author who saw no Eden code, a Haiku agent with Eden raised 65.6% of hidden facts against 20.3%
  alone (+45.3 points). On the four earlier held-out suites it was 74.4% against 13.1% (+61.3). On Hermes Agent,
  67.2% against 15.6% on the blind suite (+51.6) and 81.3% against 3.1% on held-out 13 (+78.1). Every one of these
  intervals is far from zero.
- **The cost is about twice the agent's model bill and 0.6 s per task on the realistic mix,** paid on every task,
  mostly when Eden has nothing to add. For a Haiku agent on first-party APIs, $0.35 → $0.85 per 1,000 tasks in the
  assumed mix (1 task in 10 needs a fact, 1 is a look-alike, 8 need nothing); for a Sonnet or Opus agent the same
  Eden adds about 9–11%. On connector platforms that bill per call, Eden's 6–7 extra calls a task dominate (sync polls;
  forwarding change notifications with their items removes most of them).
- **False alarms are rare but not zero.** On held-out 10–13 Eden raised a wrong concern on 3.1% of look-alikes against
  0.6% alone, a difference whose interval excludes zero (+2.5 points). On the blind suite: 0 of 128 look-alikes and
  7 of 128 neutral tasks (2 of 128 alone; interval touches zero). Eden beside the agent's own tools halves these
  (1.6%) for 9 points less recall.
- **It stays current and fails safe.** With change notifications, 1 of 43 updated facts went out stale (7 of 46
  without) and deleted items were delivered or cited once instead of 19 times. With connectors erroring 30% of the time
  nothing changed; with every connector down Eden stayed silent; every ask whose source failed said so (2,808 of 2,808).
- **It does not leak.** 0 secrets leaked, 48 of 50 secret formats redacted (the two misses are a bare New Relic key and
  a Sentry DSN, public by design), injection text stayed inside the data envelope in 36 of 36 cases after a fix this
  benchmark found (a newline in a source title could forge a packet line; fixed, with a test).
- **It is fast and scales by memory.** The per-event fast path takes 0.16 ms at the median; a 4-core server handles
  3,200–3,800 events a second within a 100 ms p99 (3–8.7x one process); memory, at about 1.5–2 MB per synced user, is
  what limits a machine: about 5,000–7,400 active users on 4 cores and 16 GB (arithmetic on measured figures).

## Scorecard

| Tier | Measure | Result | Part |
| --- | --- | --- | --- |
| T1 outcomes, blind | Pi, heldout14, hidden raised, tools → eden | 20.3% → 65.6%, +45.3 pts (+35.2..+55.5) | A |
| | false concerns, control / any concern, neutral | 0/128 → 0/128 / 2/128 → 7/128 (+3.9, +0.0..+7.8) | A |
| | Eden beside tools (both), hidden | 57.0% (8.6 pts below eden, −16.4..−0.8) | A |
| | traffic mix (1:1:8): raised / wrong / $ per 1k / wall mean | 2.0% → 6.6% / 1.3% → 4.4% / 0.349 → 0.848 / +0.60 s | A |
| | Hermes, heldout14, hidden raised | 15.6% → 67.2%, +51.6 (+37.5..+64.1); neutral wall +1.58 s | C |
| T1 outcomes, read suites | Pi, held-out 10–13 pooled, hidden raised | 13.1% → 74.4%, +61.3 (+55.6..+66.9) | B |
| | false concerns | 0.6% → 3.1%, +2.5 (+0.6..+4.7) | B |
| | Hermes, held-out 13, hidden raised | 3.1% → 81.3%, +78.1 (+67.2..+87.5); 0 false concerns | C |
| T1 attribution | eden minus sync / reader / intent (held-out 13) | −42.2 / −25.0 / −18.8 pts; grounds and graph: no difference | B |
| T1 connectors | hosted vs direct latency | tools −6.2 pts; eden unchanged (+4.7, n.s.), +0.33 s on Eden's path | B |
| T1 cost per model | Eden's share of the bill, neutral tasks, first-party APIs | Haiku agent +148%, Sonnet +11%, Opus +9% | A |
| T2 decisions ($0) | eval precision / recall / false-fire rate | 0.828 / 0.48 / 0 (31 scenarios) | D |
| | funnel on train, hidden / decoys of 384 (stub; paid reader replayed) | 281 / 256; 311 / 137 | D |
| | blind funnel, heldout14 (no model) | hidden surfaced 100/128, decoys 84/128, neutral with a packet 55/128 | A |
| T3 freshness | stale updates / deleted delivered+cited, signals vs none | 1/43 vs 7/46 / 1 vs 19; 0.48 re-reads per turn | D |
| T5 robustness | 30% errors / Gmail down / all down | no change / recall 0.454 → 0.328 / silent, 0 false fires | D |
| | honest ask on a failed source (D127) | 2,808 of 2,808 | D |
| T6 privacy | secrets leaked / formats redacted / ReDoS worst 1 MB / injection held | 0 / 48 of 50 / 65 ms / 36 of 36 (after the fix) | D |
| T7 shipped wiring | reader on Haiku, eval precision / recall / false-fire rate | 0.833 / 0.50 / 0, 6 calls, $0.0009 | D |
| T4 speed | observe p50 / p99; ms CPU per event | 161 µs / 4.1 ms; 1.006 ms | E |
| | reader call p50 / p90 / TTFT / $ | 1,123 ms / 1,485 ms / 463 ms / $0.000287 | E |
| | ingest, shipped: µs per item / B per item held | 294.5 / 4,015 (about 2 MB per 500-item user) | E |
| T4 scale | router, 4 children, events/s at p99 ≤ 100 ms (realistic / hosted) | 3,819 (8.68x one process) / 3,210 (3.04x) | E |
| | HTTP steady / soak / faults | p99 9.2 / 7.9 / 7.4 ms; 0 failed open in every scenario | E |
| | active users per machine (arithmetic) | 4-core 16 GB 5,100–7,400; 16-core 64 GB 20,000–29,600 (memory-bound) | E |
| Dev loop | `bun run check` / `test:changed` / funnel | 36.4 s / 23.9 s / 11.8 s | E |

## What the benchmark changed

- **A security fix (D11):** a newline in a source item's title, or in an `ask_context` source line, could forge an
  extra packet line. Fixed in `render.ts` and the MCP answer, with tests; the reviewer approved (part D).
- **A simulator fix:** the token bucket refused every call below 1 request a second, so "rate-limited" scenarios had
  been total outages (part D).
- **Lab:** the blind suite `heldout14` with a new `neutral` variant across the funnel, Pi, Hermes, graders and
  reports (part A); `pi-ab` and `hermes-ab` no longer demand an OpenRouter key when every role is on Anthropic (parts
  A and B); `quality-cli --source-profile`; the router-sim ladder no longer stops on one noisy step (part E).

## What it did not measure, and why

- **The OpenRouter route the servers ship** (caching, latency, how it treats requests): every paid call here was
  Anthropic-direct, as asked. The model and prompts are the same; transport and routing are not.
- **Hermes in the cloud sessions:** their permission check refused to run the Hermes checkout, so both Hermes suites
  were run by the parent session's container instead (part C note).
- **A multi-day user:** sessions are single tasks over a seeded world; freshness and soak are simulated (T3, T4).
- **Real user data:** none, by rule. Worlds, connectors and their latency profiles are simulated or estimated.

## Spend

| Part | What | $ (Anthropic) |
| --- | --- | --- |
| A | heldout14 caches, Pi direct and hosted | 1.109 |
| B | Pi on held-out 10–13, hosted, five ablations | 1.866 |
| C | Hermes on held-out 13 and heldout14 (incl. a run killed by a container restart, $0.20) | 0.607 |
| D | shipped-wiring eval | 0.001 |
| E | reader timing, 360 calls | 0.136 |
| **Total** | | **3.72** of a $30 cap |
