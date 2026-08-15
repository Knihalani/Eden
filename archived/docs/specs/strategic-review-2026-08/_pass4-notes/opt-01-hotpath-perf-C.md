# Pass 4 — Adversarial Skeptic (Agent C) — `optimizations/01-hotpath-perf.md`

Verification method: re-derived every load-bearing line citation from `src/` directly
(not trusted from the doc's prose), re-ran the git-forensics claim, and wrote an
independent Python reproduction of the doc's own headline clustering microbenchmark to
stress-test its numbers. Full command trail below each finding.

---

## SURVIVED SCRUTINY

These are the claims I tried hardest to break and could not.

1. **Finding 5's central claim — `get_default_embedder` is dead code that has never
   existed on `main`.** Verified independently:
   - `src/eden/kb/` submodules (`ls`) = `book, episodic, exploit, flywheel, ledger,
     procedural, prompt_versions, research, retrieval_intel, retrieval_logger.py,
     semantic, shared, strategy_store.py` — no `embeddings.py`.
   - `grep -rn "get_default_embedder|embed_batch" src/` → exactly the two call sites
     the doc names (`signals/clusterer.py:199,201,204`,
     `observability/patterns_clusterer.py:147-149`), nothing else.
   - `git log --all -p -S"def get_default_embedder"` returns **no commits** — I ran
     this myself, zero hits, matching the doc's claim.
   - I went one step further than the doc did: I checked *what the one unmerged
     commit it names (`d56a2596`) actually contains*. `git show
     d56a2596:src/eden/kb/embeddings.py` defines `_HashFallbackEmbedder`,
     `_build_default_embedder`, `_fallback_vector` — **not** `get_default_embedder`
     at all, a different name. So even the one historical near-miss the doc flags as
     "coincidence, not history" doesn't define the function in question either. This
     makes the dead-code claim stronger than the doc itself states, not weaker.
   - `git merge-base --is-ancestor d56a2596 HEAD` → confirmed NOT an ancestor, exactly
     as claimed.
   This is about as rigorously proven as a static-analysis claim can be. Keep at
   full confidence.

2. **The `except Exception` at `clusterer.py:205` silently swallowing
   `ModuleNotFoundError` and falling to `stable_hash` fallback.** Read the function
   directly (`src/eden/signals/clusterer.py:195-212`) — matches the doc's
   description exactly, including that the fallback comment ("Deterministic hash
   fallback for tests / no-embedder envs") reads like an intentional test shim, not
   a warning that it's the *only* path in production. `logger.debug(...)` (not
   `warning`/`error`) is correct — this is genuinely invisible in prod at default
   log levels.

3. **`_eval_statgate_rule`'s uncapped scans (Finding 2).** Re-pulled the function
   with `nl -ba`: the two `for e in events` loops are at exactly lines 129 and 142,
   inside branches spanning exactly 123-137 and 139-151 as the doc states — line
   citations are precise to the character, not "close enough." No `[:80]` cap
   anywhere in this function, confirmed by full read.

4. **The `StatGateIncidentScorer` vs. `investigator.py`'s `_eval_statgate_rule` being
   two genuinely different classes, so the N08 SLA doesn't cover this hot path.**
   Confirmed: `src/eden/issues/statgate_scorer.py:51` `class StatGateIncidentScorer`
   is what `tests/perf/test_statgate_microbench.py` benches (its own docstring says
   so explicitly: `StatGateIncidentScorer.score`). `signals/investigator.py`'s
   `_eval_statgate_rule` is a free function in a different module entirely, with no
   microbench (`grep -in "perf|benchmark|elapsed|p95" tests/unit/signals/
   test_f35_investigator.py` → zero hits). The doc is right that the SOTA scorecard's
   "StatGate MET" row does not cover this code path — this is a real, non-obvious
   gotcha (same acronym, two unrelated classes) and the doc catches it correctly.

5. **Round-trip ledger arithmetic.** Re-read `investigator.py:255-316`,
   `issues/stumble_writer.py` (`_burst_seen:121`, `StumbleWriter.create:37`),
   `issues/repo.py` (`insert_stumble:101`), `issues/issue_promoter.py`
   (`upsert:41`, `_insert:69`, `_update:115`) directly. The chain shape (1 Redis +
   up to 3 Postgres round trips per matched row, before clustering starts) is
   correct, and `cluster_after_match` is genuinely `await`ed inline in the request
   path (not fire-and-forget) in all three branches of the loop — confirmed at
   lines ~276-283, ~292-299, ~305-312. Finding 2/4/5's "reachable synchronously
   from `POST /traces/{trace_id}/investigate`" framing is accurate, not
   speculative.

6. **`GET /agents` / `GET /issues` "checked, ruled out" counter-example.** Confirmed
   `asyncio.gather(_load_registry(), _load_metrics(), _load_open_issues())` at
   `api/routes/portal.py:1091-1094`, and the batched `ANY($2::text[])` pattern in
   `_resolve_stumble_refs`. This is a legitimately useful contrast and not
   oversold — the doc doesn't claim these routes are perfect, just that they
   demonstrate the codebase already knows the pattern the other findings recommend.

7. **`asyncio.to_thread` / GIL claim.** Directly matches official Python docs
   language ("primarily intended... for IO-bound functions"). Correct and properly
   cited, not a stretch.

8. **Two files named `clusterer.py` exist in this repo** (`src/eden/signals/
   clusterer.py` — `SignalEventClusterer`, the one this doc analyzes — and
   `src/eden/insights/incidents/clusterer.py` — `IncidentClusterer`, a different
   file referenced by `bugs/02-data-consistency.md`). The hot-path doc always
   qualifies with the module path (`signals/clusterer.py`) and never confuses the
   two. Not a contradiction with the bugs doc, just worth noting the ambiguity was
   correctly avoided.

---

## CUT / DOWNGRADE

### 1. The clustering microbenchmark table's "`_cosine()` calls" column is not
   uniform across dimensions the way the table presents it — and I can reproduce
   why.

> "n=100, dim=8 (today's actual fallback) — wall time 0.75ms — `_cosine()` calls
> 4,950" / "n=500, dim=8 — wall time 4.68ms — `_cosine()` calls 124,750" ... "the
> exact worst-case count is `C(n,2) = n(n-1)/2`, confirmed by direct
> instrumentation."

The grouping loop (`clusterer.py:105-119`) has an early-exit `used` set: once item
`j` is grouped into item `i`'s cluster (cosine ≥ `_COSINE_THRESHOLD = 0.82`), it's
skipped for the rest of the outer loop (`if j in used: continue`, `:113-114`).
That means the **actual** number of `_cosine()` calls is data-dependent, not a
fixed `C(n,2)` — it only equals the full triangle when *no* vectors cluster.

I wrote a direct reproduction of the same function (`clusterer.py:25-33`,
`:105-119`, copied verbatim) and ran it myself:

```
n= 100 d=    8 wall=     0.86ms calls=    281 groups=7      # NOT 4,950
n= 500 d=    8 wall=     6.10ms calls=   1514 groups=15     # NOT 124,750
n= 100 d=  384 wall=   376.66ms calls=   4950 groups=0      # matches C(n,2)
n= 500 d=  384 wall=  9481.36ms calls= 124750 groups=0      # matches C(n,2)
n= 100 d= 1536 wall=  1785.54ms calls=   4950 groups=0
n= 500 d= 1536 wall= 42225.30ms calls= 124750 groups=0
[real fallback shape, diverse text→stable_hash] n=500 d=8 wall=1.78ms calls=565 groups=5
```
(script + exact numbers available on request; uses the identical `_cosine`/grouping
code copied from `clusterer.py:25-33,105-119`, `random.random()` vectors seeded for
d=384/1536, and `stable_hash`-derived 8-dim vectors for the "real fallback shape"
row, matching the actual production code path.)

At low dimension (today's actual 8-dim hash fallback), random-ish vectors hit the
0.82 cosine threshold by chance far more often than at 384/1536 dims (a
well-known concentration-of-measure effect: high-dimensional random vectors are
nearly orthogonal, low-dimensional ones aren't), so the `used`-set short-circuit
fires constantly and the real call count comes out to **roughly 5-12% of the
"4,950/124,750" figure the table prints for every row regardless of dimension.**
This also explains an internal inconsistency in the doc's own numbers that a
careful reader should have caught: going from n=100→500 at d=8, wall time only
scales **6.2x** (0.75→4.68ms), while the claimed call count scales **25.2x**
(4,950→124,750) — those two numbers are incompatible under a constant-cost-per-call
model, which is itself a tell that d=8 isn't actually executing anywhere near
124,750 calls. At d=384/1536 the doc's numbers are internally consistent (21.97x
and 25.33x wall-time ratios, both close to the 25.25x call-count ratio) because
groups=0 there — no clustering happens with independent random vectors in high
dimension, so it genuinely is close to full `C(n,2)`.

**Why this matters, and why it's a downgrade not a full cut:** the headline
4.7-18.5s worst-case number (d=384/1536) is *not* undermined by this — it's
legitimately close to true worst-case, because genuinely dissimilar real
embeddings rarely exceed a 0.82 cosine threshold, matching my own d=384/1536
reproduction. But the table's own "today, harmless" row (d=8) is presented next
to a call-count that isn't what actually executes today, which weakens the
doc's implicit "look how precisely I instrumented this" framing for that
specific row. The recommendation: keep the 4.7-18.5s ceiling number (it holds up
under independent reproduction), but caveat that the "4,950/124,750 calls"
column is the *worst-case* bound that only applies when no vectors cluster
(true at high dim for dissimilar inputs, not true at low dim or when inputs are
duplicative — which is, ironically, the exact condition clustering exists to
detect, so **real production embedding-fixed behavior might land meaningfully
below the stated 4.7-18.5s ceiling** if signal events cluster the way they're
supposed to). This nuance is currently absent from the doc.

### 2. Finding 4's fix recommendation cites a weaker precedent than a sibling doc
   already found in the same codebase.

> "Recommended fix: Batch `signal_events` inserts; run per-matched-row
> stumble-write + cluster hooks concurrently via `asyncio.gather` (the codebase
> already uses this pattern successfully elsewhere — see the `GET /agents`
> contrast below)."

`optimizations/02-db-queries.md:404-420` (its own **F5**, same exact code —
`investigator.py:255-316` — same exact bug) recommends `bounded_gather`
(`eden/insights/incidents/clusterer.py:59-100`, imported from
`eden.async_tasks.bounded_gather` — I confirmed this is a real, already-used
utility, `grep -n "bounded_gather" src/eden/insights/incidents/clusterer.py:70,79,81`)
specifically *because* an unbounded `asyncio.gather` over up to 20 concurrent
per-matched-row chains (each doing up to 4 sequential round trips) risks a burst
of up to 20 simultaneous DB/Redis connections from one request — a connection-pool
exhaustion risk that `GET /agents`'s plain 3-way `asyncio.gather` (a much smaller,
fixed fan-out) doesn't have to worry about. `01-hotpath-perf.md`'s citation of
`GET /agents` as the precedent is directionally correct (concurrency > sequential)
but is the *weaker* of the two existing patterns in this codebase, and the doc
didn't find the one that actually matches the shape of its own problem
(unbounded fan-out, not fixed 3-way). Recommend downgrading Finding 4's fix
wording from "the codebase already uses this pattern" to noting `bounded_gather`
specifically, or cross-referencing 02-db-queries.md's F5 (see duplication note
below) rather than independently re-deriving a less precise precedent.

### 3. The doc's own evidence-integrity standard isn't fully applied to itself.

The doc spends significant space (rightly) attacking the prior pass's F12 JSON
for being an unreproducible, uncommitted artifact ("**Evidence-integrity flag**").
But its own headline clustering benchmark (4.7-18.5s at n=500) is described only
in prose ("script: generate `n` random vectors, run the real grouping function,
time it — `python3.12`, M-series laptop, **single run**, `time.perf_counter`") and
is **not committed anywhere in the repo** — I checked (`find . -iname
"*cluster*bench*"`, `git status --short | grep -i bench` → nothing). A future
reader can't re-run this exact benchmark from the repo; they can only trust the
pasted table, which is the identical category of problem (uncommitted,
unreproducible numeric claim) the doc itself flags as disqualifying for the F12
JSON, just smaller in scope and more plausible in magnitude. This doesn't mean
the number is wrong — my independent reproduction (above) confirms the
d=384/1536 order of magnitude is right — but the doc should either commit the
script (it already recommends doing exactly this for F12 in its "Corrected,
honest benchmark plan" section) or explicitly acknowledge that its own Finding 5
numbers carry a smaller version of the same evidentiary gap it's criticizing
elsewhere in the same document. Single-run-no-repeats methodology is also worth
one sentence of caveat given CPython timing noise, even though my reproduction
landed in a compatible ballpark.

### 4. Finding 4/6's escalation to "MEDIUM-HIGH" leans entirely on an extreme
   worst-case (`R=M=20`) with no attempt to estimate a typical case.

> "**MEDIUM-HIGH** (raised from MEDIUM) — now that Finding 6 (below) quantifies
> the DB-round-trip ceiling precisely, the compounding is worse than previously
> stated."

The ~5,102-round-trip number requires *every one of 20 enabled signal
definitions to match on the same trace* (`M=R=20`) — the doc is explicit this is
"a hard ceiling derived from the code's own bounds, not a speculative
extrapolation," which is true as *math*, but the confidence escalation from
MEDIUM to MEDIUM-HIGH is driven by that ceiling number alone, with no attempt to
sanity-check a typical `R` (how many `signal_definitions` a real org actually
has enabled — `092_market_ready_consolidated.py`/seed data would show this) or a
typical match rate. `optimizations/02-db-queries.md` (sibling doc, same code)
labels the equivalent finding **F5 — MEDIUM**, not MEDIUM-HIGH, for the same
underlying code. This isn't necessarily wrong, but the escalation rests on an
extreme-tail scenario framed with more confidence than the doc's own
"worst-case, not typical" hedging elsewhere would suggest — worth downgrading
back to MEDIUM to match the sibling doc, or explicitly justifying the escalation
with a typical-case estimate rather than the ceiling alone.

### 5. Web research citation for Finding 1 draws on a benchmark at a scale far
   below Eden's own claimed corpus size, and the doc's confidence framing hides
   this gap somewhat.

> "A Typesense community benchmark thread... measured facet cost scaling with
> `max_facet_values` (a Typesense team member's own numbers on a small **~3k-doc
   collection**...)"

The doc's own SLA section states Eden's F12 target is measured at 1.1M docs
(scaling to 10M). A ~3k-doc community benchmark is 3-4 orders of magnitude
smaller than the corpus this finding is meant to matter for, and facet
aggregation cost is generally understood to scale with *matched corpus size* as
well as `max_facet_values` — the cited thread only speaks to the latter. The
doc's own confidence line ("**MEDIUM** on ms magnitude... mechanism is
independently corroborated") is honest about this (it says "mechanism," not
"magnitude," is corroborated) — so this survives as *properly hedged*, but it's
worth flagging explicitly in the synthesis pass that this external citation
provides essentially no quantitative support at Eden's actual data scale, only
qualitative directional support. Not a "cut," but reviewers should not treat the
Typesense thread as more than very weak circumstantial corroboration.

---

## NEW FINDINGS (not in the doc)

### A. Direct duplication with `optimizations/02-db-queries.md` — same code, two
   independent findings, needs synthesis merge, not two separate line items.

`02-db-queries.md`'s **F5 — MEDIUM: per-signal write loop in `investigate_trace`
is serial and unbatched** (`optimizations/02-db-queries.md:404-420`) analyzes
the *exact same code* as this doc's **Finding 4** and **Finding 6**
(`investigator.py:255-316`, the `for row in rows: await _write_event(...); ...
await cluster_after_match(...)` loop), with an overlapping fix recommendation
(batch inserts + concurrent execution). Both docs were clearly written
independently and arrived at the same underlying bug from different analytical
angles (DB-query-shape audit vs. hot-path round-trip audit). This is good
convergent validation of the underlying finding, but as currently written the
two docs would double-count this as two separate findings in any aggregate
severity/impact rollup. `02-db-queries.md` additionally cites a more precise
existing-pattern fix (`bounded_gather`) than this doc does (see CUT #2 above).
Synthesis should merge these into one finding, citing both docs, and adopt
`02-db-queries.md`'s `bounded_gather` recommendation over this doc's plain
`asyncio.gather` framing.

### B. `optimizations/05-cron-jobs.md` independently profiled `cluster_signal`'s
   SQL query and reached a different but complementary verdict — worth an
   explicit cross-reference in this doc, currently absent.

`optimizations/05-cron-jobs.md:296` evaluates `cluster_signal`
(`signals/clusterer.py:57-84`) from a query-scoping angle: "`ORDER BY
detected_at DESC LIMIT 500` scoped to one org+signal... OK — not a global
candidate-selection query." This is **not a contradiction** — that doc is
assessing whether the SQL query itself is safely bounded (yes), while this doc
(Finding 5) is assessing the O(n²) *algorithmic* cost of what happens to the
500 rows *after* the query returns (expensive if the embedding bug were fixed).
Both verdicts are correct and non-overlapping, but a reader of either doc in
isolation could come away thinking `cluster_signal` is either "fine" (05) or
"a real risk" (01) without realizing they're evaluating different layers of the
same function. Recommend this doc add a one-line cross-reference to
`05-cron-jobs.md:296` clarifying the query-vs-algorithm distinction.

### C. `optimizations/03-llm-cost.md` independently re-verified several of the
   same `investigator.py` line citations this doc relies on (`:170`
   `RuntimeError("signal investigator LLM path removed")`, `:279` "LLM
   investigator path removed" comment) via its own from-scratch grep-based
   fact-check, and got matching results. This is a second independent
   confirmation (beyond my own) that the doc's line citations into
   `investigator.py` are trustworthy — worth noting as corroboration, not a
   problem.

### D. SLA source citation is accurate down to the line number.
   `docs/specs/SOTA-PERF-COST-SCORECARD.md:17` is indeed the "Search (Typesense)
   F12" row with the exact `MET @1.1M (tuned) — 10M staging follow-up` text
   quoted, and `:56` is indeed the "Overall: PARTIAL-GREEN" line. Checked
   character-for-character; no drift.

---

## Summary verdict

This is a genuinely well-evidenced document — I went in assuming it oversold
itself and came away with only one number-level correction (the clustering
call-count table conflating a worst-case bound with an "instrumented" value for
the currently-harmless d=8 case) and one duplication issue with a sibling doc
that's a synthesis-process problem rather than a factual error. The dead-import
forensics (Finding 5's core claim) is if anything under-stated relative to what
I could independently confirm. The weakest parts of the document are (a) the
MEDIUM→MEDIUM-HIGH confidence escalation resting on an unqualified worst-case
ceiling, and (b) not applying its own evidence-integrity standard to its own
ad hoc, uncommitted benchmark script.
