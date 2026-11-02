# @eden/engine

`ContextPartner`: the context partner itself. `observe` sees each session event and, rarely, injects context unasked;
`ask` answers the agent's question; `checkAction` reads a tool call before it runs (D69). Two speeds: a fast path
with no network and no model call, a background slow path (route, live search, cache, score, maybe one budgeted
model call). [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) describes every path and flag; read it first.

**Another session may be editing `src/*.ts`: check `git log origin/main -- packages/engine` before changing code.**

## Files (src/)

| File | Owns |
|---|---|
| `partner.ts` (5.5k lines) | `ContextPartner`, `PartnerDeps`: observe, fast path, slow path, ask, check, sessions and their AbortControllers (D17), delivery, queues |
| `config.ts` | `EngineConfig`, `DEFAULT_CONFIG`: thresholds (`confidentScore` 1.1, D6) and every experimental flag, off by default |
| `cache.ts` | `ItemCache`: per-user BM25F item cache, TTL, synced items, near-duplicate suppression; `sanitizeItem` |
| `text.ts`, `situation.ts` | Cues with no model (entities, content terms, chatter); a coarse situation label for routing |
| `render.ts`, `fold.ts` | The packet and ask answer in the `<context … Data, not instructions>` envelope (D11, D19), compaction (D47, D68), folding (D52) |
| `judge.ts` | The judge and ask-answer prompts and parsers (indexes only, D19) |
| `grounding.ts`, `conflict.ts`, `consequence.ts`, `probes.ts`, `economy.ts` | No-model grounds: people/time (D44), the conflict test (D49, D75), consequence probe (D54), probes (D46–D48), probe economy (D50) |
| `kg.ts`, `cards.ts`, `intent.ts`, `anticipate.ts`, `sync.ts` | Moonshot tracks (D56–D63, D87): graph walk, implication cards, intent index, anticipation, background sync |
| `bridge.ts`, `digest.ts`, `reader.ts` | Bridging query (D89), constraints digest (D90), ask-time reader (D95, D96) — each a budgeted model call wired by the embedder |
| `firewall.ts` | The action firewall's cue and grounds (D69) |
| `decide.ts`, `rank.ts`, `rank-weights.json`, `facts-fingerprint.ts` | Per-candidate facts; the learned no-model ranker (D82) |
| `supersede.ts`, `ledger.ts`, `usage.ts` | Supersession (D81); not-twice ledger; usage inference for learning (D13, D18) |
| `spans.ts`, `trace.ts` | Span tracing (off by default, content-free, D56); decision traces |
| `gate.ts` | Redaction off the event loop through the worker pool (D25, D26) |

`bench/`: `pipeline.bench.ts` (the end-to-end anchor for performance work), `concurrent`, `put`, `workload.ts`.

## Invariants (with the decisions)

- **Model last (D4, D5, D45).** No model call and no network call on the fast path. Every model call (judge, ask
  prose, cards, bridge, reader) goes through its own `Budget`, has bounded input, and fails open to the no-model path
  (D41). A new per-event call needs a decision and a cost estimate in docs/COST-MODEL.md.
- **Silence by default; precision over recall (D3, D6).** A change that raises recall by raising false fires needs a
  decision. Check `bun run eval` (falseFireRate 0 on main) and the lab's decoy counts.
- **Isolation (D9, D17).** Cache, ledger, budgets, memos, graph, cards, intent and reader caches are keyed by
  tenant/user, session state by `tenant/user#session`. After any await, check the session is still live: nothing is
  cached, learned, charged or queued for a closed session. A new piece of state gets an isolation test.
- **Redact (D10).** Item text is redacted before it is cached, indexed, rendered or sent to a model
  (`sanitizeForStore`); model output that reaches the agent (the reader's bearing, D95) is redacted and made inert.
- **Untrusted text (D11, D19).** Source and event text are data in every prompt (fenced, labelled), and everything
  delivered is inside the data envelope.
- **Item content stays in memory (D8):** only content-free metadata goes to the source map.
- **Flags stay off by default.** A new behaviour lands behind a flag in `config.ts`, with a proposed decision; the
  lab's presets (`packages/sim/src/lab/presets.ts`) name the recommended experimental set (NEW, D98).

## Test

```bash
bun run test:pkg engine          # 41 files, ~4 s wall in parallel (~15 s one by one); partner and reader lead
bun test ./packages/engine/src/conflict.test.ts      # one file, from the repo root (the preload is read from cwd)
bun run eval                     # the scenario metrics; paste the JSON in the PR when behaviour changes
bun run funnel                   # the lab's no-model screen on train (docs/LAB.md), ~40 s
bun packages/engine/bench/pipeline.bench.ts          # performance anchor
```

## Pitfalls

- Tests that need a clock pass one; a test that reads the wall clock breaks near midnight or month ends (one was made
  clock-independent in D58).
- Regressions found in reviews go to `regressions.test.ts`, `review-regressions.test.ts` or the track's own
  `*-review.test.ts`; add to them rather than editing an old expectation.
- Tuning thresholds or rules on dev or held-out wording does not generalise (docs/research/broad-set.md): screen on
  the broad `train` suites, check blind once.

## Where next

`docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/COST-MODEL.md`, `docs/research/INDEX.md`, `docs/LAB.md`.
