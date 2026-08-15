# Pass 4 — Agent A (Fact-Verifier & Pruner) — `optimizations/02-db-queries.md`

Method: re-derived every SQL/line-number/behavioral claim from source directly (grep -n for
exact line anchors, `python3 -c` import tests, and an independent from-scratch re-implementation
of F2's cosine-similarity simulation) rather than trusting the doc's own citations.

## VERIFIED

All of the following were independently re-checked against current source and match the doc
either exactly or within immaterial rounding of the cited line range:

- **F1** — `signal_events` table def and its single index (`idx_signal_events_trace`, trace_id
  only) exactly match `src/eden/db_migrations/versions/092_market_ready_consolidated.py:44-59`
  (table) / `:58` (index). `grep -rn "signal_events" .../*.py | grep -i "CREATE INDEX"` returns
  only that one hit across all 149 files — confirmed. Both read-path queries
  (`signal_investigator.py:41` `list_signal_events`, `clusterer.py:57,74-81`
  `cluster_signal`) match verbatim, including that neither filters/sorts on `trace_id`.
- **F1 exact migration** — `142_session_summaries.py` is confirmed the current head
  (`ls db_migrations/versions | tail`), so "next free revision 143" is correct. The partial-index
  precedents cited (`idx_closed_loop_actions_pending` in `066_session21_indexes.py:163`,
  `idx_agent_issues_repetition` in `084_agent_issues.py:122`, both literal `WHERE` partial
  indexes) and the "ACCESS SHARE doesn't block INSERT" claim (`043_neon_cost_indexes.py:28-33`)
  all check out verbatim.
- **F2 — embedder unreachability is real, verified by direct execution:**
  `PYTHONPATH=src python3 -c "from eden.kb.embeddings import get_default_embedder"` →
  `ModuleNotFoundError: No module named 'eden.kb.embeddings'` (confirmed live, not asserted).
  `find src/eden/kb -iname embeddings.py` → only `src/eden/kb/ledger/embeddings.py`, which
  defines `embed_text(text, *, dims: int = 384)` (dims=384 default confirmed at line 10),
  `unpack_embedding`, `cosine`, `_hash_embedding` — no `get_default_embedder`/`embed_batch`
  anywhere in `src/`. `git log --diff-filter=A -- src/eden/kb/ledger/embeddings.py` and same for
  `clusterer.py` both return **only** commit `95401573` — same-commit-add claim confirmed. Second
  call site `src/eden/observability/patterns_clusterer.py:147` (`from eden.kb.embeddings import
  get_default_embedder`) confirmed to exist with the identical broken import.
- **F2 — investigator call sites**: `src/eden/signals/investigator.py:275,295,312` all read
  `await cluster_after_match(org_id, signal_id)` inside `try/except Exception: pass` blocks —
  exact line match. `trace_finalized_consumer.py:42` (`_MAX_CONCURRENT_SCANS = 5`) and `:95`
  (`self._sem = asyncio.Semaphore(_MAX_CONCURRENT_SCANS)`) confirmed exactly as cited
  ("L42,95").
- **F2 — simulation reproduced independently.** Re-implemented `_embed`'s fallback
  (`clusterer.py:207-212`, `[(stable_hash(text)%1000+i)%97/97.0 for i in range(8)]`) against
  real `eden.util.stable_hash.stable_hash` with 500 distinct synthetic strings and got
  **fraction ≥0.82 = 88.78%**, min=0.098, p50=0.998, p90=0.99999, max=1.0 — matches the doc's
  claimed 88.7% / 0.098 / 0.999 / ~1.0 / 1.0 almost digit-for-digit despite a different random
  text corpus. Re-ran the actual clustering loop against those vectors: one dominant cluster
  absorbed 472/500 (94%) with small leftover groups (14/6/4/4) — directionally identical to the
  doc's 478/500 + 8/6/6/2 claim (exact counts vary by input corpus as expected, doc doesn't claim
  determinism across runs). This is a real, reproducible bug, not a cherry-picked one-off.
- **F2 — cost benchmark**: `n(n-1)/2` for n=500 = 124,750 confirmed by arithmetic (500×499/2).
  `500/(1000×14) ≈ 3.57%` ≈ doc's "≈3.6%" confirmed. My own cosine-loop benchmark (different
  machine) got 4.2µs/comparison @ dims=8 and 83.5µs @ dims=384 — same order of magnitude as the
  doc's 2.7µs/53.8µs; doc explicitly caveats "on this machine," so the discrepancy is expected
  and doesn't undermine the claim.
- **F3** — `rca_chain` at `intelligence_rca.py:127` (`async def rca_chain`), `:138`
  (`_fetch_trace_events` call #1), `:143` (`_rca.categorize` call #2) — exact line matches.
  `_fetch_trace_events` SQL in `_common.py:104-136` matches verbatim, no LIMIT confirmed.
  `idx_telemetry_events_trace_id (trace_id, timestamp ASC)` confirmed at
  `009_telemetry_events.py:64-67`.
- **F4** — `agent_issues.py:167` (`async def resolve_issue`), `:174` (`set_status`), `:190` and
  `:209` (both `issue = await _repo.get_issue(org_id, issue_id)`) — every line number exact.
- **F5** — loop at `investigator.py:255` (`for row in rows:`), `_write_event` def at `:319` —
  matches "L255-321"/"L319-336" claim.
- **F6** — `list_signal_clusters` `LIMIT 200` hardcoded, no offset param, confirmed;
  `idx_signal_clusters_org_signal` confirmed at `104_wave8_signals.py:36`.
- **F7** — `_fetch_failed_traces_in_window` (`_common.py:178-213`) has `LIMIT 500`;
  `_fetch_cluster_members` (`:217-243`) has no LIMIT — confirmed, sibling comparison is accurate.
- **F9** — `tool_call_labels` table/UNIQUE constraint confirmed at `092_market_ready_...py:65-79`;
  `list_for_agent` query at `tool_call_labels.py:114-118` and `count_labels` at `:137-140` —
  exact line match (doc cites the same ranges). MCP tool reference at `mcp_server/tools.py:307`
  confirmed real (`from eden.learning.tool_call_labels import ...`).
- **"Already-good" section** — `IncidentClusterer._gather_trace_events`
  (`clusterer.py:59-90`, `bounded_gather(..., limit=32, ...)`) and its own docstring
  ("~5s → ~50ms" for "100 traces" @ "50ms RTT") match the doc's phrasing almost verbatim — this
  looks like it was pulled directly from the source docstring, which is fine, it's accurately
  attributed as a confirmed real optimization already in the codebase.
  `RootCauseAnalyzer.explain` (`analyzer.py:152-186`) confirmed to reuse `categorize()`'s result
  and call `_fetch_similar_rca_analyses(..., limit=5)` once — no redundant re-fetch, confirmed.
  `030_brin_timeseries.py`, `034_timescale_telemetry.py` etc. all exist and match their described
  content (BRIN correlation ≥0.7 gate, hypertable conversion).
- **Broader sweep** — `session_summaries` composite-PK false-positive claim confirmed:
  `142_session_summaries.py` uses `PRIMARY KEY (org_id, session_id)` (spot-checked). This is the
  exact category of scanner false-positive later shown to also apply to F10 (see CUT below).
  `production_eval_scores` / `idx_prod_eval_scores_agent_hour` confirmed at
  `092_market_ready_consolidated.py:431`; all three cited caller files
  (`evaluation/production/sampler.py`, `fleet/service.py`, `monitoring/dashboards.py`) really do
  query `production_eval_scores`.
- **Web research section** — Postgres partial-index plan-time-predicate-match behavior is
  standard, correctly described, and the doc's application of it to F1 (bound param `$3` can't
  use a partial index, but the literal `matched = TRUE` in `clusterer.py:78` can) is internally
  consistent with what's actually in the two queries.
- **"Cut" — old F6, `repo.py` limit clamp** — verdict of "no live bug" is still defensible (see
  CUT #3 below for why the stated *reasoning* is inaccurate even though the practical conclusion
  survives): `agent_issues.py`'s two routes do validate `limit: int = Query(50, ge=1, le=200)`
  before calling the repo.

## CUT

1. **F10 is very likely a false positive of the exact scanner bug the doc itself already caught
   once (for `session_summaries`).**

   Quote: `"live_trace_sessions has the same zero-index gap... zero indexes, confirmed the same
   way as F1/F9."`

   Reason: `src/eden/db_migrations/versions/111_w27_live_labels.py:52-63` shows:
   ```sql
   CREATE TABLE IF NOT EXISTS live_trace_sessions (
       org_id TEXT NOT NULL,
       session_id TEXT NOT NULL,
       ...
       PRIMARY KEY (org_id, session_id)
   )
   ```
   This is a **composite `PRIMARY KEY (org_id, session_id)`** — an implicit unique btree over
   exactly `(org_id, session_id)`, the same leading-column shape F10's own proposed fix asks for
   (`CREATE INDEX idx_live_trace_sessions_org_session ON live_trace_sessions (org_id,
   session_id)`). The doc's own "Broader sweep" section explicitly describes ruling out this
   *exact* pattern for `session_summaries` ("flagged... as missing session_id coverage; false
   positive... it uses PRIMARY KEY (org_id, session_id), a composite PK the scanner's CREATE
   INDEX-only regex didn't recognize as an index") but appears not to have applied that same
   check to `live_trace_sessions` before writing F10. Recommend cutting F10 entirely, or at most
   downgrading it to a one-line note that the table already has adequate coverage for its only
   plausible future query shape and needs no fix.

2. **F8's file:line citation for the `signal_definitions` table is wrong.**

   Quote: `"Table: src/eden/db_migrations/versions/092_market_ready_consolidated.py:11-19 — only
   a primary key on id."`

   Reason: lines 11-19 of that file are the module docstring tail and `from __future__
   import annotations` / import lines, not the table. The actual `CREATE TABLE IF NOT EXISTS
   signal_definitions (...)` is at lines **30-39** (confirmed via `grep -n`). The *substance* of
   F8 (table has only a PK on `id`, `097_signal_definitions_f35_bridge.py:51` adds a
   partial-unique `(org_id, template_id) WHERE template_id IS NOT NULL` that doesn't cover
   `enabled=TRUE ORDER BY created_at ASC`) is correct and the `097` line-51 citation is exact —
   only the `092` line range needs fixing. Low-stakes (F8 is already ranked LOW/optional) but an
   easy, cheap fix before this ships to synthesis.

3. **The "Cut — old F6" section's stated reasoning is factually wrong, even though its bottom-line
   verdict happens to still hold.**

   Quote: `"IssuesRepo.list_issues/list_stumbles accept limit: int with no internal min(limit, N)
   guard, but the only caller (agent_issues.py) already validates at the route layer."`

   Reason: `grep -rn "\.list_issues(\|\.list_stumbles(" src/eden/` shows at least 10 other call
   sites beyond `agent_issues.py`: `closed_loop/verify.py:575`, `improvement/
   issue_patch_trigger.py:942`, `improvement/cockpit_aggregator.py:327`, `improvement/agent.py:439`,
   `api/routes/portal.py:1609`, `evaluation/regression_builder.py:224`,
   `issues/triage_agent.py:144,334`, `issues/fixture_export.py:104`,
   `issues/statgate_p0_rail.py:43`. "The only caller" is a factually false claim. The ultimate
   "no live bug" verdict is still probably right in practice — every other call site I checked
   passes a hardcoded/bounded literal (`limit=5`, `limit=10`, `limit=20`, `limit=50`,
   `limit=_MAX_REACT_CALLS`) rather than user-controlled input, and `portal.py:1609` has its own
   independent `Query(50, ge=1, le=200)` clamp identical to `agent_issues.py`'s — but the doc
   should say that (verified against all callers, all bounded) rather than the false "only
   caller" framing, in case a future caller passes an unbounded value and this Cut entry gets
   cited as prior clearance.

## NEW FINDINGS

1. **F1/F2's "runs for every trace the consumer finalizes" overstates the actual trigger
   condition — the investigator is conditionally gated, not universal.**

   `trace_finalized_consumer.py::_process_trace` (`L326-335`) only calls
   `_run_signal_investigator` inside:
   ```python
   if not _layer_a_primary_hit(layer_a_report):      # L331
       skip_inv = await _run_signal_classifiers(org_id, trace_id)   # L333
       if not skip_inv:                                # L334
           await _run_signal_investigator(org_id, trace_id)         # L335
   ```
   i.e. it's skipped whenever Layer A already found a "primary hit" descriptor
   (`_layer_a_primary_hit`, `trace_finalized_consumer.py:535`), and can be further skipped by
   `_run_signal_classifiers` (F34 classifier gate, `trace_finalized_consumer.py:665`). F1's write
   path text ("runs for every trace the consumer finalizes") and F2's framing ("every org sharing
   it," "for every trace passed through it") both read as unconditional. The `investigate_trace`
   call itself, once triggered, does still write up to 20 rows "regardless of match" (that part
   is accurate) — but the outer trigger is conditional, which means the actual write-rate/blast
   radius is somewhat lower than "every finalized trace" implies. Worth a one-line correction in
   F1/F2 rather than a full rewrite — the core finding (missing indexes, unreachable embedder)
   is unaffected, only the "how often does this fire" framing.

2. **`cluster_after_match`'s call sites all swallow exceptions silently (`except Exception:
   pass`, no logging at all)** — `investigator.py:273-276,293-296,310-313`. This is a second,
   independent silencing layer on top of F2's already-noted `_embed`'s `logger.debug`: even if
   `cluster_after_match` raised for some other reason entirely (DB error, bad row shape), nothing
   would surface it anywhere, not even at debug level. Worth folding into F2's "needs
   error-level visibility" fix recommendation as a second call site to fix, since the current fix
   text only mentions `_embed`'s own `except Exception: logger.debug`.

## Summary of net effect on findings

- F1, F2, F3, F4, F5, F6, F7, F9, and the "Already-good"/"Broader sweep" sections all hold up
  under direct source verification, several down to exact line numbers and a from-scratch
  reproduction of the F2 simulation.
- F10 should be cut or heavily downgraded — it's very likely a scanner false positive
  (`live_trace_sessions` already has `PRIMARY KEY (org_id, session_id)`), the same failure mode
  the doc explicitly says it already caught once for `session_summaries`.
- F8's `092` line citation is wrong (11-19 → should be 30-39); substance is fine.
- The "Cut — old F6" entry's "only caller" claim is false (10+ call sites), though its
  conclusion likely still stands once you check that all other callers use bounded literals.
- F1/F2's "runs on every trace" framing should be corrected to reflect the Layer-A/classifier
  gating in `_process_trace` — real conditional logic the doc didn't trace through.
