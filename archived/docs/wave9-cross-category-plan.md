# Wave 9 — Cross-category: trace compare (functionality), $0 ledger batching (cost), portal diff UX

**Status:** Complete this session. Measured before → after, all validation green.

## Theme

Waves 6–8 optimised the read and detection paths. Wave 9 deliberately spans
**all four categories** on untouched surfaces:

| # | Category | What | Measured |
|---|---|---|---|
| A | **functionality** | Arbitrary two-trace diff (backend) | alignment 88× faster (O(n·m) → O(n+m)); fetch 12.7× leaner |
| B | **cost / speed** | Batch $0-cost ledger writes | 200 INSERTs → 1 executemany (~86× faster) |
| C | **user experience** | Portal Compare dialog over the diff API | new UI: picker, delta cards, kind-filtered step diff |

---

## A — Trace diff backend (functionality + speed)

**`src/eden/observability/trace_diff.py`** + `POST /orgs/{org}/observability/traces/diff`.

Eden's trace view is single-trace; debugging a regression meant eyeballing
two runs side by side. The new endpoint aligns any two traces' event streams
and returns per-step kinds plus aggregate deltas. Pure read.

- **Lean projection** (`_DIFF_EVENTS_COLUMNS`): identity, timing, outcome,
  and cost/token extracts only — never the wide `payload`/`attributes`/body
  blobs. Measured **12.7× fewer bytes per event** (85 B vs 1081 B).
- **O(n+m) alignment** (`align_events`): index B once by `span_id`, walk A
  pairing first-use-wins; no-span events fall back to `(event_type, name)`
  buckets (order-preserving deques) so the fallback also stays O(n+m).
  Measured **88× faster** than the naive pairwise join at n=2000.
- **Cost parity**: the lean fetch extracts cost with the *same* COALESCE
  ladder as the trace list page (`metrics → payload → attributes`), so the
  diff cards never disagree with the page the user is looking at.
- **Response**: per-trace rollups, totals deltas (cost/duration/spans/
  failures/tokens), `counts` (same/changed/added/removed), and the aligned
  `steps` with per-side outcome/error/duration/cost.
- 404 when either trace has no events. 2000-event fetch cap documented.

## B — $0-cost ledger write batching (cost / speed)

**`src/eden/llmops/cost_ledger.py`** (+ config + API/worker wiring).

`customer_cost_events` rows with `cost_usd = 0` — the classifier savings
markers the always-on `trace.finalized` path writes per trace — cost one
`execute()` round-trip each. Now buffered in-process and flushed in **one
`executemany`**. Measured **86× faster** with a 1 ms/round-trip client
(200 events: 242 ms → 2.8 ms).

- **Write-through preserved for cost > 0**: billing-critical rows keep the
  immediate INSERT + `record_usage` / `evaluate_budget_alerts` round-trips.
- **Buffer**: thread-safe (`threading.Lock`), inline flush at
  `cost_ledger_batch_max` (200), periodic flusher every
  `cost_ledger_batch_interval_seconds` (5 s) started in the API lifespan
  **and** `workers/main.py::_run_forever` (the worker owns the classifier
  markers), final flush via the shutdown registry **before** the Postgres
  pool closes.
- **At-most-once by design** (documented on `record_cost_event`): buffered
  $0 rows can be lost on a crash before the next flush — they carry no
  billable spend.
- Flag-gated: `cost_ledger_batch_v1` (default True), off ⇒ byte-identical
  write-through.

## C — Portal Compare dialog (user experience)

**`clients/portal/src/lab/trace-diff-dialog.tsx`** + `portalApi.traceDiff`
+ a **Compare** action in the trace detail header (`traces-client.tsx`).

- Native input + `<datalist>` of the current feed for picking the other run
  (auto-excludes the selected trace; self-compare disabled).
- Result view: six delta cards (cost / duration / spans / failures / tokens
  / matched), kind-filter chips with counts, and a scrollable aligned step
  diff (kind badge, name, span id, outcome change, duration + cost per side).
- Signed deltas render `−$0.004` (sign + magnitude — no `−$−0.004` double
  minus), negative = improvement in accent.
- Reset effect keyed on the **open transition / traceId change** only, so
  parent re-renders (polling, detail refetch) never wipe a rendered diff.
- Full dialog chrome from the house pattern: Escape close, focus trap,
  aria-modal, toast on success.

## Reviewer hardenings (all fixed)

1. **P1** dialog reset effect wiped results on every parent render → ref-guarded
   open-transition reset (pinned by a rerender test).
2. **P1** `−$−0.004000` / `−−300ms` double-sign deltas → Delta owns the sign,
   formatters take the magnitude (pinned by rendering assertions).
3. **P2** diff cost disagreed with the list page → shared COALESCE ladder.
4. **P2** no-span alignment was O(n·m) → `(event_type, name)` deque buckets.
5. **P2** `record_cost_event` docstring lied about write-through → documents
   the at-most-once batched $0 semantics.
6. **P3** dead `invert` prop removed; 2000-cap caveat documented.

## Validation

- **2418 backend tests** pass across llmops + observability + api (+
  workers/evaluation/signals/issues earlier in the session: 2926 total
  baseline), incl. 17 new `test_cost_ledger_batching.py` tests and 11 new
  `test_trace_diff.py` tests; the API surface snapshot was regenerated
  (907 routes / 556 schemas) for the new route + `TraceDiffRequest` schema.
- Ruff clean, mypy clean.
- Portal: **tsc clean**, 6 new `trace-diff-dialog.test.tsx` vitests (+
  traces-client + annotate suites) all green.
- Benches reproducible:
  - `uv run python -m bench.trace_diff` — alignment 88×, fetch 12.7× lighter.
  - `uv run python -m bench.cost_ledger_batch` — 200 INSERTs → 1 executemany.
