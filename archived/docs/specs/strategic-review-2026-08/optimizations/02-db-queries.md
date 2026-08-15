# DB Query Patterns — RCA / Signal Investigator / Agent Issues (+ broader DB query audit)

Scope: `src/eden/api/routes/intelligence_rca.py`, `src/eden/api/routes/signal_investigator.py`,
`src/eden/api/routes/agent_issues.py`, and their direct call chains
(`eden/insights/rca/_common.py`, `eden/insights/rca/analyzer.py`,
`eden/insights/incidents/clusterer.py`, `eden/signals/investigator.py`,
`eden/signals/clusterer.py`, `eden/issues/repo.py`), plus the migration history for
every table those paths touch (`src/eden/db_migrations/versions/`, 149 files at this
pass). This is the **third** pass on this file. Passes 1–2 broadened from the
original three routers to the write path (`investigate_trace` → `_write_event`/
`cluster_after_match`) and landed F1/F2 (`signal_events`'s missing indexes +
`cluster_signal`'s inline synchronous cost). This pass goes deeper on both and adds
a schema-wide sweep beyond the tables already covered.

Looking for N+1 loops, missing LIMIT/pagination, redundant re-fetching within one
request, and *verified* (not implied) missing indices — every index claim below
was checked against the actual migration files, not inferred from query shape.

**Cross-reference (corrected this pass):** an earlier pass claimed `rca_chain`'s
double-fetch of `telemetry_events` was "tracked as O2 at the top-level `INDEX.md`
synthesis" — that doesn't hold up: `INDEX.md` has no `O`-numbered finding scheme
at all, and a full-file search finds no mention of `rca_chain` or its
double-fetch anywhere in it under any label. So F3 isn't deliberately owned
elsewhere; it's tracked here, in this file's own ranked findings and priority
order, at its verified severity (see F3 below and item 3 in "Priority order").
F1/F2 still have larger verified blast radius, but F3 is not deprioritized on
the basis of being covered somewhere else — it isn't.

---

## Summary

This pass produced three new, concretely-verified results that change how F1/F2
should be read:

1. **F1's fix is now a literal migration diff**, not just a recommendation — exact
   file, exact SQL, exact column order, exact partial-index predicate, justified
   against both real query shapes and cross-checked against Postgres's own
   documented rule for when the planner can actually use a partial index (see
   "Exact migration" under F1).
2. **F2 is not just slow, it's silently non-functional.** Tracing `_embed`'s
   import (`eden.kb.embeddings.get_default_embedder`) all the way through the
   package tree found that module **does not exist anywhere in the current
   source tree** — only `eden.kb.ledger.embeddings` does, and that module doesn't
   define `get_default_embedder` or `embed_batch` either. A live import test
   against this repo's `src/` confirms `ModuleNotFoundError` every time. That
   means `cluster_signal`'s "real embedding-model call" has never executed in
   this codebase; every invocation, in production, silently falls back to the
   deterministic hash embedding (`_embed`'s `except Exception: logger.debug(...)`
   branch) — and that fallback's own vector construction is measurably degenerate
   for cosine similarity (simulated below: ~89% of all pairs of *distinct* text
   summaries score above the 0.82 clustering threshold). Net effect: the feature
   ships CPU cost for a clustering pass that mostly produces one oversized,
   semantically-meaningless mega-cluster per call, with zero error-level logging
   to surface it. This reframes F2 from "a perf problem under load" to "a shipped,
   invisible product-correctness bug that also costs CPU on the shared ingest
   path" — see the expanded F2 below for the exact numbers.
3. **A schema-wide sweep** (all 149 migration files, every table with an
   `org_id`/`tenant_id`/`agent_id`/`trace_id`/`session_id` column, cross-checked
   against every `CREATE INDEX`/`UNIQUE`/`PRIMARY KEY` in the same files) found
   one other table with a verified, live, application-code-confirmed version of
   the same gap as `signal_events`: **`tool_call_labels`** (new F9). Most of the
   ~60 other tables an early automated pass flagged turned out to be false
   positives (composite `PRIMARY KEY`/`UNIQUE` constraints the naive scan
   missed) or genuinely low-risk (per-org config/registry tables with ~1 row per
   org, not event tables) — see "Broader sweep" below for the methodology and
   what was ruled out, not just what was flagged.

---

## Ranked findings (blast radius = data volume × query frequency, verified against live code)

## F1 — CRITICAL: `signal_events` has no index for either of its real read patterns, and is written up to 20×/finalized trace

**Table:** `src/eden/db_migrations/versions/092_market_ready_consolidated.py:44-60`

```sql
CREATE TABLE IF NOT EXISTS signal_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    signal_id UUID NOT NULL REFERENCES signal_definitions(id) ON DELETE CASCADE,
    trace_id TEXT NOT NULL,
    matched BOOLEAN NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    investigator_confidence REAL,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)
...
CREATE INDEX IF NOT EXISTS idx_signal_events_trace ON signal_events (trace_id)
```

That's the *only* index ever created on this table — confirmed with
`grep -rn "signal_events" src/eden/db_migrations/versions/*.py | grep -i "CREATE INDEX"`
across all 149 migration files; no later migration adds one.

**Write path:** `src/eden/signals/investigator.py::investigate_trace` (loop at
`L255-321`, `_write_event` at `L319-336`) inserts one row into `signal_events`
per enabled signal definition (`LIMIT 20`, fetched at `L232-248`) for every trace
it runs against, regardless of match. `investigate_trace` is called from
`src/eden/workers/trace_finalized_consumer.py:686-699` (`_run_signal_investigator`)
and from `src/eden/signals/backfill.py:244-251` for backfill windows. **Correction
this pass:** `_run_signal_investigator` does *not* run for literally every
finalized trace — `_process_trace` gates it behind `if not
_layer_a_primary_hit(layer_a_report)` and a classifier skip check
(`trace_finalized_consumer.py:326-335`), so it's skipped whenever Layer A already
found a primary-hit descriptor or the signal classifiers decide to skip it. The
per-trace fan-out below is therefore an upper bound, not the literal rate.
`scripts/cost_model.py` — the team's own documented infra-cost assumptions, not
measured production data — puts `ROWS_PER_TRACE = 35` for `TRACES_PER_ORG_DAY =
1_000` ("an actively-instrumented org"), with an explicit breakdown comment: "10
telemetry_events + 5 trace_*_reports + up to 20 signal_events"
(`scripts/cost_model.py:46-50`). So on the traces where the investigator gate
fires, `signal_events` grows at up to 1,000×(≤20) rows/day for a single
actively-instrumented org — still one of the fastest-growing tables in the
schema relative to the index investment `telemetry_events` got, even accounting
for the gate.

**Read path 1 — the list endpoint**, `src/eden/api/routes/signal_investigator.py::list_signal_events` (`L40-94`):
```sql
SELECT id, trace_id, matched, payload, investigator_confidence, detected_at
FROM signal_events
WHERE org_id = $1 AND signal_id = $2 [AND matched = $3]
ORDER BY detected_at DESC
LIMIT $N   -- Query(100, ge=1, le=500)
```

**Read path 2 — the in-request clusterer**, `src/eden/signals/clusterer.py::cluster_signal` (`L72-86`):
```sql
SELECT id, trace_id, payload, detected_at
FROM signal_events
WHERE org_id = $1 AND signal_id = $2 AND matched = TRUE AND detected_at >= $3
ORDER BY detected_at DESC
LIMIT 500
```

Neither query can use `idx_signal_events_trace` — both filter on `org_id`/
`signal_id`, neither filters or sorts by `trace_id`.

### Exact migration

Following the codebase's established migration convention exactly (idempotent
`op.execute("CREATE INDEX IF NOT EXISTS ...")` pairs with a matching `DROP INDEX
IF EXISTS` in `downgrade()`, same shape as `066_session21_indexes.py` and
`043_neon_cost_indexes.py`), the next free revision after the current head
(`142_session_summaries.py`) is `143`:

```python
"""143 — signal_events read-path indexes (F1).

Revision ID: 143
Revises: 142
Create Date: 2026-08-05

signal_events has shipped since 092 with exactly one index -- a bare
(trace_id) btree -- that serves neither of its two real read shapes:
list_signal_events (org_id, signal_id, [matched], ORDER BY detected_at)
and cluster_signal (org_id, signal_id, matched=TRUE literal, detected_at
range, ORDER BY detected_at). No CREATE INDEX CONCURRENTLY needed, for
the same reason 043_neon_cost_indexes.py documents: signal_events is
INSERT-only (no UPDATE path touches it), and a plain CREATE INDEX IF
NOT EXISTS takes an ACCESS SHARE lock that never blocks INSERT.
"""
from alembic import op

revision = "143"
down_revision = "142"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. list_signal_events: org_id/signal_id are equality filters (org_id
    #    leftmost -- it's the tenant boundary every query has; signal_id
    #    narrows further), detected_at DESC is the sort column. `matched`
    #    is passed as an optional *bound parameter* ($3) in this query, so
    #    it cannot be served by a partial-index predicate (Postgres only
    #    matches a partial index when it can prove the WHERE clause implies
    #    the predicate at PLAN time -- a bound parameter's value isn't known
    #    then; see postgresql.org/docs/current/indexes-partial.html). This
    #    index must be the full (non-partial) composite.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_signal_events_org_signal_detected "
        "ON signal_events (org_id, signal_id, detected_at DESC)"
    )
    # 2. cluster_signal: same leading columns, but `matched = TRUE` is a
    #    literal in the query TEXT (not a bind param) -- clusterer.py:78
    #    hardcodes "AND matched = TRUE", never parameterizes it. That
    #    literal exactly matches a `WHERE matched = TRUE` partial-index
    #    predicate at plan time, so the partial index is actually usable
    #    here (unlike #1). Matched rows are the minority of all signal
    #    evaluations (most signal checks don't fire), so scoping the index
    #    to them keeps it small and cheap to maintain on every INSERT --
    #    same pattern already proven at idx_closed_loop_actions_pending
    #    (066_session21_indexes.py) and idx_agent_issues_repetition
    #    (084_agent_issues.py).
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_signal_events_org_signal_matched_detected "
        "ON signal_events (org_id, signal_id, detected_at DESC) "
        "WHERE matched = TRUE"
    )


def downgrade() -> None:
    op.execute(
        "DROP INDEX IF EXISTS idx_signal_events_org_signal_matched_detected"
    )
    op.execute("DROP INDEX IF EXISTS idx_signal_events_org_signal_detected")
```

Both additive, no downtime, no backfill required (index build reads existing
rows once at creation).

---

## F2 — CRITICAL: `cluster_after_match` runs inline on the shared ingest consumer — and its "real embedding call" is unreachable dead code

**Files:** `src/eden/signals/clusterer.py::cluster_signal` (`L57-150`),
`::_embed` (`L195-212`); called from `src/eden/signals/investigator.py:275/295/312`
(`await cluster_after_match(org_id, signal_id)`, once per matched signal inside
the `investigate_trace` loop); invoked from
`src/eden/workers/trace_finalized_consumer.py::_run_signal_investigator` (`L686-735`),
itself called from `_process_trace` (`L287-344`), which the consumer's `run()`
loop fans out via `asyncio.gather` bounded by `self._sem =
asyncio.Semaphore(_MAX_CONCURRENT_SCANS)` where `_MAX_CONCURRENT_SCANS = 5`
(`trace_finalized_consumer.py:42,95`). As with F1, `_run_signal_investigator`
itself only fires when `_process_trace`'s Layer-A/classifier gate lets it through
(`trace_finalized_consumer.py:326-335`) — this section's "every match" framing
below describes what happens on the traces that do reach `investigate_trace`, not
a claim that every finalized trace reaches it. The bug itself (dead import,
degenerate fallback, O(n²) inline scan) is unaffected by how often the gate
fires — it's just how *often* it fires that's more conditional than a naive read
of the call chain suggests.

```python
rows = await pg.fetch(...)                      # F1's un-indexed query, LIMIT 500
summaries = [_event_summary(r["payload"]) for r in rows]
vectors = await self._embed(summaries)           # ONE batched call, not N
groups: list[list[int]] = []
used: set[int] = set()
for i, vi in enumerate(vectors):                 # O(n²) single-linkage-ish scan
    if i in used: continue
    group = [i]; used.add(i)
    for j, vj in enumerate(vectors):
        if j in used: continue
        if _cosine(vi, vj) >= _COSINE_THRESHOLD:  # >=0.82
            group.append(j); used.add(j)
```

### The embedder call is verified unreachable

`_embed` (`clusterer.py:195-212`) does
`from eden.kb.embeddings import get_default_embedder`. Checked this directly:

```
$ python3 -c "from eden.kb.embeddings import get_default_embedder"
ModuleNotFoundError: No module named 'eden.kb.embeddings'
```

`find src/eden/kb -iname embeddings.py` returns exactly one file:
`src/eden/kb/ledger/embeddings.py` — a different module path, and even that one
only defines `embed_text`/`unpack_embedding`/`cosine`/`_hash_embedding`, **not**
`get_default_embedder` or `embed_batch`. `grep -rn "def get_default_embedder"
src/ tests/` returns zero real definitions anywhere in the tree (one test file,
`tests/unit/observability/test_patterns_clusterer_zstd_reader.py`, stubs a fake
`embed_batch` on a mock object — confirming the authors knew this path needs
mocking to exercise, not that it works unmocked). `git log --diff-filter=A --
src/eden/kb/ledger/embeddings.py` shows this file and `clusterer.py` were **added
in the same commit** (`95401573`) — so this was never a working call that later
broke via refactor; the import target was wrong from the moment `clusterer.py`
shipped. The identical broken import also exists in
`src/eden/observability/patterns_clusterer.py:147-148`, so this is a
two-call-site bug, not a one-off typo.

`_embed`'s `except Exception: logger.debug(...)` catches the `ModuleNotFoundError`
and returns the hash fallback — at **debug** level, which is suppressed at any
default production log level, so this has been failing silently since it shipped.
(Worth noting: the source comment immediately above this fallback branch reads
`# Deterministic hash fallback for tests / no-embedder envs` — the fallback
*mechanism* itself was anticipated by the original author as a degraded-mode
safety net, not a pure accident. The bug is that `get_default_embedder` was
apparently never actually implemented for the "real" branch to reach, so an
anticipated fallback silently became the unconditional 100%-of-the-time path with
no visibility that it had.)

### The fallback isn't just cheap, it's clustering-broken

The fallback (`clusterer.py:207-212`) builds an 8-dim vector per text as
`[(stable_hash(text)%1000 + i) % 97 / 97.0 for i in range(8)]` — 8 consecutive
integers mod 97, scaled to `[0,1)`. That's structurally a short, near-monotonic
"ramp" for *any* input text, and ramps of similar shape have high cosine
similarity regardless of the underlying text. Verified by simulation (500
distinct, non-duplicate summary strings, using the actual `stable_hash` from
`eden/util/stable_hash.py`):

```
pairwise cosine similarity across 124,750 unique pairs:
  min=0.098  p50=0.999  p90=~1.0  max=1.0
  fraction of pairs >= 0.82 (the clustering threshold): 88.7%
```

Running the actual clustering loop against these fallback vectors: the first
unused item absorbed 478 of 500 rows into one cluster, with 4 small leftover
groups (sizes 8/6/6/2) — i.e., ~96% of matched signal events collapse into a
single, mostly-arbitrary mega-cluster on every invocation, named after whatever
text happens to be in row 0's summary (`_label_cluster`, `clusterer.py:47-51`).
This is inserted into `signal_clusters` as real data (`INSERT INTO
signal_clusters ... VALUES (...)`, `clusterer.py:129-146`) that the portal and
`GET /signal-clusters` (F6) surface to users as if it were a genuine semantic
grouping.

### Quantifying the O(n²) cost precisely

The comparison loop's true worst case (no early absorption, i.e. what would
happen if a *real* embedder were reachable and text genuinely didn't cluster) is
`n(n-1)/2` comparisons for `n=500` = **124,750**, not `n²=250,000` as the prior
pass estimated (that count double-counted symmetric pairs and self-comparisons —
the `if j in used: continue` guard prevents both). Benchmarked the actual
`_cosine` function on this machine at both the current fallback's dimensionality
and a plausible real-embedder dimensionality (384, `eden/kb/ledger/embeddings.py`'s
own default `dims` for its unrelated `embed_text` helper):

| dims | per-comparison cost | worst-case total (124,750 comparisons) |
|---|---|---|
| 8 (current fallback) | 2.7 µs | **~333 ms** |
| 384 (hypothetical, if the embedder import were fixed) | 53.8 µs | **~6.7 s** |

**Why the 500-row cap is the realistic case, not a tail case:** at the
`TRACES_PER_ORG_DAY = 1_000` / 14-day-lookback assumption from `cost_model.py`
(`_LOOKBACK_DAYS = 14`, `clusterer.py:22`), the `LIMIT 500` fetch saturates
whenever a signal's match rate is `>= 500 / (1_000 x 14) ≈ 3.6%` — a low bar for
any commonly-firing signal (error/retry/frustration detectors). So `n=500` isn't
a worst-case edge; it's the steady state for any moderately active signal at
this documented traffic assumption, and every one of those calls runs `await`ed,
synchronously, inside one of only 5 concurrent trace-finalized consumer slots.
Because Python's asyncio event loop is single-threaded and this loop is *not*
offloaded to a thread (unlike `_embed`, which correctly uses
`asyncio.to_thread`), a slow clustering pass blocks the **entire event loop**,
not just its own semaphore slot — so the risk isn't "1 of 5 slots throttled,"
it's "the whole consumer process stalls" for the duration of the scan, for every
org sharing it. Today that stall is bounded (~ms, thanks to the fallback's own
early-absorption behavior) — but it's bounded by an accidental property of a
broken embedder, not a designed guarantee, and would become the ~6.7s worst case
above the moment someone "fixes" the import without also fixing the algorithm.

**Fix:**
- Apply F1's index first — cheapest lever, shrinks `pg.fetch`'s cost regardless.
- **Fix or remove the embedder wiring.** Either point `_embed` at a real,
  reachable embedder (`eden.kb.ledger.embeddings.embed_text`, adapted to a batch
  API, or a genuinely new `get_default_embedder`), or — if a real embedder isn't
  worth the added latency/cost on this path — replace the degenerate ramp
  fallback with something that doesn't systematically over-cluster (e.g. a
  proper token-set/Jaccard similarity on the summary text, which doesn't have
  the "everything looks alike" failure mode of a low-dimensional monotonic hash
  vector). Either way, **this needs an error-level log or metric**, not
  `logger.debug`, so a silent 100%-fallback-rate incident like this is visible
  next time. The same visibility gap exists one layer up, too: all three call
  sites in `investigator.py` wrap `cluster_after_match` in a bare `try: ... except
  Exception: pass` with zero logging (`investigator.py:273-276,293-296,310-313`)
  — so even a failure unrelated to the embedder (a DB error, a bad row shape)
  would vanish just as silently. Fix both layers together, not just `_embed`'s.
- Move `cluster_after_match` off the synchronous ingest path entirely (queue/
  background job), and specifically **run the O(n²) scan itself in a thread**
  (`asyncio.to_thread`, matching `_embed`'s own existing pattern) even if it
  stays inline, so it can never block the shared event loop outright.
- Debounce: cluster on a cadence (e.g. every Nth match, or a periodic sweep) not
  on every single match.

---

## F3 — HIGH: `rca_chain` double-fetches an unbounded, heavy trace-event query

*(Owned and ranked here, not elsewhere — see the corrected cross-reference note
at the top of this doc. `intelligence_rca.py` is in this file's original scope,
and verifying its index claim was part of this pass's index audit.)*

**File:** `src/eden/api/routes/intelligence_rca.py:127-148` (`rca_chain`)

```python
events = await _fetch_trace_events(org_id, trace_id)      # L138 — fetch #1
...
categorized = await _rca.categorize(org_id, trace_id)      # L143 — fetch #2 happens inside here
```

`RootCauseAnalyzer.categorize` (`src/eden/insights/rca/analyzer.py:89`) calls
`_fetch_trace_events(org_id, trace_id)` again for the same `(org_id, trace_id)`
pair, inside the same HTTP request.

`src/eden/insights/rca/_common.py:104-140` (`_fetch_trace_events`):
```sql
SELECT event_id, trace_id, span_id, event_type, payload,
       attributes, tags, source_format, timestamp, name,
       duration_ms, outcome, error, parent_span_id,
       agent_id, reasoning, tool_calls_full, tool_results,
       request_body, response_body, tenant_id
FROM telemetry_events
WHERE tenant_id = $1 AND trace_id = $2
ORDER BY timestamp ASC
```
No `LIMIT`, and it pulls the heaviest columns on the table unconditionally.

**Index fact-check (unchanged from pass 2):** `idx_telemetry_events_trace_id
(trace_id, timestamp ASC)` (migration `009_telemetry_events.py:64-67`) serves
`WHERE trace_id = $2 ORDER BY timestamp ASC` on its own — `trace_id` is
effectively unique per trace, so a `tenant_id` prefix wouldn't narrow the scan
further. **No new index is needed here.** The real problem is the double-fetch
and the unbounded/wide `SELECT`.

**Fix (unchanged from prior passes, still correct):**
- Give `RootCauseAnalyzer.categorize`/`explain` an optional `events: list[dict]
  | None = None` parameter so `rca_chain` can pass its already-fetched `events`.
- Add a `LIMIT` (e.g. 2000 rows, or a byte-budget) to `_fetch_trace_events`, and
  a "thin" variant that excludes `tool_calls_full`, `tool_results`,
  `request_body`, `response_body` for the chain/list view.

---

## F4 — LOW: `resolve_issue` re-fetches the same issue row twice

**File:** `src/eden/api/routes/agent_issues.py:167-234` (`resolve_issue`)

```python
ok = await _repo.set_status(...)                          # L174
issue = await _repo.get_issue(org_id, issue_id)            # L190 — regression-run block
issue = await _repo.get_issue(org_id, issue_id)            # L209 — flywheel block
```

**Severity corrected this pass (was MEDIUM-HIGH):** `get_issue` is a cheap point
lookup (`SELECT * FROM agent_issues WHERE org_id = $1 AND id = $2::uuid`) on a
well-indexed table (`084_agent_issues.py`), reached from a human/agent-triggered,
low-QPS admin action — not a hot ingest path, not looped, not per-trace. Doubling
one cheap point-lookup doesn't belong in the same severity tier as F1–F3;
downgraded to LOW. More importantly, `bugs/02-data-consistency.md` ("Bug 8")
reviews this exact same function and found something materially worse:
`resolve_issue` silently coerces unrecognized `status` values to `"resolved"`
(firing real side-effect pipelines including regression runs and prompt
evolution), and the portal's actual `"acknowledged"` status isn't even a legal DB
value — `set_status` throws a `CheckViolation`, swallows it in a bare `except
Exception`, returns `False`, and the endpoint still returns HTTP 200 as if it
worked. Fix that correctness bug before spending effort on this doubled fetch.

**Fix:** fetch the issue once immediately after `set_status` succeeds and reuse
the same `Issue` object for both blocks.

---

## F5 — MEDIUM: per-signal write loop in `investigate_trace` is serial and unbatched

**File:** `src/eden/signals/investigator.py:255-316` (`investigate_trace`).

```python
for row in rows:                                    # L255, up to 20 rows
    await _write_event(pg, org_id, signal_id, trace_id, matched, payload, confidence)
    if matched:
        await _maybe_write_stumble(org_id, trace_id, row, payload, agent_id=agent_id)
        await cluster_after_match(org_id, signal_id)                                    # F1+F2
```
(Simplified for readability — the real code is three near-identical branches
[`statgate_rule`/`inv_prompt`/heuristic-else], each independently calling
`cluster_after_match` inside its own `try: ... except Exception: pass`,
`investigator.py:273-276,293-296,310-313`; see F2's fix for why that
exception-swallowing matters.)

**Fix:**
- Batch the `_write_event` inserts into one multi-row `INSERT`.
- Run independent per-signal work concurrently with `bounded_gather`
  (`eden/insights/incidents/clusterer.py:59-100`) instead of a plain `for` loop.
- Move `cluster_after_match` off the request path per F2's fix.

---

## F6 — LOW/MEDIUM: `list_signal_clusters` has a fixed cap but no pagination

**File:** `src/eden/api/routes/signal_investigator.py:97-149`

```sql
... FROM signal_clusters WHERE {clauses}
ORDER BY last_seen DESC NULLS LAST
LIMIT 200
```
`LIMIT 200` is hardcoded (`L124`) with no `offset`/cursor query param. The
underlying index, `idx_signal_clusters_org_signal (org_id, signal_id, status)`
(migration `104_wave8_signals.py:36-38`), doesn't cover `ORDER BY last_seen
DESC` either — low-impact today, worth folding into the same fix if pagination
is added.

**Fix:** add `limit`/`offset` (or `after_id` cursor) query params.

---

## F7 — LOW: `_fetch_cluster_members` has no LIMIT

**File:** `src/eden/insights/rca/_common.py:217-243` — `SELECT trace_id ...`
(`L234`) has no `LIMIT`, unlike its sibling `_fetch_failed_traces_in_window`
(`_common.py:178-214`, `LIMIT 500`).

**Fix:** add `LIMIT 500` (or similar), matching `_fetch_failed_traces_in_window`.

---

## F8 — LOW (minor, low blast radius): `signal_definitions` has no index covering its actual filter/sort shape

**Table:** `src/eden/db_migrations/versions/092_market_ready_consolidated.py:30-39`
— only a primary key on `id`. `097_signal_definitions_f35_bridge.py:51` adds
`(org_id, template_id)`, which doesn't cover `enabled = TRUE ORDER BY created_at
ASC` (`investigator.py:226-248`, `WHERE org_id = $1 AND enabled = TRUE [AND id =
$2] ORDER BY created_at ASC LIMIT 20`).

**Why this is LOW:** `signal_definitions` rows are created manually/rarely
(configs, not events) — per-org row counts are small and the query is bounded
by `LIMIT 20`.

**Fix (cheap, optional):** `CREATE INDEX idx_signal_definitions_org_enabled_created ON signal_definitions (org_id, created_at ASC) WHERE enabled = TRUE`.

---

## F9 — MEDIUM: `tool_call_labels` has the same shape of gap as F1, verified against live application code

**Table:** `src/eden/db_migrations/versions/092_market_ready_consolidated.py`
(same migration as `signal_events`, F1's table). Note the comparator originally
cited here — `tool_call_predictions`/`tool_call_calibrators` "getting composite
indexes in this same migration" — was wrong: those two tables actually live in
`111_w27_live_labels.py`, not `092`, with their own purpose-built indexes there
(`idx_tool_call_calibrators_org_agent`/`idx_tool_call_predictions_org_span`,
`111_w27_live_labels.py:68-75`; see "Already-good Postgres patterns" below for
the correct version of that comparison). Within `092` itself, `tool_call_labels`
shipped with no secondary index at all beyond its `UNIQUE (org_id, span_id)`
constraint:

```sql
CREATE TABLE IF NOT EXISTS tool_call_labels (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id UUID NOT NULL,
    span_id ...,
    trace_id ...,
    agent_id ...,
    label ..., reason ..., tool_name ..., args_hash ..., labeled_by ...,
    created_at ...,
    UNIQUE (org_id, span_id)
)
```
`grep -rl "tool_call_labels" src/eden/db_migrations/versions/*.py` returns only
this one migration — no later migration adds an index, and the only index this
table has is the implicit unique btree behind `UNIQUE (org_id, span_id)`.

**Confirmed live read paths that this constraint doesn't serve**
(`src/eden/learning/tool_call_labels.py`):
```sql
-- list_for_agent, :114-118
SELECT id, span_id, trace_id, tool_name, label, reason, created_at
FROM tool_call_labels
WHERE org_id = $1 AND agent_id = $2 [AND tool_name = $3]
ORDER BY created_at DESC LIMIT 200

-- count_labels, :137-140
SELECT COUNT(*) FROM tool_call_labels
WHERE org_id = $1 AND agent_id = $2 AND tool_name = $3
```
Both filter on `agent_id`, which isn't part of `UNIQUE (org_id, span_id)` — that
constraint only accelerates point lookups/upserts by `(org_id, span_id)` (which
is exactly what it's for — `ON CONFLICT (org_id, span_id) DO UPDATE`,
`tool_call_labels.py:54`), not the per-agent list/count queries both API routes
(`src/eden/api/routes/tool_call_labels.py`) and the MCP tool (`mcp_server/tools.py:307`)
actually call. Lower urgency than F1 because this table's write volume is gated
by explicit human/agent labeling actions, not one row per trace per signal
definition — but the query shape gap is real and unindexed today.

**Fix:** `CREATE INDEX IF NOT EXISTS idx_tool_call_labels_org_agent_created ON tool_call_labels (org_id, agent_id, created_at DESC)` — serves `list_for_agent`
directly and gives `count_labels` an `(org_id, agent_id)` prefix scan instead of
a full-table scan (a further `tool_name` suffix would fully cover `count_labels`
too, but `created_at DESC` is the higher-value addition since `list_for_agent`
is the paginated/user-facing path).

---

## F10 — RESOLVED / NO-OP: `live_trace_sessions` was flagged as a zero-index gap; it isn't one

**Table:** `src/eden/db_migrations/versions/111_w27_live_labels.py:52-64` —
`live_trace_sessions (org_id, session_id, trace_id, event_count,
dropped_events, finalized, created_at, updated_at)`.

**Correction this pass:** an earlier pass flagged this table as having "the same
zero-index gap as F1/F9." It doesn't — `PRIMARY KEY (org_id, session_id)` is a
composite primary key, i.e. an implicit unique btree over exactly `(org_id,
session_id)`, which is *the same leading-column shape the original F10 fix
proposed adding*. This is the identical scanner false-positive already caught
and ruled out elsewhere in this doc for `session_summaries` (see "Broader
sweep" below) — the naive `CREATE INDEX`-only regex doesn't recognize a
composite `PRIMARY KEY (...)` as an index, but Postgres does. No fix is needed;
the table already has exactly the coverage a future `(org_id, session_id)`
lookup would need. (Separately, and not the reason this is a no-op:
`grep -rln "live_trace_sessions" src/eden tests` still finds no application code
reading or writing this table today, only the migration itself and one
schema-existence test assertion — so even if the index gap had been real, there
would be no live query to be slow yet.)

---

## Cut

**Old F6 — repo-layer `limit` has no internal clamp** (`src/eden/issues/repo.py:270-306`, `:149-191`).
VERDICT: CUT (confirmed again this pass, with a corrected caller count).
`IssuesRepo.list_issues`/`list_stumbles` accept `limit: int` with no internal
`min(limit, N)` guard. **Correction:** an earlier pass described `agent_issues.py`
as "the only caller" — that's false. `grep -rn "\.list_issues(\|\.list_stumbles("
src/eden/` finds 10+ call sites beyond `agent_issues.py`: `closed_loop/verify.py:575`,
`improvement/issue_patch_trigger.py:942`, `improvement/cockpit_aggregator.py:327`,
`improvement/agent.py:439`, `api/routes/portal.py:1609`,
`evaluation/regression_builder.py:224`, `issues/triage_agent.py:144,334`,
`issues/fixture_export.py:104`, `issues/statgate_p0_rail.py:43`. Checked every
one: all pass hardcoded/bounded literals (`limit=5`/`10`/`20`/`50`, or
`_MAX_REACT_CALLS`) except `portal.py:1609`, which has its own independent
`Query(50, ge=1, le=200)` clamp identical to `agent_issues.py`'s. So the
"no live bug" verdict still holds — but because every caller happens to pass a
bounded value, not because there's only one caller. A future caller that passes
unbounded user input wouldn't be caught by anything in the repo layer itself.

---

## Broader sweep: methodology and what was ruled out

Built an automated scan over all 149 migration files: for every `CREATE TABLE`,
extract the real column list (balanced-paren parsing, not a fixed-length slice —
an earlier naive version produced ~60 false positives from columns of
*subsequent* tables in the same migration file bleeding into the capture); for
every table with an `org_id`/`tenant_id`/`agent_id`/`trace_id`/`session_id`
column, cross-check against every `CREATE INDEX`/`UNIQUE (...)`/composite
`PRIMARY KEY (...)` referencing that table anywhere in the migration history
(also had to fix the scanner to collapse adjacent Python string-literal
concatenation — `"CREATE INDEX ... "` `"ON table (...)"` split across lines,
the same style used throughout `066`/`104`/etc. — which the first pass of the
scanner didn't join, producing false "no index" hits for tables like
`signal_clusters` that are actually indexed).

After the fix, ~37 tables still show zero index and ~27 show a partial gap
(some filter column present in the table but absent from every index). Manually
spot-checked the highest-signal candidates (event/log/run-shaped names, not
config tables) against real application queries:

- **`tool_call_labels`** — real gap, confirmed against live route code → **F9**.
- **`live_trace_sessions`** and **`session_summaries`** (migrations `111` and
  `142` respectively) — both flagged by the naive scanner as zero/missing
  coverage; both **false positives** of the same kind, ruled out on inspection:
  each uses a composite `PRIMARY KEY (org_id, session_id)`, which the scanner's
  `CREATE INDEX`-only regex didn't recognize as an index. (An earlier pass of
  this doc caught this for `session_summaries` but missed applying the same
  check to `live_trace_sessions`, briefly carrying it as informational finding
  "F10" before this pass corrected it — see F10 above, now resolved/no-op.)
- **`production_eval_scores`** — has `idx_prod_eval_scores_agent_hour (org_id,
  agent_id, scored_at DESC)`, which covers the read paths actually found in
  `evaluation/production/sampler.py`, `fleet/service.py`, and
  `monitoring/dashboards.py` (all `org_id`+`agent_id`(+time) shaped); no
  confirmed `trace_id`-filtered read path found, so not flagged as a live gap
  despite the scanner marking `trace_id` "uncovered."
- The remaining ~30+ zero-index tables (`org_plans`, `org_api_keys`,
  `org_sso_settings`, `scim_identities`, `org_allowed_domains`,
  `prompt_environments`, `signal_classifiers`, `agent_registry`,
  `agent_books`/`agent_book_config`, etc.) are per-org **config/registry**
  tables — roughly one row (or a handful) per org, looked up rarely, not
  written on every trace/event. A missing secondary index on these is real in
  the strict sense but not a `signal_events`-shaped problem: no data-volume
  growth curve makes a sequential scan over ~1 row expensive. Not tracked as
  findings; noted here so this sweep reads as "checked and ruled out," not
  "didn't look."

This is also why `telemetry_events`, `agent_issues`/`agent_stumbles` (`084`),
and `signal_clusters`/`signal_backfill_jobs`/`topic_clusters` (`104`) don't
reappear here — confirmed in pass 2 as already well-indexed, and this pass's
wider scan didn't surface anything new on them.

---

## Already-good Postgres patterns confirmed this pass (contrast with F1/F8/F9 above)

`telemetry_events` remains the best-indexed table in the schema — 6 composite
btree indexes, a BRIN on `timestamp`, a TimescaleDB hypertable conversion, and a
cold-archive index, all added incrementally and each with a migration docstring
explaining the triggering incident (`030_brin_timeseries.py`,
`034_timescale_telemetry.py`, `040_trace_archive_index.py`,
`043_neon_cost_indexes.py`, `066_session21_indexes.py`, `106_filterbar_indexes.py`).
`agent_issues`/`agent_stumbles` (`084`) and `signal_clusters`/
`signal_backfill_jobs`/`topic_clusters` (`104`) also got purpose-built composite
indexes at creation time. `tool_call_predictions`/`tool_call_calibrators`
(`111_w27_live_labels.py:23,39,68-75`) got purpose-built composite indexes
(`idx_tool_call_calibrators_org_agent`, `idx_tool_call_predictions_org_span`) in
that same migration — `tool_call_labels` (F9), created separately in `092`, is
the actual "one table missed" case; `live_trace_sessions`, once suspected of the
same gap (former F10), turned out to already have adequate coverage via its
composite primary key (see F10 above).

- **`IncidentClusterer.cluster`** (`eden/insights/incidents/clusterer.py:125-207`)
  fixed an O(N × RTT) N+1 via `_gather_trace_events`
  (`bounded_gather(limit=32)`), ~5s → ~50ms for a 100-trace window. The pattern
  F5/F7 should copy, and the one F2's fix should extend to `cluster_after_match`.
- **`RootCauseAnalyzer.explain`** does *not* redundantly re-fetch trace events —
  reuses `categorize()`'s result and issues one bounded query
  (`_fetch_similar_rca_analyses(..., limit=5)`).

---

## Web research: Postgres index design (2026) + the Tinybird calculus

**Partial indexes require a literal, plan-time-provable predicate match — this
directly gates F1's design.** Per the official Postgres docs
([postgresql.org/docs/current/indexes-partial.html](https://www.postgresql.org/docs/current/indexes-partial.html)):
the planner uses a partial index only when it can prove the query's `WHERE`
clause implies the index's predicate *at planning time*; a bound parameter's
value isn't known then, so parameterized conditions (`x = $1`) generally
**cannot** use a partial index on that same column, but a literal condition in
the query text (`x = TRUE`, hardcoded) can. That's exactly why F1 needs two
different indexes rather than one: `list_signal_events` passes `matched` as a
bound parameter (`$3`), so it needs the full `(org_id, signal_id, detected_at
DESC)` composite; `cluster_signal` hardcodes `AND matched = TRUE` as a literal
in the SQL text (`clusterer.py:78`), so — and only because of that — a `WHERE
matched = TRUE` partial index is actually reachable for it. The same docs also
confirm the mechanical rationale already used in this codebase's existing
partial indexes (`idx_closed_loop_actions_pending`,
`idx_agent_issues_repetition`): smaller index, lower write-time maintenance
cost, because rows that don't match the predicate never touch the index during
`INSERT`/`UPDATE`.

**BRIN vs. B-tree, composite column order, and the Tinybird split** — unchanged
from the prior pass's findings, still correct: BRIN needs `pg_stats.correlation
>= ~0.7` (`030_brin_timeseries.py` already gates on this correctly); composite
index column order should put equality filters first (highest cardinality
leftmost) and the range/sort column last, which is why `(org_id, signal_id,
detected_at DESC)` is the right shape for both F1 indexes and why F9's `(org_id,
agent_id, created_at DESC)` follows the same rule; and Eden already applies the
Postgres-for-OLTP / Tinybird-for-aggregation split correctly for
`telemetry_events` (mirrored as `telemetry_events_ch`,
`src/eden/dsl/_common.py:54-72`). `signal_events` and `tool_call_labels` have no
analytical-layer mirror (`grep` across `src/eden/columnar/`,
`data_platform/clickhouse_sink.py`, `tinybird/` returns zero hits for either) —
fine for their current filtered/bounded query shapes, but it does mean Postgres
indexing is the only lever available for them; there's no Tinybird DSL path to
mask a slow query the way there might be for `telemetry_events`.
[OneUptime: B-Tree/GIN/BRIN](https://oneuptime.com/blog/post/2026-01-25-btree-gin-brin-indexes-postgresql/view),
[Tiger Data: Postgres index tuning](https://www.tigerdata.com/learn/postgresql-performance-tuning-optimizing-database-indexes),
[bigdataboutique: Postgres index best practices](https://bigdataboutique.com/blog/postgresql-indexes-best-practices),
[Tinybird: PostgreSQL for OLTP and analytics](https://www.tinybird.co/blog/postgresql-for-oltp-and-analytics-8-options-compared)

---

## Priority order for execution (this file)

1. **F1** — ship the `143_signal_events_indexes.py` migration above (cheap,
   additive, unblocks F2's most expensive component too). Bundle F9's index add
   into the same migration if convenient — same shape, same risk profile, zero
   marginal deploy cost.
2. **F2** — now the higher-severity half of the pair: fix or remove the
   unreachable embedder import (silent since inception, currently masking a
   ~89%-false-positive mega-clustering bug), add error-level visibility so this
   class of silent fallback can't hide again, and move `cluster_after_match` off
   the synchronous ingest path / off the event loop.
3. **F3** — stop `rca_chain`'s double-fetch and cap/thin `_fetch_trace_events`.
4. **F9** — add the `tool_call_labels` index (real, verified gap; lower urgency
   than F1 because write volume is human/agent-action-gated, not per-trace).
5. **F5** — batch `_write_event` inserts once F1/F2 land.
6. **F6, F7** — pagination/LIMIT hygiene, low urgency.
7. **F4** — dedupe `resolve_issue`'s issue-row fetch; low urgency (downgraded
   this pass, see F4) and secondary to `bugs/02-data-consistency.md`'s Bug 8 on
   the same function, which should be fixed first.
8. **F8** — optional, bundle with any other index migration work rather than
   shipping alone. (F10 is resolved/no-op — see F10 above; no fix needed.)
