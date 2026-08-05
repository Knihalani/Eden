# Pass 4 Notes — optimizations/02-db-queries.md — Agent B (Impact Validator)

Method: for every quantitative/severity claim, re-derived it independently against live source
(`grep`, direct file reads, exact line-number checks) and, where the doc claims a benchmark or
simulation, re-ran an equivalent script myself (`PYTHONPATH=src python3 ...`) rather than trusting
the doc's own numbers. Then diffed subject matter against every other file in `optimizations/` and
`bugs/`.

## Headline judgment

This is the best-grounded file I've audited in this pass so far. Every line-number citation I
checked (~25 spot checks across F1–F10) matched the source exactly, including fiddly ones like
`agent_issues.py:167/174/190/209` for F4's double-fetch and `investigator.py:275/295/312` for the
three `cluster_after_match` call sites. The one real problem isn't false numbers — it's that **F2
substantially re-derives ground already covered, more rigorously, by
`optimizations/01-hotpath-perf.md`**, without cross-referencing it the way F3 already does for O2.
That's the main actionable finding here.

## IMPACT AUDIT — every query-cost / index / N+1 claim, classified

| Claim | Location | Class | Verification |
|---|---|---|---|
| `signal_events` has exactly one index, `idx_signal_events_trace (trace_id)`, and no later migration adds one | F1, L86-91 | **Measured** (grep across all 149 migration files) | Reproduced independently: `grep -rn "signal_events" src/eden/db_migrations/versions/*.py \| grep -i index` returns exactly one hit, in `092_market_ready_consolidated.py`. Confirmed. |
| Neither `list_signal_events` nor `cluster_signal` can use that index (both filter `org_id`/`signal_id`, not `trace_id`) | F1, L126-127 | **Measured** (direct code read) | Confirmed against `signal_investigator.py:40-94` and `clusterer.py:72-86` — query text matches the doc's quoted SQL exactly. |
| `ROWS_PER_TRACE = 35` / `TRACES_PER_ORG_DAY = 1_000`, "10 telemetry_events + 5 trace_*_reports + up to 20 signal_events" | F1, L99-104 | **Correctly labeled estimated** — doc itself says "the team's own documented infra-cost assumptions, not measured production data" | Confirmed exact match in `scripts/cost_model.py:46-50`. Doc does not overclaim this as measured; good practice, no downgrade needed. |
| Partial-index-requires-literal-predicate rule (gates the two-index F1 design) | F1 migration commentary, L162-190; also "Web research" section | **Grounded in official docs**, cited and correctly applied | Matches postgresql.org/docs/current/indexes-partial.html's documented behavior; the doc correctly identifies that `clusterer.py:78` hardcodes `matched = TRUE` as a literal (confirmed) while `list_signal_events` passes it as `$3` (confirmed), which is exactly the condition the docs describe for partial-index eligibility. Sound. |
| `eden.kb.embeddings.get_default_embedder` does not exist; `ModuleNotFoundError` on import | F2, L232-240 | **Measured, reproduced independently** | `PYTHONPATH=src python3 -c "from eden.kb.embeddings import get_default_embedder"` → `ModuleNotFoundError: No module named 'eden.kb.embeddings'`. Confirmed. |
| `clusterer.py` and `eden/kb/ledger/embeddings.py` added in the same commit (95401573) — never a working call | F2, L249-252 | **Measured** | `git log --diff-filter=A --oneline -- src/eden/signals/clusterer.py src/eden/kb/ledger/embeddings.py` → both list only `95401573`. Confirmed. |
| Fallback caught at `logger.debug`, invisible at default prod log level | F2, L257-259 | **Measured** (direct code read) | Confirmed `clusterer.py:205-206`: `except Exception as exc: logger.debug(...)`. Accurate. One nuance the doc doesn't mention: the source comment right above that line reads *"Deterministic hash fallback for tests / no-embedder envs"* — suggesting the fallback was anticipated as a no-embedder safety net, not purely accidental. Doesn't invalidate the finding (the "real" embedder path genuinely never resolves in this tree), but softens "never a working call" framing slightly — worth a one-line caveat, not a cut. |
| Simulated fallback-vector cosine similarity: "88.7% of 124,750 pairs ≥ 0.82 threshold"; clustering collapses 478/500 rows into one mega-cluster | F2, L268-281 | **Measured, reproduced independently (close match)** | My own independent simulation (500 distinct random ASCII strings, actual `stable_hash`/`_cosine` logic) got **90.9%** of pairs ≥ 0.82 (doc: 88.7% — different random text distribution, same order of magnitude) and a **478/500** single mega-cluster (doc: exactly 478/500, my re-run matched this number precisely) with the remainder in a few small groups (doc: 8/6/6/2; mine: 16/4/2 — small-group split differs by input distribution but the "~96% single-cluster collapse" qualitative finding is reproduced exactly). This is the strongest evidence in the doc — genuinely measured, not asserted. |
| Per-comparison cost table: 8-dim 2.7µs → ~333ms; 384-dim 53.8µs → ~6.7s (124,750 comparisons) | F2, L298-301 | **Measured on doc author's machine, plausible** but see cross-doc discrepancy below | My own `timeit` re-run: 8-dim ≈4.4µs/comparison (≈548ms total), 384-dim ≈66.6µs/comparison (≈8.3s total) — same order of magnitude as the doc's numbers, differs by ~1.6-1.7x (expected machine-to-machine variance for a microbenchmark; doc doesn't claim precision beyond "on this machine"). **However**, see NEW FINDINGS below: `01-hotpath-perf.md`'s benchmark for the *identical* computation (n=500, dim=8) reports **4.68ms**, ~70-120x lower than either this doc's 333ms or my own 548ms reproduction. Worth flagging to synthesis. |
| `n=500` is the realistic steady-state, not a tail case, at `match rate ≥ 3.6%` | F2, L303-310 | **Derived correctly** from `cost_model.py`'s own assumptions (`1_000 traces/day × 14-day lookback`) | Arithmetic checks: `500 / (1000×14) = 0.0357 ≈ 3.6%`. Correct, and appropriately conditioned on the (already-flagged-as-estimated) cost model assumptions, not overclaimed as measured traffic. |
| `_MAX_CONCURRENT_SCANS = 5`; single-threaded event loop stall claim | F2, L213-215, L311-319 | **Measured** (direct code read) | Confirmed `trace_finalized_consumer.py:42,95`. The "runs in coroutine body, not `to_thread`'d" claim also confirmed: grouping loop at `clusterer.py:105-119`(approx) has no `to_thread` wrapper, while `_embed`'s (unreachable) real-embedder branch does (`clusterer.py:204`). Accurate. |
| `rca_chain` double-fetches `_fetch_trace_events`/`categorize` for the same `(org_id, trace_id)` | F3, L351-358 | **Measured** (direct code read) | Confirmed: `intelligence_rca.py:138` calls `_fetch_trace_events`; `intelligence_rca.py:143` calls `_rca.categorize(...)`, which itself calls `_fetch_trace_events` again at `analyzer.py:89`. Exact. |
| `idx_telemetry_events_trace_id (trace_id, timestamp ASC)` already serves the query; no new index needed for F3 | F3, L373-378 | **Measured** (migration read) | Confirmed `009_telemetry_events.py:64-67` creates exactly this index. Correctly concludes no fix needed here (a rarer, credible outcome for a review doc to report — no false "add an index" padding). |
| `resolve_issue` calls `get_issue` twice, at L190 and L209, after `set_status` at L174 | F4, L393-397 | **Measured, exact line numbers** | `grep -n "_repo.get_issue\|_repo.set_status" agent_issues.py` returns `174` (set_status), `190`, `209` — exact match to the doc's citations. |
| Serial per-signal loop in `investigate_trace`, `cluster_after_match` called 3x (once per branch) | F5, L409-414 | **Measured**, exact line numbers | Confirmed calls at `investigator.py:275, 295, 312`, all three branches unconditionally call `cluster_after_match` inside `if matched:`. Exact. |
| `list_signal_clusters` hardcodes `LIMIT 200`; underlying index `(org_id, signal_id, status)` doesn't cover `ORDER BY last_seen DESC` | F6, L426-436 | **Measured** | Confirmed `signal_investigator.py:124` (`LIMIT 200`) and `104_wave8_signals.py:36-38` (index columns). Exact. |
| `_fetch_cluster_members` has no LIMIT, sibling `_fetch_failed_traces_in_window` has `LIMIT 500` | F7, L445-447 | **Measured** | Confirmed both functions in `_common.py:178-243` — sibling has `LIMIT 500` at the end of its query, `_fetch_cluster_members`'s query has none. Exact. Note (not in doc): `_fetch_cluster_members` filters only by `cluster_id`, not `org_id`, which naturally bounds cardinality to one cluster's membership — genuinely LOW severity as labeled, this doesn't change the verdict. |
| `signal_definitions`: only PK at creation (092), `(org_id, template_id)` added later (097) doesn't cover `enabled=TRUE ORDER BY created_at` | F8, L455-459 | **Measured** | Confirmed table def in `092_...py:11-19` (PK only) and unique partial index in `097_...py:51-53` on `(org_id, template_id) WHERE template_id IS NOT NULL`. Query shape at `investigator.py:224-248` matches doc's quote exactly. |
| `tool_call_labels`: only implicit index is `UNIQUE (org_id, span_id)`; live reads filter on `agent_id`, uncovered | F9, L471-513 | **Measured** | Confirmed table def + `grep -rl "tool_call_labels" src/eden/db_migrations/versions/*.py` → one file only. `list_for_agent`/`count_labels` queries in `tool_call_labels.py:105-140` match the doc's quoted SQL exactly. |
| `live_trace_sessions`: zero indexes, zero live application callers (test-only reference) | F10, L525-533 | **Measured** | Confirmed `grep -rln "live_trace_sessions" src/eden tests` returns only the migration itself and one string-assertion in `tests/unit/observability/test_w27_n11_f21.py:224` (`assert "live_trace_sessions" in text`, checking migration file *text*, not runtime behavior). Correctly labeled informational, not a live bug. |
| Cut: `IssuesRepo.list_issues`/`list_stumbles` lack internal clamp but caller already validates | "Cut" section, L547-550 | **Measured, verdict confirmed** | `agent_issues.py:135-136` (`limit: int = Query(50, ge=1, le=200)`) and `:290` (same `le=200`) both validate at the route layer before calling the unclamped repo methods. Cut verdict is correct — no live bug, appropriately pruned by the doc's own prior pass rather than left in as padding. |

## CUT

No claims in this doc met the bar for cutting on falseness/lack of grounding — everything I
checked traced to real code or was honestly labeled as an estimate. The one item I'd flag for
**downgrade/consolidation** rather than outright cut:

> **F2, L38-54 (Summary) and L205-339 (full section)** — the dead-embedder-import narrative, the
> git-blame same-commit evidence, and the O(n²) CPU-cost benchmark table.
> REASON: this is ~70% identical in substance to `optimizations/01-hotpath-perf.md`'s Finding 5
> (same file, same repro command `PYTHONPATH=src python3 -c "from eden.kb.embeddings import
> get_default_embedder"`, same git-blame-style verification that the function was never defined,
> same "fix import + fix algorithm together, never in isolation" recommendation, same
> event-loop-blocking analysis, same citation of `to_thread`'s CPU-bound limitation). 01-hotpath's
> version is *more* rigorous on the CPU-cost axis (benchmarks n=100/500 × dim=8/384/1536, six data
> points, vs. this doc's two data points at dim=8/384 only). Recommend synthesis either fold this
> doc's F2 down to a short pointer ("see 01-hotpath-perf.md Finding 5 for the dead-import + O(n²)
> cost analysis") the same way this doc's own F3 already does for O2 at the top-level INDEX.md, or
> explicitly keep only the genuinely unique contribution — the cosine-similarity/mega-cluster
> correctness simulation (L261-285), which does NOT appear in 01-hotpath-perf.md and is this doc's
> real value-add on this topic. Don't cut F2 entirely — the index-cost angle (F1's fix shrinking
> `pg.fetch`'s cost, tying F1+F2 together) and the correctness-bug framing are legitimately scoped
> to a db-queries doc — but the CPU-benchmark table and dead-import forensics are redundant weight
> that should be trimmed or merged, not independently re-verified in two sibling docs.

Nothing else warrants cutting. F1/F3/F4/F5/F6/F7/F8/F9/F10 are all tightly scoped, accurately
cited, and appropriately severity-ranked (note in particular that F6/F7/F8/F10 are self-labeled
LOW/INFORMATIONAL and the doc doesn't try to inflate them — this is the opposite of a padding
problem).

## NEW FINDINGS

1. **Cross-doc benchmark discrepancy worth flagging to synthesis (not a reason to cut either
   number).** This doc's F2 table claims 8-dim/n=500 grouping-loop cost ≈ 333ms (2.7µs ×
   124,750 comparisons). `optimizations/01-hotpath-perf.md`'s Finding 5 table claims the *same*
   computation (500 rows, 8-dim, "today's actual fallback") takes **4.68ms** wall time for the
   same 124,750 `_cosine()` calls — implying ~37.5ns/call, which is implausibly fast for a
   pure-Python function doing a `zip`+`sum` dot product and two `math.sqrt` calls. My own
   independent `timeit` reproduction of the exact `_cosine` function (see IMPACT AUDIT row above)
   got ≈4.4µs/comparison (≈548ms total) — matching this doc's order of magnitude, not
   01-hotpath-perf.md's. Two plausible explanations, neither adjudicated here since it's out of
   this doc's scope: (a) 01-hotpath-perf.md's benchmark generated random vectors that triggered
   heavy early-absorption via the `if i in used: continue` guard, so far fewer than 124,750 actual
   `_cosine()` calls occurred despite the table's "124,750" column (mislabeling actual-calls vs.
   theoretical-worst-case), or (b) a different `_cosine` implementation/optimization was
   benchmarked. Recommend synthesis reconcile or footnote this — right now two sibling docs quote
   conflicting "measured" numbers for the same function without either flagging the conflict.

2. **F2's "never a working call" framing has one unmentioned nuance.** The source comment
   immediately above the fallback branch (`clusterer.py:206`, not quoted in the doc) reads
   `# Deterministic hash fallback for tests / no-embedder envs.` — i.e., the original author
   appears to have anticipated a no-embedder environment and treated the fallback as an
   intentional degraded-mode, not purely an accident. This doesn't change the finding's substance
   (the "real" embedder path is still genuinely unreachable in production, confirmed), but a
   one-line acknowledgment would make the "silent, invisible bug" framing slightly more precise:
   the *mechanism* (fallback exists) was intentional; the *bug* is that `get_default_embedder` was
   apparently never actually implemented anywhere for the "real" branch to reach, and that this
   fallback silently became the 100%-of-the-time path with no visibility. Minor — not a basis for
   downgrading severity, just a citation completeness note for the writer.

3. **No overlap found with `bugs/02-data-consistency.md` on the specific findings in this doc**,
   despite both files touching `resolve_issue`/`agent_issues.py:167-234` and
   `rca_chain`/`intelligence_rca.py`. Checked directly: `bugs/02-data-consistency.md`'s "Bug 8"
   covers `resolve_issue` silently coercing unrecognized status values (a correctness issue, lines
   465-608ish) — a different finding from this doc's F4 (redundant double-fetch, a perf issue) on
   the same function. Similarly, `bugs/02`'s discussion of `_fetch_trace_events`/`rca_chain`
   (lines 437-450) is about a missing `agent_id` filter/projection (correctness), not the
   double-fetch (perf) this doc's F3 covers. These are genuinely complementary findings on
   overlapping code, not duplicates — no cut warranted, but worth a cross-reference footnote in
   both docs pointing at each other given they cite the exact same functions.

4. **No overlap found with `bugs/01-dead-code-stale-docs.md`** on the `eden.kb.embeddings` dead
   import, despite that file's name suggesting it's the natural home for a "dead code" finding —
   confirmed via grep, zero mentions of `get_default_embedder`/`eden.kb.embeddings`/`clusterer` in
   that file. So F2's dead-import angle isn't redundant with the bugs-side dead-code sweep, only
   with `01-hotpath-perf.md` as noted above.

5. **`optimizations/05-cron-jobs.md` touches `signal_events` and `clusterer.py` from a different
   angle** (the `classifier_retrain` cron's `SELECT DISTINCT org_id, signal_id FROM signal_events`
   query and `signal_cluster_quiet`'s set-based UPDATE) — these are genuinely different query
   shapes on the same table, not covered by this doc's F1, and not redundant. Confirmed no overlap
   in query text or line citations between the two files' treatment of `signal_events`.

## Summary verdict

F1, F3–F10: verified accurate, well-cited, appropriately severity-ranked, no cuts. F2: core
findings (dead import, mega-cluster correctness simulation) are genuinely measured and hold up to
independent reproduction, but the section substantially duplicates `01-hotpath-perf.md`'s more
rigorous treatment of the same dead-import + O(n²)-cost material — recommend synthesis consolidate
rather than carry both in full. One cross-doc numeric inconsistency (333ms vs. 4.68ms for the
"same" benchmark) should be flagged for reconciliation, not silently resolved in favor of either
doc.
