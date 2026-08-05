# Pass 4 — Adversarial Skeptic Notes (Agent C)
Target: `docs/specs/strategic-review-2026-08/optimizations/02-db-queries.md`

Methodology: re-derived every checkable claim independently (grep against all 149
migration files, direct source reads, a live `python3` import test, and an
independent re-implementation of F2's clustering-collapse simulation) rather than
trusting the doc's own citations. Also diffed the doc's claims against
`INDEX.md`, `KNOWN-SUBSYSTEMS.md`, and sibling `optimizations/`/`bugs/` docs.

---

## SURVIVED SCRUTINY

This doc is unusually well-verified for an "assume it oversells itself" pass. The
following load-bearing claims were independently re-derived and check out exactly:

- **F1 core claim** — `signal_events` has exactly one index
  (`idx_signal_events_trace` on `(trace_id)`, `092_market_ready_consolidated.py:58`)
  across all 149 migrations. Confirmed via `grep -n "CREATE INDEX" src/eden/db_migrations/versions/*.py | grep -i signal_events`
  → single hit, matching the doc. `list_signal_events`'s `matched` filter is
  genuinely a conditional bound param (`signal_investigator.py:41-66`, confirmed
  read), and `cluster_signal` genuinely hardcodes `AND matched = TRUE` as a literal
  (`clusterer.py:78`) — so the doc's two-index (full composite + partial) design is
  correctly justified, not just asserted. `143` is genuinely the next free revision
  after `142_session_summaries.py` (confirmed via directory listing).
- **F2 core claim — the embedder import is dead code.** Reproduced independently:
  `python3 -c "from eden.kb.embeddings import get_default_embedder"` →
  `ModuleNotFoundError`, exactly as claimed. `grep -rn "def get_default_embedder" src/ tests/`
  → zero real definitions, only a test-file mock stub, exactly as claimed.
  `git log --diff-filter=A -- src/eden/kb/ledger/embeddings.py` and the same for
  `src/eden/signals/clusterer.py` both return **the same commit**, `95401573` —
  the doc's "added in the same commit, never worked" claim is exactly right, not
  an inference.
- **F2's "89% mega-cluster collapse" claim — independently re-simulated, and it's
  if anything understated, not oversold.** I re-implemented the fallback vector
  construction and clustering loop from scratch (not copy-pasted from the doc)
  against 500 distinct random strings and the real `stable_hash` from
  `eden/util/stable_hash.py`. Result: **94.6%** of the 124,750 pairs scored
  `>= 0.82` (doc claims 88.7%), and the clustering loop collapsed **487/500**
  rows into one cluster (doc claims 478/500). This is exactly the kind of
  claim I expected to find inflated on an adversarial pass — instead my
  independent number is *worse* than the doc's. This finding should not be
  downgraded.
- **F2 concurrency/threading claims** — `_MAX_CONCURRENT_SCANS = 5` and
  `asyncio.Semaphore` at `trace_finalized_consumer.py:42,95` confirmed verbatim.
  `_embed`'s `asyncio.to_thread(embedder.embed_batch, ...)` vs. the O(n²) loop
  *not* being thread-offloaded is confirmed by direct read of `clusterer.py:57-150`
  — the comparison loop runs inline in the coroutine, `_embed` alone is threaded.
- **F3's index fact-check** — `idx_telemetry_events_trace_id (trace_id, timestamp ASC)`
  really is at `009_telemetry_events.py:64-67` (confirmed by direct read) and really
  does serve `WHERE trace_id = $2 ORDER BY timestamp ASC` with no `tenant_id` prefix
  needed. The "no new index needed here" verdict is correct, not hand-waved.
- **F4's mechanics** — exact line numbers for the double `get_issue` fetch
  (`agent_issues.py:174`, `:190`, `:209`) confirmed via `grep -n`. (Severity
  framing is separately challenged below — the *mechanic* is real.)
- **F6/F7/F8 spot checks** — `signal_clusters`'s `LIMIT 200` hardcode at
  `signal_investigator.py:124`, `idx_signal_clusters_org_signal` at
  `104_wave8_signals.py:36-38`, and `097_signal_definitions_f35_bridge.py:51`'s
  `(org_id, template_id)` index all confirmed exactly as cited.
- **F9's core gap (independent of the migration-092 error below)** — confirmed via
  direct read of `src/eden/learning/tool_call_labels.py:96-140` that
  `list_for_agent`/`count_labels` filter on `(org_id, agent_id[, tool_name])`,
  which `UNIQUE (org_id, span_id)` cannot serve. Real, live, unindexed gap.
- **"Cut" verdict (old F6, repo-layer limit clamp)** — confirmed `IssuesRepo.list_issues`/`list_stumbles`
  have no internal clamp, and the only caller (`agent_issues.py`) already validates.
  Correct to cut.
- **Web-research grounding for the partial-index reasoning** (bound param vs.
  literal predicate) matches the actual Postgres docs behavior and matches how
  the two real queries in this codebase are written — not a generic pasted
  factoid, it's applied correctly to the specific `$3` vs. literal-`TRUE`
  distinction between `list_signal_events` and `cluster_signal`.

## CUT (or downgrade)

### 1. F9's own migration citation is internally self-contradictory — factual error, not fabrication of the underlying finding

Quote (F9 header):
> **Table:** `src/eden/db_migrations/versions/092_market_ready_consolidated.py`
> (same migration as `signal_events` and `tool_call_predictions`/
> `tool_call_calibrators`, which — unlike `tool_call_labels` — *did* get composite
> indexes in this same migration; this is a "one table missed," not a systemic gap
> in this file)

**Counter-evidence:** `tool_call_predictions` and `tool_call_calibrators` are **not
in migration 092 at all**. `grep -rln "tool_call_predictions\|tool_call_calibrators" src/eden/db_migrations/versions/*.py`
returns only `111_w27_live_labels.py`. Confirmed directly:
`111_w27_live_labels.py:23` (`CREATE TABLE tool_call_calibrators`),
`:39` (`CREATE TABLE tool_call_predictions`), with their indexes at `:68-75`
(`idx_tool_call_calibrators_org_agent`, `idx_tool_call_predictions_org_span`).

The doc **itself later gets this right** in the "Already-good Postgres patterns"
section:
> `tool_call_predictions`/`tool_call_calibrators` (`111_w27_live_labels.py`) got
> indexes in the *same migration* that `live_trace_sessions` (F10) shipped without one

So the doc contradicts itself between F9's header (092) and the "Already-good
patterns" section (111, correctly). This matters because F9's whole reassurance
framing — "this is a 'one table missed,' not a systemic gap in this file" — leans
on a false premise (that 092 is otherwise a well-indexed migration except for
`tool_call_labels`). The correct comparison table (`tool_call_predictions`/
`tool_call_calibrators` getting indexes while `live_trace_sessions` didn't) is in
migration **111**, a completely different migration with no direct bearing on
whether 092 was internally consistent. **Fix: correct F9's parenthetical to not
cite 092 as the "did get indexes" comparator, or drop the parenthetical
entirely** — the underlying finding (tool_call_labels lacks the index its live
queries need) survives and doesn't need this comparison to stand.

### 2. The "tracked as O2 at the top-level INDEX.md synthesis" cross-reference does not exist — F3 is an orphaned finding, not a deliberately-deprioritized one

Quote (top of doc):
> **Cross-reference:** `rca_chain`'s double-fetch of `telemetry_events` is tracked
> as **O2** at the top-level `INDEX.md` synthesis (owned there for prioritization).
> It's kept here as F3 because `intelligence_rca.py` is inside this file's original
> scope... but it is not this file's headline finding anymore; F1/F2 below have
> larger verified blast radius.

**Counter-evidence:** `INDEX.md` contains **zero** `O`-numbered findings anywhere
in the file. `grep -noE "\bO[0-9]+\b" INDEX.md` (run against the full file, not a
truncated read) returns no matches at all — not "O2 is elsewhere," genuinely no
`O`-prefixed labeling scheme exists in `INDEX.md`. `INDEX.md`'s actual numbering
scheme (Part 2, "Roadmap") uses `finding #N` (e.g. "finding #8" for the
`cluster_after_match`/dead-embedder bug, "finding #11" for the issue-ranking fix).
A full-file search for `rca_chain`, `double-fetch`, or `telemetry_events` context
in `INDEX.md` turns up only two unrelated `telemetry_events` mentions
(re: a different table/migration topic, lines 134/140-141) — **`rca_chain`'s
double-fetch is not referenced, tracked, or prioritized anywhere in `INDEX.md`,
under any label.**

This is a real problem for the review, not a cosmetic citation slip: F3 is
demoted here on the stated premise that another document owns it for
prioritization — but no document owns it. If synthesis takes this doc's framing
at face value, F3 (a real, verified, unbounded-`SELECT`-on-every-RCA-request bug)
silently falls through the cracks between two docs that each think the other has
it. **Recommend: either restore F3 to this file's own priority ranking without
the "tracked elsewhere" hedge, or have synthesis explicitly add it to `INDEX.md`
under a real finding number.**

### 3. F4's "MEDIUM-HIGH" severity is oversold relative to what the code actually does, and ignores that the same function already has a much bigger, already-documented bug

Quote:
> ## F4 — MEDIUM-HIGH: `resolve_issue` re-fetches the same issue row twice

**Counter-evidence on cost:** `IssuesRepo.get_issue` (`src/eden/issues/repo.py:237-250`)
is `SELECT * FROM agent_issues WHERE org_id = $1 AND id = $2::uuid` — a
point lookup by primary-key-shaped predicate on a table the doc's own "Already-good
patterns" section says is well-indexed (`084_agent_issues.py`). This is called from
a human/agent-triggered "resolve an issue" action — not a hot ingest path, not
looped, not per-trace. Doubling a single cheap point-lookup on a low-QPS admin
endpoint from 1 query to 2 does not belong in the same severity tier as F1
(missing index on a table growing ~1,000×20 rows/day) or F2 (broken clustering +
O(n²) synchronous scan blocking the shared ingest event loop). This reads as
severity-inflation to keep the doc's finding count looking uniformly serious.

**Counter-evidence on framing/priority:** `bugs/02-data-consistency.md`'s "Bug 8"
(`bugs/02-data-consistency.md:465-535`, confirmed by direct read) analyzes the
*exact same function* (`agent_issues.py:167-223`) and finds something materially
worse: `resolve_issue` silently coerces any unrecognized `status` value to
`"resolved"` (firing 4 real side-effect pipelines including regression runs and
prompt evolution), AND the portal's real `"acknowledged"` status is not a legal
DB value at all — `set_status` throws a `CheckViolation`, swallows it in a bare
`except Exception`, returns `False`, and the endpoint still returns HTTP 200 as if
it worked. **02-db-queries.md never cross-references this**, despite reviewing the
identical 60-line function in the same pass window. Two docs independently spent
review budget on `resolve_issue` without either flagging that the other function
found something bigger in the same code. For synthesis: F4 should be resequenced
behind Bug 8 (fix the correctness bug that already silently corrupts state before
optimizing a doubled point-lookup), and downgraded to LOW.

### 4. F5's code snippet elides that `cluster_after_match` is wrapped in a bare `except Exception: pass` at all 3 call sites — a second silent-failure pattern layered on F2's silent-fallback bug, that the doc doesn't credit toward F2's severity case

Quote (F5's snippet):
```python
for row in rows:                                    # L255, up to 20 rows
    await _write_event(pg, org_id, signal_id, trace_id, matched, payload, confidence)
    if matched:
        await _maybe_write_stumble(org_id, trace_id, row, payload, agent_id=agent_id)
        await cluster_after_match(org_id, signal_id)                                    # F1+F2
```

**Counter-evidence:** the real code (`investigator.py:255-316`, confirmed by direct
read) is not one `for` loop with 4 lines — it's three near-identical branches
(`statgate_rule` / `inv_prompt` / heuristic-else), each independently calling
`cluster_after_match` inside its own
```python
try:
    from eden.signals.clusterer import cluster_after_match
    await cluster_after_match(org_id, signal_id)
except Exception:
    pass
```
This is real, load-bearing context the doc drops: not only does `_embed` silently
swallow its `ModuleNotFoundError` at `debug` level (F2's headline claim), but the
*caller* of `cluster_after_match` also silently swallows **any** exception from
the entire clustering call with a bare `except: pass` and zero logging — a second,
independent silencing layer around the same broken feature. This is not a "cut"
so much as a missed opportunity to strengthen F2/F5's own argument; flagging it as
a finding gap rather than an inflation, but it means F5's snippet as presented is
a simplification that understates how thoroughly this feature's failures are
hidden from operators — worth citing explicitly in F2 or F5 rather than only in
this adversarial pass.

## NEW FINDINGS

### A. Benchmark-number mismatch with sibling doc `optimizations/01-hotpath-perf.md` on the same broken-embedder fix, unreconciled

`optimizations/01-hotpath-perf.md` (grep-confirmed) independently found the same
dead `get_default_embedder` import and separately benchmarked the O(n²) cost at
**"4.7s / 18.5s CPU time at n=500, d=384/1536"**. `02-db-queries.md` reports
**"~6.7 s"** for `n=500, d=384` in its own table. These are two different
measured numbers for what should be the same quantity (n=500, d=384 case).
Neither doc references the other's number. This isn't necessarily a fabrication
in either doc (different machines/methodologies could explain the gap), but
synthesis should reconcile which number is canonical before either is cited in a
scorecard — the review's own `INDEX.md` roadmap flags exactly this class of
problem elsewhere ("F12 search-benchmark provenance," item 19 in Part 2), so the
same discipline should apply here.

### B. `KNOWN-SUBSYSTEMS.md` flags `kb/` as "not yet inspected but plausibly
relevant — check before claiming a gap" (line 70). `02-db-queries.md`'s F2 does
exactly the deep, verified inspection `KNOWN-SUBSYSTEMS.md` asks for
(`eden.kb.embeddings` vs. the real `eden.kb.ledger.embeddings`, confirmed via
`pkgutil`-equivalent `find`), and its conclusion — the embedder wiring in
`kb` is broken/unreachable, not merely "unexplored" — should be surfaced back
into `KNOWN-SUBSYSTEMS.md`'s `kb/` entry for other review agents, since it
directly contradicts the "not yet inspected" framing there (it now *has* been,
and found broken, not just unexplored).

### C. No overlap/contradiction found with `optimizations/06-storage-retention.md`
or `05-cron-jobs.md` on the tables this doc covers (`signal_events`,
`tool_call_labels`, `signal_clusters`, `agent_issues`) — checked via grep, no
hits. This doc's scope is genuinely disjoint from those two siblings; no
duplication risk there for synthesis.

---

## Summary verdict

This is the most rigorously self-verified doc I've adversarially reviewed in this
pass — nearly every checkable line-number, migration citation, and even a
from-scratch-reproduced statistical simulation (F2's 89%/478 collapse number, which
I independently got 94.6%/487 for — *worse*, not inflated) held up. The genuine
issues are: (1) a factual self-contradiction in F9's migration-092 attribution,
(2) a fabricated/stale cross-reference to a non-existent "O2" label in `INDEX.md`
that leaves F3 unowned by any doc, and (3) F4's severity rating, which reads as
inflated once compared against its actual query cost and against the more serious
correctness bug (`bugs/02-data-consistency.md` Bug 8) sitting in the same function
that this doc never cross-references.
