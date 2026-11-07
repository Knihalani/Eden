# Eden's weak points after RealUse-1, and the plan to fix them

Status: 2026-11-07. Source: [benchmark-realuse-1-results.md](benchmark-realuse-1-results.md) and the part notes in
[realuse-1/](realuse-1/). Every evidence figure below is quoted from those notes (Anthropic-direct Haiku lab runs);
causes marked "likely" are readings of the code, not measurements. Work is split into sessions that own disjoint
files; each session's decision rows use its own block of numbers (below) so parallel branches do not collide.

## 1. Eden pays its full cost on turns where it has nothing to add (sessions S1)

- **Evidence.** Blind `heldout14` neutral tasks: +$0.517/1k (+148% on a Haiku agent), +0.77 s (Hermes +1.58 s),
  1.58 reader calls, 5.89 fetches and +6.85 connector calls a task, more than on hidden tasks (1.06 reader calls,
  +$0.38, no slowdown). Mix (1:1:8, assumed): +$0.50/1k, +0.6 s.
- **Causes.** `readerGate` (`config.ts`) only closes when no candidate has a constraint-kind card or wording, which a
  real mailbox almost always has (D157: a learned gate decided 2.5% of calls); the agent waits for the push up to
  `DEFAULT_WAIT_MS` 3,000 ms; on an empty or weak packet the agent calls `ask_context` more (1.22 a neutral task vs
  0.57 hidden), each a reader call; each reader call may start up to `VERIFY_AHEAD` = 3 re-reads after a signal
  (likely the main source of the fetches).
- **Fixes (trials).** (a) An evidence gate: the reader runs only when the request's own evidence clears a bar (top
  candidate's no-model score, its intent match to the request, card kind), screened at $0 on the paid-reader replay
  then live. (b) No blocking wait when the pool is weak: return at once and queue any finding (`readerPushBehind`
  machinery). (c) Re-reads start after the reader names an item. (d) A same-turn ask reuses the push's reading.

## 2. False concerns rise with Eden, mostly through the no-model rule paths (S2)

- **Evidence.** Held-out 10–13: 0.6% → 3.1% (+2.5, the only significant quality loss; held-out 11 +6.2). Blind
  neutral: 7/128 vs 2/128. Funnel: of 137 decoys surfaced, 68 came from rule paths (grounded-conflict 32, fallback
  19, sources 9), 46 listed only, 23 reader-flagged.
- **Causes.** The no-model grounds deliver on structure (shared people and dates, conflict patterns) before the reader
  reads, so it cannot veto them (D151); their decoy cost was never measured per rule with a real reader.
- **Fixes.** A per-rule precision table with the paid reader (replay); retire or tighten rules whose decoys outnumber
  their hidden finds; route rule deliveries through the reader when it runs anyway; test labelling rule-path items so
  the agent weighs them (a hypothesis, live).
- **Outcome (S2, 2026-11-07, [fix-s2-rules.md](fix-s2-rules.md)).** All three fixes measured live and deleted
  (D195–D197): none lowered false concerns (held-out 10–13 3.1% → 3.1% with the veto); the veto lost hidden facts on
  held-out 14 (−9.4). Rule-path decoy items are not what the agent raises; the cause is open.
- **Outcome (W2b, 2026-11-07, [fix-w2b-false-concerns.md](fix-w2b-false-concerns.md)).** Attributed: of 39
  Haiku-graded concerns 15 (+1 unclear) are grader errors, none is the agent's invention; the real ones are
  reader-flagged look-alikes (13) and listed-only items of information asks the reader never reads (10). Framing the
  ask answer (D230, D231) moved nothing live; both deleted. Next: the reader's look-alike judgements, and reading
  information asks (a cost decision).

## 3. Recall: facts Eden never surfaces (S3a)

- **Evidence.** Blind 65.6% vs 74–80% on read suites. 45 of 384 hidden facts never reach the pool: 27 under intent
  thresholds, 10 no shared term, 5 past the intent-hits cut, 3 no intent requests.
- **Causes.** Thresholds tuned on read suites (D159); vocabulary gaps expansion cannot close (D189).
- **Fixes.** Per-card-kind threshold calibration on train, confirmed once blind; intent requests generated in the
  phrasing agents actually use (a trial, card cost measured).

## 4. Eden beside the agent's own tools is weaker, and the shipped integration is unmeasured (S3b)

- **Evidence.** `both` −8.6 to −8.7 hidden points vs `eden`, +0.41 to +0.89 s.
- **Causes.** Pi's `both` arm has no `ask_context`, so the shape integrators ship (own tools + Eden context +
  `ask_context`) is untested; with its own search the agent searches (1.97–2.92 a task).
- **Fixes.** A `both+ask` condition in pi-ab, measured; if it still trails, tell the agent what the packet covers.

## 5. Connector calls dominate cost on per-call platforms (S4)

- **Evidence.** +6.14 to +7.75 connector calls a task (about 3.3 sync listings, 4–6 fetches); on a $12/1k-calls
  platform agent + Eden $113–133/1k vs $39–41 alone ($73–94 with sync by push).
- **Causes.** Signal-only notices make the next lookup poll (D131 source-wide); the re-reads of issue 1; payload
  notices fix most of it (0.91 → 0.22 calls a lookup) but depend on the integrator.
- **Fixes.** Payload notices as the documented integration default, with the client's `sourceChanged` accepting items;
  coalesce polls per source across a user's concurrent requests; per-source recency caps.

## 6. Latency: Eden is a third of the agent's wait, mostly the reader (S1)

- **Evidence.** Eden 1.6–2.4 s, 34–42% of task wall; reader 70–88% of Eden's share; reader p50 1,123 ms, fit 896 ms +
  2.55 ms per output token, 131–169 output tokens.
- **Fixes.** Issue 1's gate; a shorter reader output schema (ids plus a kind code), measured for quality and latency.

## 7. Scale is memory-bound; one process saturates early (S5)

- **Evidence.** 4.0–4.2 KB per synced item (about 2 MB per 500-item user); 5,100–7,400 users per 4-core 16 GB machine
  by memory vs 3–6x more by CPU; shipped ingest 2.5–3x the bare cache's CPU; one process saturates at 200–300
  cold-start events/s with `store` 40% of CPU on the main thread.
- **Fixes.** Backfill ingest off the request thread; compact per-item structures (interned labels, no raw copy after
  redaction); measure each with the ingest, pipeline, concurrent and router-sim benches.

## 8. An ask can still cite a deleted item (S4)

- **Evidence.** 1 in 360 asks under signals. **Cause.** `verifyDelivery` guards packets, not ask citations.
- **Fix.** Verify the ask's doubted citations through the same `verifyItems` path.

## 9. Robustness is honest but coarse (S4)

- **Evidence.** A connector's 429 reads "failed"; one source down costs what it holds (Gmail down: recall 0.454 →
  0.328). **Fix.** Map upstream 429s to "rate-limited" in the fan-out and the ask's wording.

## 10. Privacy gaps (S6)

- A bare New Relic `NRAK-` key passes the gate; S3 presigned `X-Amz-Signature` is not redacted (decide); the forged
  line bug class appeared in three renderers, so one shared line sanitiser should serve every packet, answer and
  prompt line, with the part D forgery probe as a standing test.

## 11. Parts with no measured value, two that may hurt (wave 2)

- $0 train: grounds, anticipate, compaction, fallback, freshness, judge, probeGrace, slowPathQueue contribute 0;
  graph (+6) and askVerdicts (+16 hidden, +9 decoys) read better removed at the stub; grounds and graph no live
  difference. **Fix.** Paid-replay ablation per part at the current default, then promote or delete (D112).
- **Status (wave 2, W2a):** decided in D225–D229, [fix-w2a-parts.md](fix-w2a-parts.md): graph, askVerdicts,
  anticipate and slowPathQueue deleted; the other parts kept; judge out of `PARTS`.

## 12. Benchmark gaps (S3b, and wave 2)

- The OpenRouter route is never called (the owner tests on Anthropic only: recorded, not run); the grader is the
  agent's model (regrade a seed with a stronger Anthropic grader); neutral tasks only on one suite and 4 seeds;
  `sim:perf` never syncs its users; no multi-turn sessions; cold-start enrichment estimated, not measured. A fresh
  blind suite (`heldout15`) is written in wave 1 and run only in wave 2's final confirmation.

## Execution

| Session | Issues | Owns | Decision numbers | Paid cap |
| --- | --- | --- | --- | --- |
| S1 | 1, 6 | `reader.ts`; partner.ts's reader paths (readAsk, reader push, checkAhead, observe wait); its own config keys | D190–D194 | $5 |
| S2 | 2 | `grounding.ts`, `conflict.ts`, partner.ts's rule-path delivery; render.ts's item labelling; its own config keys | D195–D199 | $4 |
| S3a | 3 | `intent.ts`, `cards.ts`, `cards-enrich.ts`; its own config keys | D200–D204 | $3 |
| S3b | 4, 12 | `suites.ts` + `hidden-heldout15.ts`, `pi-conditions.ts`/pi-ab's conditions, regrade, sim server/perf-cli, a multi-turn harness | D205–D209 | $4 |
| S4 | 5, 8, 9 | `sync.ts`, `packages/client`, `sources/src/guarded.ts`, partner.ts's ask verification; INTEGRATION.md | D210–D214 | $1 |
| S5 | 7 | `cache.ts`, `kg.ts`, a new ingest worker, partner.ts's `store` hook | D215–D219 | $0.5 |
| S6 | 10 | `packages/redact`, a new shared line sanitiser and its callers outside reader.ts and render.ts | D220–D224 | $0.5 |
| W2b | 2 | reader.ts's prompt and verdicts; partner.ts's ask-answer composition | D230–D234 | $4 |
| Wave 2 | 11, final | ablations, deletions, `heldout15` blind confirmation (Pi, Hermes), RealUse-2 | D225+ | about $8 |
