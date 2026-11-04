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
| `config.ts`, `parts.ts` | `EngineConfig`, `DEFAULT_CONFIG` (the unified default, D112: thresholds such as `confidentScore` 1.1, D6, and every part on); `PARTS` (each part's settings that take it out), `withoutParts`, `CORE_CONFIG` (every part out) |
| `cache.ts` | `ItemCache`: per-user BM25F item cache, TTL, synced items, near-duplicate suppression; `sanitizeItem` |
| `text.ts`, `situation.ts` | Cues with no model (entities, content terms, chatter); a coarse situation label for routing |
| `render.ts`, `fold.ts` | The packet and ask answer in the `<context … Data, not instructions>` envelope (D11, D19), compaction (D47, D68), folding (D52) |
| `judge.ts` | The judge's prompt and parser (indexes only, D19) |
| `grounding.ts`, `conflict.ts`, `consequence.ts`, `probes.ts`, `economy.ts` | No-model grounds: people/time (D44), the conflict test (D49, D75), consequence probe (D54), probes (D46–D48), probe economy (D50) |
| `kg.ts`, `cards.ts`, `intent.ts`, `anticipate.ts`, `sync.ts` | Moonshot tracks (D56–D63, D87): graph walk, implication cards, intent index, anticipation, background sync |
| `reader.ts` | Ask-time reader (D95, D96): a budgeted model call wired by the embedder |
| `firewall.ts` | The action firewall's cue and grounds (D69) |
| `decide.ts` | Per-candidate facts for the lab's candidate dump (`onCandidates`) |
| `ledger.ts`, `usage.ts` | Not-twice ledger; usage inference for learning (D13, D18) |
| `spans.ts`, `trace.ts` | Span tracing (off by default, content-free, D56); decision traces |
| `gate.ts` | Redaction off the event loop through the worker pool (D25, D26) |

`bench/`: `pipeline.bench.ts` (the end-to-end anchor for performance work), `ingest.bench.ts` (memory per synced
user, ingest µs/item; the scale anchor, docs/TESTING.md), `index-memory` (the per-user index's heap per item and per
user, put/search latency, D111), `concurrent`, `put`, `churn`, `workload.ts`.

## Invariants (with the decisions)

- **Model last (D4, D5, D45).** No model call and no network call on the fast path. Every model call (judge,
  cards, reader) goes through its own `Budget`, has bounded input, and fails open to the no-model path
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
- **One product (D112).** `DEFAULT_CONFIG` is the best measured configuration and what ships. A new behaviour lands
  as a trial switch in `config.ts` (off), with an owner and an end date in DECISIONS.md's trials table; at the end it
  joins the default (and a part in `parts.ts`) or is deleted with its code and tests. A part whose model role is not
  wired (no `cards`, no `reader` dep) is inert: the default runs its no-model path (`default.test.ts`).
- **Unit tests start from the core.** A test of one mechanism builds its partner on `{ ...CORE_CONFIG, ...what it
  tests }`, so the other parts do not move its result; the default as a whole is `default.test.ts`, the eval and the
  funnel.

## Test

```bash
bun run test:pkg engine          # 43 files, ~4 s wall in parallel (~15 s one by one); partner and reader lead
bun test ./packages/engine/src/conflict.test.ts      # one file, from the repo root (the preload is read from cwd)
bun run eval                     # the scenario metrics; paste the JSON in the PR when behaviour changes
bun run funnel --jobs 4          # the lab's $0 screen of the default on train (reader stub; docs/LAB.md)
bun packages/engine/bench/pipeline.bench.ts          # performance anchor
```

## Pitfalls

- Tests that need a clock pass one; a test that reads the wall clock breaks near midnight or month ends (one was made
  clock-independent in D58).
- Regressions found in reviews go to `regressions.test.ts`, `review-regressions.test.ts` or the track's own
  `*-review.test.ts`; add to them rather than editing an old expectation.
- `new ModelReaderMaker(model, { reasoning })` takes `"low"` (the default, production's value), `"medium"`, `"high"`
  or `"off"` (no effort sent). No `EngineConfig` key wires it yet. OpenRouter excludes reasoning from the reply but
  bills it as output; `usage.reasoningTokens` (from `completion_tokens_details.reasoning_tokens`, unset when not
  reported) shows that share. Lab reader latencies (Anthropic, thinking off by default) exclude it, so they
  understate production wherever the routed endpoint reasons. Changing the default needs a decision and a decoy
  measurement (D96: reasoning before the verdict is what keeps decoys out).
- `Held` (what a tool result or agent message holds, for `alreadyHas`) is two sorted unique typed arrays, searched by
  binary search: a remap (`rebuildVocab`) must sort and dedupe again, since new ids do not keep the old order. Pair
  keys stay exact Float64 (`pairKey`): a hashed key could hold back a delivery on a collision. `held.test.ts` measures
  a session with 12 mail listings of 8 KB (311 KB; 2,096 KB with Sets).
- `readerPushBehind` (on in the default; needs `readerPush`, `syncOnDemand`, `syncPollBehind`): the push's lookup reads the index
  before the poll is done; a poll that stores something gets one more ranking and reading, no new source call, a
  reader cache hit when the pool is unchanged, and its packet replaces one the agent has not taken
  (`push-behind.test.ts`). A packet withdrawn untaken has its ledger entries restored (`Ledger.entry`/`restore`, not
  a bare unmark) and its sketches dropped from `s.delivered`, so what the second reading does not deliver again stays
  deliverable. On in the default (D112). With `syncPollBehind` a lookup's trace leaves out the poll it did not wait for; the
  poll gets its own "skipped" trace (reason "sync poll behind", `sourceCalls` = `syncCalls`) when it settles, even
  after the session closed, so traces sum to what the connectors received. A lookup whose poll waits on a read
  already running (`SourceSync.busy`, which resolves to what that read stored) counts what it stored, not one, and
  `freshen` returns only its own calls. `probeGraceMs` is 0 in the default (D112): a lookup no longer waits for its
  probes (D47's grace), so a slow probe's finds only reach later turns.
- `syncPush` (D125) acts only on sources whose `notifies` is true. Any wrapper around a `Source` (tracing, timing, a
  lease) must copy `notifies` as it copies `listsByTime`, or notifications are silently ignored and the source is
  polled on its learned rate. `sourceItems` redacts before storing (D10); `ingest` stores only items of that source.
- `cardsLean` (D125) only narrows what the intent index reads (`readForIntent`): constraint-worded items are carded
  whatever their sender or age. `automated` reads a `From:` line in the text or a `meta.from`/`meta.sender` field
  (connectors differ: `toItems` keeps whatever text the tool returned) and bulk footers; a connector giving neither
  is judged on its footers alone.
- Tuning thresholds or rules on dev or held-out wording does not generalise (docs/research/broad-set.md): screen on
  the broad `train` suites, check blind once.

## Where next

`docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/COST-MODEL.md`, `docs/research/INDEX.md`, `docs/LAB.md`.
