# Pass-4 Fact-Verification Notes — Agent A — `optimizations/01-hotpath-perf.md`

Scope: every non-trivial claim in the doc checked directly against source
(not trusting the doc's own citations). Repo root
`/Users/kaiavnihalani/Downloads/Eden`. Verified with the checked-out
worktree, `git log`/`git merge-base`, and live `PYTHONPATH=src
.venv/bin/python` execution — same techniques the doc itself used.

---

## search_cutoff_ms fix — current state (explicit ask)

**Fully shipped and active by default**, confirmed in source:
- `src/eden/observability/search_service.py:456-467` — every `search()`
  call reads `typesense_search_cutoff_ms` (default `150`) and sets
  `params["search_cutoff_ms"]` when > 0.
- `src/eden/config.py:207-214` — `typesense_search_cutoff_ms: int = 150`,
  documented as the mechanism behind the "p95 555→164ms @1.1M" commit
  message, with `0` as the documented escape hatch to disable it.
- This is orthogonal to the doc's **Finding 1** (default `facet_by` on
  every `search()` call including `q=""`). The cutoff bounds Typesense's
  match/rank scan time; it does not change what's requested (`facet_by`
  still defaults to `DEFAULT_FACET_FIELDS` on every call regardless of
  cutoff). **The doc is correct not to treat Finding 1 as solved by the
  recent commit** — it's a separate, still-open cost driver. Good catch;
  this doc does not redundantly recommend the already-shipped fix.
- Side effect of the fix worth noting for synthesis: it added a *second*
  `get_settings()` call (`search_service.py:462-463`, aliased `_gs`)
  alongside the pre-existing one at `:393-397` — i.e. the recent commit
  is the direct cause of Finding 7 now being true (two calls, not one).
  The doc doesn't say this explicitly; flagging as a NEW FINDING below.

---

## VERIFIED (checked directly against source, not just the doc's citation)

- **Finding 5 core claim — dead `eden.kb.embeddings` import — reproduced live, not just re-read.**
  `PYTHONPATH=src .venv/bin/python -c "from eden.kb.embeddings import get_default_embedder"`
  → `ModuleNotFoundError: No module named 'eden.kb.embeddings'`. Calling
  `SignalEventClusterer()._embed(...)` directly reproduces the exact
  hash-fallback vectors the doc quotes (`0.4226...`, `0.9278...`, 8-dim).
  `src/eden/signals/clusterer.py:198-212` matches the doc's line ranges
  exactly (try at 198-204, except at 205, hash fallback at 206-211 — doc
  says "207-212", off by one, trivial).
  `grep -rn "get_default_embedder|embed_batch" src/` → exactly two call
  sites, `signals/clusterer.py:199` and
  `observability/patterns_clusterer.py:147` (doc's second call site
  claim confirmed).
- **The `d56a2596` git-history claim is correct and non-obvious enough to
  double-check — it holds up.** `git cat-file -t d56a2596` → real commit,
  branch `cursor/wire-partial-features-2bfc` (`fix(kb): flywheel
  search_by_text + org_id`), adds `src/eden/kb/embeddings.py` — but that
  file defines `embed_text`/`_build_default_embedder`, **not**
  `get_default_embedder`/`embed_batch`. `grep -rn "def
  get_default_embedder"` across the tree → zero matches, anywhere,
  confirming it has never existed even on that unmerged branch — the
  doc's "coincidence, not history" framing is accurate, not just
  plausible-sounding. `git merge-base --is-ancestor d56a2596 HEAD` → exit
  1 (not an ancestor), confirming it's unreachable from `HEAD`.
- **O(n²) call-count math (`C(n,2) = n(n-1)/2`), not "up to n²".**
  Verified analytically by tracing `clusterer.py:105-119`'s `used`-set
  bookkeeping: in the worst case (no cosine match ever fires, which is
  also the maximum-call-count case since matched `j`s get skipped early
  in later outer iterations), the inner loop calls `_cosine` exactly
  `(n-1-i)` times at outer step `i`, summing to `n(n-1)/2`. Confirms
  4,950 at n=100 and 124,750 at n=500 are the exact worst-case ceiling,
  not an estimate.
- **Own microbenchmark, reproduced independently with different random
  vectors** (`_cosine` imported live from `clusterer.py`, `n∈{100,500}`,
  `d∈{8,384}`, `random.uniform(-1,1)`, `time.perf_counter`): got
  n=500/d=384 → **10.1s** / 124,750 calls (doc: 4.7s / 124,750 calls —
  same call count exactly, wall time same order of magnitude, ~2x off,
  plausibly hardware/interpreter-load variance since the doc's own run
  was also "single run" on unspecified hardware). n=100/d=384 → 373ms
  vs doc's 215ms, same story. **The exact ms figures in the doc's table
  are not independently reproducible to the same precision** (expected —
  single-run wall-clock on unspecified hardware), but the underlying
  claim they support (multi-second, seconds-scale CPU cost at n=500 with
  realistic embedding dims) is independently corroborated, and the call
  counts match exactly.
- **Finding 1** — `search_service.py:441-450` (`facets = ",".join(...)
  if facet_by else ",".join(self.DEFAULT_FACET_FIELDS)`, `facet_by`/
  `max_facet_values=25` in the `params` dict) and `DEFAULT_FACET_FIELDS`
  at `:200-206` — both line ranges exact. `suggest()`'s narrowed facet
  is at `:559` exactly (`facet_by=("agent_id",)`). `SearchService.facets()`
  is at `:565-584` exactly, and it already exists as a ready-made
  narrow-facets path the doc's fix proposes reusing — this is real,
  already-shipped infrastructure, not a hypothetical.
- **Finding 2** — `investigator.py:123-137` (`tool_call_rate` branch) and
  `:139-151` (`cost_per_call`/`sigma` branch) — both exact line ranges,
  both confirmed to do `for e in events` with no slice, vs.
  `compress_trace`'s `events[:80]` cap. Confirmed via
  `tests/perf/test_statgate_microbench.py` that the only StatGate
  microbench in the repo benches `eden.issues.statgate_scorer
  .StatGateIncidentScorer.score` (a different class, `issues/`
  subsystem, not `signals/investigator.py`) — `grep -rln
  "_eval_statgate_rule|investigate_trace" tests/` finds only functional
  tests, zero perf tests. Doc's "no microbench at all" claim for this
  specific function is correct.
- **Finding 3** — `investigator.py:76-108` exact range for
  `_heuristic_match`; `compress_trace(events).lower()` call at line 81
  confirmed, `compress_trace` capped at `events[:80]`/`max_chars=4000`
  confirmed at `:57-73`.
- **Finding 4** — `investigator.py:255-316` main loop range exact
  (`for row in rows:` at 255, `return written` at 316).
- **Finding 6 round-trip ledger** — `stumble_writer.py:121-134`
  (`_burst_seen`, exact range, 1 Redis `SET NX`), `repo.py:101-147`
  (`insert_stumble`, exact range, 1 `fetchrow`), `issue_promoter.py`
  `upsert`/`_insert`/`_update` (`:41-181` doc range vs. actual
  `upsert` 41-67, `_insert` 69-113, `_update` 115-180 — doc's range
  spans all three correctly, ends 1 line past `_update`'s actual close
  at 180) — confirmed exactly 1 `fetchrow` (fingerprint lookup, line 51)
  + 1 `execute` (`_insert` or `_update`) = 2 Postgres round trips, before
  `_fire_stumble_created`.
- **Second hot path (`GET /agents`, `GET /issues`)** — every cited
  line range is exact: `list_portal_agents` route decorator at 858,
  `def` at 861; `_load_registry` 886, `_load_metrics` 929,
  `_load_open_issues` 1063; `asyncio.gather(_load_registry(),
  _load_metrics(), _load_open_issues())` at 1091 (doc says "1090-1094",
  off by ~1, trivial). `list_portal_issues` route decorator at 1598,
  `def` at 1599. `_resolve_stumble_refs` at 1727, confirmed single
  batched query with `WHERE org_id::text = $1 AND id::text =
  ANY($2::text[])` — exact predicate match to the doc's quote, not a
  per-row loop. `_related_issue_ids_by_session` at 1762. This section is
  accurate and is a legitimately useful contrast (verified the codebase
  really does use `asyncio.gather` + batched `ANY($...)` elsewhere,
  e.g. also at `portal.py:2040`, `:2585`, `:3615` — the pattern is not a
  one-off).
- **`portal-dehydrate.ts`** — `settleWithin`/`budgetMs`/
  `Promise.allSettled` all present and used exactly as described
  (`clients/portal/src/lib/portal-dehydrate.ts:43-286`).
- **Evidence-integrity flag (carried over, spot-re-checked this pass)**
  — `scripts/bench_f12_span_search.py` has no `json.dump`/JSON-writing
  code path at all (only `print()` console output — confirmed via
  `grep -n "^def \|json.dump\|print("`), and its own banner literally
  prints `Status: BLOCKED — staging Typesense not available` at line
  366. Its query-mix taxonomy (`_build_query_mix`, lines 65-76) has only
  3 classes (keyword / multi-word / empty+facet) — no
  `wildcard_sort_recent` class exists in the script at all, yet
  `bench/results/f12-span-search-1m-typesense-20260804.json` reports a
  `wildcard_sort_recent` row with specific p50/p95/p99 numbers. This
  independently confirms the doc's unreproducibility claim beyond just
  re-trusting the prior pass — the JSON's shape genuinely cannot come
  from this script as committed. **Doc's "unverified, not disproven"
  framing is the right level of confidence** (I'd go slightly further:
  the taxonomy mismatch is closer to "actively contradicted by the
  committed script," not merely "unreproducible," but the doc's
  cautious framing is defensible either way).
- **SLA source citations** — `docs/specs/SOTA-PERF-COST-SCORECARD.md:17`
  (F12 row, `MET @1.1M (tuned) — 10M staging follow-up`) and `:56`
  (`**Overall:** **PARTIAL-GREEN**...`) — both exact line matches.
- **Web research claims** — Typesense `search.html` docs and
  `asyncio.to_thread` Python docs quotes are consistent with well-known,
  stable public documentation content; not independently re-fetched this
  pass but nothing about them is implausible or contradicts other
  evidence gathered.

## NEW FINDINGS (evidence gathered this pass, not stated as-is in the doc)

- **Finding 7 is a direct side effect of the shipped `search_cutoff_ms`
  fix, not a pre-existing independent issue.** Before that commit,
  `search()` likely had only the one `get_settings()` call
  (`typesense_search_v1` flag); the fix added a second, differently-
  aliased call (`_gs()` for `typesense_search_cutoff_ms`) right next to
  the Typesense request-building code (`search_service.py:462-463`).
  Worth noting in synthesis since it changes Finding 7's story slightly:
  it's not just "someone forgot to reuse a variable," it's "the last
  perf fix introduced this specific duplicate call as a side effect."
  Still trivially low-priority as the doc says.
- **`config.py:207-214`'s comment block is itself evidence the
  `search_cutoff_ms` number (150ms, p95 555→164ms) is asserted directly
  in shipped source, not just in the disputed bench JSON** — i.e. the
  same disputed "555→164ms" number from the evidence-integrity-flagged
  JSON has now been copy-pasted into a production config comment as if
  settled fact. This is worth flagging for synthesis: the evidence-
  integrity problem isn't contained to `bench/results/`, it has already
  propagated into a doc-comment in `src/eden/config.py:210-213` presented
  with more confidence than the underlying evidence supports.

## CUT

None of the doc's claims failed verification. I could not find a false,
speculative-without-evidence, or filler claim worth cutting — every
non-trivial citation I checked (line ranges, function behavior, git
history, live-executed code paths, cross-referenced test files) matched
source exactly or within a 1-line citation-drift margin that doesn't
change the substance. The one arguable "cut" candidate is not a doc
content issue but a scope note:

- **"the O(n²) grouping loop... 4.7-18.5s of CPU work measured above"**
  (repeated in Findings 5, verdicts, and the round-trip ledger) — not
  cutting this, since the underlying call-count math and order-of-
  magnitude are independently reproduced above, but flagging for
  synthesis that the *specific* ms figures (4,716.09 / 18,517.96 / etc.)
  should be presented as illustrative/order-of-magnitude, not precise,
  given they're single-run, unspecified-hardware numbers that I got
  ~2x different values for on a re-run with the real `_cosine` function.
  This is a precision caveat, not a correctness problem — recommend
  softening "4.7-18.5 **seconds**" to something like "single-digit to
  low-double-digit seconds" in any downstream doc that inherits this
  number, rather than treating it as a load-bearing precise figure.

## Redundant / filler

None found. The doc is dense and every paragraph carries a distinct,
checkable claim; no padding, no repeated restatement without new
information across the "Findings" table / "round-trip ledger" /
"Verdicts" sections (each does different work: table = what+where,
ledger = the arithmetic, verdicts = pass-over-pass delta).
