# @eden/engine

`ContextPartner`: the context partner itself. `observe` sees each session event and, rarely, injects context unasked;
`ask` answers the agent's question; `checkAction` reads a tool call before it runs (D69). Two speeds: a fast path
with no network and no model call, a background slow path (route, live search, cache, score, maybe one budgeted
model call). [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) describes every path and flag; read it first.

**Another session may be editing `src/*.ts`: check `git log origin/main -- packages/engine` before changing code.**

## Files (src/)

| File | Owns |
|---|---|
| `partner.ts` (5,081 lines) | `ContextPartner`, `PartnerDeps`: observe, fast path, slow path, ask, check, sessions and their AbortControllers (D17), delivery, queues |
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
bun run test:pkg engine          # 49 files, 8-10 s wall (two runs, shared 4-core box, 2026-11-05); partner and reader lead
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
- `new ModelReaderMaker(model, { reasoning })` takes `"off"` (the default since D144: no effort sent, the request
  every lab quality figure measured), `"low"`, `"medium"` or `"high"`. No `EngineConfig` key wires it; the servers
  build it with no options, so they ship "off". D96's decoy cut came from the prompt writing `why` before `binds`
  (READER_SYSTEM v4/v5), not from provider reasoning. On Haiku 5.5 (Anthropic-direct, default pool) "low" was 2.38x
  slower at p50, 1.59x dearer, and 38 of 60 calls ran past `askReaderWaitMs` (docs/COST-MODEL.md, `reader-time.ts`).
  When a caller asks for reasoning, OpenRouter excludes it from the reply but bills it as output;
  `usage.reasoningTokens` (from `completion_tokens_details.reasoning_tokens`, unset when not reported) shows that
  share. The lab's reader replay key treats a `claude-*` reader request with no reasoning as the pre-D144 "low" line
  (`reader-disk.ts`, `keyedReasoning`), so recorded caches still replay. Making reasoning the default again needs a
  decision and a decoy measurement.
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
- **Deliveries go through `deliverChecked` (D126)** in every async path, so `verifyDelivery` can re-read copies a signal put in doubt;
  only the fast path calls `deliver` directly, and it hands a doubted item (`doubted`) to the slow path instead. The
  reader's push runs `verifyItems` itself, re-checks that no newer user message came during the re-reads, then calls
  `deliver`: a packet marked delivered and not queued would be lost. A re-read started ahead (`checkAhead`) makes the
  cached copy current, so `verifyItems` also applies a session's recent re-reads, not only doubted items. A new
  delivery path uses `deliverChecked`, never `deliver`, or it can send a stale copy. `deliverChecked` itself calls
  `deliver` (a bulk rename of `return this.deliver(` once made it call itself forever: the tests hung, not failed).
- **An ask says "Nothing in the connected sources." only when its sources answered (D127).** `searchLive` returns
  each chosen source's status (`sources`: the fan-out's, or "local" for a synced source answered from the index);
  `honestAnswer` names any that did not answer (error, timeout, circuit open, busy, limited) and says the empty answer
  is not an all-clear, and `AskResponse.sources` carries the statuses. A new lookup path an ask answers from must
  return statuses too, or an outage reads as "nothing". A failed on-demand sync poll (`freshen`) feeds the status
  through `localOf`, not a status of its own: it leaves the copy not current, so the source is searched live and that
  search's status stands. An ask never passes `behind`, so a warm-but-stale copy is not "local" there
  (`review-regressions.test.ts`); only the reader push's first reading answers from it. A session that ends before the
  search runs returns `closed`, and the answer says so rather than "nothing". Probes are extra queries
  beside a chosen source's own search, whose outcome gives the source's status.
- **Shown means handed out.** With `askDedup`, what an injection showed is noted (`noteShown`) in `handOut`, which
  every path that gives the agent an injection calls (observe's reply, `takePending`, the firewall's finding, the
  ask's own answer), not when `deliver` builds it: a queued packet the agent has not taken was shown nothing, so an
  ask before `takePending` says its items in full. The ask then drops from `s.pending` a packet whose every item it
  cited; one cited in part stays queued (`review-regressions.test.ts`).
- `confident()` is one loop that stops at the cap, cheap tests first; every test in it must judge one item alone (no
  state across items), or stopping early would change its output.
- **A re-read never revives a held-gone id (D126).** `recheck` checks `ItemCache.isHeldGone` after its fetch and
  before `revive`/`store`: a `sourceRemoved` can land while the fetch is on the wire, and reviving would lift the
  hold and deliver the deleted item. Any new path that stores a re-read or pushed copy must not `revive` an id a
  removal holds unless that copy is itself newer than the removal (`sourceItems` is: the source sent it again).
- **`checkAhead` runs only once the reader will be called (D134):** after `readAsk`'s empty-pool and `readerGate`
  returns. Moving it back above the gate makes every gated ask pay up to `VERIFY_AHEAD` connector calls.
- **One deadline per lookup (D140).** `searchLive` takes `deadlineAt` once, after resolving the sources and before
  the on-demand poll; the poll's signal, the live search's `timeoutMs`, the planner and the probes
  (`ProbeOpts.deadlineAt`) get only what is left. Do not give a later stage a fresh `sourceTimeoutMs`: an ask waits
  for its poll, so the stages add up. Under `MIN_SEARCH_MS` (50) left, the search is skipped with "timeout" statuses
  and no call (no rate token or breaker failure for a call that could not answer). `Sync.freshen` skips a source
  whose on-demand poll gave up within `demandTimeoutMs` (= `sourceTimeoutMs`), so the next lookup searches it live
  instead of waiting on the same listing.
- `fetchChecked`'s `gone` needs `Source.fetchReportsGone`: an MCP tool's null fetch proves nothing, so verification
  never deletes an MCP item on its own; deletions there come from `sourceRemoved` or the sweep.
- Tuning thresholds or rules on dev or held-out wording does not generalise (docs/research/broad-set.md): screen on
  the broad `train` suites, check blind once.

## Where next

`docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `docs/COST-MODEL.md`, `docs/research/INDEX.md`, `docs/LAB.md`.
