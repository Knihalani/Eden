# Pass 4 — Agent B (Impact Validator) notes on optimizations/01-hotpath-perf.md

Scope per task: audit every claimed perf number for real grounding, check
redundancy against sibling docs, prune false/unverified/redundant/filler.
Did not edit the source doc. All code-fact citations below were independently
re-checked against the current tree (not taken on the doc's word), and the
core microbenchmark was independently re-run on the same machine class
(Apple M3, `.venv/bin/python3.12`, `PYTHONPATH=src`) the doc says it used.

---

## IMPACT AUDIT (per claim)

### 1. SLA source numbers (doc header: "Search (Typesense) F12: p95 < 200ms",
"StatGate (N08): p95 < 80ms, p99 < 150ms")
**Verdict: ASSERTED (target, not a measurement) — correctly flagged by the doc itself.**
These are targets quoted from `docs/specs/SOTA-PERF-COST-SCORECARD.md`, not
measurements taken in this doc. The doc's own "Evidence-integrity flag"
section already says the backing artifact
(`bench/results/f12-span-search-1m-typesense-20260804.json`) is
unreproducible from any code in the repo and un-re-verified this pass. I did
not re-litigate that (Docker unavailable here too), but I confirm the doc is
not overclaiming here — it explicitly labels this "unverified, not disproven."
No change recommended to this framing.

### 2. Core microbenchmark table (Finding 5 / the "corrected O(n²) cost" table:
0.75ms/4.68ms @ dim=8, 214.71ms/4,716.09ms @ dim=384, 731.03ms/18,517.96ms @ dim=1536)
**Verdict: PARTIALLY MEASURED, PARTIALLY NOT REPRODUCIBLE — downgrade precision, keep magnitude.**

I reran the described methodology myself (same machine class, same
`_cosine`/grouping loop imported live from `src/eden/signals/clusterer.py`).
Two independent problems found:

- **The dim=8 row's call count (4,950 @ n=100, 124,750 @ n=500) does not
  reproduce.** The grouping loop's actual `_cosine()` call count is
  data-dependent (the `used`-set short-circuits comparisons the moment two
  vectors cross the `0.82` cosine threshold — see `clusterer.py:107-118`).
  At `dim=8`, random vectors (I tried both `random.random()` uniform and
  `random.gauss` across 3 seeds each) cross that threshold often enough that
  actual measured call counts landed at **385–2,400** (not 4,950/124,750) —
  a 5–300x gap depending on distribution/seed. The full `C(n,2)` count is a
  real mathematical *worst case* (true iff literally zero pairs ever cross
  threshold — trivially provable from the code, doesn't require
  instrumentation), but the doc presents it as *"confirmed by direct
  instrumentation"* specifically for the dim=8 row, which is not what a live
  run with random vectors actually produces.
- **The dim=8 timing/call-count pairing is internally implausible.** The
  table pairs 124,750 calls with 4.68ms at n=500 → 37.5ns/call. I measured
  `_cosine()`'s real per-call cost directly with `timeit` (200k calls,
  dim=8 random vectors): **3,815 ns/call — ~100x higher** than what the
  table's numbers imply. A pure-Python function doing two `zip`/`sum`
  generator passes plus two `math.sqrt` calls cannot execute in 37.5ns under
  CPython; Python's own per-call overhead alone exceeds that. This means the
  dim=8 row's two numbers (call count, wall time) were not jointly produced
  by one live run of the actual algorithm as described — most likely the
  call count was copy-pasted from the high-dim rows (where it's genuinely
  ≈C(n,2), see below) rather than independently measured for dim=8.
- **The dim=384/1536 rows are directionally right but not precisely
  reproducible.** At those dimensions, random vectors rarely cross 0.82
  cosine similarity, so call count does converge to ≈C(n,2) (I measured
  124,318–124,750, consistent with the doc). But wall time on my run was
  **3.2–4.5x higher** than the doc's numbers at n=500 (mine: 15.3s @
  dim=384, 84.1s @ dim=1536, vs. the doc's 4.7s/18.5s), and my direct
  `timeit` per-call cost (90.7µs @ dim=384, 340µs @ dim=1536) is 2.1–2.3x
  the doc's implied per-call cost. **02-db-queries.md independently
  benchmarked the same function** (`optimizations/02-db-queries.md`, "###
  Quantifying the O(n²) cost precisely") and got a *third* different number:
  53.8µs/comparison @ dim=384 → ~6.7s @ n=500 — itself 1.4x the doc's
  implied cost and yet 1.7x lower than mine. Three independent measurements
  of the same pure-Python function, same machine class, disagree by 2–5x on
  the exact figure.

**Net verdict:** the qualitative/order-of-magnitude conclusion — "O(n²)
grouping at real embedding dimensions costs single-to-tens of seconds at
n=500, and is currently masked only by the dead embedder import" — is
**real and independently corroborated three ways** (this doc, my rerun,
02-db-queries.md's separate bench). The dead-import claim itself is
fully reproducible (see §3). But the specific millisecond figures in the
table, presented to 2 decimal places as if precisely measured, should be
downgraded to an order-of-magnitude statement ("single-digit to tens of
seconds at n=500 for realistic embedding dims") rather than cited as exact.
The dim=8 row specifically should not be cited at all in its current form —
recommend cutting the exact 4,950/124,750 call-count cells or relabeling
them "theoretical worst case, not this run's actual count."

### 3. Dead `eden.kb.embeddings` import / `ModuleNotFoundError` fallback claim
**Verdict: MEASURED — fully reproduced independently.**
Reran the exact repro:
```
$ PYTHONPATH=src python3 -c "from eden.kb.embeddings import get_default_embedder"
ModuleNotFoundError: No module named 'eden.kb.embeddings'
```
Confirmed `src/eden/kb/` has no `embeddings.py` at that path (only
`src/eden/kb/ledger/embeddings.py`, a different module with different
functions — `embed_text`, not `get_default_embedder`/`embed_batch`).
Confirmed exactly two call sites repo-wide
(`src/eden/signals/clusterer.py:199`,
`src/eden/observability/patterns_clusterer.py:147`), matching the doc. Line
citations for the try/except/fallback (`clusterer.py:198-212`) verified
exact against source. This is solid, reproducible, not overclaimed.

**However: this is not novel to this pass of the review** — see REDUNDANCY
below. `optimizations/02-db-queries.md` (its own F2, landed in *that* file's
passes 1–2, deepened further in its pass 3) documents the identical bug with
strictly more depth: it identifies the exact commit that introduced it
(`git log --diff-filter=A -- src/eden/kb/ledger/embeddings.py` → commit
`95401573`, added in the *same* commit as `clusterer.py` — i.e. "never
worked, not broke via refactor," which is more precise than this doc's
"coincidence, not history" framing), and traces the call path further
upstream into `workers/trace_finalized_consumer.py::_run_signal_investigator`
— meaning the bug also fires on the async ingest consumer, not only on the
synchronous `POST /traces/{trace_id}/investigate` route this doc frames it
around.

### 4. Round-trip ledger (5,102 Postgres round trips, 20 Redis round trips,
2,495,000 CPU comparisons worst-case for one `investigate_trace` call)
**Verdict: DERIVED-FROM-CODE ARITHMETIC, not measured — correctly labeled as such by the doc.**
Checked the arithmetic: `2 + R + M·3 + M·(1+G)` at `R=M=20, G=250` →
`2+20+60+20×251 = 5,102`. Correct. Checked the bounds it's built from against
source:
- `R ≤ 20`: confirmed, `LIMIT 20` at `investigator.py:232` and `:246`.
- Stumble-write chain round trips (1 Redis + up to 3 Postgres per matched
  row): confirmed against `stumble_writer.py:121-134` (`_burst_seen`, 1
  `redis.set(...NX)`), `issues/repo.py:101-147` (`insert_stumble`, 1
  `fetchrow` INSERT), `issues/issue_promoter.py:41-181` (`upsert`, a `SELECT
  ... FOR UPDATE` then one `_insert`/`_update` = 2 round trips). Matches
  exactly.
- `n ≤ 500`, `G ≤ n/2`: confirmed, `LIMIT 500` at `clusterer.py:81`
  (`cluster_signal`'s fetch), and `G ≤ n/2` is a valid mathematical upper
  bound given groups require ≥2 members.

This is legitimate, source-grounded math, not a live benchmark — and the doc
itself says as much ("a hard ceiling derived from the code's own bounds, not
a speculative extrapolation"). No overclaiming here; keep as-is. One caveat
worth adding: it's a *worst case* built from every independent `LIMIT`
maxing out simultaneously — the doc doesn't estimate how often that actually
happens in practice. `02-db-queries.md`'s F2 section does address realistic
likelihood (see NEW FINDINGS below) — worth cross-referencing in synthesis.

### 5. Web research citations (Typesense facet cost ~3ms–78ms community
thread; Python docs on `asyncio.to_thread` and CPU-bound work)
**Verdict: EXTERNALLY SOURCED, correctly caveated.** Both are real, cited,
checkable URLs, used only as directional corroboration for a mechanism (not
as an Eden-specific number). Appropriate use — not a codebase benchmark
claim, doesn't need downgrading.

### 6. "Verdict: checked, ruled out" for `GET /agents`/`GET /issues` (portal
dashboard hot path)
**Verdict: CODE FACT, VERIFIED — no perf number claimed, just round-trip counts.**
Confirmed against `src/eden/api/routes/portal.py`: `asyncio.gather` at
`:1090-1094` for `_load_registry`/`_load_metrics`/`_load_open_issues`;
`list_portal_issues` (`:1598`) → `IssuesRepo.list_issues` + one batched
`_resolve_stumble_refs` call, matching the doc's "2 sequential round trips,
no N+1" claim. No latency numbers are claimed here (correctly — no bench
exists), just round-trip *counts*, which are code facts, not estimates. Good
use of "profiled" to mean "traced," not "timed" — the doc is honest about
this distinction throughout, which is worth crediting.

### 7. Finding 1 (opt-in faceting) code facts
**Verdict: VERIFIED.** `search_service.py:375` (`facet_by: tuple[str,...] |
None = None`), `:441` (`facets = ... if facet_by else
",".join(self.DEFAULT_FACET_FIELDS)`), `suggest()` narrowing to one facet at
`:559`. All match. No ms magnitude is claimed as measured for Eden itself —
the doc correctly labels its confidence "MEDIUM on ms magnitude pending the
unresolved evidence-integrity issue," which is the right call given F12 is
unreproducible.

### 8. Finding 7 (duplicate `get_settings()`)
**Verdict: VERIFIED, trivial.** `get_settings()` calls at `search_service.py:395`
and `:462` — two per `search()` call, confirmed. No perf number attached
(correctly, since it's a "LOW/trivial" finding with no bench claimed).

---

## CUT

1. **The dim=8 row of the microbenchmark table** (`| 100 | 8 ... | 0.75 ms |
   4,950 |` and `| 500 | 8 ... | 4.68 ms | 124,750 |`) — the call count is
   not reproducible with the described methodology (my 6 independent reruns:
   385–2,400 calls at n=500, not 124,750) and the timing/call-count pairing
   implies a per-call cost (37.5ns) that is ~100x faster than directly
   measured (`timeit`: 3,815ns/call) or than a second independent source
   measured (`02-db-queries.md`: 2.7µs/call). Reason to cut: this specific
   row reads as a fabricated or copy-pasted-from-elsewhere number dressed up
   as "confirmed by direct instrumentation," which is a stronger claim than
   the evidence supports. Recommend either removing the row or relabeling it
   "theoretical worst case (not this run's measured count)."

2. **"confirmed by direct instrumentation — 124,750 at n=500, not 250,000...
   (the used-set bookkeeping produces the upper triangle, not a full n×n
   scan)"** — the *upper bound* correction (C(n,2) vs n²) is correct and
   useful (matches `02-db-queries.md`'s independent correction of the same
   prior-pass error), but "confirmed by direct instrumentation" overstates
   it: it's a trivial algebraic fact from reading the `used`-set guard, true
   regardless of instrumentation, and — per above — is *not* what the dim=8
   instrumented run actually produced. Reword to "provable directly from the
   `used`-set guard at `:107-118`" rather than "confirmed by instrumentation."

3. **"the first time this file has put an exact number on 'up to 20x'"** and
   similar "headline result"/"first...to..." framing around Finding 5 — not
   false about this *file's own* pass history, but misleading in the context
   of the full review: `optimizations/02-db-queries.md` already landed this
   exact bug (dead `eden.kb.embeddings` import, O(n²) grouping cost) with
   *more* precision (exact introducing commit, broader call-path including
   the ingest consumer) in its own passes 1–3, which predate or run parallel
   to this file's pass 4. Recommend softening to avoid implying
   review-wide novelty; see REDUNDANCY below for the synthesis note.

4. Two decimal places on the O(n²) wall-time figures throughout (e.g.
   "4,716.09 ms", "18,517.96 ms", "731.03 ms") — false precision given three
   independent measurements of the same computation (this doc, my rerun,
   `02-db-queries.md`) disagree by 2–5x. Round to one significant figure
   ("~5s", "~19s", "~0.7s") or present as a range across machines/runs.

---

## REDUNDANCY (major — flag for synthesis)

`optimizations/02-db-queries.md` substantially duplicates this doc's
Findings 4, 5, and 6, with more depth in most places:

- **Finding 5 (dead embedding import + O(n²) grouping)** ≈
  `02-db-queries.md` **F2** ("`cluster_after_match` runs inline on the
  shared ingest consumer — and its 'real embedding call' is unreachable dead
  code"). F2 is deeper: it pinpoints the exact introducing commit
  (`95401573`, same commit as `clusterer.py` itself — i.e. never worked, not
  a later regression), traces the call path into
  `workers/trace_finalized_consumer.py` (background ingest, not just the
  synchronous HTTP route this doc frames it around), and runs its own O(n²)
  microbenchmark with a "why n=500 is the realistic case, not a tail case"
  argument this doc doesn't have (F2's traffic-model math: `TRACES_PER_ORG_DAY
  = 1_000` × 14-day lookback → any signal firing on ≥3.6% of traces
  saturates the `LIMIT 500` cap — i.e. n=500 is steady-state for any
  commonly-firing signal, not an edge case). This doc should either defer to
  F2 as the canonical writeup and keep only its unique addenda (the
  `_cosine` norm-recompute micro-opt, the `asyncio.to_thread`-doesn't-help
  Python-docs citation, and the fact that fixing the import *in isolation*
  would regress event-loop latency — F2 makes essentially the same "don't
  fix in isolation" point but this doc's phrasing is clearer), or synthesis
  should merge them explicitly rather than carry two independent tables of
  disagreeing numbers for the same computation into the final report.
- **Finding 4 / 6 (sequential per-row writes, stumble-write round trips)** ≈
  `02-db-queries.md` **F5** ("per-signal write loop in `investigate_trace` is
  serial and unbatched") — same file, same lines
  (`investigator.py:255-316`), same fix (batch inserts, `asyncio.gather`/
  `bounded_gather`). F5 even cites a more directly-analogous existing
  in-repo precedent (`eden/insights/incidents/clusterer.py:59-100`'s
  `bounded_gather`) than this doc's `GET /agents` contrast.
  **Not fully redundant, though:** this doc's Finding 6 — the exact
  stumble-write round-trip chain through `stumble_writer.py` →
  `issues/repo.py` → `issue_promoter.py` (1 Redis + up to 3 Postgres per
  matched row) — is *not* present in `02-db-queries.md` (checked: it
  mentions `_maybe_write_stumble` only as one line in a code excerpt, never
  traces into it). This is this doc's one genuinely new, non-duplicated
  contribution in the round-trip area and should survive synthesis.
- Finding 1 (opt-in faceting), Finding 2 (StatGate uncapped scan), Finding 3
  (`compress_trace` recompute), Finding 7 (duplicate `get_settings()`), and
  the `_cosine` redundant-norm micro-optimization are **not** duplicated
  anywhere else I checked (`grep`'d all of `optimizations/*.md` and
  `bugs/*.md` for `facet_by`, `search_service`, `_eval_statgate_rule`,
  `precompute`/`L2 norm` — no hits outside this file). Keep these.
- The `GET /agents`/`GET /issues` "checked, ruled out" section is unique to
  this doc (no other optimization/bug doc profiles those routes) — keep,
  it's useful negative-result documentation and the contrast with
  Findings 4-6 is a legitimate and well-supported rhetorical point.

---

## NEW FINDINGS (from this audit, not in the source doc)

1. **The microbenchmark table's dim=8 row is very likely not from a live run
   of the described methodology** (see CUT #1/#2 and IMPACT AUDIT §2 above)
   — worth flagging to the doc owner/synthesis as a possible evidence-quality
   issue in this pass's *own* new material, not just the pre-existing F12
   evidence-integrity flag it carries over. This is a new, pass-4-introduced
   instance of the same class of problem (a specific-looking number that
   doesn't reproduce) the doc itself was set up to catch in the F12 JSON.
2. **Three independent benchmarks of the same `_cosine`/grouping computation
   (this doc, my rerun, `02-db-queries.md`) disagree by 2–5x on exact
   figures but agree on order of magnitude** (single-digit to tens of
   seconds at n=500, real embedding dims) — recommend synthesis present this
   as a corroborated *range*, not adopt any one file's specific numbers as
   authoritative.
3. **The embedding-dead-import bug also fires on the async ingest consumer**
   (`workers/trace_finalized_consumer.py::_run_signal_investigator`, per
   `02-db-queries.md` F2), not only on the synchronous
   `POST /traces/{trace_id}/investigate` route this doc frames Finding 5
   around. If Finding 5 is kept/merged in synthesis, its blast-radius
   framing should be widened accordingly — the "blocks one HTTP request's
   event loop" framing undersells it; it can also stall the shared
   trace-finalized ingest consumer for every org sharing that worker
   process, per F2's own analysis.
