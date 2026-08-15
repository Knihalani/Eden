# Eden — Consolidated, Ranked Optimization Action List

## What this is

This document consolidates every distinct, actionable optimization/fix item
identified across the six finalized (pass-4) strategic-review docs in
`docs/specs/strategic-review-2026-08/optimizations/`:

1. `01-hotpath-perf.md` — hot-path performance (`search_service.py`,
   `signals/investigator.py`)
2. `02-db-queries.md` — database query patterns (missing indexes, N+1s,
   redundant fetches)
3. `03-llm-cost.md` — LLM cost/telemetry accuracy
4. `04-frontend-perf.md` — portal frontend performance
5. `05-cron-jobs.md` — cron/background-job efficiency
6. `06-storage-retention.md` — storage growth and retention-policy gaps

Each source doc had already been through 2-3 rounds of independent
source-verification by the time it reached pass 4 (final). This document
does not re-verify those findings from scratch — it extracts, deduplicates
across docs, and ranks them into one prioritized backlog. Where a doc's own
wording flagged uncertainty about a number (unreproducible benchmark,
estimated-not-measured, evidence-integrity flag), that caveat is preserved
here rather than smoothed over.

## How this was built

Three passes read all six source documents in full (in parallel, one pass
per document cluster: `01`+`02` together since they share findings, `03`
alone, and `04`+`05`+`06` together), extracting every distinct actionable
point with its source citation, mechanism, fix, quantified impact (labeled
MEASURED / DERIVED-FROM-CODE / ESTIMATED exactly as each source doc
characterizes it), severity, effort, and confidence. The extracted points
were then merged (two genuine cross-doc duplicates were found and combined
— see Appendix), tiered by severity, and ordered.

**61 distinct points** were extracted in total.

## Ranking methodology

The numbered list below is sorted:

1. **Primarily by severity/impact tier** — Critical → High →
   Medium-High → Medium → Low-Medium → Low.
2. **Secondarily by confidence** — within a tier, points the source docs
   verified with higher confidence (direct source reads, reproduced bugs,
   exact line citations) are ranked above points flagged as
   estimated/unverified/order-of-magnitude-only.
3. **Effort is noted, not used as a sort key.** Where a point is both
   high-severity and small-effort, it is explicitly called out as a
   **QUICK WIN** — these are the best return-on-effort items regardless of
   where they land in strict severity order, and are worth pulling forward
   in actual sprint planning even though this list doesn't reorder around
   effort.

Severity tiers reflect each source doc's own framing where the doc gave
one explicitly (e.g. "CRITICAL" tags, "highest severity" language,
"Priority order" lists); where a doc didn't assign an explicit tier, the
tier here was inferred from the doc's own description of consequences.

---

## Ranked Action List

### CRITICAL

#### 1. Add missing composite indexes for `signal_events`'s two real read paths
**QUICK WIN — Critical severity, Small effort, migration fully drafted.**

- **Source:** `02-db-queries.md` F1 (L73-213) — the source doc's own #1
  priority item, "Priority order for execution."
- **Description:** `signal_events` has shipped since migration 092 with
  exactly one index — a bare `(trace_id)` btree — which serves neither of
  the table's two real read patterns: (1) `list_signal_events`
  (`api/routes/signal_investigator.py:40-94`) filters
  `WHERE org_id = $1 AND signal_id = $2 [AND matched = $3] ORDER BY
  detected_at DESC`; (2) `cluster_signal` (`clusterer.py:72-86`) filters
  `WHERE org_id = $1 AND signal_id = $2 AND matched = TRUE AND
  detected_at >= $3 ORDER BY detected_at DESC LIMIT 500`. Neither query can
  use the trace_id index. Write volume: up to 20 rows per trace (bounded by
  `signal_definitions`' `LIMIT 20`), from `investigator.py`'s per-row
  insert loop. The team's own `scripts/cost_model.py` documents
  `ROWS_PER_TRACE=35` at `TRACES_PER_ORG_DAY=1,000` for an
  "actively-instrumented org" (a documented cost assumption, not measured
  production data).
- **Fix (exact migration provided in source doc):** New migration
  `143_signal_events_indexes.py` adding two `CREATE INDEX IF NOT EXISTS`
  statements: (a) a full composite
  `idx_signal_events_org_signal_detected ON signal_events (org_id,
  signal_id, detected_at DESC)`, needed because `list_signal_events` passes
  `matched` as a bound parameter (not provable at plan time); (b) a partial
  index `idx_signal_events_org_signal_matched_detected ON signal_events
  (org_id, signal_id, detected_at DESC) WHERE matched = TRUE`, usable
  because `clusterer.py` hardcodes `matched = TRUE` as a literal. No
  `CONCURRENTLY` needed — `signal_events` is INSERT-only, so a plain
  `CREATE INDEX IF NOT EXISTS` never blocks inserts. Both additive, zero
  downtime, no backfill.
- **Impact:** Not independently latency-benchmarked (no live Postgres
  available during review), but the missing-index fact is VERIFIED with
  certainty against migration files and live application code, and both
  real read-path queries provably cannot use the existing index.
- **Severity:** Critical (source doc's own top-ranked tier).
- **Effort:** Small (migration fully drafted, additive, zero-downtime).
- **Confidence:** High.

#### 2. Fix dead `eden.kb.embeddings` import that silently disables real clustering (produces an 88.7%-false-positive mega-cluster) and the O(n²) grouping cost it masks
- **Source:** `01-hotpath-perf.md` Finding 5 (L36-179) + `02-db-queries.md`
  F2 (L215-368, CRITICAL) — **cross-doc duplicate, merged**; `01`
  explicitly states "This is the same bug `optimizations/02-db-queries.md`
  documents in more depth as its F2." `02` is the fuller forensic version.
- **Description:** Two independently-actionable sub-problems the source
  docs insist must be fixed together (fixing one alone makes things
  worse):
  - **(a) Broken import → silent no-op → degenerate clustering
    (correctness bug).** `signals/clusterer.py::_embed` (`:195-212`) does
    `from eden.kb.embeddings import get_default_embedder` inside a `try`.
    This module does not exist anywhere in the source tree — confirmed by
    direct live import (`ModuleNotFoundError`) in both docs independently.
    `git log --diff-filter=A` shows `clusterer.py` and the real module
    (`eden/kb/ledger/embeddings.py`, which doesn't even define
    `get_default_embedder`) were added in the **same commit** (`95401573`)
    — this has never worked, it isn't a regression. The identical broken
    import exists at a second call site,
    `observability/patterns_clusterer.py:147-148`. The `except Exception`
    at `:205` catches this on every call at **debug level only**
    (invisible in production), then falls through to a deterministic
    hash-based 8-dim fallback vector. `02-db-queries.md` proved via
    simulation (500 real summary strings, actual `stable_hash`) that this
    fallback isn't just cheap-but-harmless: pairwise cosine similarity
    across the hash vectors is min=0.098, p50=0.999, max=1.0, with
    **88.7% of the 124,750 unique pairs scoring ≥ the 0.82 clustering
    threshold** (MEASURED via simulation), and running the actual grouping
    loop collapses **478 of 500 rows into one semantically-meaningless
    mega-cluster**. This is written to `signal_clusters` and surfaced to
    users via the portal / `GET /signal-clusters`. All three call sites in
    `investigator.py` also wrap `cluster_after_match` in a bare
    `except Exception: pass` with zero logging, compounding the
    invisibility.
  - **(b) O(n²) grouping loop, real and currently masked by (a), runs
    directly on the event loop.** The pairwise grouping loop
    (`clusterer.py:105-119`) is bounded by `C(n,2) = 124,750` calls at
    n=500 (a corrected number vs. an earlier pass's incorrect n²=250,000
    estimate). This is a worst-case bound reached only when nothing
    clusters — real hash vectors currently cluster so aggressively that
    actual call counts land far lower (400-2,400 at n=500, MEASURED via
    reruns but not consistently reproducible). If the import bug were
    fixed and a real embedder wired in: `02-db-queries.md` measured
    ~53.8µs/comparison at 384 dims (~6.7s worst-case total at n=500,
    MEASURED); `01-hotpath-perf.md`'s independent bench gives ~5-15s at
    dim=384 / ~20-85s at dim=1536 at n=500 — but explicitly flags this as
    "not committed anywhere in the repo," disagreeing with the other doc's
    own number by 2-5x, and states "treat it as a corroborated order of
    magnitude, not a measurement." At the documented
    `TRACES_PER_ORG_DAY=1,000` / 14-day lookback, the `LIMIT 500` fetch
    saturates whenever a signal's match rate is ≥ ~3.6% — a low bar, so
    n=500 is the steady state for any moderately active signal, not a tail
    case (DERIVED-FROM-CODE). The loop is not `to_thread`'d — it blocks
    the entire single-threaded asyncio event loop for its full duration,
    stalling every other concurrent request/org sharing that worker
    process. (Python's own docs confirm `to_thread` wouldn't help
    CPU-bound work anyway.) A separate, smaller inefficiency: `_cosine`
    recomputes the outer-loop vector's L2 norm from scratch on every
    pairwise call even though it's invariant across the inner loop.
- **Fix:** (1) Apply the F1/item-1 index fix first (cheapest lever,
  shrinks the fetch cost regardless). (2) Either point `_embed` at a real
  embedder or replace the degenerate fallback with something that doesn't
  systematically over-cluster (e.g. Jaccard similarity on summary text).
  (3) Upgrade the swallowed exceptions to error-level logging/metrics at
  both `_embed` and the three `investigator.py` call sites. (4) Cap/batch
  the O(n²) grouping and move it to a process pool (not `to_thread`) or off
  the synchronous request path entirely. (5) Precompute vector norms once.
  (6) Batch the per-group cluster INSERTs (currently unbatched, up to
  ⌊n/2⌋ per call). (7) Debounce clustering instead of running on every
  match. **Do not fix the import in isolation** — doing so without also
  fixing the O(n²) cost would convert a silent correctness bug into a
  synchronous multi-second-to-tens-of-seconds event-loop stall, up to 20x
  per `investigate_trace` request, or blocking the 5-slot-concurrent async
  ingest consumer.
- **Impact:** 88.7% false-positive-cluster rate (MEASURED via simulation).
  O(n²) cost: 333ms at d=8 / ~6.7s at d=384 (MEASURED, `02`) vs. ~5-15s at
  d=384 / ~20-85s at d=1536 (MEASURED but explicitly flagged
  non-reproducible/order-of-magnitude-only, disagreeing 2-5x across
  independent runs, `01`). Comparison-count ceiling of 124,750 at n=500 is
  DERIVED-FROM-CODE (provable bound).
  This bug also fires on the async ingest path (`trace_finalized_consumer.py::_run_signal_investigator`),
  not only the synchronous `investigate_trace` HTTP route.
- **Severity:** Critical (both docs' own tier — `02-db-queries.md`
  explicitly rates this CRITICAL, reframed from "a perf problem" to "a
  shipped, invisible product-correctness bug that also costs CPU on the
  shared ingest path").
- **Effort:** Medium-Large (touches embedder wiring, algorithm, threading
  model, and logging across two call sites).
- **Confidence:** High on the dead-import reproduction and the 88.7%
  mega-cluster simulation (both independently reproduced by both docs).
  Medium on the exact O(n²) cost magnitude (real and order-of-magnitude
  confirmed, but figures disagree 2-5x across independent measurements and
  scripts aren't committed to the repo).

#### 3. Fix `auto_curator`'s unwatermarked org-selection query
- **Source:** `05-cron-jobs.md` "Full schedule map" (L108), "Systematic
  check" table (L131), "Pass 3 — unified fix" (L389-421), verdict table
  (L559).
- **Description:** `cron_tick.py:202` runs `SELECT id::text AS org_id FROM
  organizations LIMIT 50` daily with **no `ORDER BY` and no time-window
  floor** — it scans the entire `organizations` table every day. Without
  `ORDER BY`, Postgres gives no ordering guarantee, and in practice tends
  to return a stable subset per plan — meaning the same 50 orgs can be
  served every single run while every org past that cursor is permanently
  excluded, and the excluded set grows forever as the org base grows. This
  never errors (`pg.fetch` succeeds, the tick logs success), so it is
  **invisible to exception-based monitoring**.
- **Fix:** Replace with a watermarked selection using a reusable helper
  `fetch_stale_candidates()` (sketched in the source doc) that left-joins
  the candidate query against a new side-table
  `auto_curator_watermark(org_id, last_processed_at)`, returning the
  oldest-processed-first `limit` rows, then calling `advance_watermark()`
  per org after `AutoCurator.run_for_org` completes — mirroring the
  in-table pattern already proven in `columnar/compaction.py`
  (`ORDER BY last_compaction_at ASC NULLS FIRST`). This same helper is
  reused by the fixes for items 8 and 25 below.
- **Impact:** Not independently measured (no coverage metric exists to
  measure the actual excluded-org count today); mechanism DERIVED-FROM-CODE
  (re-verified pass-4).
- **Severity:** Critical/High — the source doc's own verdict table calls
  this the "highest severity" of the five watermark bugs found: "silent,
  permanent, worsening-with-growth coverage gap, not a performance issue."
- **Effort:** Medium (new watermark table + helper + two-line call-site
  change; the helper is shared across four related fixes).
- **Confidence:** High (re-verified pass-4; SQL string matched exactly
  against source).

---

### HIGH

#### 4. Make Typesense faceting opt-in instead of always-on in `search()`
**QUICK WIN candidate — High severity (code-level), Small effort.**

- **Source:** `01-hotpath-perf.md` Findings table row 1 (L198); mechanism
  corroborated L303-322.
- **Description:** `SearchService.search()` (`search_service.py:441-450`)
  always requests `facet_by=DEFAULT_FACET_FIELDS` (5 fields,
  `max_facet_values=25`) on every call — including empty-query (`q=""`)
  calls that Typesense treats as match-all, where facet aggregation cost is
  computed over the entire matched corpus. `suggest()` in the same file
  already narrows to a single facet (`:559`) specifically to avoid this
  cost — `search()` doesn't follow its own established pattern.
- **Fix:** Default `facet_by=None` in `search()`; move faceting to the
  existing, currently underused `SearchService.facets()` method
  (`:565-584`), invoked only when the filter panel UI is actually open,
  with a short TTL cache on the result.
- **Impact:** Typesense's own docs confirm facet cost scales with
  `max_facet_values` and matched-corpus size; a community benchmark showed
  ~3ms flat facet cost up to ~78ms at `max_facet_values=100000` on a
  ~3k-doc collection — explicitly labeled "weak circumstantial
  corroboration, not a stand-in for an Eden-specific measurement" (that
  test collection is 3-4 orders of magnitude smaller than Eden's 1.1M-doc
  target). No Eden-specific ms number exists; magnitude is UNMEASURED/
  ESTIMATED.
- **Severity:** High (code-level bug is a fact) / Medium (exact magnitude
  uncertain, pending the unreproducible F12 benchmark — see item 13).
- **Effort:** Small.
- **Confidence:** High on the code-level bug; Medium on quantified impact.

#### 5. Fix `rca_chain`'s double-fetch of an unbounded, wide `telemetry_events` query
- **Source:** `02-db-queries.md` F3 — HIGH (L370-416).
- **Description:** `api/routes/intelligence_rca.py::rca_chain` (`:127-148`)
  calls `_fetch_trace_events(org_id, trace_id)` directly, then calls
  `_rca.categorize(org_id, trace_id)`, which internally
  (`insights/rca/analyzer.py:89`) calls `_fetch_trace_events` **again**
  for the identical `(org_id, trace_id)` pair — a redundant second fetch
  within the same HTTP request. The underlying query
  (`insights/rca/_common.py:104-140`) has **no `LIMIT`** and selects the
  heaviest columns on the table unconditionally, including `payload`,
  `attributes`, `tags`, `tool_calls_full`, `tool_results`, `request_body`,
  `response_body`. The existing index
  (`idx_telemetry_events_trace_id (trace_id, timestamp ASC)`) already
  fully serves the query, so no new index is needed — the problem is
  purely the double-fetch and the unbounded/wide `SELECT`. (Contrast:
  `RootCauseAnalyzer.explain` correctly reuses `categorize()`'s result and
  does one bounded query — this bug is specific to `rca_chain`.)
- **Fix:** Give `RootCauseAnalyzer.categorize`/`explain` an optional
  `events: list[dict] | None = None` parameter so `rca_chain` can pass its
  already-fetched events instead of triggering a second fetch. Add a
  `LIMIT` (e.g. 2000 rows or a byte-budget) to `_fetch_trace_events`, and
  create a "thin" variant excluding the heaviest columns for the
  chain/list view where they aren't needed.
- **Impact:** Not independently latency-benchmarked; the doubled
  unbounded/wide fetch is source-VERIFIED as a structural inefficiency
  (one full extra round trip plus unnecessary bandwidth/memory for the
  heaviest columns, on every `rca_chain` call, scaling with unbounded
  trace size).
- **Severity:** High (source doc's own tier).
- **Effort:** Small-Medium.
- **Confidence:** High (verified directly from source, unchanged across
  passes).

#### 6. Implement real retention enforcement for `quarantine_events`
**QUICK WIN — High severity, Small effort, only no-op policy with a
confirmed live unbounded-growth mechanism.**

- **Source:** `06-storage-retention.md` fix table (L167), "Other
  storage-growth risks" (L129).
- **Description:** `quarantine_events` has a real backing table
  (`008_phase_5_5_data_platform.py:77-99`) and a declared policy (`7, 30,
  90, 90`), but it silently no-ops: `run_retention_policy`
  (`retention.py:456-505`) has no PII branch, no archive branch, and the
  deletion `elif policy.delete_after_days <= policy.warm_days` at `:498`
  is False (90 ≤ 30 is False) — this dead-`elif` trap is confirmed false
  for **all 8** current `DEFAULT_POLICIES` entries, so it silently
  disables enforcement across the board, not just here. Unlike the other
  five no-op policies (items 39/57/58/59 below), this one has a
  **currently confirmed live growth mechanism**: its only deletion path is
  `silver_etl.py:797-803`, which removes rows only on successful
  reprocessing — rows with unparseable payloads, or that are never
  reprocessed, are kept forever with no age-based cleanup.
- **Fix:** Add a dedicated dispatch branch (mirroring the existing
  `debug_dumps` pattern at `retention.py:484-489`):
  `elif policy.data_type == "quarantine_events": DELETE FROM
  quarantine_events WHERE quarantined_at < $1` at the existing
  `delete_after_days=90`, independent of `resolution`.
- **Impact:** Not quantified in rows/GB, but explicitly flagged as a live,
  ongoing unbounded-growth risk — not just a hygiene/false-confidence issue
  like the other five no-op policies.
- **Severity:** High.
- **Effort:** Small.
- **Confidence:** High.

#### 7. Fix `classifier_retrain`'s unwatermarked org/signal-pair selection query (highest tick frequency of the watermark bugs)
- **Source:** `05-cron-jobs.md` "Full schedule map" (L114), finding #3
  (L158-168), unified fix table (L420), verdict table (L561).
- **Description:** `classifier_pipeline.py:234-241` runs `SELECT DISTINCT
  org_id, signal_id FROM signal_events WHERE detected_at > now()-7d LIMIT
  50` every 15 minutes — **96 ticks/day, the highest frequency of the five
  buggy queries found** — with no `ORDER BY`. A `SELECT DISTINCT` on a
  stable, mostly-append-only table commonly gets served by the same
  hash-aggregate plan run to run, meaning the same 50 (org, signal) pairs
  could win every tick indefinitely and every other pair's classifier
  never retrains — this "self-heals" only if Postgres happens to vary its
  plan, which is not guaranteed.
- **Fix:** Same `fetch_stale_candidates()` helper as item 3, new
  `classifier_retrain_watermark(org_id, signal_id, last_processed_at)`
  table. The doc notes this is literally the same shape as
  `insights/detector_loop.py`'s already-working watermark for a
  near-identical problem — copy that table rather than reinventing it.
- **Impact:** Not independently measured; DERIVED-FROM-CODE.
- **Severity:** High (same defect class as items 3/8, but highest tick
  frequency of the five).
- **Effort:** Small-Medium (existing near-identical template to copy).
- **Confidence:** High (re-verified pass-4).

#### 8. Fix `drift_baselines`'s unwatermarked org/agent-pair selection query
- **Source:** `05-cron-jobs.md` "Systematic check" table (L132), finding
  #2 (L153-157), unified fix table (L419), verdict table (L560).
- **Description:** `drift_baseline_worker.py:27-33` runs `SELECT DISTINCT
  org_id, agent_id FROM agent_issues WHERE last_seen >= now()-7d LIMIT
  100` weekly with no `ORDER BY`. The 7-day activity window narrows the
  blast radius vs. item 3 (the candidate set changes week to week), but
  it's the same missing-watermark defect.
- **Fix:** Same `fetch_stale_candidates()` helper, new
  `drift_baseline_watermark(org_id, agent_id, last_processed_at)` table,
  advance after the 7-dimension loop (see item 25) completes for that
  pair.
- **Impact:** Not independently measured; DERIVED-FROM-CODE.
- **Severity:** High.
- **Effort:** Medium.
- **Confidence:** High (re-verified pass-4).

#### 9. Virtualize the issues kanban board
**QUICK WIN — High severity, Small effort, existing in-repo pattern to
reuse.**

- **Source:** `04-frontend-perf.md` "Worst offender" section +
  "Recommendation" #1 (L15-16, 34-40, 73-76).
- **Description:** `issues-client.tsx:704-709` renders every issue in
  every kanban column as a real, un-windowed DOM node via `.map()` —
  despite `@tanstack/react-virtual` + a shared helper
  (`clients/portal/src/lab/virtual-list.ts`) already being a proven,
  test-covered pattern one directory over in `traces-client.tsx`.
- **Fix:** Reuse `useVirtualizer` + `measureVirtualRow` exactly as
  `traces-client.tsx:848-858` does; no new dependency or infra needed.
- **Impact:** DERIVED-FROM-CODE — worst case is all 200 issues (server
  cap) in one column → ~200 × ~10 DOM nodes/row ≈ 2,000 DOM nodes.
  "Bounded and modest in absolute terms even at the cap," per the doc.
- **Severity:** High (source doc's own priority-#1 recommendation).
- **Effort:** Small (existing helper + pattern, no new dependency).
- **Confidence:** High (doc's fact-check status: 3 internal verification
  passes, no claim found false/unverifiable).

#### 10. Virtualize the session-turn timeline list (no server-side cap at all)
- **Source:** `04-frontend-perf.md` "Worst offender" points 2-3 (L17-18) +
  "Concrete DOM-cost estimates" (L42) + "Recommendation" #1 (L73, 75).
- **Description:** `clients/portal/src/lab/traces-session-lens.tsx:312,320`
  renders the session-turn timeline as plain `.map()` with no windowing.
  This is structurally worse than item 9 because the underlying data has
  **no server-side cap at all** — a long-running agent session can produce
  an unbounded number of turns, each a full `TurnCard` subtree (already
  `memo`-wrapped, so this fix is windowing-only).
- **Fix:** Same `useVirtualizer`/`measureVirtualRow` reuse as item 9.
- **Impact:** DERIVED-FROM-CODE for per-row cost (~11-15 DOM
  nodes/`TurnCard`). Worst-case row *count* is explicitly ESTIMATED/
  illustrative, not measured: the doc models ~2,880 turns over a 24h
  session as "on the order of tens of thousands of DOM nodes" — the doc is
  explicit that "the specific node-count multiplier is a plausibility
  illustration... not evidence in itself." The only independently-verified
  fact is that no server cap exists at all.
- **Severity:** High ("higher priority than it looks" per the doc — the
  only list in the audited surface with no bound in either direction).
- **Effort:** Small (existing helper + pattern).
- **Confidence:** High for the existence of the no-cap bug; Low/Medium for
  the illustrative node-count figure (doc explicitly disclaims it as
  non-evidentiary).

#### 11. Add limit/offset pagination to the session-timeline endpoint (backend query fix + frontend infinite query)
- **Source:** `04-frontend-perf.md` "Session-timeline pagination" (L44-50)
  + "Recommendation" #2 (L77).
- **Description:** This is the payload/fetch-cost root cause behind item
  10 (which only bounds render cost, not fetch cost). Backend:
  `sessions_timeline` (`sessions.py:264-270`) needs `limit`/`offset` query
  params mirroring its sibling `sessions_list`. Inside
  `get_session_timeline` (`timeline.py:170-208`), naively slicing
  `trace_ids[offset:offset+limit]` is **wrong** because `trace_ids` is not
  chronologically ordered. The correct fix appends `LIMIT $3 OFFSET $4` to
  `_TURNS_SQL` itself (which already has `ORDER BY min(timestamp)`), then
  derives `page_trace_ids` from the *paginated* result for the stumbles/
  issues sub-queries (today both scan every turn in the session on every
  fetch). `enumerate(turn_rows, start=1)` must become
  `enumerate(turn_rows, start=offset+1)`. Frontend: `sessionsApi.timeline`
  needs the same `URLSearchParams` treatment as `sessionsApi.list`;
  `SessionTurnsSection` needs to become a `useInfiniteQuery`.
- **Impact:** No separate quantified figure beyond item 10's DOM-cost
  estimate; this is the fetch-cost half of the same root cause.
- **Severity:** High (doc frames this as "the actual root cause of the
  timeline's unbounded worst-case").
- **Effort:** Medium (backend SQL restructuring + new frontend
  infinite-query wiring, though both sides have close in-repo templates).
- **Confidence:** High — the doc explicitly corrected its own earlier
  draft here ("the naive fix... is wrong") after tracing
  `_session_trace_ids`, so this is a verified, not assumed, design.

#### 12. Correct the roadmap/scorecard narrative for F34 (signal investigator), RCA, and guardrails — none have a live LLM call
**QUICK WIN — prevents misallocated engineering effort, Small effort
(documentation), High confidence.**

- **Source:** `03-llm-cost.md` intro (L41-72), "Prioritized levers" item 1
  (L498-502).
- **Description:** Three features framed elsewhere as LLM-cost-optimization
  targets have **no live LLM call in them at all**, so there is nothing to
  optimize: (a) the signal investigator —
  `run_investigator_llm_batch` always returns `{}`; `_one_completion`
  raises `RuntimeError("signal investigator LLM path removed")`;
  `INVESTIGATOR_COST_USD = 0.03` in `classifier_worker.py` is documented as
  "NOT a real price," used only for a local savings counter, never written
  to a real CostEvent; (b) RCA — `RootCauseAnalyzer` is a rule-based
  6-rule table with a deferred LLM-as-judge upgrade path never built
  (every response carries `model: "rule_based_v1"`); (c) guardrails — a
  repo-wide grep for every symbol reaching an LLM client across
  `guardrails/*.py` returns zero matches; checks are regex/threshold
  detectors only.
- **Fix:** Correct the internal roadmap/scorecard documentation so future
  cycles don't spend engineering time "optimizing" paths with no LLM in
  them.
- **Impact:** $0 real LLM spend today on all three (target was already
  $0). No dollar savings — the impact is preventing misallocated
  engineering effort across 3 separate features. MEASURED (direct source/
  line reads, confirmed verbatim in code/docstrings).
- **Severity:** High (source doc's own words: "prevents misallocated
  effort across three separate features, not just one").
- **Effort:** Small (process/documentation change, $0 code change).
- **Confidence:** High.

#### 13. Evidence-integrity flag: F12 Typesense span-search benchmark is unreproducible from any code in the repo
- **Source:** `01-hotpath-perf.md` "Evidence-integrity flag" section
  (L181-192, L339-395); referenced in item 4's confidence rating.
- **Description:** `bench/results/f12-span-search-1m-typesense-20260804.json`
  — the artifact behind `SOTA-PERF-COST-SCORECARD.md`'s "F12 MET @1.1M
  (tuned)" claim — is documented (in a prior pass, unchanged this pass) as
  unreproducible from any code in the repo: the committed
  `bench_f12_span_search.py` has no code path that can produce this JSON's
  structure, and the script's own docstring hardcodes `"Status: BLOCKED —
  staging Typesense not available"`. This pass could not re-verify or
  further refute it (no Typesense instance reachable in this environment).
  Status is explicitly labeled **"unverified, not disproven."**
- **Fix (from the doc's "Corrected, honest benchmark plan"):** (1) spin up
  `docker compose up typesense postgres`; (2) extend the committed
  `scripts/bench_f12_span_search.py` to implement the disputed JSON's
  query-mix taxonomy as real executable code, plus a `facet_by=…` vs.
  `facet_by=None` A/B toggle to isolate item 4's specific claim; (3) run a
  full scale ladder — 10k → 100k → 1M → 10M — reporting every rung; (4)
  commit the extended harness in the same commit as any results JSON it
  produces, letting the harness's own pass/fail logic set `gate_met`
  rather than hand-editing output.
- **Impact:** N/A directly (documentation/process/evidence-integrity
  issue), but it undermines confidence in the current "PARTIAL-GREEN" /
  "MET @1.1M" SLA claim for Search (Typesense) F12
  (`p95 < 200ms` target) in `SOTA-PERF-COST-SCORECARD.md`.
- **Severity:** High (as a process/evidence-integrity risk — an SLA
  scorecard resting on an unreproducible artifact).
- **Effort:** Medium-Large (requires live Typesense infrastructure and a
  multi-rung benchmark run).
- **Confidence:** Low/unverified by the source doc's own explicit
  characterization — flagged, not disproven, not confirmed.

---

### MEDIUM-HIGH

#### 14. Add agent-scoped, paginated traces query for the agent-detail page
- **Source:** `04-frontend-perf.md` "Secondary finding" (L58-60) +
  "Recommendation" #3 (L78).
- **Description:** `agents-client.tsx:361-374` fetches the org-wide,
  unscoped, most-recent-50/24h trace list and does
  `.filter((t) => t.agentId === agent.id)` client-side to derive one
  agent's runs. This is both wasteful (every agent-detail view pays for
  and discards traces belonging to every other agent) **and a correctness
  bug**: an agent whose activity is older than the org's most-recent 50
  traces renders an **empty run list even though data exists**.
  `list_portal_traces` currently has no `agent_id` scoping parameter at
  all (confirmed by reading the full signature, `portal.py:1186-1192`).
- **Fix:** Add an `agent_id` filter to the route/repo query (real fix), or
  at minimum widen `limit`/`window` for this call site as a stopgap.
- **Impact:** Not quantified numerically; framed as a functional
  under-reporting bug plus wasted fetch/filter cost.
- **Severity:** Medium-High (correctness bug — silently under-reports data
  for less-recently-active agents, not just wasted bandwidth).
- **Effort:** Medium (backend route/repo change plus client-side call-site
  change).
- **Confidence:** High.

#### 15. Wire route-level offset/cursor pagination for the issues list
- **Source:** `04-frontend-perf.md` "Practical impact" (L22) +
  "Recommendation" #4 (L79).
- **Description:** Backend caps issues at `limit: Query(50, ge=1, le=200)`,
  but the client never sends `limit`, so it always gets the server default
  of 50 with no "load more." The doc corrects its own earlier draft: the
  route does **not** already support `offset` — `list_portal_issues`
  hardcodes `offset=0`. The repo layer already accepts an `offset: int = 0`
  kwarg, so the fix is scoped to adding an `offset`/cursor `Query` param to
  the route and threading it to the existing repo parameter, then having
  the client pass `limit`/`offset` and add a "load more" UI.
- **Impact:** Not quantified numerically; framed as a correctness gap —
  "any org with more than 50 issues silently only ever sees the newest 50,
  with no user-visible signal that older issues exist."
- **Severity:** Medium-High (silent data-visibility bug for any org
  exceeding 50 issues).
- **Effort:** Medium (route param + repo wiring already half-built +
  client UI).
- **Confidence:** High (doc explicitly corrected its own earlier "backend
  already supports offset" claim after re-grepping the whole file).

---

### MEDIUM

#### 16. Add missing composite index for `tool_call_labels`
- **Source:** `02-db-queries.md` F9 — MEDIUM (L516-573).
- **Description:** `tool_call_labels` has no secondary index beyond its
  `UNIQUE (org_id, span_id)` constraint. Two live, confirmed read paths in
  `learning/tool_call_labels.py` don't use `agent_id` in a way the unique
  constraint covers: `list_for_agent` (`WHERE org_id = $1 AND agent_id =
  $2 [AND tool_name = $3] ORDER BY created_at DESC LIMIT 200`) and
  `count_labels` (`WHERE org_id = $1 AND agent_id = $2 AND tool_name =
  $3`). Both are called from real API routes and an MCP tool. Lower
  urgency than item 1 because write volume here is gated by explicit
  human/agent labeling actions, not one row per trace per signal.
- **Fix:** `CREATE INDEX IF NOT EXISTS
  idx_tool_call_labels_org_agent_created ON tool_call_labels (org_id,
  agent_id, created_at DESC)`. Recommended to bundle into the same
  migration as item 1 ("same shape, same risk profile, zero marginal
  deploy cost").
- **Impact:** Not independently benchmarked; index gap and query shapes
  VERIFIED directly against live application code and migration history.
- **Severity:** Medium.
- **Effort:** Small.
- **Confidence:** High.

#### 17. Thread `org_id`/`feature` through `autonomous/_common.py`'s `_call_llm` → `route_async` (fixes 6 silently-zeroed cost-ledger call-site groups)
- **Source:** `03-llm-cost.md` "Root cause" (L191-256), "Prioritized
  levers" item 2 (L503-517).
- **Description:** `_call_llm` (`autonomous/_common.py:181-188`) has no
  `org_id`/`feature` parameter, so it can't forward what it's never given.
  It calls `route_async(...)` with no `org_id=`/`feature=` kwarg;
  `route_async`'s signature defaults these to `None`/`"unknown"`. Inside
  `cost_context`, the `if org_id is not None` branch is skipped, so the
  `_org_id` contextvar is never set. After the real OpenRouter call,
  `schedule_record_from_usage` checks `oid = org_id or ctx.get("org_id");
  if not oid: return` — both sides are `None`, so the real, token-metered
  CostEvent is discarded before construction, **never reaching Postgres**.
  This silently zeroes real cost for 6 call-site groups: `investigate()`,
  `report()`, and `nl_interface/query.py`'s 4 direct `_call_llm` calls.
- **Fix (precise diff given in source doc):** Add `org_id: str | None =
  None, feature: str = "unknown"` to `_call_llm`'s signature; forward them
  into the `route_async(...)` call; then at each of 6 call sites add
  `org_id=org_id, feature="..."` — `org_id` is already in local scope at
  every site, no upstream caller needs to change. Mirrors the pattern
  already used correctly in `soft_issue_review.py:286-295` and
  `autonomous/agent.py:1707-1717`.
- **Impact:** Real dropped spend at triage's theoretical cap ≈ $0.11/
  org/day (≈250 LLM-used triages/day × ~$0.00045/call) — ESTIMATED,
  bounded/assumption-labeled, not a measurement (no production
  call-volume telemetry exists). Aggregate across all 6 sized `_call_llm`
  paths: "very likely well under $1/org/day" — ESTIMATED. This is framed
  explicitly as **a correctness bug, not a cost-reduction opportunity**:
  "the dollar amounts involved were never large enough for this bug to
  matter as spend, only as trust in the number." It does nudge the
  customer-facing credit-consumption figure `06-cost-governance.md`'s
  hard-enforcement path reads, in the direction of overcounting customer
  spend.
- **Severity:** Medium (doc: "Small dollar impact... but this is Eden's
  own cost telemetry being wrong, which is the thing this audit is
  supposed to get right").
- **Effort:** Small (2-kwarg signature change + 6 call-site additions,
  `org_id` already in local scope everywhere).
- **Confidence:** High ("traced all 7 hops... by direct source read").

#### 18. Thread `org_id`/`feature` through `optimization/model_router.py`'s `ModelRouter.route`/`.aroute`
- **Source:** `03-llm-cost.md` "Root cause" (L258-274), call-site family 9
  (L173-191), "Prioritized levers" item 2 (L503-517).
- **Description:** A separate, independent instance of item 17's bug.
  `ModelRouter.aroute()` accepts an `org_id` kwarg but never uses it in the
  method body — not forwarded to `self.llm_client.call(...)` and never
  bound into a `cost_context`. `ModelRouter.route()` (sync) doesn't even
  accept `org_id` as a parameter. This silently drops cost for every
  `ModelRouter` call, **including calls where the caller does pass
  `org_id=org_id`** (e.g. `patch_generator.py:963-967`), since `aroute`
  discards it regardless. Affects the autonomous issue→patch→test→
  auto-merge closed loop (enabled by default,
  `config.py:320: improvement_schedule_enabled: bool = True`): main
  patch-generation call, critic-review call, and RCA-to-code linking.
- **Fix:** Mirror the `_call_llm` fix — thread `org_id`/`feature` through
  `ModelRouter.route`/`.aroute` into `self.llm_client.call(...)`.
- **Impact:** **Not sized to a dollar estimate in this pass** — the doc
  explicitly states "no visibility into sweep-budget cadence or per-org
  call frequency" for `improvement/sweep_budget.py::try_consume_llm_call()`.
  Per-call cost "very likely in the same sub-cent range, but total volume
  — and therefore whether it changes the aggregate bound — is unknown."
  This is an explicit evidence-gap flag, excluded from item 17's aggregate
  "<$1/org/day" bound.
- **Severity:** Medium (same correctness-bug class as item 17, but a real
  spend ceiling exists via the fail-closed `sweep_budget.py` gate).
- **Effort:** Small ("a second, smaller diff" than item 17's fix).
- **Confidence:** High that the bug exists (zero grep matches confirmed);
  Low/unverified on dollar sizing (explicitly unsized by the doc).

#### 19. Stop writing the synthetic flat `_TRIAGE_COST_ESTIMATE_USD` ($0.02) CostEvent once real metered cost flows through
- **Source:** `03-llm-cost.md` "New finding (Phase 3, re-verified)"
  (~L361-420), "Prioritized levers" item 2 (L505-506).
- **Description:** A live, unfixed recurrence of a bug already fixed
  elsewhere (the investigator used to book a fictitious $0.03; that path
  is now $0.0). In `issues/triage_agent.py`,
  `_TRIAGE_COST_ESTIMATE_USD = 0.02` is a flat, non-metered constant.
  `triage()` calls `_debit_budget(org_id, _TRIAGE_COST_ESTIMATE_USD)`
  whenever `llm_used` is true, which calls
  `record_spend(org_id, amount, feature="triage", model="triage")` —
  `autonomy_policy.record_spend()` unconditionally writes a `CostEvent`
  with the fake amount to the real, customer-facing FinOps ledger table.
  This write path is entirely independent of items 17/18's `cost_context`
  machinery — it's a hand-built `CostEvent` with `org_id` correctly
  attached, which is precisely why the fake $0.02 lands while the real
  number (dropped by item 17's bug) does not. Net effect: for every triage
  that uses the LLM, the FinOps ledger records a flat invented $0.02 line
  tagged `model="triage"`, while the real token-metered OpenRouter cost is
  never recorded anywhere.
- **Fix:** After item 17's fix lands (real cost flows), remove/replace
  this synthetic constant write.
- **Impact:** Fake constant = $0.02/call (MEASURED, literal in code). Real
  per-call cost at a generous high-end token estimate ≈ $0.00045/call
  (ESTIMATED; per-token pricing verified live against DeepSeek docs). At
  triage's corrected $5/org/day cap (≈250 LLM-used triages/day), fake ≈
  $5/org/day vs. real ≈ $0.11/org/day — **fake is ~45× the real number**;
  the doc explicitly states this ratio, not either absolute figure, is
  "the more important artifact of this bug." Realistic volume is likely
  far below the cap (StatGate resolves most P0s deterministically; repeat
  triages hit a result cache).
- **Severity:** Medium (correctness/trust issue, not a cost-reduction
  lever — dollar amounts are immaterial to Eden's own P&L, but it does
  nudge the customer-facing credit-consumption number).
- **Effort:** Small (remove one constant-based write path once item 17's
  real-cost path is live).
- **Confidence:** High (direct line reads throughout the write chain).

#### 20. Batch/parallelize `investigate_trace`'s serial, unbatched per-signal write loop
- **Source:** `01-hotpath-perf.md` Finding 4 (L201) + round-trip ledger
  (L208-254) + `02-db-queries.md` F5 (L446-469) — **cross-doc duplicate,
  merged**; `01` explicitly states "Same code, same bug as
  `optimizations/02-db-queries.md` F5... not double-counted."
- **Description:** `investigator.py::investigate_trace`'s main loop
  (`:255-316`) processes up to `R=20` matched `signal_definitions` rows
  sequentially in a plain Python `for` loop (three branches each wrapped
  in a bare `try/except Exception: pass`). For each row: (a) `_write_event`
  does a single-row `INSERT` with no batching (→ `R` round trips total);
  (b) for matched rows, the stumble-write chain (see item 21) and
  `cluster_after_match` (see item 2) are awaited sequentially, not
  concurrently. `01-hotpath-perf.md`'s exact round-trip ledger (traced
  line-by-line through `investigator.py`, `clusterer.py`,
  `stumble_writer.py`, `repo.py`, `issue_promoter.py`, `rca/_common.py`)
  computes the precise worst-case Postgres round-trip formula:
  `2 + R + M·3 + M·(1 + G)`, which at `R=M=20`, `G≈250` (clustering
  groups) = **2 + 20 + 60 + 20×251 = 5,102 Postgres round trips**, plus up
  to **20 Redis round trips**, plus up to **20 × 124,750 = 2,495,000
  CPU-bound pairwise comparisons**, all in one
  `POST /traces/{trace_id}/investigate` call — a hard ceiling
  DERIVED-FROM-CODE from the code's own `LIMIT`s, explicitly NOT a
  typical-case estimate (requires all 20 signal definitions to match the
  same trace simultaneously; neither doc estimates how often that occurs).
- **Fix:** (1) Batch the `_write_event` inserts into one multi-row
  `INSERT`. (2) Run independent per-matched-row work concurrently via
  `bounded_gather` (`eden.async_tasks.bounded_gather`, already proven at
  `eden/insights/incidents/clusterer.py:59-100` for this exact shape,
  cited elsewhere as achieving ~5s → ~50ms for a 100-trace N+1) — not a
  bare `asyncio.gather`, since an unbounded fan-out over up to 20
  concurrent chains risks a burst of up to 20 simultaneous DB/Redis
  connections from one request. (3) Move `cluster_after_match` off the
  synchronous request path per item 2's fix.
- **Impact:** ~5,100 Postgres round trips + 20 Redis round trips —
  DERIVED-FROM-CODE worst-case ceiling; both docs agree it is a ceiling
  not a typical case.
- **Severity:** Medium (both docs explicitly rate this Medium, not
  escalated, specifically because the worst-case all-20-signals-matching
  assumption is unverified against real-world match rates).
- **Effort:** Medium.
- **Confidence:** Medium — round-trip counts and code asymmetry are
  directly verified from source; typical-case frequency is unknown.

#### 21. Parallelize the stumble-write round-trip chain
- **Source:** `01-hotpath-perf.md` Findings table row 6 (L203); round-trip
  ledger detail (L208-254). Doc explicitly flags this as "confirmed unique
  — not covered by `02-db-queries.md`."
- **Description:** Per matched signal row, the chain
  `investigator.py::_maybe_write_stumble` → `StumbleWriter.create` does:
  `_burst_seen` (1 Redis round trip) → `_repo.insert_stumble` (1 Postgres
  round trip) → `IssuePromoter.upsert` (fingerprint lookup + insert/update
  = 2 more Postgres round trips) → `_fire_stumble_created` (best-effort,
  cost unbounded/out of scope). Total: 1 Redis + up to 3 Postgres round
  trips per matched row, sequential, before clustering even starts, up to
  20x per trace.
- **Fix:** Same as item 20 — parallelize across matched rows using
  `bounded_gather`.
- **Impact:** DERIVED-FROM-CODE, precise counts (mechanism and exact
  counts verified from source), not separately benchmarked.
- **Severity:** Medium.
- **Effort:** Medium.
- **Confidence:** Medium (source-verified mechanism, unbenched magnitude).

#### 22. Cap or precompute shared state for uncapped StatGate rule scans
- **Source:** `01-hotpath-perf.md` Findings table row 2 (L199).
- **Description:** `investigator.py::_eval_statgate_rule` (`:123-137,
  :139-151`) does an uncapped `for e in events` scan in both branches —
  unlike `compress_trace`, which caps at `[:80]` events. This runs once
  per enabled `statgate_rule` signal definition row, up to 20x per trace,
  synchronously reachable from `POST /traces/{trace_id}/investigate`. No
  shared precomputation is done across the up-to-20 calls.
- **Fix:** Cap the scan (matching `compress_trace`'s `[:80]` pattern) or
  precompute shared per-event derived state once per `investigate_trace`
  call instead of recomputing per signal definition. Also add a latency
  microbenchmark — none exists for this function specifically.
- **Impact:** Code asymmetry (missing cap) VERIFIED in source; actual
  latency magnitude UNMEASURED — no bench exists.
- **Severity:** Medium.
- **Effort:** Small-Medium.
- **Confidence:** Medium (bug mechanism verified, magnitude unknown).

#### 23. Strip unused body/reasoning fields from the trace-tree API response on the cheap path
- **Source:** `04-frontend-perf.md` "Third finding" (L52-56).
- **Description:** `TelemetryCollector.get_trace_tree`
  (`telemetry_collector.py:1848-2075`), served at
  `GET /orgs/{org}/observability/traces/{trace_id}/tree`, builds every span
  node with `metrics`, `attributes`, `payload`, `request_body`,
  `response_body`, `reasoning`, `tool_calls_full`, and `tool_results` —
  even on the default "cheap" path (`hydrate_bodies=False`). The cheap
  path only skips body-column decompression; `reasoning`,
  `tool_calls_full`, and `tool_results` still fall through to raw row
  values and are never stripped. The portal's only consumer of this
  endpoint reads `node.metrics`/`node.payload`/`node.attributes` only,
  deriving request/response/tool-results from inside `node.payload` — the
  five top-level fields are grepped nowhere else in `clients/portal/src`.
- **Fix:** Omit `request_body`, `response_body`, `reasoning`,
  `tool_calls_full`, and `tool_results` from the node dict when
  `hydrate_bodies=False` (two of five already have this guard; add it to
  the other three); only fetch them via a dedicated per-span "expand" call
  if drill-down is ever needed.
- **Impact:** Not independently quantified in bytes; doc states this
  "multiplies the `/tree` response size by however large those blobs are
  — per span, for every trace-tree fetch" for traces with long reasoning
  chains or large tool outputs.
- **Severity:** Medium (payload bloat on the default path of a frequently
  hit endpoint, for fields with zero live consumers).
- **Effort:** Small (mirrors an existing conditional pattern already used
  for 2 of the 5 fields).
- **Confidence:** High (grepped whole frontend for consumers, zero found).

#### 24. Parallelize `soft_issue_review`'s sequential 20-org loop
- **Source:** `05-cron-jobs.md` "Other concrete inefficiencies" #5
  (L232-241), verdict table (L564).
- **Description:** `soft_issue_review.py:75-90` processes its 20 hot orgs
  strictly sequentially, and each org can issue up to 3 sequential LLM
  calls (itself a sequential inner loop) — up to ~60 sequential LLM
  round-trips serialized in one job. `_claim_org` already makes
  cross-pod concurrency safe, so nothing structural blocks parallelizing.
- **Fix:** Reuse the `bounded_gather(limit=8)` pattern `auto_curator`
  already uses next door.
- **Impact:** Not independently measured. **Evidence-integrity flag:** a
  cross-referenced "~$0.20/night" LLM-cost figure (from `03-llm-cost.md`)
  is itself "a code-comment-sourced worst-case ceiling, not a measured
  invoice line" — treat "not a cost concern" as directional, not settled.
- **Severity:** Medium (wall-clock/job-duration concern, not a confirmed
  cost impact).
- **Effort:** Small (existing pattern in same file).
- **Confidence:** Medium (KEEP-WITH-CAVEAT per doc's own verdict table).

#### 25. Batch/parallelize `drift_baselines`'s sequential 7-dimension nested loop
- **Source:** `05-cron-jobs.md` "Other concrete inefficiencies" #7
  (L260-269), verdict table (L566).
- **Description:** `drift_baseline_worker.py:35-44` runs a fully
  sequential 7-dimension nested loop per org/agent pair — up to 1,400
  sequential DB round-trips in one weekly run (100-pair cap × 7 dimensions
  × up to 2 round-trips/dimension). No batching or concurrency. This is on
  top of item 8's missing-`ORDER BY` defect.
- **Fix:** Same bounded-concurrency approach `auto_curator` already uses.
- **Impact:** MEASURED/DERIVED-FROM-CODE — "the 1,400-round-trip figure...
  independently re-derived from scratch" and "checked out exactly" per the
  doc's pass-4 fact-check.
- **Severity:** Medium (weekly job-duration concern).
- **Effort:** Medium.
- **Confidence:** High (independently re-derived and confirmed exact in
  pass-4).

#### 26. Fix shadow-detector creation/promotion throughput mismatch (unbounded backlog growth)
- **Source:** `05-cron-jobs.md` "Other concrete inefficiencies" #6
  (L243-255), verdict table (L565).
- **Description:** Shadow-detector creation runs at ≤20 orgs/night × ≤3
  detectors/org ≈ 420/week. Consumption (`promote_shadow_detectors`) runs
  weekly and inspects only the oldest 200 rows **globally**
  (`ORDER BY created_at ASC` — a correct order-by, so this is a
  throughput-budget problem, not the missing-watermark bug class). 420
  created/week vs. 200 evaluated/week means the `enabled=false` backlog
  grows unbounded over time; it's also a single global FIFO not scoped per
  org, so a burst from one noisy org can delay every other org's detectors
  indefinitely.
- **Fix:** Increase weekly promotion throughput/limit, and/or shard the
  FIFO per-org (round-robin dequeue) so one org's burst can't starve
  others — doc cites Temporal/AWS SQS fair-queue patterns as the 2026
  industry template.
- **Impact:** ESTIMATED from code constants ("≤420/wk created vs. 200/wk
  evaluated" — arithmetic checks out, but is a worst-case ceiling, not a
  measured `nl_signals` backlog depth). Doc recommends instrumenting a
  backlog-depth metric before prioritizing a fix.
- **Severity:** Medium.
- **Effort:** Medium (throughput-limit change is small; true per-org
  fairness requires new sharding logic).
- **Confidence:** Medium (KEEP-WITH-CAVEAT — arithmetic verified from
  constants, not from measured backlog).

#### 27. Fix duplicate-fleet-on-deploy risk (`eden-worker`'s `runOnSourceChange: cd-promote`)
- **Source:** `05-cron-jobs.md` "Correction to the deployment/scope
  framing" (L54-72), verdict table (L569).
- **Description:** A documented production incident (2026-07-29,
  `northflank.yml:595-621`) found `eden-worker`'s `backoffLimit: 0` meant
  crashed background-loop runs were simply gone — 45 consecutive failed
  runs between 2026-07-21 and 07-24 were never restarted, leaving every
  background loop dead in prod for **7.4 days** while the API kept serving
  reads. This half is **already fixed** (`backoffLimit: 3`). A second,
  still-open hazard from the same incident is **not fixed**:
  `runOnSourceChange: cd-promote` starts a duplicate fleet copy on every
  deploy with no old-run cleanup, mitigated only by leader locks making
  duplicates "safe rather than correct" — the same incident comment
  records **five copies "RUNNING" at once** after repeated redeploys, each
  idle poller billing Upstash and Neon for one job's worth of work.
- **Fix:** Add old-run cleanup on `cd-promote` (infra/deploy change, not a
  code fix).
- **Impact:** MEASURED (sourced verbatim from an in-repo incident comment,
  not independently re-derived from logs): 7.4-day outage (already fixed);
  5 simultaneous running copies observed (still open, ongoing cost waste
  on every redeploy).
- **Severity:** Medium (open infra/deploy hazard — currently "safe" but
  wasteful; not a correctness bug given leader locks).
- **Effort:** Medium (infra/deploy change).
- **Confidence:** High (figures sourced verbatim from in-repo incident
  comment).

#### 28. Add a coverage metric to catch the LIMIT-without-ORDER-BY bug class
- **Source:** `05-cron-jobs.md` "Why this bug class evades the existing
  monitoring" (L202-228), verdict table (L571).
- **Description:** Existing cron/maintenance-loop monitoring
  (`run_if_leader`, `workers/leader.py:210-280`) is real and reasonably
  good at the exception level, but none of it catches items 3/7/8/53's bug
  class, because the query never errors — it's a silently-too-small result
  set, invisible to exception-based monitoring, exit-code checks, or
  heartbeat pings by construction.
- **Fix:** Add either (a) a coverage metric (e.g. "distinct orgs curated
  in the last N days" vs. "total active orgs"), alerting on a growing gap,
  or (b) fix the selection queries themselves to be watermarked (items
  3/7/8/53) so there is structurally no excluded tail to miss.
- **Impact:** Not quantified; framed as the cross-cutting root cause
  behind items 3/7/8/53's invisibility.
- **Severity:** Medium (root-cause visibility gap).
- **Effort:** Medium (new metric + dashboard/alerting, separate from the
  query fixes themselves).
- **Confidence:** High.

#### 29. Remove `audit_logs` phantom retention-policy entry; file a higher-priority follow-up for `agent_audit_ledger`
- **Source:** `06-storage-retention.md` fix table (L165).
- **Description:** No table named `audit_logs` exists in the schema, but a
  real analog does — `agent_audit_ledger`
  (`092_market_ready_consolidated.py:501`) — a genuine audit table that
  "arguably should have a compliance-grade retention policy" (the dead
  entry's `delete_after_days=2555` ≈ 7 years hints this was the original
  intent) but was never connected.
- **Fix:** Remove the phantom `DEFAULT_POLICIES` entry, file a follow-up
  ticket (higher priority than the other phantom-entry removals, given
  legal-hold/compliance implications) to add a policy under the real table
  name.
- **Impact:** N/A directly, but compliance/legal-hold exposure is implied
  if a real audit ledger has no retention policy at all.
- **Severity:** Medium (compliance implications called out explicitly).
- **Effort:** Small (removal) + separate follow-up ticket.
- **Confidence:** High.

#### 30. Add a new retention policy + dispatch branch for `trace_replay_sessions`
- **Source:** `06-storage-retention.md` "checkpoint-blob retention gap"
  (L41-66), "replay UI is stubbed" (L68-90), "Complete fix design"
  (L134-156).
- **Description:** `trace_replay_sessions` is the live write path for
  Cat-1 rewind. It has **no TTL column and is absent from
  `DEFAULT_POLICIES`**; `state_json TEXT` is unbounded with no size
  ceiling at the schema level. The portal's `/replay` page is currently a
  stub and the one client function that would drive traffic has zero call
  sites, so organic growth today is effectively ~0. **But the backend is
  not gated off**: `intelligence_gap_v0` defaults `True` globally (not
  per-org opt-in), so any direct API/SDK caller or QA session writes a
  real, permanent row today — a "flip the stub off" launch risk once the
  otherwise fully built replay UI ships.
- **Fix:** `RetentionPolicy("trace_replay_sessions", 7, 0, 0, 30)`
  (hot-only, 30-day TTL, mirroring `debug_dumps`' shape). **Same dead-`elif`
  trap as item 6 applies** — a real dedicated dispatch branch is required
  (`DELETE FROM trace_replay_sessions WHERE updated_at < $1`), not just a
  `DEFAULT_POLICIES` entry.
- **Impact:** ESTIMATED, explicitly labeled a placeholder: ~1,300
  rows/month, ~1-2 MB/month baseline by analogy to comparable tooling —
  but "the 20-org input is aspirational and not reconciled against Eden's
  actual measured scale — production had 9 orgs as of 2026-07-29, more
  than 2x smaller." The qualitative point (a small fraction of active orgs
  use replay/rewind per week) is the load-bearing part, not the number.
  The real risk emphasized is the unbounded `TEXT` column with no size
  ceiling — "a slow, invisible creep... with no dashboard signal and no
  ceiling."
- **Severity:** Medium (near-zero live risk currently, but an unaddressed
  pre-launch design gap — Eden's own design doc flagged "Replay session
  TTL" as an Open Question filed 2026-06-10, still unanswered).
- **Effort:** Small (mirrors existing `debug_dumps` pattern, though the
  dead-elif trap must be handled correctly).
- **Confidence:** High for the gap's existence; Low/Medium for the ~1,300
  rows/month estimate (explicitly self-flagged as an unvalidated
  placeholder).

#### 31. Add a new retention policy + dispatch branch for `replay_sessions` (migration 029) — worse growth model than item 30
- **Source:** `06-storage-retention.md` "replay UI is stubbed" section
  (L78), "Complete fix design" (L156).
- **Description:** A third, related table: `replay_sessions` (migration
  029, `POST /orgs/{org_id}/intelligence/replay/sessions`). Unlike
  `trace_replay_sessions`, "scratch" sessions (`name IS NULL`) are
  **always inserted as new rows, not upserted** — no dedup at all for the
  common case. It shares the same "built but not yet driving traffic"
  status and is also absent from `DEFAULT_POLICIES`. Its growth model is
  strictly worse than item 30's once the replay UI ships (unbounded rows
  per open session, not per distinct trace).
- **Fix:** Fold into the same fix/PR as items 30 and 58 — same 30-day TTL,
  same dead-elif-trap caveat applies.
- **Impact:** Not quantified; qualitatively worse than item 30's growth
  model.
- **Severity:** Medium.
- **Effort:** Small.
- **Confidence:** High.

#### 32. Extend `get_storage_summary()` to track the gap tables and add byte-size/$-GB tracking
- **Source:** `06-storage-retention.md` "Other storage-growth risks"
  (L130), "Other carried-over recommendations" (L170).
- **Description:** `get_storage_summary()` (`storage_lifecycle.py:525-541`)
  — the one function meant to give ops visibility into hot-storage growth
  — only counts `usage_events`, `silver_events`, and `quarantine_events`
  (row counts only). It does not track `checkpoint_blobs`,
  `trace_replay_sessions`, `replay_sessions`, or any of the six no-op-policy
  tables, so none of the actual gaps found in this doc are visible in the
  one dashboard-ready summary that exists. No table anywhere tracks byte
  size or a $/GB figure (repo-wide grep for
  `bytes_used|table_size|pg_total_relation_size|storage_cost` returns
  nothing relevant).
- **Fix:** Extend `get_storage_summary()` to include the missing tables
  plus `quarantine_events`'s unreprocessed-row count, and fold in a
  byte-size column (e.g. `pg_total_relation_size`) — "the smallest change
  that would finally make a $/GB storage-cost conversation possible for
  this system."
- **Impact:** Not quantified.
- **Severity:** Medium (pure visibility gap, but a prerequisite for any
  future cost conversation).
- **Effort:** Small-Medium.
- **Confidence:** High.

---

### LOW-MEDIUM

#### 33. Deduplicate redundant `compress_trace` recomputation in `_heuristic_match`
- **Source:** `01-hotpath-perf.md` Findings table row 3 (L200).
- **Description:** `investigator.py::_heuristic_match` (`:76-108`)
  recomputes `compress_trace(events).lower()` from scratch for every
  signal definition it's called against — up to 20x per trace. The
  recomputed string is capped at 80 events/4000 chars, which limits
  absolute cost.
- **Fix:** Compute `compress_trace(events).lower()` once per
  `investigate_trace` call and pass the result into `_heuristic_match`
  rather than recomputing per signal.
- **Impact:** Not quantified; doc characterizes as "cheap" given the
  existing cap.
- **Severity:** Low-Medium (doc's own tier: "LOW-MEDIUM").
- **Effort:** Small.
- **Confidence:** High (mechanism directly verified in source), low
  priority.

#### 34. Add pagination to `list_signal_clusters`
- **Source:** `02-db-queries.md` F6 — LOW/MEDIUM (L471-489).
- **Description:** `api/routes/signal_investigator.py:97-149` queries
  `signal_clusters` with a hardcoded `LIMIT 200` and no `offset`/cursor
  query parameter — callers cannot page past the first 200 results. The
  underlying index also doesn't cover the `ORDER BY last_seen DESC NULLS
  LAST` sort — noted as low-impact today but worth folding into the same
  fix if pagination is added.
- **Fix:** Add `limit`/`offset` (or `after_id` cursor) query parameters;
  consider extending the index to cover the sort column.
- **Impact:** Not quantified; low impact today per the doc.
- **Severity:** Low/Medium (doc's own tier).
- **Effort:** Small.
- **Confidence:** High.

#### 35. Fix `UsageStats.cache_reads`/`cache_writes` field names to match OpenRouter's real usage schema
- **Source:** `03-llm-cost.md` "Prompt caching" (L422-448), "Prioritized
  levers" item 3 (L518-525).
- **Description:** `llm/client.py:634-635` reads
  `getattr(response.usage, "cache_reads", 0)` and `"cache_writes"` — but
  OpenRouter's `usage` object has no attributes with these names, so both
  are **always 0** (confirmed "dead, not merely 'likely dead.'"). Verified
  live against OpenRouter's current docs (Aug 2026): cache activity is
  actually reported as `usage.prompt_tokens_details.cached_tokens` and
  `usage.prompt_tokens_details.cache_write_tokens`. Note:
  `cost = getattr(response.usage, "cost", None)` IS read correctly —
  `usage.cost` is the real, already-discounted dollar figure — so this bug
  does **not** cause dollar miscounting, only 100% loss of
  cache-attribution visibility.
- **Fix:** Change `llm/client.py:634-635` to read
  `usage.prompt_tokens_details.{cached_tokens, cache_write_tokens}`
  instead of the nonexistent flat attributes.
- **Impact:** 0% dollar-miscounting effect (cost_usd already correct when
  org_id is present) but "100% opacity rate on a metric that's currently
  un-computed for every single Eden-internal LLM call." Potential
  visibility into a discount described as up to ~98% (DeepSeek V4 Flash:
  $0.14/1M input cache-miss vs. $0.0028/1M cache-hit) — VERIFIED-LIVE
  pricing fact, but whether Eden is actually banking that discount today
  is unverified (see item 36).
- **Severity:** Low-Medium (visibility/reporting gap, not a
  cost-reduction lever by itself).
- **Effort:** Small (rename ~2 attribute reads in one function).
- **Confidence:** Medium-High ("upgraded from Phase 3's 'medium' — the
  exact schema was verified live against current OpenRouter docs").

#### 36. Instrument and verify actual prompt-cache hit rate against live production traffic
- **Source:** `03-llm-cost.md` "Confidence" section (L522-554).
- **Description:** Once item 35 (and the related `cache_discount`
  capture, item 45) land, Eden will be able to see cache-hit/write
  telemetry, but this doesn't by itself confirm savings are being
  realized — that depends on whether Eden's actual prompts preserve a
  stable shared prefix in production traffic, which is **unmeasured** in
  this audit. DeepSeek's automatic disk-based prefix caching and
  OpenRouter's "sticky routing" mean the ~98% discount **may already be
  fully banked with zero further code changes** — the payoff of items
  35/45 "is purely being able to report/verify a savings number... that
  may already be fully banked."
- **Fix:** Instrument the new fields (items 35/45) and observe real
  production cache-hit rates rather than assuming the discount is or
  isn't already happening.
- **Impact:** Unknown/unmeasured — the doc's own confidence rating here is
  capped for this reason, not a quantified savings figure. **Explicit
  evidence-uncertainty flag from the doc.**
- **Severity:** Low-Medium (informational/verification step, not itself a
  cost fix — but could reveal that a large discount already exists,
  changing prioritization of other items).
- **Effort:** Medium (requires production telemetry/dashboarding beyond
  the code diff, and traffic analysis over time).
- **Confidence:** Low-Medium (doc: "still medium on whether Eden's
  production traffic actually preserves cache prefix — unmeasured against
  live traffic").

#### 37. Add age-based expiry for stale non-firing shadow detectors
- **Source:** `05-cron-jobs.md` "Other concrete inefficiencies" #6 (L258).
- **Description:** Rows that never reach `min_firings` (20) sit in `hold`
  state indefinitely — no age-based expiry/deletion exists for stale
  non-firing shadow detectors, compounding item 26's backlog growth.
- **Fix:** Add a TTL/cleanup query for `hold`-state rows.
- **Impact:** Not quantified.
- **Severity:** Low-Medium.
- **Effort:** Small.
- **Confidence:** High (direct code observation).

#### 38. Add a CI lint rule to catch `LIMIT` without `ORDER BY` going forward
- **Source:** `05-cron-jobs.md` "Research: 2026 scheduled-job design at
  scale" (L523-539), verdict table (L573).
- **Description:** PostgreSQL's own docs confirm "LIMIT without ORDER BY =
  undefined order" as a documented anti-pattern, and Eden's SQL lives as
  raw triple-quoted strings rather than a linter-managed SQL tree. The doc
  proposes a small CI script (`scripts/lint_unordered_limit.py`, as a
  pre-commit hook + required CI step alongside existing `ruff`/`mypy`
  checks) that walks every `*.py` file under `src/eden/`, extracts
  triple-quoted strings passed as the first positional arg to
  `.fetch(`/`.fetchrow(`/`.fetchval(`, and fails the build listing
  `file:line` for any containing `LIMIT` but not `ORDER BY` — with a
  single opt-out escape hatch for legitimate exceptions.
- **Impact:** DERIVED-FROM-CODE — "run against the current tree, this rule
  would catch all 5 findings [items 3, 7, 8, 53, and the shadow-outcome
  finding, item 54] and 0 false positives among the confirmed-OK queries
  catalogued."
- **Severity:** Low-Medium (preventive/systemic follow-up).
- **Effort:** Small-Medium.
- **Confidence:** High.

#### 39. Remove `training_datasets` phantom retention-policy entry; file a follow-up for real dataset tables
- **Source:** `06-storage-retention.md` fix table (L164).
- **Description:** No table named `training_datasets` exists, but real
  analogs do (`datasets`, `dataset_items`, `dataset_snapshots`;
  `fine_tuning_runs`/`dataset_trace_lineage`), added later under
  different, more specific names and never reconciled back into
  `DEFAULT_POLICIES`.
- **Fix:** Remove the phantom entry, file a follow-up ticket to add a
  correctly-named policy targeting the real tables.
- **Impact:** N/A.
- **Severity:** Low-Medium.
- **Effort:** Small (removal) + separate follow-up ticket.
- **Confidence:** High.

---

### LOW

#### 40. Deduplicate `resolve_issue`'s double fetch of the same issue row
- **Source:** `02-db-queries.md` F4 — LOW, downgraded this pass from
  MEDIUM-HIGH (L417-445).
- **Description:** `api/routes/agent_issues.py::resolve_issue`
  (`:167-234`) calls `_repo.get_issue(org_id, issue_id)` twice after
  already calling `_repo.set_status(...)`. `get_issue` is a cheap indexed
  point lookup on a low-QPS, human/agent-triggered admin action — not a
  hot ingest path — which is why the doc downgrades severity this pass.
  (The doc separately cross-references a materially worse correctness bug
  in the same function, documented in `bugs/02-data-consistency.md`
  outside this extraction's scope, and recommends fixing that first.)
- **Fix:** Fetch the issue once immediately after `set_status` succeeds
  and reuse the same object for both downstream blocks.
- **Impact:** Not quantified; one redundant cheap point-lookup per admin
  action, low-QPS path.
- **Severity:** Low.
- **Effort:** Small.
- **Confidence:** High.

#### 41. Add `LIMIT` to `_fetch_cluster_members`
- **Source:** `02-db-queries.md` F7 — LOW (L490-497).
- **Description:** `insights/rca/_common.py:217-243`'s
  `_fetch_cluster_members` query has no `LIMIT`, unlike its sibling
  `_fetch_failed_traces_in_window`, which has `LIMIT 500`.
- **Fix:** Add `LIMIT 500` (or similar), matching the sibling function's
  pattern.
- **Impact:** Not quantified.
- **Severity:** Low.
- **Effort:** Small (trivial, one-line change).
- **Confidence:** High.

#### 42. Add index for `signal_definitions`'s actual filter/sort shape (optional, low priority)
- **Source:** `02-db-queries.md` F8 — LOW/minor (L500-514).
- **Description:** `signal_definitions` has only a primary key on `id`; a
  later migration adds `(org_id, template_id)`, which doesn't cover the
  actual query shape used in `investigator.py`:
  `WHERE org_id = $1 AND enabled = TRUE [AND id = $2] ORDER BY created_at
  ASC LIMIT 20`. Low priority because rows are created manually/rarely,
  per-org counts are small, and the query is already `LIMIT 20`-bounded.
- **Fix:** `CREATE INDEX idx_signal_definitions_org_enabled_created ON
  signal_definitions (org_id, created_at ASC) WHERE enabled = TRUE`.
  Recommended to bundle into other index migration work rather than
  shipping alone.
- **Impact:** Not quantified; explicitly framed as low blast radius.
- **Severity:** Low.
- **Effort:** Small.
- **Confidence:** High.

#### 43. Dedupe two separate `get_settings()` calls in `search()`
- **Source:** `01-hotpath-perf.md` Findings table row 7 (L204); marked
  "CUT as before, trivial" in Verdicts (L439).
- **Description:** `search_service.py:393-397` and `:461-465` each
  independently call `get_settings()` within a single `search()`
  invocation.
- **Fix:** Fetch `get_settings()` once at the top of `search()` and reuse;
  doc suggests folding into item 4's edit rather than shipping separately.
- **Impact:** Not quantified; explicitly framed as trivial.
- **Severity:** Low.
- **Effort:** Small (trivial).
- **Confidence:** High, but the doc itself deprioritizes/cuts this as not
  worth separate tracking.

#### 44. (Hardening, no live bug) Add an internal clamp to `IssuesRepo.list_issues`/`list_stumbles`'s `limit` parameter
- **Source:** `02-db-queries.md` "Cut" section, "Old F6" (L598-616).
  Explicitly "VERDICT: CUT (confirmed again this pass)" — not a live bug,
  included for completeness.
- **Description:** `IssuesRepo.list_issues`/`list_stumbles` accept a
  `limit: int` parameter with no internal `min(limit, N)` guard. A full
  `grep` found 10+ call sites; every one was checked and passes a
  hardcoded/bounded literal value except one, which has its own
  independent `Query(50, ge=1, le=200)` clamp. **No live bug exists
  today** — this is purely a latent/defense-in-depth gap.
- **Fix (optional, defensive only):** Add an internal clamp inside the
  repo methods themselves so future callers can't accidentally pass
  unbounded values.
- **Impact:** None currently (no live bug).
- **Severity:** Low (informational; explicitly not a current bug).
- **Effort:** Small.
- **Confidence:** High that no current bug exists (all 10+ call sites
  individually checked).

#### 45. Capture the new top-level `cache_discount` field from OpenRouter's response
- **Source:** `03-llm-cost.md` "Prompt caching" (L442-448), fix code block
  (L448-521).
- **Description:** In addition to item 35's nested usage fields,
  OpenRouter's response body includes a separate top-level
  `cache_discount` field (outside the `usage` object entirely), which
  `UsageStats` doesn't capture in any form today.
- **Fix:** Add a new `cache_discount` field to `UsageStats`, sourced from
  the top-level `response.cache_discount` — part of the same
  `llm/client.py:629-635` fix block as item 35.
- **Impact:** Same visibility-gap framing as item 35 — enables a future
  "cache savings" reporting line. No direct dollar-miscounting effect.
- **Severity:** Low (pure telemetry addition).
- **Effort:** Small (same function/location as item 35).
- **Confidence:** Medium-High (same basis as item 35).

#### 46. Rename/annotate the `signal_investigator_llm_v1` feature flag to prevent accidental reintroduction of real LLM spend
- **Source:** `03-llm-cost.md` "no cost, misleading name only" (L486-494),
  "Prioritized levers" item 4 (L526-528).
- **Description:** `investigate_trace_endpoint`
  (`signal_investigator.py:252-323`) is flag-gated by
  `signal_investigator_llm_v1` (default `False`), and returns a `disabled`
  envelope when off. Even when explicitly turned on, `investigate_trace()`
  never calls an LLM (per item 12) — `total_cost` is always `0`. The
  flag/endpoint name is the only remaining artifact implying live LLM
  cost.
- **Fix:** Rename or annotate the flag so a future engineer doesn't
  mistakenly "restore" this path under the belief they're reinstating
  existing behavior, when they'd actually be introducing brand-new spend.
- **Impact:** $0 current cost; the risk is a future regression introducing
  unplanned new spend. Not quantified (forward-looking risk-prevention).
- **Severity:** Low (housekeeping/preventive).
- **Effort:** Small.
- **Confidence:** High.

#### 47. Update the stale Anthropic/Claude prompt-cache economics comment in `autonomous/agent.py`
- **Source:** `03-llm-cost.md` live call-site family 3 discussion
  (L121-131), "Prioritized levers" item 4 (L526-528).
- **Description:** The in-code comment at `agent.py:1462-1466` still says
  Anthropic prompt-caching for Sonnet/Opus is "the single biggest line
  item in the agent budget" — pre-Soft-Autonomy economics. Since the
  2026-08-01 "Soft Autonomy" change collapsed `TIER_MODELS` onto DeepSeek
  flash for all tiers, T2 no longer resolves to Sonnet/Opus, so the
  `_is_anthropic_model` branch this comment justifies is now a no-op.
- **Fix:** Update the comment to reflect what model T2 actually resolves
  to today, avoiding future misdirected optimization effort.
- **Impact:** No dollar impact; doc-hygiene item only.
- **Severity:** Low (doc hygiene).
- **Effort:** Small.
- **Confidence:** High.

#### 48. (Deprioritized/CUT) `_scout_novel_patterns` digest/`existing_block` dedup in `soft_issue_review.py`
- **Source:** `03-llm-cost.md` "Prioritized levers" item 5 (L529-531),
  "Confidence" closing line (L561-563).
- **Description:** A dedup opportunity in `_scout_novel_patterns` (bounded
  already at `_MAX_ORGS_PER_NIGHT=20` × `_MAX_AGENTS_PER_ORG=3`, ≈$0.01/
  org/night), carried over from a prior phase and explicitly **not
  re-benchmarked this pass**: "still an unmeasured structural estimate,
  already downgraded to CUT in Phase 2."
- **Impact:** ≤~$0.20/night, ≤~$6/month system-wide worst case (from
  module docstring) — labeled as an unmeasured structural estimate, not a
  measurement.
- **Severity:** Low ("Not a P0... CUT — revisit only if volume grows").
- **Effort:** Unclear from this doc (mechanism not re-detailed this pass);
  tentatively Medium.
- **Confidence:** Low (doc explicitly: "unmeasured structural estimate").

#### 49. Memoize `IssueRow` and replace inline closure with a stable callback
- **Source:** `04-frontend-perf.md` "Memoization gap compounds it" (L20) +
  "Recommendation" #1 (L76).
- **Description:** `IssueRow` (`issues-client.tsx:79-115`) is not wrapped
  in `memo`, unlike its declared sibling `SessionListButton`. Worse, the
  `.map()` call site passes a fresh inline closure every render
  (`onSelect={() => selectIssue(issue.id)}`), so wrapping in `memo` alone
  wouldn't help — props are never referentially stable. `selectIssue` is
  already a stable `useCallback`.
- **Fix:** Mirror `SessionListButton`'s own pattern —
  `handleClick = useCallback(() => onSelect(session.id), [onSelect,
  session.id])` — pass `issue.id` + `selectIssue` down and derive the
  stable callback per-row inside `IssueRow` itself.
- **Impact:** Not separately quantified; every keystroke in the issues
  search box re-renders every currently-mounted `IssueRow` (up to the
  unpaginated default of 50).
- **Severity:** Low (doc explicitly frames this as "secondary to the
  windowing gap").
- **Effort:** Small.
- **Confidence:** High.

#### 50. Virtualize the signals list and memoize `SignalRow`
- **Source:** `04-frontend-perf.md` "A third, smaller instance" (L24).
- **Description:** `signals-client.tsx:862` renders `{filtered.map(...)}`
  unvirtualized; `SignalRow` is not memoized. Backend query is a
  hardcoded `LIMIT 200` with no `Query` param, so no client-side paging is
  possible even in principle.
- **Fix:** Same `useVirtualizer` + `memo` reuse as items 9/10.
- **Impact:** DERIVED-FROM-CODE — ~200 × ~10 DOM nodes/row ≈ 2,000 nodes,
  same order of magnitude as the kanban worst case.
- **Severity:** Low ("lower priority than issues/timeline... 200 rows of
  short text is meaningfully cheaper to paint").
- **Effort:** Small.
- **Confidence:** High.

#### 51. Virtualize the automations panel list and memoize `AutomationRow`
- **Source:** `04-frontend-perf.md` "A fourth instance" (L26).
- **Description:** `automations-panel.tsx:489` renders
  `{automations.map(...)}` unvirtualized and unmemoized. Backend
  `GET /automations` caps at `limit: Query(100, ge=1, le=100)`,
  hard-capped again in `AutomationsEngine.list_automations`.
- **Fix:** Same `useVirtualizer` + `memo` reuse.
- **Impact:** Not separately quantified beyond the 100-row cap; doc notes
  "automations are typically small, admin-configured lists in practice."
- **Severity:** Low ("noted for completeness, not urgent").
- **Effort:** Small.
- **Confidence:** High.

#### 52. Fix `retention_cron`'s unwatermarked cold-archive candidate-selection query
- **Source:** `05-cron-jobs.md` "Full schedule map" (L109), finding #4
  (L169-181), unified fix table (L421), verdict table (L562).
- **Description:** `retention_cron.py:176-182` runs `SELECT DISTINCT
  tenant_id FROM telemetry_events WHERE timestamp < ... LIMIT 1000` daily,
  no `ORDER BY`, floored by `min_scan_days`. Same defect class as items
  3/7/8 but lowest urgency of the four: 1,000-tenant cap vs. a production
  org count in the low tens (a self-obs heartbeat records "9 orgs" as of
  2026-07-29).
- **Fix:** Same `fetch_stale_candidates()` helper, new
  `retention_archive_watermark(tenant_id, last_processed_at)` table.
- **Impact:** ESTIMATED, explicitly directional — "on the order of 100x
  headroom," but the doc caveats that the `telemetry_events.tenant_id` ↔
  `org_id` 1:1 mapping is **not independently confirmed** this pass (the
  "9 orgs" figure comes from a different subsystem). Treat the headroom
  figure as directional, not exact.
- **Severity:** Low ("lowest urgency of the four," but "architecturally
  identical to #1 [item 3] and should get the same fix opportunistically").
- **Effort:** Small-Medium.
- **Confidence:** Medium (existence of bug is High confidence; the
  headroom estimate is explicitly flagged as unconfirmed/directional).
- **Cross-doc note:** `06-storage-retention.md` separately flags a
  *different* bug in the same file (`retention_cron.py`) — 6 of 8
  retention policies being unenforced no-ops (items 6/39/57/58/59/plus
  `user_feedback`). Both docs explicitly state these are complementary
  findings ("which orgs get scanned" vs. "which policies actually execute
  once scanned"), not the same finding — not merged as a duplicate.

#### 53. Add `ORDER BY` to `shadow_outcome_join`'s candidate query
- **Source:** `05-cron-jobs.md` "Full schedule map" (L115), finding #5
  (L182-200), unified fix (L423-438), verdict table (L563).
- **Description:** `nudges/shadow_outcomes.py:14-42` runs a 200-row-capped
  join every 15 minutes with no `ORDER BY`, filtering on
  `outcome_success IS NULL`. Partially self-mitigating — every
  successfully processed row gets `outcome_success` set, removing it from
  the candidate set on the next tick. But without `ORDER BY`, Postgres can
  return a different physical subset on any plan change, and if new-row
  arrival rate ever exceeds 200/15min, there's no guarantee the *oldest*
  unresolved rows are selected — some could be starved indefinitely.
- **Fix (one line):** Add `ORDER BY no.recorded_at ASC` before the
  `LIMIT $1` at `shadow_outcomes.py:41`. No new table needed.
- **Impact:** Not independently measured; mechanism DERIVED-FROM-CODE
  ("confirmed by direct read of the full method body").
- **Severity:** Low ("lowest severity of the five [watermark/ordering
  bugs]").
- **Effort:** Small (one-line SQL change).
- **Confidence:** High.

#### 54. Replace `signal_backfill`'s OFFSET-based cursor with true keyset pagination
- **Source:** `05-cron-jobs.md` "Other concrete inefficiencies" #8
  (L271-283), verdict table (L567).
- **Description:** `signals/backfill.py:204-219` uses
  `ORDER BY trace_id OFFSET $4 LIMIT $5` where `$4 = traces_done`. This is
  resumable and idempotent (correct behavior on crash/retry), but
  `OFFSET n` re-scans and discards the first `n` rows of the sort order on
  every batch, so a backfill job with very large `traces_total` degrades
  toward O(n²) work across its batches instead of O(n). Not urgent today —
  window capped at 30 days and `_MAX_TRACES_PER_MINUTE=100`.
- **Fix:** Compare `trace_id > $last_trace_id` instead of `OFFSET` — the
  textbook keyset pattern.
- **Impact:** Not quantified (bounded today by existing 30-day/100-per-
  minute caps).
- **Severity:** Low.
- **Effort:** Small.
- **Confidence:** High ("KEEP — low priority... correct/idempotent/
  resumable" per doc's verdict).

#### 55. Set explicit `backoffLimit` on the (currently inert) `eden-cron` Northflank job
- **Source:** `05-cron-jobs.md` "Pass 3 — Northflank backoffLimit sweep"
  (L336-365), verdict table (L570).
- **Description:** `eden-cron` (the disabled, once-a-year, `echo ...; exit
  0` no-op job) has no `settings:` block and no `backoffLimit` key
  anywhere — it silently inherits Northflank's platform default (which was
  `0` for `eden-worker` before item 27's incident fix). Currently inert
  risk only, but the job's own comment says it's "kept as a free-tier job
  slot placeholder," implying future reactivation.
- **Fix:** One-line YAML addition: `settings: { backoffLimit: 3 }`.
- **Impact:** Not applicable (risk is currently inert by construction).
- **Severity:** Low (opportunistic — risk-free to fix now, becomes real
  only if `eden-cron` is ever reactivated with a real command).
- **Effort:** Small.
- **Confidence:** High.

#### 56. Fix stale/incorrect docstrings in `cron_tick.py` and `retention_cron.py`
- **Source:** `05-cron-jobs.md` "Correction to the deployment/scope
  framing" (L42-53, 73-89).
- **Description:** `cron_tick.py`'s module docstring is wrong on three
  points: it claims the tick includes an "EQL alert watchdog + columnar
  compaction" step and runs "N23 improvement sweeps when org schedule is
  due" — neither is true. `retention_cron.py`'s module docstring claims
  "Northflank: a daily scheduled job (cron: `0 2 * * *`)" — stale, since
  it actually runs at hour==3 via `_run_daily` inside the leader-elected
  in-process loop, not via a real Northflank cron; and elsewhere claims
  "Runs all 7 retention policies" when `DEFAULT_POLICIES` has had 8
  entries since the file was introduced (cosmetic; doesn't affect behavior
  since the code iterates `retention.policies`, not a hardcoded count).
- **Fix:** One-line doc-comment corrections in both files.
- **Impact:** N/A — documentation-only.
- **Severity:** Low.
- **Effort:** Small.
- **Confidence:** High.

#### 57. Remove the `error_logs` phantom retention-policy entry
- **Source:** `06-storage-retention.md` "6 of 8 DEFAULT_POLICIES entries
  are declarative only" (L17-39), "Git archaeology" (L91-99), fix table
  (L162).
- **Description:** `DEFAULT_POLICIES` declares
  `RetentionPolicy("error_logs", 7, 30, 90, 90)`, but no table plausibly
  maps to a dedicated error-log store (errors live inline as fields on
  `telemetry_events`). Git archaeology confirms this was speculative/
  aspirational from day one — "pure vaporware with no successor to
  redirect to."
- **Fix:** Remove the entry outright, no follow-up needed.
- **Impact:** N/A (dead config entry, zero enforcement either way today).
- **Severity:** Low.
- **Effort:** Small.
- **Confidence:** High.

#### 58. Remove the `derived_metrics` phantom retention-policy entry
- **Source:** `06-storage-retention.md`, same sections as item 57; fix
  table (L163).
- **Description:** Same defect class as item 57 — no table anywhere named
  or shaped like `derived_metrics`. Real analogs (`custom_metric_runs`,
  `telemetry_streaming_metrics`) were built later under different names
  and never reconciled back into `DEFAULT_POLICIES`.
- **Fix:** Remove outright, no follow-up.
- **Impact:** N/A.
- **Severity:** Low.
- **Effort:** Small.
- **Confidence:** High.

#### 59. Implement real retention enforcement for `user_feedback`
- **Source:** `06-storage-retention.md` fix table (L166), "Precise
  dispatch trace" (L101-126).
- **Description:** `user_feedback` has a real backing table but its
  policy (`7, 90, 2555, 2555`) currently no-ops silently for the same
  dead-`elif` reason as item 6 (2555 ≤ 90 is False). Existing configured
  values are already sane (7-year window); this is a low-urgency honesty
  fix, not a live growth risk.
- **Fix:** Add a real dedicated dispatch branch (mirroring `debug_dumps`):
  `elif policy.data_type == "user_feedback": DELETE FROM user_feedback
  WHERE created_at < $1`.
- **Impact:** N/A (7-year window rarely fires in practice; low urgency,
  but "should be honest" that the config lies about being enforced today).
- **Severity:** Low.
- **Effort:** Small.
- **Confidence:** High.

#### 60. Add a new retention policy + dispatch branch for `checkpoint_blobs` (defense-in-depth)
- **Source:** `06-storage-retention.md` "checkpoint-blob retention gap"
  (L41-59), "Complete fix design" (L134-156).
- **Description:** `checkpoint_blobs` (migration 001) has no TTL column
  and is absent from `DEFAULT_POLICIES`. It is legacy — writes go through
  an upsert bounding growth per key, and
  `insert_checkpoint_blob`/`get_checkpoint_blob(s)`/
  `delete_checkpoint_blobs` have **zero production callers anywhere in
  `src/eden`** (only referenced in a mocked test fixture).
  `rewind.py:8-19` confirms this table "predates the trace_id naming
  convention" and is "read-only per the Phase 2 cutover." It is still read
  live via `websocket.py:372-384/387-415` for the live job-trace stream,
  so it's not fully dead code.
- **Fix:** `RetentionPolicy("checkpoint_blobs", 7, 0, 0, 30)` with a
  dedicated dispatch branch — "cheap insurance against a not-yet-found
  write path."
- **Impact:** Not quantified (no confirmed active write path today, so
  growth is likely near-zero currently).
- **Severity:** Low.
- **Effort:** Small.
- **Confidence:** High.

#### 61. File a follow-up ticket to make RCA/signal-investigator routes tier-aware
- **Source:** `06-storage-retention.md` "Verified (prior pass,
  re-confirmed)" #3 (L15), "Other carried-over recommendations" (L171).
- **Description:** A grep for `warm_days|cold_tier|tier` across
  `intelligence_rca.py` and `signal_investigator.py` returns zero matches
  — old/archived data beyond `warm_days` is invisible to RCA and
  signal-investigator queries today.
- **Fix:** Make the relevant queries tier-aware so archived data is still
  reachable for investigations.
- **Impact:** Not quantified.
- **Severity:** Low ("low urgency — 90d hot window covers most active
  investigations" per the doc).
- **Effort:** Medium (requires tier-aware query changes across two route
  files).
- **Confidence:** High (KEEP-WITH-CAVEAT per Phase-3 verdicts).

---

## Appendix: Cross-doc duplicates merged

Two genuine cross-doc duplicates were found and merged into single points
above (both explicitly cross-referenced by the source docs themselves,
not independently discovered coincidences):

1. **Item 2** (dead `eden.kb.embeddings` import + O(n²) clustering cost) —
   `01-hotpath-perf.md` Finding 5 documents the reproduction of the dead
   import and its own O(n²) benchmark; `02-db-queries.md` F2 documents the
   same bug in more forensic depth (commit archaeology pinpointing
   introduction at `95401573`, plus the 88.7%-false-positive-cluster
   simulation). `01` explicitly states: "This is the same bug
   `optimizations/02-db-queries.md` documents in more depth as its F2 —
   not re-derived here."

2. **Item 20** (batch/parallelize `investigate_trace`'s serial per-signal
   write loop) — `01-hotpath-perf.md` Finding 4 and `02-db-queries.md` F5
   both describe the exact same unbatched-write / non-concurrent-fanout
   code path in `investigator.py::investigate_trace`. `01` explicitly
   states: "Same code, same bug as `optimizations/02-db-queries.md` F5...
   not double-counted."

**Explicitly checked and found NOT to be duplicates** (flagged by the
source docs themselves to prevent false merging):

- `05-cron-jobs.md`'s finding on `retention_cron.py`'s unwatermarked
  org-selection query (item 52) and `06-storage-retention.md`'s finding
  that 6 of 8 retention policies in the same file are unenforced no-ops
  (items 6, 39, 57-59, and the `user_feedback` fix) touch the same source
  file but are complementary, not duplicate: one is about *which orgs get
  scanned*, the other is about *which policies actually execute once
  scanned*. Both source docs state this explicitly.
- No overlapping findings were identified between `03-llm-cost.md` and
  any other doc, nor within `04-frontend-perf.md` / `05-cron-jobs.md` /
  `06-storage-retention.md` against each other.

## Appendix: Evidence-integrity / uncertainty flags carried forward

The following points in this list carry an explicit "unverified" or
"unreproducible" flag from their source doc, distinct from ordinary
ESTIMATED figures — these are places where the source doc itself
flagged a red flag about evidence quality, not just precision:

- **Item 13** — the F12 Typesense benchmark JSON backing the
  `SOTA-PERF-COST-SCORECARD.md` "MET @1.1M" claim is unreproducible from
  any code in the repo; status is "unverified, not disproven."
- **Item 2** — the O(n²) clustering-cost benchmark figures disagree 2-5x
  across three independent measurement attempts (two internal reruns plus
  `02-db-queries.md`'s own bench), and the benchmarking scripts
  themselves are not committed to the repo.
- **Item 18** — the `ModelRouter` cost-ledger bug's dollar impact is
  explicitly unsized ("no visibility into sweep-budget cadence or per-org
  call frequency").
- **Item 36** — whether Eden's production traffic actually realizes the
  ~98% DeepSeek prompt-cache discount is unmeasured against live traffic.
- **Item 48** — the `_scout_novel_patterns` dedup savings estimate was
  not re-benchmarked this pass; carried forward as an "unmeasured
  structural estimate."
- **Item 30** — the ~1,300 rows/month growth estimate for
  `trace_replay_sessions` uses a 20-org input explicitly flagged as
  "aspirational... not reconciled against Eden's actual measured scale"
  (production had 9 orgs as of 2026-07-29).
- **Item 52** — the "~100x headroom" estimate for `retention_cron`'s
  candidate cap relies on an unconfirmed `tenant_id` ↔ `org_id` mapping
  assumption.
- `06-storage-retention.md` separately notes that web-research figures
  (LangSmith/Honeycomb/Sentry retention-window comparisons cited to
  support 30-day TTL recommendations) were sourced in an earlier pass and
  not independently re-confirmed this pass — "not flagged as wrong... but
  should be treated as unverified-external pending a spot-check."
