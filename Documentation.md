# Eden — Architecture Notes (Cat 23 v1.7 PR-System Revamp)

This document captures the durable architectural decisions for Eden's
PR-generation system as it shipped in the v1.7 Cat 23 revamp
(2026-07-05). The intent is to make the system understandable to
on-call + new team members without re-reading the code.

---

## 1. The 60-second mental model

```
                  ┌───────────────────────────────────────────────┐
                  │                discipline gate                 │
                  │  (confidence_gate → circuit_breaker →          │
                  │   dedupe → rate_limiter)                       │
                  └────────────┬──────────────────────────────────┘
                               │ allowed + clear
                               ▼
   ┌────────────────┐    ┌─────────────────┐    ┌─────────────────┐
   │ incident_       │    │ scheduled_      │    │ admin (manual)  │
   │ trigger.run    │    │ trigger.run     │    │ via PRCreator   │
   └────────┬───────┘    └────────┬────────┘    └─────────────────┘
            │                     │
            ▼                     ▼
   ┌────────────────┐    ┌─────────────────┐
   │ RepoGraphClient │    │ PRAgent          │
   │ (SymbolGraph)   │    │ (EdenPatchAgent) │
   │                 │    │  → LocalCodingAgent fallback │
   └─────────────────┘    └─────────────────┘
            │                     │
            └──────────┬──────────┘
                       ▼
   ┌────────────────────────────────────────────────┐
   │  existing Cat 23 surface:                       │
   │  PRCreator → Provider (PRProvider) → repo      │
   │  (does the actual commit + PR open)            │
   └────────────────────────────────────────────────┘
```

The brief says "do not bolt on a homemade code graph" + "do not bolt
on a homemade coding-agent framework". So the *graph* is the in-process
:mod:`SymbolGraph` (stdlib-only, persistent in SQLite), and the *agent*
is :class:`EdenPatchAgent` — a thin wrapper over Eden's existing
:class:`eden.code_change.patch_generator.PatchGenerator` +
:class:`eden.optimization.model_router.ModelRouter`. Both have
no-credentials fallbacks for dev/CI/on-prem (LocalCodingAgent and
LocalRepoGraph respectively). The *commit* + *PR open*
reuse the existing Cat 23 `PRCreator` + `PRProvider` machinery — no
parallel pipeline.

---

## 2. Why the discipline layer is four separate concerns

The brief lists five distinct anti-overzealous protections. They could
have been one big function, but they are deliberately separated so:

* **ConfidenceGate** is the only thing that can be *bypassed* by raising
  the policy threshold. It encodes the "should we even consider this?".
* **CircuitBreaker** is the only thing that operates on a *time window*.
  It encodes the "are we in a noise storm right now?".
* **DedupeIndex** is the only thing keyed on a *fingerprint*. It encodes
  the "did we already say this in the last 14 days?".
* **RateLimiter** is the only thing that fails *closed* (all others
  fail open on a DB outage). It encodes the "are we over the cap?".

Each one has a single, well-named module under
`src/eden/code_change/discipline/`. The four together form the chokepoint
that every trigger flow must pass through.

---

## 3. Why we use SymbolGraph (not Greptile) by default

In v1.7.1 the user clarified that Greptile was an *example* in the
brief, not a real decision. We built **SymbolGraph** instead:

* **In-process** — runs locally, no hosted dependency, no per-PR cost.
* **Zero extra dependencies** — uses Python stdlib (`ast` for .py
  files, regex for TS / JS / Go / Java / Rust / Ruby).
* **Persistent** — backed by SQLite (`$EDEN_SYMBOL_GRAPH_DB`, default
  `./.eden/symbol_graph.sqlite`). Incremental re-indexing uses
  `git diff --name-only` so unchanged files are not re-parsed.
* **Real cross-file reference resolution** — extracts call sites and
  attribute access so `find_affected_areas` can surface files that
  *reference* the suspected symbols, not just files that mention
  them in their docs.
* **Bulletproof** — every method is best-effort and degrades to
  `None` / `[]` on any failure. A missing or unreadable file is
  silently skipped; the index never crashes.

Greptile is retained as an optional upgrade — set `GREPTILE_API_KEY`
*and* instantiate `GreptileRepoGraph` directly. The factory no
longer defaults to it because (a) it's a hosted dependency and (b)
the user explicitly told us Greptile was an example.

The `LocalRepoGraph` (the v1.7 path-extraction fallback) is retained
for tests / callers that explicitly need "no graph, just regex on
the question". It is *not* the default.

---

## 4. Why we use EdenPatchAgent (not the OpenHands Cloud) by default

In v1.7.1 the user told us OpenHands is open source — install it
locally rather than paying for the cloud API. We built
**EdenPatchAgent** instead: a thin wrapper over Eden's existing
:class:`eden.code_change.patch_generator.PatchGenerator` +
:class:`eden.optimization.model_router.ModelRouter`.

The factory order is:

* **`EdenPatchAgent`** — the production default. Wraps
  :class:`PatchGenerator` (which already implements the critic
  loop + size cap + similarity dedup + quality floor) and
  :class:`ModelRouter` (which already implements tier
  selection — T2 for code generation, per the v1.6 ship
  plan). Calls are bounded by:
  * a per-call cost cap (default ``$0.50``, configurable),
  * a per-call wall-time cap (default ``120s``,
    ``asyncio.wait_for`` wrap),
  * cumulative per-instance cost tracking via
    :attr:`EdenPatchAgent.cost_used_usd`.
  Inspects the Cat 23 envelope: ``status="ok"`` → returns
  the diff; ``status="not_implemented"`` → ``report_only``.
  Promotes ``draft_pr`` → ``pr_ready`` when
  ``quality_score >= 0.85`` and the discipline decision
  allowed the PR.

* **`LocalCodingAgent`** — bulletproof fallback when the LLM
  is unreachable. Three layered implementations:

* **`OpenHandsLocalAgent`** — shells out to the OpenHands Python
  SDK / CLI via `subprocess.run` with a configurable timeout
  (default 60s). If `openhands` isn't installed, the cached
  availability probe returns `False` and we fall through. Cost:
  your marginal LLM cost (you point OpenHands at whatever model
  you have locally).
* **`ScriptedCodingAgent`** — stdlib-only deterministic patch
  generator. Uses `ast` + `re` + `difflib` to apply a small
  catalog of safe operations (`add_import`, `add_docstring`,
  `add_log_line`, `annotate_unhandled`). Cost: $0. Fast (ms).
* **Combined dispatcher** — tries OpenHands-local first, then
  scripted, then a structured `report_only` payload. **Never
  returns `None`.** Never raises. Cost-effective because the
  default path is the scripted agent; OpenHands-local only kicks
  in when the host actually has it installed.

When the LLM is unreachable, :class:`EdenPatchAgent` fails to
initialise and the factory falls through to :class:`LocalCodingAgent`
automatically — the agent layer is never down.

The OpenHands Cloud API + `OpenHandsPRAgent` is retained as an
optional upgrade — set `OPENHANDS_API_KEY` and instantiate
`OpenHandsPRAgent` directly.

The `LocalPRAgent` (v1.7's report-only fallback) is retained for
backward compatibility. It is *not* the default — the new default
is `EdenPatchAgent` (production) → `LocalCodingAgent` (fallback).

---

## 5. Why the existing Cat 23 scheduler stays the source of candidates

The brief says: "Eden uses agent data to identify issues". The
existing Cat 23 `scheduler.evaluate_pending_clusters` already
identifies candidate incidents from the Cat 2 `incident_clusters` table
+ the org's per-day cost / count caps. It is the *source of candidates*
in both flows:

* Incident flow: fed directly by an upstream incident detector (Cat 2
  + Cat 9 RCA + Cat 14 autonomous).
* Scheduled flow: fed by the scheduler's 15-min cron tick.

The discipline layer does not duplicate this logic. It wraps it.

---

## 6. Decision verdicts are explainable

Every `Decision` carries:

* `allowed: bool`
* `score: float` (0-1)
* `reasons: list[str]` (human-readable)
* `fingerprint: str` (stable dedupe key)
* `gate_policy: dict` (echoed for audit)

The `reasons` list is deliberately designed to be the answer to the
brief's question: "why was this PR created?" + "why was no PR created
in ambiguous cases?". For example:

* Allowed high-confidence: `["rca_confidence_high(0.90)", "quality_score_high(0.85)"]`
* Denied low-confidence: `["composite_below_threshold"]`
* Denied protected-path: `["protected_path_touched"]`

The portal's `DisciplineStateCard` (in the PR-suggestions page) renders
this state inline so the tester can see *why* Eden did or didn't act.

---

## 7. Storage: 3 new tables + 5 new columns

Migration `042_pr_discipline_layer.sql` adds:

| Table | Purpose | Notes |
|---|---|---|
| `pr_decision_audit` | Append-only audit trail of every discipline decision | One row per decision (allowed or denied or report_only) |
| `pr_dedupe_index` | Per-org short-window dedupe index | PK on `(org_id, fingerprint)` |
| `circuit_breaker_state` | Per-org per-breaker state | PK on `(org_id, breaker_name)` |

Plus 5 new columns on `repo_connections` to track graph index state:

| Column | Purpose |
|---|---|
| `graph_indexed` | True once the graph backend reports `status=indexed` |
| `graph_index_status` | `pending` / `indexed` / `failed` |
| `graph_latest_sha` | The most recent commit SHA the graph has indexed |
| `graph_indexed_at` | ISO-8601 timestamp |
| `graph_provider` | `symbol` / `greptile` / `local` |

All tables use `IF NOT EXISTS` so the migration is re-runnable.

---

## 8. Frontend: one API namespace + one existing card

The frontend changes are minimal:

* `clients/portal/src/lib/api.ts` gains `disciplineApi` (5 methods + 4 types).
* The existing `DisciplineStateCard` in `clients/portal/src/app/(portal)/pr-suggestions/page.tsx`
  (line 498) was already designed to call these endpoints; it now resolves
  against real backend routes.
* No new UI components were added (no bloated dashboards per the brief).

The `DisciplineStateCard` shows three cells: repo-graph status, breaker
state, rate-limit snapshot. The cells render independently via
`Promise.allSettled` so a partial backend failure shows what worked and
gracefully degrades for the rest.

---

## 9. Failure semantics — fail-open vs fail-closed

The discipline layer is intentionally **fail-open on DB outage for
the gate + breaker + dedupe**, and **fail-closed for the rate limiter**.

The reason: the rate limiter is the *hard cap* (per-day caps that
prevent over-spend). If the DB is down and the limiter fails open, a
postgres outage could let the system open hundreds of PRs in a short
window — a real operational noise problem.

The gate / breaker / dedupe failing open, by contrast, *still* default
to the conservative behaviour: the gate's default `min_confidence=0.65`
means most candidates are denied anyway. A DB outage that flips the
breaker to "no reading available" should *not* cause the system to
silently stop — the rate limiter is the backstop.

This is documented in the module docstrings of each file in
`src/eden/code_change/discipline/`.

---

## 10. Testing strategy

* **Unit tests** (78 new): every discipline / graph / agent /
  trigger function has a unit test that doesn't need a DB. The pure
  functions (confidence gate, fingerprint, prompt builder, diff
  extractor) are fully covered. The DB-touching functions are tested
  with fail-open / fail-closed assumptions only.
* **Integration tests** (existing, +34 from new route coverage): the
  app boots with all 738 routes; the read-only routes return the
  expected Cat 23 envelope shape.
* **Smoke tests** (this doc): high-confidence / low-confidence /
  protected-path / fingerprint-stability / graph-fallback / agent-fallback
  all run cleanly from the CLI.

What is *not* tested:

* Real Greptile API calls (needs `GREPTILE_API_KEY`).
* Real OpenHands API calls (needs `OPENHANDS_API_KEY` + a test repo).
* Long-running scheduled triggers against the full Cat 2 cluster table
  (needs a seeded Postgres).

These are documented as remaining risks in the audit report.

---

## 11. Open questions / future work

* **Plumb `max_prs` through the policy JSONB** instead of hard-coding
  it to 2.
* **Add admin UI buttons** for breaker-reset + index-request on the
  `DisciplineStateCard`.
* **Upgrade `EdenPatchAgent` → `OpenHandsPRAgent`** by setting
  `OPENHANDS_API_KEY` (the factory will fall through to the cloud
  backend automatically once both `EdenPatchAgent` and
  `LocalCodingAgent` fail to initialise).
* **Upgrade `SymbolGraph` → `GreptileRepoGraph`** by setting
  `GREPTILE_API_KEY` if hosted graph fidelity is required
  (single-file change in `graph/factory.py`).
* **Install the OpenHands CLI/SDK locally** to activate the
  `OpenHandsLocalAgent` branch inside `LocalCodingAgent`
  (currently falls through to the deterministic scripted
  agent).
* **Partition `pr_decision_audit`** when volume grows materially
  (currently unbounded).
