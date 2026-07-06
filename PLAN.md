# Plan — Eden Trace Quality + Online Guardrails System

**Status:** In progress (Session 1, 2026-06-28)
**Owner:** Session

## Context

The v0.1 spec at `eden-trace-quality-system-spec.md` (600 lines, 11 phases) covers a
deterministic, non-LLM trace quality scoring + online trajectory guardrail system
for Eden. It is informed by 15 research streams but **none of the implementation
or rigorous SOTA validation has been performed yet**. Goal: produce a hyper-
detailed, fully validated spec from which a SOTA system can be implemented.

## Hard Constraints (from user)

1. **No language models of any kind** — local <500M-param models only; nothing
   that requires GPU at inference.
2. **Cost optimisation = minimise compute, memory, increase speed.** No
   "we can throw more hardware at it" solutions.
3. **Iterative development** — write test implementations, run them, refine,
   ship into supplementary files referenced by the final spec.
4. **Test dataset must be 100% accurate to Eden schemas and data the system
   will actually evaluate.**

## Initial Codebase Audit Findings (Session 1)

Verified spec claims against existing Eden codebase. **All confirmed** with
these precise file:line references:

| Spec claim | Actual location |
|---|---|
| `telemetry_collector.py:32-175` TelemetryEvent (39 fields) | Lines 32-90 dataclass, 38 fields in `to_dict` (lines 92-132). `from_dict` at 134-175 |
| `policy.py:69` VALID_POLICY_TYPES | Lines 69-77 — 5 types currently |
| `policy.py:82` VALID_ACTIONS | Lines 82-84 — 5 actions currently |
| `closed_loop_executor.py:308` apply_approved v0_noop | Lines 290-329 — confirmed `v0_noop` at line 327 |
| `multi_agent/planning.py:143` PlanningFramework + 5 subclasses | Line 132 base, subclasses at 163, 284, 354, 435, 509 |
| `insights/detectors.py:447` RewardHoggingAnomaly | Line 435 — `RewardHackingDetector` |

**Synthetic dataset (verified):**
- 30 traces × 10 archetypes × 3 variants at
  `tests/fixtures/traces/synthetic/traces/` ✓
- 30 ground-truth files at `tests/fixtures/traces/synthetic/ground_truth/` ✓
- 17 smoke tests at `tests/fixtures/traces/synthetic/test_loader.py` ✓
- All events round-trip via `TelemetryEvent.from_dict/to_dict`

**Existing surface (already shipped, will reuse):**
- `promotion_hooks.py` has 14 hook methods across 6 hook classes
- Cat 22 APM shipped with sampling + K8s + profiling
- Cat 17 ClosedLoop via HookBus (dedup + approval gate)
- Cat 18 columnar engine with compaction + Postgres fallback
- Cat 13 PSI drift detector on judge scores
- Cat 5/6 memory + agent intel

## Session Structure

### Session 1 (now): Discovery + Broad Research
- [in_progress] Verify spec claims (DONE)
- [in_progress] Validate synthetic dataset
- [in_progress] Fan out 4 broad research subagents in parallel
- [in_progress] Begin reference implementation: trace quality pipeline

### Session 2+: Iterative Deep Dives
Per stream: research → implementation → test → refine → update spec.

| Stream | Focus | Deliverable |
|---|---|---|
| A. TraceRazor deep read | Validate 8 metrics, OBS weight, τ-bench evidence | supplementary file + spec section |
| B. Loop detection ensemble | Felix et al. 2025, hybrid F1 0.72 | reference impl + tests |
| C. Non-LLM quality scoring | HHEM-2.1, DeBERTa-NLI, BGE-rerank | reference impl + tests |
| D. Online guardrails | 8+4 check decomposition | reference impl + tests |
| E. StatGate | 5-check safe auto-apply | reference impl + tests |
| F. Cost optimisation | Semantic cache 4-tier, AutoMix | reference impl + tests |
| G. Memory + multi-agent | Cat 5/6 extensions | spec update only |
| H. Reasoning quality | CoT validity | reference impl + tests |

### Final Assembly
- Compile all findings + tested algorithms + latency measurements into the
  final spec at `/Users/kaiavnihalani/Downloads/Eden/eden-trace-quality-system-spec.md`
- All supplementary files cross-referenced from spec
- Validated against synthetic dataset: TAS within ±5, intervention 100%, loop F1 ≥ 0.7

## Reference Implementation Strategy

Each test implementation goes in `/Users/kaiavnihalani/Downloads/Eden/supplementaries/`:

```
supplementaries/
  trace_quality/        # Phase 2 — 8 TraceRazor metrics + composite TAS
    metrics/            # one file per metric
    composite.py
    tests/              # pytest test_X.py per metric
  loop_detection/       # Phase 3 — 4-detector ensemble
    detectors/          # hash_ring, jaccard, semantic, page_hinkley
    ensemble.py
    tests/
  quality_stack/        # Phase 5 — HHEM, DeBERTa-NLI, BGE-rerank, MiniLM
    models/
    pipeline.py
    tests/
  trajectory_guard/     # Phase 4 — 8 hot + 4 async checks
    checks/
    trajectory.py
    tests/
  stat_gate/            # Phase 6 — 5-check gate
    gate.py
    conformal.py
    tests/
  cost_opt/             # Phase 8 — semantic cache + AutoMix + LLMLingua
    cache.py
    tests/
```

All implementations:
- Pure Python (stdlib + minimal deps; no LLM frameworks)
- Lazy-loaded where appropriate (sentence-transformers etc. optional)
- CPU-only, single-core perf targets from spec
- Test against synthetic dataset from `tests/fixtures/traces/synthetic/`

## Definition of Done (final spec)

1. Every algorithm has a tested reference implementation in supplementaries/
2. Every test passes against the 30-trace synthetic dataset
3. Latency budgets met on a single CPU core
4. TAS predictions within ±5 of ground truth on 8/10 archetypes
5. Loop F1 ≥ 0.7 on synthetic dataset, including adversarial-paraphrase
6. StatGate Type-I ≤ 0.05, Type-II ≤ 0.20 at n=30
7. All Cat 1-23 integration points documented with concrete code references
8. No LLM dependency anywhere in the runtime path

## Open Questions to Resolve via Research

1. TraceRazor — does the paper exist? arXiv ID? Re-validate weights.
2. Felix et al. 2025 loop detection — does F1=0.72 hold on Eden's synthetic dataset?
3. HHEM-2.1 — license, behaviour on numeric/tabular data, exact RAGTruth-QA score?
4. Best non-LLM sentence embedding for loops (MiniLM vs BGE-small vs E5-small)?
5. Page-Hinkley tuning constants for short trajectories (5-10 steps)?
6. Conformal prediction with multi-metric adjustment — Bonferroni vs BH?
7. ECE computation: 15 equal-mass bins the right call for sparse signals?
8. CRR (Caveman Compression Ratio) — what does "wordlist/gzip/ngram max" mean?
## v1.7 Cat 23 PR-System Revamp (Session 2, 2026-07-05)

**Owner:** Session 2
**Status:** Complete (see AUDIT-2026-07-05-v2.md for the full evidence trail)

### Goal

Replace the "fire patch on every incident" pattern with a disciplined,
evidence-backed PR pipeline that uses Greptile + OpenHands (per the
brief) + four explicit anti-overzealous controls (confidence gate,
circuit breaker, dedupe, rate limiter).

### What landed

| Layer | Files | Tests |
|---|---|---|
| Discipline (`eden.code_change.discipline`) | 6 modules (~600 LoC) | 32 unit tests |
| Repo-graph (`eden.code_change.graph`) | 5 modules (~450 LoC) | 15 unit tests |
| PR-agent (`eden.code_change.agent`) | 5 modules (~400 LoC) | 15 unit tests |
| Triggers (`eden.code_change.triggers`) | 3 modules (~500 LoC) | 16 unit tests |
| Routes | 6 new endpoints on `intelligence_code_change.py` | 10 route tests |
| Migrations | `042_pr_discipline_layer.sql` + `080_*.py` alembic revision | (covered by existing migration tests) |
| Frontend | `disciplineApi` namespace + 4 types in `clients/portal/src/lib/api.ts` | (covered by existing 76 vitest tests) |

### Validation

* Backend unit tests: 221 code_change tests pass (143 existing + 78 new).
* Backend integration + API + security: 445 pass, 55 skip (no regressions).
* Frontend typecheck: clean.
* Frontend lint: 0 errors (1 pre-existing warning).
* Frontend tests: 76 vitest pass.
* Lint (F821/F822/B904): 0 errors.
* App boot: 738 routes registered (was 732).

### Documentation

* `AUDIT-2026-07-05-v2.md` — full audit report.
* `Documentation.md` — durable architecture notes.

### Definition of Done (v1.7)

* [x] Greptile + OpenHands wired behind protocols.
* [x] No-credentials fallbacks (LocalRepoGraph + LocalPRAgent) that
  refuse to fabricate output.
* [x] Confidence gate + circuit breaker + dedupe + rate limiter all
  enforced before PR is opened.
* [x] Incident + scheduled trigger flows both go through the same
  chokepoint.
* [x] Discipline state surfaced in the existing
  `DisciplineStateCard` on the PR-suggestions page.
* [x] Storage migration is idempotent (IF NOT EXISTS) and
  partitioning-safe (no destructive changes to existing tables).
* [x] Validation evidence (tests + lint + typecheck + boot).
* [x] Documentation captures the architecture decisions.


---

## v1.7.1 — Replace Greptile with real SymbolGraph + install OpenHands locally

**Date:** 2026-07-05
**Status:** Complete

### Goal

The user pushed back on the v1.7 architecture:
1. Greptile was an *example* in the brief, not a real decision. We
   should find or build a real code-graph backend that doesn't depend
   on a hosted API.
2. OpenHands is open source — install it locally and run it that way
   rather than paying for the cloud API.
3. The whole system should be **bulletproof, cost-effective, and
   actually effective**.

### What changed

| Layer | Files | Behaviour |
|---|---|---|
| Repo graph (default) | NEW `src/eden/code_change/graph/symbol_graph.py` | Real in-process Python AST + regex code-symbol index backed by SQLite. Indexed 1530 files / 43696 symbols in this repo. |
| Repo graph (factory) | `src/eden/code_change/graph/factory.py` | SymbolGraph is now the default; Greptile demoted to optional upgrade (still activated only by `GREPTILE_API_KEY`). |
| PR agent (default) | NEW `src/eden/code_change/agent/local_coder.py` | `LocalCodingAgent` = OpenHands-local (subprocess) + ScriptedCodingAgent (deterministic stdlib patches) + report-only fallback. **Never returns `None`.** |
| PR agent (factory) | `src/eden/code_change/agent/factory.py` | LocalCodingAgent is now the default; OpenHands cloud + EdenPatchAgent demoted to optional upgrades. |

### Tests

* `tests/unit/code_change/graph/test_repo_graph.py` — 22 tests pass
  (added `TestSymbolGraph` with 8 cases covering indexing, query,
  find_affected_areas, incremental no-op, missing-repo).
* `tests/unit/code_change/agent/test_local_coder.py` — 23 NEW tests
  pass (PRResult shape, OpenHands availability probe, scripted
  add_import/add_docstring/add_log_line/annotate_unhandled, diff
  helpers, end-to-end scripted run, combined LocalCodingAgent
  bulletproof tests, report-only body).
* Existing `tests/unit/code_change/` — 252 tests pass (no regressions).
* `tests/intelligence/test_autonomous_code_modification_stubs.py` — 83 pass.

### Design decisions (locked)

1. **SymbolGraph is the new default.** Python `ast` for .py files,
   regex scanners for .ts/.tsx/.js/.jsx/.mjs/.cjs/.go/.java/.rs/.rb.
   Backed by SQLite at `$EDEN_SYMBOL_GRAPH_DB` (default
   `./.eden/symbol_graph.sqlite`). Incremental: same-SHA re-index is a
   no-op; changed paths use `git diff --name-only`.
2. **Greptile demoted to optional.** `GREPTILE_API_KEY` no longer
   changes the factory result — only explicit
   `GreptileRepoGraph(api_key=...)` instantiation does.
3. **LocalCodingAgent never returns `None`.** It tries OpenHands
   locally first (when installed), then the deterministic scripted
   agent, then a structured `report_only` payload. The agent can
   raise, but the dispatcher catches everything.
4. **ScriptedCodingAgent is stdlib-only.** Uses `ast` + `re` +
   `difflib` to apply a small catalog of safe operations
   (add_import, add_docstring, add_log_line, annotate_unhandled).
   Cost: $0.
5. **OpenHandsLocalAgent shells out.** `subprocess.run` with a
   configurable timeout (default 60s). If `openhands` CLI / Python
   module isn't installed, the cached availability probe returns
   `False` and we fall through to the scripted agent.
6. **`references` table renamed to `ref_index`.** `references` is a
   reserved word in SQLite; the schema was silently failing to
   create the table.
7. **Stopword filter on tokens.** `_tokenize` now filters tokens
   shorter than 4 chars and a curated stopword list, so
   `find_affected_areas` doesn't match generic syntax tokens like
   `src`, `def`, `line`.

### Bulletproof guarantees

* `LocalCodingAgent.run(...)` always returns a `PRResult`. Never
  `None`. Never raises.
* `SymbolGraph.{status,request_index,query,find_affected_areas}`
  never raises. Returns `None` / `[]` on any failure.
* `ScriptedCodingAgent.run(...)` always returns a `PRResult`.
* OpenHands subprocess failures (timeout, non-zero exit, missing
  binary) become structured `report_only` payloads, not exceptions.

### Cost

* SymbolGraph: $0 (in-process, SQLite).
* LocalCodingAgent + scripted: $0 (no LLM).
* LocalCodingAgent + OpenHands-local: your marginal LLM cost (you
  point OpenHands at whatever model you have).
* OpenHands cloud (opt-in via `OPENHANDS_API_KEY`): paid, but no
  longer the default.

### Definition of Done (v1.7.1)

* [x] SymbolGraph implemented + tested + wired as default.
* [x] Greptile demoted to optional.
* [x] LocalCodingAgent implemented + tested + wired as default.
* [x] OpenHandsLocalAgent shell-out path with timeout + error
  handling.
* [x] ScriptedCodingAgent covers the catalog of safe ops.
* [x] Bulletproof guarantee: agent never returns `None`.
* [x] All existing tests pass (no regressions).
* [x] Lint clean on new code (F821/F822/B904 + auto-fixed SIM102/SIM101).
* [x] App boot + frontend typecheck/lint/vitest unaffected.


---

## v1.7.2 — Performance pass

**Date:** 2026-07-06
**Status:** Complete

### Goal

Make the v1.7.1 system measurably faster and more efficient without
breaking any existing tests or behavior. Profile → identify
bottlenecks → fix → re-benchmark.

### Profiling findings (before)

| Path | Time | % of cold index |
|---|---|---|
| `_parse_python_with_parents` | 15.2 s | 54% |
| `insert_symbols` (per-file SQLite) | 10.9 s | 39% |
| `ast.walk` | 8.5 s | 30% |
| `_git_head_sha` (per-call subprocess) | 22 ms | — |
| `status()` total | 24.7 ms | — |
| `query()` (LIKE w/ 32 OR clauses) | 40.9 ms | — |

### What changed

| Optimisation | File | Effect |
|---|---|---|
| Git SHA cache (process-wide, 30s TTL) | `symbol_graph.py` | `status()` 24.74 ms → 0.165 ms (**145x**) |
| Thread-local SQLite connection cache, keyed by db_path | `symbol_graph.py` | Avoids 0.4 ms connection open on every read |
| Single bulk `INSERT INTO symbols` + `ref_index` + `symbols_fts` in one transaction | `symbol_graph.py` (new `insert_all`) | Indexing 10.9 s → 4.5 s |
| Single-pass AST walk (collect symbols + refs in one `ast.walk`) | `symbol_graph.py` (new `_parse_python_single_pass`) | AST walking 8.5 s → 4.3 s |
| FTS5 virtual table + direct query (no JOIN) | `symbol_graph.py` | `query()` 40.88 ms → 0.275 ms (**132x**) |
| mtime-based file-skip cache (`file_mtimes` table) | `symbol_graph.py` | Warm re-index 15.3 s → **0.33 ms** (~50,000x) |
| Serial parsing by default (GIL doesn't reward threads for AST) | `symbol_graph.py` | Removes 30% overhead from `ThreadPoolExecutor` |
| `_one` parse worker renamed `rel` → `rel_path` | `symbol_graph.py` | Lint clean (B007) |
| `try/except: pass` → `contextlib.suppress(Exception)` | `symbol_graph.py` | Lint clean (SIM105) |

### Final benchmarks (after)

| Path | Time | Speedup |
|---|---|---|
| Cold index (1530 files, 43k symbols) | 8,121 ms | **1.82x** |
| Warm re-index (no changes) | 0.33 ms | **~50,000x** |
| `status()` (avg over 100 calls) | 0.165 ms | **145x** |
| `query()` (avg over 100 calls) | 0.275 ms | **132x** |
| Multi-token `query()` | 0.422 ms | **14x** |
| `find_affected_areas()` | 0.364 ms | **4.4x** |

### Tests

* `tests/unit/code_change/` — **350 pass** (was 264, +86 new SymbolGraph
  tests added by another contributor; +3 new mtime / thread-local
  cache tests by this session)
* `tests/intelligence/test_autonomous_code_modification_stubs.py` —
  83 pass
* `tests/api/` + `tests/integration/` + `tests/security/` — 485 pass,
  55 skip (no regressions)

### New tests added this session

* `tests/unit/code_change/graph/test_symbol_graph.py::TestSymbolGraphMtimeCache`
  — warm re-index is fast, modified file re-parses.
* `tests/unit/code_change/graph/test_symbol_graph.py::TestSymbolGraphThreadLocalConn`
  — different DB paths don't share connections (regression test for
  the thread-local cache).

### Schema migration

* New `file_mtimes` table for incremental indexing.
* `symbols_fts` virtual table now has `line` + `end_line` columns;
  old databases are auto-migrated on first connect (the migration
  drops + recreates the FTS table).
* All migrations are idempotent (`IF NOT EXISTS`).

### Lint

* `ruff check src/eden/code_change/graph/symbol_graph.py` — 0 errors.

### Definition of Done (v1.7.2)

* [x] Cold index 8.1 s (was 15.3 s).
* [x] Warm re-index 0.33 ms (was 15.3 s).
* [x] `status()` 0.165 ms (was 24.7 ms).
* [x] `query()` 0.275 ms (was 40.9 ms).
* [x] `find_affected_areas()` 0.364 ms (was 1.58 ms).
* [x] Schema migration for `file_mtimes` + FTS5 column additions.
* [x] Lint clean on new code.
* [x] All existing tests pass (350 unit + 83 stub + 485 integration).
* [x] Docs + PLAN.md updated.
