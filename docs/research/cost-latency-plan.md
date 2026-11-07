# Slashing Eden's cost and latency: hypotheses and plan (CL wave)

Status: 2026-11-07, plan. Goal set by the owner: Eden's all-in cost per task **below the agent alone** (the `tools`
arm), with latency cut hard, measured on **short** (one request per session) and **long** (many requests per user
over days) horizons, without losing the hidden facts Eden raises or raising false concerns. Every paid call goes to
the Anthropic API with `HAIKU_API_KEY` (`claude-haiku-5-5`) through the lab provider (D97), on capped ledgers.

## Where the money and time go (measured, RealUse-2 and fix-s3b)

$ per 1,000 tasks on the 1:1:8 mix (assumed traffic), Haiku 5.5 at $0.10 / $0.50 per M tokens in / out.

|                                  | Short (heldout15, Pi) | Long (`--day 4`, heldout14, Pi)                                 |
| -------------------------------- | --------------------- | --------------------------------------------------------------- |
| tools (base)                     | 0.345                 | 0.340                                                           |
| eden: agent                      | 0.363                 | ≈0.283                                                          |
| eden: reader (0.92 calls a task) | 0.225                 | 0.268                                                           |
| eden: cards and intent backfill  | 0.075                 | 0.138 (spread over 64 tasks; amortises to ~0 per user lifetime) |

- Reader call: 2,800 input tokens (943 cached system prompt, ~1,860 uncached: 12.5 pool items × 240 chars + request),
  166 output tokens; ≈ $0.00019 input + $0.00008 output; p50 1.0 s (TTFT ~0.5 s + ~3 ms per output token).
- Latency on Pi (eden arm): Eden 2.2 s of the agent's wait (39%): the push's blocking wait 0.76–1.28 s,
  `ask_context` 0.76–1.55 s (highest on neutral tasks, where an empty packet makes the agent ask anyway).
- On long horizons the agent is already cheaper with Eden (tool results accumulate in the tools agent's transcript;
  Eden's packets are not stored in it) and the mix's wall p50 is lower (3.28 vs 3.89 s).

## Hypotheses (H1–H18) and their owners

| #   | Hypothesis                                                                                                                                                                                                                                                                                                                                                   | Lever                                 | Owner          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | -------------- |
| H1  | **Read at ingest, not per request.** The card pass also writes each constraint item's applicability (who/what/when it binds, what it does not), checked with no model at request time; the reader runs only on ambiguous matches (a cascade). Differs from D110/D157 (shallow features) because the model writes the rules, once per item, in the background | reader calls 0.92 → ~0.15             | CL1            |
| H2  | Reader verdict reuse across a user's turns and sessions (content hash × request-family key), measured first by `gate-traffic --reuse`                                                                                                                                                                                                                        | long-horizon reader calls             | CL1            |
| H3  | Reader input diet: top-k pool (12.5 → ~6) and a focused window per item (240 → ~160 chars)                                                                                                                                                                                                                                                                   | −50% reader input                     | CL2            |
| H4  | Per-user cached item prefix: the user's hot constraint items as a stable, 1-hour-cached block; each request lists ids and its own extras (cache reads at 0.1×)                                                                                                                                                                                               | −70–80% reader input on long horizons | CL2            |
| H5  | Reader `max_tokens` and stop discipline; why-before-binds kept (D96); D194's short schema is not retried                                                                                                                                                                                                                                                     | output tail                           | CL2            |
| H6  | Batch API (50% off) for background cards and intent; fewer items carded (only constraint-worded and recent)                                                                                                                                                                                                                                                  | −50% backfill                         | CL3            |
| H7  | Cards' and intent's prompt caching and output length audit                                                                                                                                                                                                                                                                                                   | backfill                              | CL3            |
| H8  | **Say "nothing found"**: when the push read and found nothing, the packet says Eden checked; the agent skips `ask_context`                                                                                                                                                                                                                                   | −1 turn, −0.5–1 s on neutral          | CL4            |
| H9  | The ask answers from the push's reading and the index only (no live search, no new reader call) when the push covered the same request (extends D193)                                                                                                                                                                                                        | ask latency                           | CL4            |
| H10 | Non-blocking first call: the push lands on the agent's next model request (or the ask), not before its first; needs H1's no-model verdict to keep quality (D191 failed on a weak pool)                                                                                                                                                                       | −0.8–1.3 s                            | CL4            |
| H11 | Start the push earlier (on the user message event's arrival, before the client's observe wait; or on a typing/draft event where the integration sends one)                                                                                                                                                                                                   | latency                               | CL4            |
| H12 | Adaptive wait: the client's `DEFAULT_WAIT_MS` replaced by the server's estimate of whether a reading is coming                                                                                                                                                                                                                                               | latency                               | CL4            |
| H13 | Agent-side savings: the packet's wording invites a one-call answer (no search when the packet covers it)                                                                                                                                                                                                                                                     | agent turns                           | CL4            |
| H14 | Connector calls: sync polls only for sources with a held doubted item; no fetch for a pool item the reader never names                                                                                                                                                                                                                                       | per-call platforms                    | CL3            |
| H15 | A tiny local model for the reader's yes/no (the D147 moonshot): researched and costed only, built only if H1 fails                                                                                                                                                                                                                                           | reader                                | CL1 (research) |
| H16 | Long-horizon accounting: backfill per user lifetime, not per 96 tasks; days of 12–20 requests over several days                                                                                                                                                                                                                                              | measurement                           | CL5            |
| H17 | A blind suite for the final check (`heldout16`, short and long)                                                                                                                                                                                                                                                                                              | measurement                           | CL5            |
| H18 | Cheaper grader-free screening for the combination search (paid reader replay plus a reader-call counter)                                                                                                                                                                                                                                                     | measurement                           | CL5            |

## Execution

| Session | Hypotheses                                                                                    | Owns                                                                           | Decisions                    | Paid cap |
| ------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------- | -------- |
| CL1     | H1, H2, H15                                                                                   | `cards.ts` (applicability), `reader.ts` cascade hook, partner.ts's reader gate | D233–D235 (D236–D237 unused) | $4       |
| CL2     | H3, H4, H5                                                                                    | `reader.ts` input building and request, the reader's prompt layout             | D238–D241                    | $3       |
| CL3     | H6, H7, H14                                                                                   | `cards-enrich`/the card and intent makers' transport (batch), `sync.ts`        | D242–D245                    | $2       |
| CL4     | H8–H13                                                                                        | partner.ts's push and ask paths, `render.ts` wording, `packages/client` wait   | D246–D250                    | $3       |
| CL5     | H16–H18                                                                                       | `pi-ab`/`pi-day` long horizon, reports, `hidden-heldout16.ts` (blind author)   | D251–D253                    | $2       |
| Combine | best stack of what survives; short and long on train, then blind on heldout16 (Pi and Hermes) |                                                                                | D254+                        | about $6 |

**CL1 outcome (2026-11-07, [cl-cl1.md](cl-cl1.md)):** H1 built and deleted (D233: reader calls 643 → 615 on train, 4
of 100 neutral reads decided; looser rules lost planted facts), H2 not built (D234: 1.08x safe ceiling), H15 not built
(D235: local models AUC 0.44–0.61). H10 needs another no-model verdict: H1 does not provide one.

**CL6 outcome (2026-11-07, [cl-cl6.md](cl-cl6.md)), H19 "the agent is the reader":** promoted (D237). The push hands
the agent its pool's first five items, framed to be checked against the request, with no reader call. Pi, train
seeds 41–42, 1:1:8 mix, steady $/1k: short 0.338 (tools 0.368, old default 0.631), long 0.326 (tools 0.317, old
0.568) with signal notices; hidden −3.6 points pooled (−8.4..+1.2); neutral wall −0.7 to −1.4 s. Variants deleted
(D236). Against the merged default (CL2's early stop on, payload notices): 0.428 vs 0.612 (short), 0.366 vs 0.494
(long), hidden −4.8 points (−10.8..+1.2); as billed with payload notices still $0.03–0.06/1k above the agent alone.
The reader-side levers (H1–H5) now apply only to `pushCandidates: 0`.

Every lever enters as a trial switch (D112), is screened at $0 where possible (paid reader replay, `gate-traffic`),
then measured live on Pi on train suites, **short and long horizon**, and is promoted or deleted with its code.

**CL7 outcome (2026-11-07, [cl-cl7.md](cl-cl7.md)):** H8's note (`pushChecked`, D246) deleted (D257): hidden −5.1
points pooled (−9.1..−1.2; about −1.9 attributable to the note, the rest sampling), not shown neutral, for
−$0.02–0.03/1k and −0.2–0.5 s where asks are slow. Current default vs `tools` on the
1:1:8 mix: steady $0.580–0.597 (short) and $0.470–0.515 (long) per 1,000 tasks against $0.383 and $0.301.

**Blind check (2026-11-07, [realuse-3/pi-heldout16.md](realuse-3/pi-heldout16.md)), heldout16 on Pi, payload notices:**
steady $/1k on the 1:1:8 mix eden 0.378 against tools 0.357 (short, paired +0.021, −0.000..+0.043) and 0.352 against
0.391 (long, two days, −0.049, −0.069..−0.029); wall mean −2.0 s (short) and −0.9 s (long); hidden 80% against 11%;
against the reader (`pushCandidates` 0) hidden −4.9 points pooled (−11.1..+1.4), regraded concerns −0.3 (−0.8..0.0).
The pre-registered rule keeps `pushCandidates` 5. heldout16 is read.
