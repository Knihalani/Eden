# Hot-Path Performance — search_service.py / signals/investigator.py

Fourth-pass deepening of this file. Prior passes (1) qualitatively described
the hot paths and (2) traced the F12 bench artifact's provenance and found
it unreproducible (see **Evidence-integrity flag**, unchanged this pass —
not revisited). This pass's mandate: get *real numbers* wherever possible
instead of more prose, precisely count round trips instead of describing
them qualitatively, check one more hot path, and — the headline result —
**directly executing** `signals/clusterer.py`'s embedding call surfaced a
bug the first two passes missed entirely: it's dead code that silently
never runs, which both *reduces* one risk (no real model-inference latency
today) and *creates* a new, more important one (clustering runs on fake
vectors, silently, with no signal anywhere that it's happening).

**SLA source:** `docs/specs/SOTA-PERF-COST-SCORECARD.md` (line 17: Search
(Typesense) F12 row, `MET @1.1M (tuned) — 10M staging follow-up`; line 56
overall verdict `PARTIAL-GREEN`). Relevant targets:
- Search (Typesense) F12: **p95 < 200ms**
- StatGate (N08): **p95 < 80ms, p99 < 150ms** — measured against a
  *different class* (`StatGateIncidentScorer`) than the rule evaluator in
  `signals/investigator.py`, which has no microbench at all (Finding 2).

---

## What I could and couldn't run locally

`docker info` fails (`dial unix .../docker.sock: connect: no such file or
directory` — Desktop daemon not running in this environment), so none of
`docker/docker-compose.yml`'s five services (Postgres, Typesense, Redis,
ClickHouse, Qdrant) are reachable. **No end-to-end measurement of
`search_service.py` or the full `investigate_trace` HTTP route is possible
here.** That part of the ask can't be satisfied honestly — I did not run a
live server against real data, and any claim to have done so would repeat
exactly the provenance problem flagged last pass.

What *is* runnable without any external service: pure-Python code paths,
imported directly from the checked-out source with `PYTHONPATH=src`. Two
things came out of exercising that:

1. **A live import test proves `SignalEventClusterer._embed`'s "real
   embedding call" never executes on this branch.**
   `clusterer.py:199` does `from eden.kb.embeddings import
   get_default_embedder` inside the `try` at `:198-204`. Run directly:

   ```
   $ PYTHONPATH=src .venv/bin/python -c \
     "from eden.kb.embeddings import get_default_embedder"
   ModuleNotFoundError: No module named 'eden.kb.embeddings'
   ```

   `eden.kb`'s actual submodules (`pkgutil.iter_modules`) are: `book,
   episodic, exploit, flywheel, ledger, procedural, prompt_versions,
   research, retrieval_intel, retrieval_logger, semantic, shared,
   strategy_store` — no `embeddings` module exists anywhere under
   `eden.kb` in this tree. `grep -rn "get_default_embedder|embed_batch"
   src/` finds exactly two call sites, both importing this same dead
   path: `signals/clusterer.py:199` and
   `observability/patterns_clusterer.py:147`.

   **This is the same bug `optimizations/02-db-queries.md` documents in
   more depth as its F2** — not re-derived here. F2 pinpoints the exact
   introducing commit (`95401573`, the same commit that added
   `clusterer.py` itself, i.e. this call has **never** worked, it isn't a
   later regression) and traces the call path further upstream into
   `workers/trace_finalized_consumer.py::_run_signal_investigator` — so
   the bug also silently corrupts clustering on the async ingest
   consumer, not only on the synchronous `POST
   /traces/{trace_id}/investigate` route this doc's round-trip ledger
   (below) focuses on. See F2 for the fuller commit forensics.

   Consequence: the `except Exception` at `clusterer.py:205` catches this
   `ModuleNotFoundError` on **every single call**, logs it at `debug`
   level only (invisible in production unless debug logging is on), and
   falls through to the deterministic `stable_hash` fallback
   (`:207-212`). I called it directly to confirm the actual runtime shape:

   ```
   $ PYTHONPATH=src .venv/bin/python -c "
   import asyncio
   from eden.signals.clusterer import SignalEventClusterer
   print(asyncio.run(SignalEventClusterer()._embed(
       ['hello world', 'another summary text'])))"
   [[0.4226..., 0.4329..., ...],  # 8-dim, hash-derived
    [0.9278..., 0.9381..., ...]]
   ```

   So today, `cluster_after_match` never makes a real embedding-model
   call and never pays real inference latency — but it also never does
   real semantic clustering: every matched signal is grouped by cosine
   similarity over 8-dimensional pseudo-vectors derived from
   `stable_hash(text) % 1000`, silently, with no error surfaced past a
   `debug` log line. This is a correctness bug that happens to also be
   the reason Finding 5 (below) isn't as slow as it looks — and fixing
   the import without also fixing the O(n²) grouping would make things
   *worse* (see next section).

2. **Microbenchmarked the actual `_cosine`/grouping loop, imported live
   from `clusterer.py:105-119`**, at realistic embedding dimensions
   (script: generate `n` random vectors, run the real grouping function,
   time it — `python3.12`, M-series laptop, single run,
   `time.perf_counter`; **this script is not committed anywhere in the
   repo**, so — same caveat class as the evidence-integrity flag below,
   just smaller in scope — a future reader can't re-run it, only trust
   the numbers below as illustrative, not a reproducible artifact):

   | n | dim | wall time (range across independent reruns) | `_cosine()` calls (worst case) |
   |---|---|---|---|
   | 500 | 384 (e.g. MiniLM-class embedder) | **~5-15s** | ≈124,750 |
   | 500 | 1536 (e.g. `text-embedding-3-small`) | **~20-85s** | ≈124,750 |

   (`n=100` scales down by roughly the same `C(100,2)/C(500,2) ≈ 1/25`
   ratio — low-single-digit seconds at `dim=384`, single-digit seconds at
   `dim=1536` — not independently re-verified at that size.)

   **Cut from the original table: the dim=8 row.** At the 8-dim
   hash-fallback dimensionality actually in use today, the grouping
   loop's `used`-set early-exit (`:113-114`, `if j in used: continue`)
   fires far more often — low-dimensional random vectors cross the
   `_COSINE_THRESHOLD = 0.82` clustering threshold by chance much more
   often than high-dimensional ones do (a standard
   concentration-of-measure effect) — so the real call count at n=500,
   dim=8 lands somewhere around 400-2,400 depending on seed and
   distribution, not a fixed 124,750, and it did not reproduce
   consistently across reruns. The original pairing (124,750 calls /
   4.68ms) also implies roughly 37.5ns per `_cosine()` call, which is not
   physically plausible for a pure-Python function doing two
   `zip`/`sum` passes plus two `math.sqrt` calls under CPython (directly
   measured per-call cost: ~2.7-3.8µs, ~70-100x higher) — the two numbers
   in that row were not jointly produced by one live run of the algorithm
   as originally framed, and the row is dropped rather than relabeled.

   **The dim=384/1536 figures above are order-of-magnitude, not precise.**
   Three independent measurements of the same `_cosine`/grouping
   function — this pass's own rerun, a separate pass-4 rerun, and
   `optimizations/02-db-queries.md`'s own independent O(n²) bench of the
   same function — agree that the cost is real and lands in the
   single-digit-to-low-double-digit-seconds range at `dim=384` and the
   tens-of-seconds range at `dim=1536` (at n=500), but disagree with each
   other by **2-5x** on the exact figure. Reporting this to two decimal
   places (as the original table did) is false precision; treat it as a
   corroborated order of magnitude, not a measurement.

   One correction to the prior pass's qualitative "up to 250,000
   comparisons" claim survives: the call count is provably bounded by
   `C(n,2) = n(n-1)/2` from the `used`-set guard at `:107-118` — 124,750
   at n=500, not 250,000 (the bookkeeping produces the upper triangle,
   not a full n×n scan) — but this is a **worst-case bound**, true only
   when no vectors ever cluster. That holds for genuinely dissimilar
   high-dimensional embeddings (hence it's a reasonable ceiling for
   Finding 5's risk framing), but not necessarily for real production
   signal events, which may cluster the way they're actually meant to —
   in which case real-world cost could land below this ceiling. Fixing
   the dead import in isolation, at n=500 (the code's own `LIMIT 500`),
   would add on the order of several-seconds-to-tens-of-seconds of pure
   CPU time to a single `cluster_after_match` call — and per Finding 5,
   that can run up to 20x inside one `POST /traces/{trace_id}/investigate`
   request.

   A further, previously-unflagged inefficiency in `_cosine`
   (`clusterer.py:25-33`): it recomputes both vectors' L2 norms
   (`na`/`nb`) from scratch on every pairwise call. `vi`'s norm is
   invariant across the whole inner `for j` loop but gets recomputed `n`
   times anyway; precomputing all `n` norms once (O(n·d)) before the O(n²)
   loop and reusing them would cut roughly a third of the redundant work
   at the same asymptotic class.

3. **The grouping loop is not `asyncio.to_thread`'d — only the embedding
   call is** (`:204`, `await asyncio.to_thread(embedder.embed_batch,
   texts)`; the O(n²) loop at `:105-119` runs directly in the coroutine
   body). So even if the embedding bug were fixed, the several-to-tens-of-
   seconds of CPU work measured above would block the **entire
   single-threaded asyncio event loop** for that duration — stalling every other concurrent
   request on that worker process, not just the one being investigated.
   Python's own docs are explicit that `to_thread` doesn't help CPU-bound
   work under CPython anyway (see Web research) — so wrapping the
   grouping loop in `to_thread` wouldn't fix this either; it needs to
   either run in a process pool or be algorithmically capped/batched.

---

## Evidence-integrity flag: unchanged from prior pass

`bench/results/f12-span-search-1m-typesense-20260804.json` is still
unreproducible from any code in this repo (traced in the prior pass: the
committed `bench_f12_span_search.py` has no code path that can produce
this JSON's `per_class_untuned`/`tuning_experiment`/`honest_caveats`
structure, and its own docstring hardcodes `"Status: BLOCKED — staging
Typesense not available"`). Not re-verified this pass since Docker being
unavailable here means I have no way to either reproduce or further refute
it — treat as **unverified, not disproven**, same as before.

---

## Findings

| # | Location | Issue | Recommended fix | Impact / Confidence |
|---|---|---|---|---|
| 1 | `search_service.py:441-450`, `DEFAULT_FACET_FIELDS` at `:200-206`; wired from `api/routes/observability.py:830-844` | `search()` always requests `facet_by=DEFAULT_FACET_FIELDS` (5 fields, `max_facet_values=25`) on every call, including `q=""` → Typesense `q="*"` match-all, where facet cost is computed over the full matched corpus. `suggest()` already narrows to one facet (`:559`) for exactly this reason; `search()` doesn't follow its own pattern. | Default `facet_by=None`, move faceting to the existing `SearchService.facets()` (`:565-584`), called only when the filter panel is open, with a short TTL cache. | **HIGH** on the code fact (verified in source). **MEDIUM** on ms magnitude pending the unresolved evidence-integrity issue — mechanism is independently corroborated by Typesense docs (below). |
| 2 | `investigator.py:123-137`, `:139-151` (`_eval_statgate_rule`) | Both branches do an uncapped `for e in events` scan (no `[:80]` cap like `compress_trace`). Runs once per enabled `statgate_rule` row, up to 20x per trace, no shared precomputation. Reachable synchronously from `POST /traces/{trace_id}/investigate`. | Cap the scan or precompute shared per-event derived state once per `investigate_trace` call. Add a latency microbench — none exists for this function specifically. | **MEDIUM** — code asymmetry verified; magnitude unmeasured, still no bench exists (Docker being unavailable this pass didn't change that; it needs Postgres+Redis, which is genuinely low-cost to spin up per the corrected benchmark plan below — this pass just didn't have a running daemon). |
| 3 | `investigator.py:76-108` (`_heuristic_match`) | Recomputes `compress_trace(events).lower()` from scratch per signal definition, up to 20x per trace. Capped at 80 events/4000 chars. | Compute once, pass into `_heuristic_match`. | **LOW-MEDIUM** — cheap, easy fix, low priority given the cap. |
| 4 | `investigator.py:255-316` (main loop) | See **exact round-trip ledger** below — precisely counted this pass instead of described qualitatively. Same code, same bug as `optimizations/02-db-queries.md` F5 (independently derived); not double-counted, see cross-reference below. | Batch `signal_events` inserts; run per-matched-row stumble-write + cluster hooks concurrently — via `bounded_gather` (`eden.async_tasks.bounded_gather`, already used successfully at `eden/insights/incidents/clusterer.py:59-100` for this exact shape of problem), not a bare `asyncio.gather`: an unbounded fan-out over up to 20 concurrent per-matched-row chains (each up to 4 sequential round trips) risks a burst of up to 20 simultaneous DB/Redis connections from one request, which `bounded_gather` caps and `GET /agents`'s fixed 3-way `gather` (contrast below) never has to worry about. See `optimizations/02-db-queries.md` F5 for the same recommendation. | **MEDIUM** — code asymmetry and round-trip counts verified from source. Not escalated to MEDIUM-HIGH: the ~5,100-round-trip figure in the ledger below is a worst case requiring all `R=20` signal definitions to match the same trace simultaneously; neither this doc nor `02-db-queries.md` (which rates the same finding MEDIUM) estimates how often that actually happens, so the ceiling alone doesn't justify a higher confidence than the sibling doc's. |
| 5 | `investigator.py:275` → `clusterer.py:215-225` → `:57-150` | Not "a real embedding call + O(n²) grouping" — it's a **broken import that always no-ops into a cheap hash fallback** (see reproduction above; fuller forensics, including the exact introducing commit and the async-ingest-consumer blast radius, in `optimizations/02-db-queries.md` F2) **+ a real, order-of-magnitude-measured O(n²) grouping cost that is currently harmless only because of that same bug**, run directly on the event loop (not `to_thread`'d), up to 20x per trace, plus up to ⌊n/2⌋ unbatched Postgres INSERTs per call (n≤500). | (a) Fix or remove the dead `eden.kb.embeddings` import — but **only together with** (b), never in isolation: (b) cap/batch/approximate the O(n²) grouping (order-of-magnitude: single-digit to tens of seconds at n=500 with real embedding dims — see corrected benchmark above) and move it off the event loop (process pool, not `to_thread` — see Python docs below) or off the synchronous request path entirely; (c) batch the per-group cluster INSERTs. | **HIGH** on the dead-import claim (directly reproduced, not inferred, and corroborated independently by `02-db-queries.md` F2's commit forensics). **MEDIUM** on the O(n²) cost's exact magnitude — real and order-of-magnitude confirmed by three independent measurements, but the specific figures disagree 2-5x across them and the benchmark script isn't committed to the repo, so it doesn't clear the same bar as "measured" implies elsewhere in this doc. |
| 6 | **New this pass, confirmed unique — not covered by `02-db-queries.md`** — `investigator.py`→`stumble_writer.py`→`repo.py`/`issue_promoter.py` chain | See exact round-trip ledger below: each matched signal's stumble-write path alone is 1 Redis + up to 3 Postgres round trips, sequential, before `cluster_after_match` even starts. | Same fix as Finding 4 — parallelize across matched rows with `bounded_gather`. | **MEDIUM** — mechanism and exact counts verified from source; not separately benched. |
| 7 | `search_service.py:393-397`, `:461-465` | Two separate `get_settings()` calls per `search()` invocation. | Fetch once at top of `search()`. | **LOW** — trivial, fold into Finding 1's edit. |

---

## Exact round-trip / Big-O ledger for `investigate_trace`

Traced line-by-line through `investigator.py`, `clusterer.py`,
`stumble_writer.py`, `repo.py`, `issue_promoter.py`, and
`rca/_common.py`. `R` = rows returned by the `signal_definitions` query
(`R ≤ 20`, hard `LIMIT`). `M` = matched rows (`M ≤ R`). `n` = historical
`signal_events` fetched per `cluster_after_match` call (`n ≤ 500`, hard
`LIMIT`).

**Fixed cost, once per `investigate_trace` call:**
1. `_fetch_trace_events` (`rca/_common.py:104-140`) — 1 Postgres round trip.
2. `pg.fetch(signal_definitions ...)` (`investigator.py:224-248`) — 1 Postgres round trip.

**Per row, `R` times (`investigator.py:263-267`, `_write_event`):**
3. 1 Postgres round trip each — single-row `INSERT`, no `executemany`/batching. → `R` round trips.

**Per matched row, `M` times — stumble-write chain (`_maybe_write_stumble` → `StumbleWriter.create`):**
4. `_burst_seen` (`stumble_writer.py:121-134`) — 1 Redis round trip (`SET ... NX`).
5. `_repo.insert_stumble` (`repo.py:101-147`) — 1 Postgres round trip (single `fetchrow`-shaped INSERT).
6. `IssuePromoter.upsert` (`issue_promoter.py:41-181`) — fingerprint lookup (1 round trip) then `_insert` or `_update` (1 round trip) = 2 Postgres round trips.
7. `_fire_stumble_created` — best-effort hook, cost unbounded/out-of-file-scope, wrapped in try/except so it can't fail the write but its own latency isn't accounted for here.
→ **1 Redis + up to 3 Postgres round trips per matched row**, before clustering even starts.

**Per matched row, `M` times — `cluster_after_match` → `cluster_signal` (`clusterer.py:57-150`):**
8. `pg.fetch(signal_events ... LIMIT 500)` (`:72-86`) — 1 Postgres round trip, returns `n ≤ 500` rows.
9. `_embed(summaries)` (`:195-212`) — **0 external round trips** (confirmed: always hits the `ModuleNotFoundError` fallback on this branch, see reproduction above).
10. Grouping loop (`:105-119`) — `C(n,2) = n(n-1)/2` `_cosine()` calls is a provable **worst-case bound** from the `used`-set guard (not a live measurement) — up to 124,750 at `n=500`, reached only when no vectors ever cluster; today's real 8-dim hash-fallback vectors cluster often enough that actual call counts run well below this ceiling (measured in the 400-2,400 range at n=500 across reruns, not a fixed number). Each call is `O(d)`; `d=8` today is cheap in absolute terms (harmless), `d∈[384,1536]` if the embedder bug were fixed in isolation is order-of-magnitude single-digit-to-tens-of-seconds (see corrected benchmark above; not precisely reproducible to less than 2-5x across independent runs) — **not** offloaded to a thread/process, blocks the event loop directly.
11. Per resulting group, `G` times (`G ≤ n/2` worst case) — 1 Postgres INSERT round trip each (`:128-146`), sequential, unbatched.
→ **1 Postgres fetch + 0 embedding calls + O(n²) CPU work + up to ⌊n/2⌋ Postgres INSERTs** per matched row.

**Worst-case total for one `POST /traces/{trace_id}/investigate` call**, bounded entirely by the code's own `LIMIT`s (`R=20`, `n=500` per matched row):
- Postgres round trips: `2 + R + M·3 + M·(1 + G)` → at `R=M=20`, `G≈250`: **2 + 20 + 60 + 20×251 = 5,102**.
- Redis round trips: `M` → up to **20**.
- External embedding/ML calls: **0** (currently — see Finding 5).
- CPU-bound pairwise comparisons: `M × n(n-1)/2` → up to **20 × 124,750 = 2,495,000**, all synchronous on the event loop.

This is a hard ceiling derived from the code's own bounds, not a
speculative extrapolation — the first time this file has put an exact
number on "up to 20x" rather than leaving it qualitative. It is,
however, still a **worst case, not a typical-case estimate**: it
requires all `R=20` enabled `signal_definitions` to match the same trace
simultaneously, and neither this doc nor `optimizations/02-db-queries.md`
(which independently derives the same code path as its own F5) estimates
how often that actually happens in practice — treat the ~5,100/~20
figures as an upper bound on blast radius, not an expected value.

---

## Second hot path profiled: portal dashboard load (`GET /agents`, `GET /issues`)

Picked per the task's suggestion — the portal Home page's agent-cards and
issue-list endpoints, both prefetched server-side by
`clients/portal/src/lib/portal-dehydrate.ts` (`Promise.allSettled` +
`settleWithin(budgetMs)` racing the prefetches against a time budget, so a
slow shard degrades to an honest client-side refetch instead of blocking
first paint — a good pattern in its own right, not touched further here).

**`GET /agents` → `list_portal_agents` (`api/routes/portal.py:858-861`):**
Traced `_load_registry` (`:886-925`), `_load_metrics` (`:929-1061`), and
`_load_open_issues` (`:1063-1089`) — each does exactly **one** bounded
Postgres query (`LIMIT 200`/`LIMIT 4000`, server-side `percentile_cont`
for p50/p95 and `GROUP BY` for aggregation, not pulled client-side). All
three are run via **`await asyncio.gather(_load_registry(),
_load_metrics(), _load_open_issues())`** (`:1090-1094`) — concurrently,
not sequentially. Per-agent card assembly afterward is `O(agents)` with
dict lookups, no N+1. `_load_metrics`'s own comment is explicit about the
tradeoff it's making: *"Bounded window scan... full-window GROUP BY is too
expensive for hot tenants."*

**`GET /issues` → `list_portal_issues` (`:1598-1616`):** `IssuesRepo.list_issues`
(`repo.py:270-306`) — 1 bounded query (`limit ≤ 200`) — then
`_resolve_stumble_refs` (`portal.py:1727-1759`) — 1 **batched** query
(`WHERE id::text = ANY($2::text[])`, not a per-stumble loop) to map
stumble IDs → trace IDs. **Exactly 2 sequential Postgres round trips
total**, no N+1, regardless of how many issues/stumbles are on the page.
`_related_issue_ids_by_session` (`:1762-1806`, used by the sessions
rollup on the same page) follows the identical single-batched-query shape.

**Verdict: checked, ruled out — and useful as a contrast, though not the
closest one in the codebase.** Both routes are `O(1)` round trips per
concurrently-gathered shard (3 for `/agents`, 2 sequential for `/issues`),
every query is bounded, and neither has an N+1. This matters beyond "no
bug here": it demonstrates the codebase *already knows how* to write
concurrent, batched code (`asyncio.gather` for a small fixed fan-out,
batched `ANY($...)` instead of a per-row loop) — the sequential,
unbatched pattern in `investigate_trace` isn't a capability gap, it's a
real inconsistency in a request path that apparently didn't get the same
review attention. Note, though, that `/agents`'s fan-out is small and
fixed (3 shards), not the unbounded-per-matched-row shape Findings 4/6
need to fix — `eden/insights/incidents/clusterer.py`'s `bounded_gather`
(cited in Finding 4's fix) is the closer precedent for that specific
shape.

---

## Web research

- **Typesense faceting cost** — official docs
  ([`typesense.org/docs/30.2/api/search.html`](https://typesense.org/docs/30.2/api/search.html))
  confirm `facet_by`/`max_facet_values` compute aggregate counts over the
  matched result set. A Typesense community benchmark thread
  ([`threads.typesense.org/t/33174733`](https://threads.typesense.org/t/33174733/hi-everyone-i-have-a-question-regarding-facets-in-typesense-))
  measured facet cost scaling with `max_facet_values` (a Typesense team
  member's own numbers on a small ~3k-doc collection: ~3ms for a flat
  facet up to ~78ms at `max_facet_values=100000` when combined with
  `facet_return_parent`), and the team's stated guidance is to keep
  `max_facet_values` modest and use `facet_query` for exploration rather
  than widening the returned facet set — directly consistent with Finding
  1's recommendation to make faceting opt-in rather than defaulted-on.
  **Caveat:** that ~3k-doc collection is 3-4 orders of magnitude smaller
  than Eden's own 1.1M-doc F12 target (10M staging follow-up), and facet
  cost generally scales with matched-corpus size as well as
  `max_facet_values` — this citation supports the *mechanism* (faceting
  isn't free, narrowing it helps), not the *magnitude* at Eden's actual
  scale. Treat it as weak circumstantial corroboration, not a stand-in
  for an Eden-specific measurement.
- **`asyncio.to_thread` and CPU-bound work** — official Python docs
  ([`docs.python.org/3/library/asyncio-task.html#asyncio.to_thread`](https://docs.python.org/3/library/asyncio-task.html#asyncio.to_thread))
  state it is *"primarily intended... for executing IO-bound
  functions/methods"* and explicitly warn: *"Due to the GIL,
  `asyncio.to_thread()` can typically only be used to make IO-bound
  functions non-blocking... for CPU-bound functions"* it generally
  doesn't help under CPython. This directly grounds the Finding-5 note
  above: even a correctly-wired embedding call wrapped in `to_thread`
  wouldn't meaningfully parallelize CPU-bound inference under standard
  CPython, and — more importantly — the O(n²) grouping loop isn't even
  given that partial benefit today, since it isn't wrapped in `to_thread`
  at all.

---

## Corrected, honest benchmark plan

The existing F12 JSON is unreproducible; here's what would actually need
to run, split by what's cheap vs. expensive to set up:

**Cheap, no Typesense needed — `investigate_trace`/`cluster_after_match` (Findings 2-6):**
1. `docker compose -f docker/docker-compose.yml up postgres redis` — only 2
   of the 5 services, no Typesense/ClickHouse/Qdrant required.
2. Run migrations, seed: 1-20 `signal_definitions` rows (mix of
   `statgate_rule`/heuristic), one trace with `telemetry_events` at 3 /
   80 / 500+ events (to exercise the uncapped-scan findings), and
   `signal_events` history at `n = 0, 50, 200, 500` per `(org, signal)`
   pair (to exercise the clustering fan-out across its full range, not
   just the `n=500` ceiling).
3. **Fix or mock `eden.kb.embeddings.get_default_embedder`** before
   benchmarking Finding 5 — benchmarking the current broken-import path
   only reproduces the accidental-fast fallback, not the cost the
   proposed fix should actually be evaluated against. Use a mock
   returning realistic-dimension (384 or 1536) vectors.
4. Hit `POST /traces/{trace_id}/investigate` with `pytest-benchmark` or
   `hey`/`wrk`, report full percentile histograms per `n`, and compare
   against the order-of-magnitude ceiling this pass sketched (single-digit
   to tens of seconds of CPU time at `n=500`, `d=384`/`1536` — see
   corrected benchmark above; commit this new benchmark's own script
   alongside its results, unlike this pass's ad hoc, uncommitted repro)
   to size the fix. This needs no staging cluster and no 10M-doc corpus —
   it's a laptop run.

**Expensive — F12 Typesense search (Finding 1):**
1. `docker compose up typesense postgres` (`typesense/typesense:27.1`,
   matching the pinned compose version).
2. Extend — don't replace — the committed `scripts/bench_f12_span_search.py`
   to add: (a) the query-mix taxonomy the disputed JSON claims
   (`keyword_1word`/`multi_word_2_3`/`wildcard_sort_recent`/`empty_plus_facet3`)
   as real code, not just output labels; (b) a `facet_by=DEFAULT_FACET_FIELDS`
   vs. `facet_by=None` A/B toggle wired into an actual `SearchService.search()`
   call, to isolate Finding 1's specific claim instead of only sweeping
   `search_cutoff_ms`.
3. Scale ladder, report all rungs (not just one): 10k (sanity) → 100k
   (dev-realistic) → 1M (the current disputed claim) → 10M (the harness's
   own stated gate target, per its `BLOCKED` docstring).
4. Commit the extended harness script **in the same commit** as any
   results JSON it produces, and let the harness's own pass/fail logic
   set `gate_met` — never hand-edit the output shape afterward. This is
   the actual fix for the evidence-integrity problem, not a new number.

---

## Not flagged as findings (checked, ruled out)

- Everything carried over from the prior pass (`search_service.py:515-516`
  short-circuit, `:417-418` schema-ready check, `TypesenseClient._request`
  circuit breaker, `_excerpt`/`_parse_facet_counts` bounds,
  `_pg_fallback_search` sargable predicates) — not re-checked this pass,
  no new information changes those verdicts.
- **New this pass:** `GET /agents` and `GET /issues` (portal dashboard) —
  see full profile above. Both are `O(1)`-round-trip-per-shard, properly
  batched/parallelized, no N+1.
- **New this pass:** `portal-dehydrate.ts`'s `settleWithin(budgetMs)` +
  `Promise.allSettled` prefetch pattern — a slow backend shard degrades to
  a client-side refetch instead of blocking the whole page; not a
  hot-path risk, a reasonable design.

---

## Verdicts

- **Finding 1 (opt-in faceting)** — KEEP, unchanged confidence framing
  from prior pass (evidence-integrity issue still unresolved; mechanism
  still independently corroborated, now with a direct official-docs
  citation instead of only DeepWiki/community sources).
- **Evidence-integrity flag** — unchanged, not re-investigated this pass
  (no Docker access to either confirm or further refute).
- **Finding 2 (uncapped StatGate scans)** — KEEP-WITH-CAVEAT, unchanged.
- **Finding 3 (redundant `compress_trace`)** — KEEP, low priority, unchanged.
- **Finding 4 (sequential writes) / Finding 6 (stumble-write chain, new)** —
  KEEP, **upgraded from qualitative to an exact round-trip ceiling**: up
  to ~5,100 Postgres round trips + 20 Redis round trips in the worst case
  for one HTTP request, derived directly from the code's own `LIMIT`s —
  but confidence held at **MEDIUM**, not escalated, since that ceiling
  assumes all 20 signal definitions match simultaneously and neither this
  doc nor the sibling doc estimates the typical case. Finding 4 is the
  same underlying bug as `optimizations/02-db-queries.md` F5 (independent
  derivation, same code, same fix shape — not double-counted in any
  rollup); Finding 6's stumble-write round-trip chain is this doc's
  confirmed-unique contribution in this area.
- **Finding 5 (embedding + O(n²) clustering)** — KEEP, **materially
  corrected**: the "real embedding call" doesn't currently execute (dead
  import, directly reproduced, fuller commit forensics in
  `optimizations/02-db-queries.md` F2) — it silently corrupts cluster
  quality instead of costing latency. The O(n²) grouping cost is real and
  order-of-magnitude confirmed (single-digit to tens of seconds at
  realistic embedding dimensions, n=500) by three independent
  measurements that disagree 2-5x on the exact figure — presented as a
  corroborated range, not a precise measurement; the original table's
  two-decimal-place figures and its dim=8 row have been cut as false
  precision / not reproducible. **Do not fix the import without also
  fixing the algorithm** — doing so in isolation would turn a silent
  correctness bug into a synchronous, multi-second-to-tens-of-seconds
  event-loop stall, up to 20x per request.
- **Finding 7 (duplicate `get_settings()`)** — CUT as before, trivial.
