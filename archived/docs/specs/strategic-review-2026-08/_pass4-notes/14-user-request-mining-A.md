# Pass 4 notes — F14 (`features/14-user-request-mining.md`)

Reviewer note up front: F14, as written, is **not** a doc about an eden product
capability — its own "Scope discipline" line says so explicitly: *"this file
is market research — externally-validated user asks, not an eden build
plan."* Its actual content is a methodology-heavy sweep of competitor GitHub
issues (LangSmith, Langfuse, Arize Phoenix, Helicone) and HN threads,
re-pulled and re-verified pass-over-pass, used as demand evidence since eden
itself has zero real customers to mine yet. That framing is coherent and
mostly holds up under spot-check (see VERIFIED). But it means the doc never
once asks the question its own title promises — "what would *eden's own*
user-request-mining capability look like, and does eden already have
building blocks for it?" That question has a real, previously-undiscovered
answer in this codebase (see NEW FINDINGS), and the USER EXPERIENCE & VALUE
section below is built around it rather than around the competitor-research
frame, per the task brief.

---

## VERIFIED

Internal (eden) claims — all checked directly against source, not assumed:

- `docs/CHANGELOG.md:102` — exact text confirmed: *"Acceptable for **<50
  beta users**; revisit at 50+"* (row: "External monitoring
  (Sentry/Datadog/uptime)"). Commit `d14e13e832914cee6e70d48cf3a9a782b9e53326`,
  dated 2026-06-25, confirmed via `git log -1 -- docs/CHANGELOG.md` filtered
  for that hash — matches the doc's "last touched 2026-06-25" claim exactly.
- Billing-gate claim — the doc cites `routes/billing.py:6`; the real path is
  `src/eden/api/routes/billing.py` (doc's own inconsistency, inherited from
  `CHANGELOG.md`'s table, not introduced by F14). Line 6 of the real file
  reads `**Free-only mode (June 2026).** All Stripe-backed endpoints return`
  — text matches the doc's paraphrase exactly.
- `src/eden/llmops/promotion.py:253` — `_promote`'s docstring literally
  reads *"Promote the canary to 100% traffic and audit-log."* and calls
  `log_audit_event` (imported from `eden.api.deps`) at `promotion.py:287-288`
  on promote and `:330-331` on rollback — confirms F14 §8's claim that the
  backend "already computes and audit-logs per `promotion.py`'s
  `log_audit_event`."
- `clients/portal/src/lab/playgrounds/playground-editor.tsx` — grepped for
  `image|multimodal|base64|<img`, zero matches. Confirms F14 §5's claim that
  eden's playground editor has no image/media handling, independent of the
  trace-viewer gap found in prior passes.
- `docs/specs/strategic-review-2026-08/optimizations/04-frontend-perf.md` —
  the unvirtualized issues-kanban (`issues-client.tsx:694-709`) and
  session-turn timeline (`traces-session-lens.tsx:312,320`) findings F14 §2
  references are real and independently documented at file:line precision in
  that doc.
- LangSmith changelog (Jul 13–17 2026 entry) — re-fetched directly;
  confirms near-verbatim the two quotes F14 attributes to it (deferred
  payload/diff rendering; truncated text + base64-image thumbnails on
  dataset/experiment tables).
- Spot-checked three external citations directly (not just trusting F14's
  paraphrase): `Helicone/helicone#5658` (self-hosted redirect to
  `us.helicone.ai`, filed 2026-04-17, open, bug label — matches), `Arize-ai/
  phoenix#10699` ("Phoenix slow," filed 2025-12-18, self-hosted v12.20.0,
  open — matches, though the live page shows no comment count that would
  confirm F14's stated "8 comments, last updated 2026-07-19" figure one way
  or the other from what WebFetch surfaced), and HN item `48908950` (Launch
  HN: Agnost AI, 85 points / 52 comments, `lnenad`'s "$500 for semantic
  analysis" quote — matches verbatim). All three check out on the load-bearing
  text; no fabricated quotes found in the sample.

## CUT

1. **Quote:** *"the gap the Arize `#7031` framing adds a specific, second
   surface to check... eden's playground's span-replay path
   (`create_from_span`, §2c of `03-prompt-playground.md`)"* (F14 §5,
   "Eden cross-check, sharpened this pass").
   **Reason:** Both the function name and the section reference are wrong.
   The real function is `from_span` (`src/eden/playground/service.py:210`),
   exposed via the route `playground_from_span`
   (`src/eden/api/routes/playgrounds.py:106`) — there is no `create_from_span`
   anywhere in the codebase (grepped `from_span|span_replay|span-replay`
   across `src/eden/`, only hits are `from_span`/`playground_from_span`).
   Worse, `03-prompt-playground.md` has **no lettered subsections at all** —
   its headings are plain `## 1.` through `## 5.` (confirmed via `grep -n
   "^##"`); there is no "§2c" and the word "span" does not appear anywhere
   in that file (`grep -in "span"` returns zero matches). This citation
   should be corrected to `from_span` / `playground/service.py:210` with no
   section-letter reference, or cut.

2. **Quote:** *"`PromotionLoop` can auto-promote it to 100% traffic via a
   statistical/Bayesian gate with zero human click required end-to-end when
   enabled"* (F14 §8, "Why this matters directly for eden").
   **Reason:** Directly contradicted by the source file's own module
   docstring. `src/eden/llmops/promotion.py:15-18`: *"The math is
   deliberately simple. **No Bayesian bandit, no Thompson sampling, no
   multi-armed-bandit.** Just plain counters and clear thresholds."* The
   gate is a fixed-threshold check (30+ calls minimum, ≥5% absolute
   success-rate lift, ≤10% latency regression, judge score must hold —
   `promotion.py:5-9`), not a Bayesian statistical gate. "Zero human click
   required end-to-end when enabled" is accurate (confirmed via `_promote`/
   `_evaluate_one` control flow), but "Bayesian gate" should be struck or
   corrected to "fixed-threshold gate."

3. **Quote:** *"the evidence favors surfacing the evolver's candidate diff,
   the live control-vs-candidate stats, and an explicit human-visible
   promote/rollback trail... — this is market evidence for the 'why,' not a
   redesign — `03-prompt-playground.md`'s own recommendation #1 already
   scopes the UI build."* (F14 §8).
   **Reason (soften, don't fully cut):** `03-prompt-playground.md` §5 lists
   three numbered UI recommendations; recommendation **#1 is specifically
   the global kill switch** (`docs/specs/.../03-prompt-playground.md:274-282`),
   not the candidate-diff/stats surface — that's recommendations #2 (Active
   evolutions table, degraded-agent stats) and #3 (Canary status table,
   control-vs-candidate lift/latency/evidence-gate). More importantly, the
   word "diff" never appears in `03-prompt-playground.md` at all (grepped) —
   the §5 spec proposes showing **version numbers and aggregate stats**
   (traffic %, success-rate lift, latency ratio), not an actual prompt-text
   diff view. F14's synthesis oversells what the referenced spec covers;
   "candidate diff" is F14's own addition, not something `03`'s existing
   recommendation already scopes. Recommend rewording to "recommendations
   #2–3" and dropping "candidate diff" (or flagging it as F14's own net-new
   proposal, not an existing scope pointer).

No claims were pruned as pure filler/redundant-with-another-feature-doc —
F14's overlap-check against `13-continuous-improvement-loop.md` (§ "Overlap
check") is proportionate and doesn't duplicate content found elsewhere in
the review set, aside from the miss noted in NEW FINDINGS below.

## USER EXPERIENCE & VALUE

**Who is the user, really.** F14's own framing treats "the user" as eden's
internal PM/founder mining *other vendors'* complaints because eden has no
paying customers to mine yet. That's a legitimate lens for a market-research
doc, but it sidesteps the more direct, product-shaped question the doc's
title implies: **if/when eden has real customers, does eden's own product
give *them* a way to mine what *their* end users are asking for from real
LLM-app traffic?** That's a distinct, answerable question, and it turns out
eden already has non-trivial backend infrastructure for it (see NEW
FINDINGS) — which F14 never discovers or cross-references, despite it being
the single closest-matching subsystem to this doc's own title anywhere in
the 63-directory `src/eden/` tree.

Two real user personas for that product-shaped capability, once eden has
customers:
- **A PM at an eden customer**, trying to answer "what are our users
  actually asking our agent to do, and is that shifting week over week?" —
  wants trending topic/task clusters, not raw traces.
- **A support/CS lead**, trying to answer "what's the most common thing
  people are stuck on right now?" — wants dedup'd, ranked, exportable
  clusters they can hand to a roadmap tool without reading 500 transcripts.

**The flow today, traced at file:line.** eden already has the beginning of
this, entirely backend/API, with no portal surface:
1. `POST /orgs/{org_id}/topics/generate` (`src/eden/api/routes/topics.py:44-53`)
   → `generate_topics()` (`src/eden/topics/service.py:147-153`) → calls
   `PatternsClusterer.run_once()` (`src/eden/observability/patterns_clusterer.py`),
   which embeds the last `patterns_clusterer_lookback_days` (default 7,
   `config.py:1524`) of request messages with `OpenAIEmbedder`/
   `SentenceTransformerEmbedder`, clusters with **HDBSCAN**, LLM-labels each
   cluster, and persists to `trace_patterns` (min cluster size 20,
   `config.py:1525`).
2. `_sync_patterns_to_topics()` (`topics/service.py:156-212`) mirrors the
   top 50 `trace_patterns` rows (by `sample_count`) into `topic_clusters`,
   computing `share_pct` as each cluster's fraction of the synced total.
3. `GET /orgs/{org_id}/topics?facet=task|sentiment|issues|custom`
   (`topics.py:35-42`) lists them back — name, keywords, sample_count,
   share_pct, representative_trace_ids.
4. `POST /orgs/{org_id}/topics/{topic_id}/act` with `action=dataset`
   (`topics/service.py:214-260`) bridges up to 100 representative traces
   from a topic into a new `DatasetHub` dataset — a genuinely useful,
   working "turn this cluster into something actionable" step.

**Where that flow breaks down as a real "what are users asking for" tool:**
- **No portal UI at all.** Grepped `clients/portal/src` for `topics` and
  `patterns` (case-insensitive) across every `.tsx` file — zero matches for
  either. A PM or support lead has to call the raw API (or write SQL against
  `topic_clusters`/`trace_patterns`) to see anything. This is a bigger gap
  than the "no portal UI" complaint F14 §8 raises about the prompt-evolution
  loop, and it's directly on-theme for this doc's title, yet F14 never finds
  it.
- **No scheduling — on-demand only.** `generate_topics` is called from
  exactly one place in the entire codebase: the `POST .../topics/generate`
  route (confirmed via `grep -rn "generate_topics\b" src/eden/`). There is
  no cron/worker/lifespan wiring that runs it automatically — contradicting
  `patterns_clusterer.py`'s own module docstring, which claims *"The
  clusterer runs as a background job (the FastAPI lifespan starts it...)"*.
  In practice, nothing surfaces new topics unless someone (or some other
  service) explicitly calls the generate endpoint.
- **No trending.** `share_pct` is a snapshot computed fresh each time
  `generate_topics` runs (`sum(...)  / total`, `topics/service.py:163`) —
  there's no comparison against the previous run's numbers, no "up 40% this
  week" signal. A PM asking "is this getting worse" has nothing to look at
  except manually diffing two API calls.
- **No dedup across runs.** Each call to `generate_topics` inserts **new**
  `topic_clusters` rows with a fresh `uuid4()` id (`topics/service.py:187`),
  `ON CONFLICT (id) DO NOTHING` — which never fires, since the id is always
  novel. There is no merge/upsert keyed on `pattern_id` or embedding
  similarity before insert, and `list_topics` filters only on `status =
  'active'` with no de-duplication step. Running `generate_topics` twice
  against the same traffic window would leave two "active" rows referencing
  the same underlying `trace_patterns` cluster, both shown side by side.
  (This is a code-level inference from the insert/read paths, not a
  DB-observed duplicate — no live data was queried.)
- **No export to a roadmap tool.** `act_on_topic`'s only real action is
  `dataset` (feeds eden's own eval-dataset system). The other declared
  action, `alert`, is a stub: `if action != "dataset": return {"action":
  action, "topic_id": topic_id, "status": "queued"}`
  (`topics/service.py:222-223`) — it does nothing beyond echoing "queued."
  There is no Linear/Jira/GitHub-Issues export path anywhere in this
  pipeline.

**What a genuinely useful version looks like** (concrete, scoped to what's
already 70% built):
1. A `/orgs/{org}/topics` portal page — facet tabs (task/sentiment/issues),
   one card per topic with name, keywords, sample count, and a trend
   sparkline. This needs a *time-series* topic-cluster table (snapshot
   share_pct per run, keyed by `pattern_id` + `generated_at`) rather than
   today's flat "active rows" model — a real schema/data-model change, not
   just a frontend build.
2. Schedule `generate_topics` as a recurring worker (same pattern as
   `PromotionLoop`'s `_loop_body` tick) instead of leaving it API-only, so
   topics stay current without a manual trigger.
3. Dedup on insert: before inserting a new `topic_clusters` row, check for
   an existing active row with the same `pattern_id` (or embedding-cosine
   above a threshold) in the current window and update-in-place rather than
   append, so the portal list doesn't accumulate near-duplicates run over
   run.
4. Wire `action=alert` for real (today it's a stub returning "queued" with
   no downstream effect) and add a `action=export` that pushes the topic
   (name, description, sample traces, share_pct trend) to a roadmap tool —
   Linear/Jira/GitHub Issues — as a single API call, mirroring the
   already-working `action=dataset` bridge pattern.
5. Cross-reference this against `01-competitor-matrix.md`, which already
   independently verified this exact subsystem against Braintrust's "Topics"
   feature and flagged it "Partial" with the same `alert`-stub and
   top-50-mirror gaps (see NEW FINDINGS) — that comparison, not fresh
   competitor GitHub-issue mining, is the more relevant "is this good
   enough" bar for this specific capability.

## NEW FINDINGS

1. **eden already has a real backend pipeline for exactly what this doc's
   title describes, and F14 never finds or mentions it.** `src/eden/topics/`
   (F65 "Topics / insights clustering service," `topics/service.py:1`) +
   `src/eden/observability/patterns_clusterer.py` ("Datadog-style Patterns
   clusterer," Phase 7.2 C5) together: read recent telemetry request
   messages → embed → **HDBSCAN cluster** → LLM-label → persist to
   `trace_patterns` → mirror top-50 into `topic_clusters` with
   task/sentiment/issues/custom facets, keywords, and representative trace
   IDs, plus a working bridge to create an eval dataset from a cluster
   (`act_on_topic`, `topics/service.py:214-260`). This is a materially
   better foundation for "what are users asking for" than anything discussed
   in F14, which is entirely about *other vendors'* users' GitHub complaints.
   Given the task brief's explicit instruction to check `insights/`,
   `topics/`, `signals/` before trusting any "eden lacks X" framing, this is
   the single most important miss in F14: the doc's implicit framing (eden
   has nothing of its own to mine, only competitor signal) is not fully
   accurate at the *code* level, even though it's accurate at the *customer
   traffic* level (eden has ~0 real users, so there's nothing live to mine
   yet with this pipeline).

2. **This exact subsystem is already independently verified, in more depth,
   in `01-competitor-matrix.md`.** Grepped the full features/ set:
   `01-competitor-matrix.md:374-387,480,521,627` documents `topics/
   service.py` at file:line precision, benchmarks it directly against
   Braintrust's 2026 "Topics" feature (their words: "headline 2026
   feature"), and independently flags the same two gaps surfaced above —
   `generate_topics` mirrors the top-50 `trace_patterns` rather than running
   an independent fresh per-trace LLM pass, and `action="alert"` is a no-op
   stub (`service.py:226-227` per that doc's line numbers). F14's own
   stated scope-discipline rule — *"where a finding maps cleanly to an
   existing eden review doc, that's noted for the reader, not resolved
   here"* — should have applied to this, but F14 never runs into `topics/`
   at all because its search strategy (GitHub API + HN + changelogs) never
   points back at eden's own code except for the two spot-checks in §0 and
   §8. Recommend F14 add a one-line pointer to `01-competitor-matrix.md`'s
   F65 findings, since a reader landing on "user request mining" would
   reasonably expect that cross-reference.

3. **`patterns_clusterer.py`'s own docstring is stale/aspirational.** It
   claims *"The clusterer runs as a background job (the FastAPI lifespan
   starts it...)"* and that *"the portal's Patterns page can show it as 🟡
   partial or 🔴 no coverage."* Neither is true today: `get_patterns_clusterer`
   is only ever called from `topics/service.py:generate_topics`, itself only
   reachable via the on-demand `POST .../topics/generate` route (no
   lifespan/cron wiring found anywhere in `src/eden/api/app.py` or
   elsewhere); and grepping `clients/portal/src/**/*.tsx` for `patterns`
   (case-insensitive) returns zero files — no Patterns page exists in the
   portal. This is a docstring/reality gap worth flagging separately from
   F14 (it belongs more naturally in a code-quality or portal-gap doc), but
   it's directly relevant context for anyone reading F14's premise that
   eden has "zero" of its own request-mining machinery.

4. Two citation errors in F14 §8 (documented above under CUT #1–#2) —
   a fabricated section reference (`§2c`) and function name
   (`create_from_span`, real name `from_span`) that don't exist in
   `03-prompt-playground.md`, and a "Bayesian gate" characterization that
   directly contradicts `promotion.py`'s own docstring disclaiming Bayesian
   methods. Both are corrections to an otherwise well-sourced cross-check
   paragraph, not indictments of the doc's external research (which held up
   well on spot-check — see VERIFIED).
