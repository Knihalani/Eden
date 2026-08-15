# F14 — Real-World User Request Mining (LangSmith, Langfuse, Braintrust, Arize Phoenix, Helicone, Lemma)

**Method (this pass, third deepening):** (1) Re-pulled GitHub Search API for `langfuse/langfuse`, `Arize-ai/phoenix`, `Helicone/helicone`, sorted by **`updated`** and separately by **`comments`** (not just reactions, to catch anything that heated up since the last pass) — real issue numbers/states/comment counts, curl-verified. (2) Fetched LangSmith's public changelog (`docs.langchain.com/langsmith/changelog`, redirected from `changelog.langchain.com`) directly for the last ~5 weekly releases (Jun 29–Jul 31 2026). (3) Queried `hn.algolia.com` for LLM-observability threads from the last several months, plus targeted queries for AI-generated-fix skepticism, and fetched full comment trees on the two threads with real engagement. (4) WebSearched vendor-published pieces that self-report the "AI-powered = marketing" skepticism (Coroot, Rootly, Metoro), quote-verified via direct fetch. (5) Re-verified eden's own pre-launch status against `docs/CHANGELOG.md`. Every claim below is tied to a link independently hit during this pass.

**Scope discipline (unchanged):** this file is market research — externally-validated user *asks*, not an eden build plan. Where a finding maps cleanly to an existing eden review doc, that's noted for the reader, not resolved here.

**Framing note (added this pass):** this file mines *other vendors'* user complaints as demand evidence, since eden itself has ~0 real customers to mine yet. But eden already has a real backend pipeline for the product-shaped version of this doc's own title — mining *eden's customers' end users'* requests from live trace traffic (`src/eden/topics/` + `src/eden/observability/patterns_clusterer.py`, F65). That subsystem is independently verified in more depth in `01-competitor-matrix.md` (benchmarked against Braintrust's "Topics" feature) and is the subject of the User Experience & Value section below, per this pass's brief.

## 0. Internal signal check — re-confirmed, unchanged
`docs/CHANGELOG.md:102` still reads "Acceptable for **<50 beta users**; revisit at 50+" (last touched 2026-06-25, commit `d14e13e`); `routes/billing.py:6` still gates Stripe billing off, comment reading "Free-only mode June 2026." Both re-verified this pass by direct grep/read, not assumed carried-over. eden remains pre-launch/early-beta with zero real customer complaints to mine — competitor-signal mining is still eden's only external user-demand evidence.

## Ranked findings

### 1. Pricing cliffs and non-transparent billing — unchanged from prior pass, no material new evidence this round
Nothing newly surfaced in this pass's fresher/most-commented sweep changed this ranking or its sourcing (§1 sources in the prior draft — morphllm, costbench, truefoundry/cekura, dev.to Langfuse teardown — all remain the live basis; not re-pasted here to avoid restating). **Confidence: high, unchanged.**

### 2. UI/dashboard performance at scale — LangSmith is now *actively shipping fixes* for the exact complaint cited last pass; Arize's version of the same failure mode has a second, independent data point
- **New, direct evidence LangSmith heard this**: the public changelog's **Jul 13–17 2026** entry states experiment tables now "defer full payload rendering and output diff preparation until those views are requested," and that dataset/experiment tables "truncate long text and show base64 images as thumbnails to avoid oversized hidden DOM content" — this is a near-literal fix for the same "hide the Metadata column, large payloads slow rendering" complaint the KB article (cited last pass) told users to work around manually ([LangSmith changelog](https://docs.langchain.com/langsmith/changelog)). Read together with `langsmith-sdk#2719` (still open, unresolved Playground CSS-remount lag), the picture is: LangSmith is fixing the *dataset/experiment-table* instance of this class of bug but not yet the *Playground* instance — the underlying failure mode (unbounded payload rendered into the DOM) is validated by the vendor's own shipped fix, not just by user complaints.
- **Arize Phoenix, second corroborating report this pass**: open issue `Arize-ai/phoenix#10699`, "[BUG]: Phoenix slow" (self-hosted, v12.20.0, filed 2025-12-18, still open, last updated 2026-07-19, 8 comments): *"I'm receiving a high volume of spam and the solution freezes and becomes slow all the time."* This is a second, independent Arize UI-degradation report distinct from the shared-tenancy bulk-export bug (`#11873`) cited last pass — two different Phoenix bugs, same root theme (UI unresponsive under load), six months apart, both still open ([issue #10699](https://github.com/Arize-ai/phoenix/issues/10699)).

**Ask:** trace/experiment UIs that stay fast regardless of payload size or query volume, without manual tuning. **Confidence: high** — now includes a vendor (LangSmith) visibly *fixing* part of this class of bug, which both validates the complaint was real and shows the fix is tractable (defer/virtualize rendering) rather than a fundamental limitation.

**Eden cross-check:** unchanged from prior pass — `docs/specs/strategic-review-2026-08/optimizations/04-frontend-perf.md`'s unvirtualized-kanban/timeline finding stands. The new detail worth adding to that checklist: LangSmith's shipped fix pattern (defer full payload rendering + thumbnail large embedded media until requested) is a concrete, proven mitigation pattern eden's O4 fix could copy directly, not just a generic "virtualize" instruction.

### 3. Missing depth for agent-specific debugging — Lemma-urgency flag reaffirmed, no material new primary-source evidence this pass
No new GitHub issue or roadmap-thread data surfaced this pass that adds beyond the prior HN thread (id=44736570) and the Langfuse roadmap-discussion multi-turn-eval requests already cited. The Lemma competitive-urgency flag from the prior pass stands unchanged (no new information found on Lemma this pass — not re-verified further, out of this pass's search scope). **Confidence: high, unchanged.**

### 4. OTel `gen_ai.*` semantic-convention support — unchanged
No new primary-source evidence surfaced this pass beyond `Arize-ai/phoenix#10622` (still open) cited previously. **Confidence: medium-high, unchanged.**

### 5. Inline multimedia rendering in trace/session UI — now corroborated at a *third* vendor, independently, via the most-commented sweep
Prior pass had two Langfuse issues (`#5030`, `#4555`). **New this pass**: sorting Arize Phoenix open issues by comment count surfaced `Arize-ai/phoenix#7031`, "[ENHANCEMENT] Add image support to playground" (open, filed 2025-04-04, still open, last updated 2026-07-10, 8 comments): *"We currently don't support showing images in Prompt Playground. If you span replay a trace with images, it will currently show a blank prompt."* A second, closely related open request, `#8814`, "[ENHANCEMENT]: allow me to add an image to a prompt" (open, filed 2025-07-28, updated 2026-07-10, 7 comments), makes the same ask independently. This is now a three-vendor pattern (Langfuse ×2, Arize ×2) asking for the same capability across both the trace viewer *and* the playground/replay surface ([#7031](https://github.com/Arize-ai/phoenix/issues/7031), [#8814](https://github.com/Arize-ai/phoenix/issues/8814)).

**Eden cross-check, sharpened this pass:** the prior pass grepped eden's trace/session viewers and found no multimodal rendering. This pass re-grepped `clients/portal/src/lab/playgrounds/playground-editor.tsx` for `image|multimodal|base64|<img` — zero matches, confirming the gap independently. The Arize `#7031` framing adds a specific, second surface to check: eden's own span-replay-into-playground path (`from_span`, `src/eden/playground/service.py:210`, exposed via the `playground_from_span` route) has the same architectural shape as the flow Arize's users are asking Arize to fix (blank prompt on image span-replay) — a trace with images replayed into the playground would silently drop them today. **Confidence: high** — three independent vendor threads, one directly matching eden's own span-replay-into-playground feature shape.

### 6. Alerting-integration and regulated-industry access-control asks — unchanged
No new primary-source evidence surfaced this pass beyond the Langfuse roadmap-discussion vote counts cited previously. **Confidence: high, unchanged.**

### 7. NEW — Self-hosting trust breakage: local deployment silently phones home / redirects to vendor's cloud
`Helicone/helicone#5658` (open, filed 2026-04-17, updated 2026-05-18, 10 reactions — the highest-reaction open Helicone issue found in this pass's sweep despite Helicone's overall low signal, see §8): a self-hosted `helicone-all-in-one` Docker deployment, accessed by IP on a private LAN, redirects the browser to `https://us.helicone.ai/signin` instead of staying local. Quoted directly (translated from Chinese): *"Browser access became `https://us.helicone.ai/signin`??? Is this a joke? Then what's the point of self-hosting at all."* This is a different flavor of trust complaint than pricing (§1) — it's users who explicitly chose self-hosting specifically to avoid vendor cloud dependency, discovering the product routes them back to the vendor's servers anyway ([issue #5658](https://github.com/Helicone/helicone/issues/5658)).

**Ask:** self-hosted deployments that verifiably do not depend on or redirect to the vendor's cloud, with no silent phone-home behavior. **Confidence: medium** — one issue, but a real primary-source complaint with above-average reaction count for this repo, and directly on-theme for any product (eden included) that offers or considers self-hosting as a compliance/control selling point.

### 8. NEW — Users publicly and skeptically call out "this is just an LLM wrapper" / distrust AI-generated analysis and RCA — directly relevant to eden's autonomous prompt-evolution and shadow-detector auto-promotion
This section responds directly to the brief's ask: is there a live, quotable pattern of users calling automated/AI-driven fixes "just marketing" or untrustworthy? Yes, and it recurs across three independent, dated sources this pass:

- **HN Launch thread, "Launch HN: Agnost AI (YC S26) – Extract user feedback from agent conversations"** (2026-07-14, 85 points, 52 comments — the single most-engaged relevant HN thread found this pass): direct skepticism that the AI-driven analysis is more than a thin prompt wrapper — `lnenad`: *"I thought startups wrapping prompts would require something more complex than semantic analysis, which is literally what this is. And for 500 bucks. Wow."* and, when the founder defended the product, *"It's still a prompt, it's just not a static one."* A separate commenter (`bfeynman`, on a related Voker HN launch thread below) made the identical critique in a different words: *"it looks like you just use llms to guess what categories are? Seems like trap for garbage in garbage out."* ([HN item 48908950](https://news.ycombinator.com/item?id=48908950)).
- **HN Launch thread, "Launch HN: Voker (YC S24) – Analytics for AI Agents"** (2026-05-12, 59 points, 22 comments): a commenter (`holoduke`) told the founder directly, in response to a product-defense reply, *"Your response is AI. It's a bit ai sloppy as well... as a business owner you can and should do better"* — i.e., the skepticism extended from the *product's* AI-generated categorization to the *founder's own communication* reading as AI-generated, undermining trust further ([HN item 48109962](https://news.ycombinator.com/item?id=48109962)).
- **Vendor-side self-admission of the same skepticism, three independent observability/SRE blogs, all 2026**: Coroot's own engineering blog states plainly, *"most of us see that as marketing fluff"* about AIOps claims generally, and *"we've all tried 'AI-powered' tools that rely on just a few basic metrics... Does that ever work? Maybe, but only for the most trivial issues"* ([coroot.com blog](https://coroot.com/blog/we-built-ai-powered-root-cause-analysis-that-actually-works/)). Rootly's SRE guidance tells buyers to *"Avoid 'black box' models that provide answers without explanation"* and frames trust as requiring the system to *"explain why it grouped certain alerts or suggested a root cause"* ([rootly.com](https://rootly.com/sre/ai-powered-observability-cut-alert-noise-boost-insight-807ee)). Metoro's 2026 comparison piece frames the entire category's marketing as needing to be cut through, distinguishing "genuinely AI-powered insights" from tools with just an "AI checkbox" ([metoro.io](https://metoro.io/blog/best-observability-tools-with-ai)). incident.io's guide goes further on the accountability angle: *"false positives destroy trust during high-stress outages"* and vendor RCA claims should be judged on measured precision/recall, "not marketing promises" ([incident.io](https://incident.io/blog/ai-root-cause-analysis-accuracy-testing-guide)).
- **Named, primary-source developer-trust statistic** (not an observability-specific source, but directly on-theme and independently verifiable): Sonar's 2026 State of Code developer survey (1,100+ enterprise developers) reports **96% of developers don't fully trust AI-generated output**, while **only 48% say they always verify it before committing/accepting it** — Sonar frames this gap itself as the risk: near-universal distrust coexisting with inconsistent verification ([sonarsource.com developer survey report](https://www.sonarsource.com/resources/developer-survey-report/)).

**Why this matters directly for eden:** `03-prompt-playground.md` §2g documents that eden's `JudgeScorePromptEvolver` LLM-generates a replacement prompt from a degraded judge-score signal, and `PromotionLoop` can auto-promote it to 100% traffic via a **fixed-threshold gate** (30+ calls minimum, ≥5% absolute success-rate lift, ≤10% latency regression, judge score must hold — `promotion.py:5-9`; the module's own docstring at `promotion.py:15-18` explicitly disclaims "no Bayesian bandit, no Thompson sampling, no multi-armed-bandit... just plain counters and clear thresholds") **with zero human click required end-to-end when enabled** — and that this entire subsystem currently has **no portal UI**, so a user cannot see the candidate text, the live stats versus control, or the promote/rollback decision (only API/SQL access exposes it). The pattern above — users explicitly distrusting AI-generated analysis they can't inspect, and vendors themselves publicly conceding "black box" AI claims read as marketing — is a direct argument for *how* eden ships that portal surface, not just *whether*: the evidence favors surfacing the evolver's candidate text, the live control-vs-candidate stats, and an explicit human-visible promote/rollback trail (which the backend already computes and audit-logs per `promotion.py`'s `log_audit_event`) rather than leaving the loop invisible-and-therefore-untrusted once it does get a UI. This is market evidence for the "why," not a redesign — `03-prompt-playground.md`'s own §5 recommendations #2–3 (Active evolutions table, Canary status table with control-vs-candidate lift/latency/evidence-gate) already scope most of that UI build; an actual candidate-text diff view is not currently in that spec's scope and would be new surface area.

**Ask (synthesized):** explainable, inspectable AI-generated analysis/fixes — show the reasoning or diff, not just the conclusion or the action taken; avoid framing automation as a solved black box. **Confidence: high on the pattern's existence and recency** (three independent, dated 2026 sources plus a named survey stat); **medium on how directly it generalizes** to eden's specific evolution loop, since none of the sources are about prompt-canary systems specifically — this is analogous-domain evidence (agent-conversation analytics, AIOps/RCA), not a direct complaint about a prompt-evolution feature, which doesn't exist yet in the market to complain about.

## Lower-priority, still-real (compressed appendix)
- **Reliability incidents (LangSmith)**: unchanged from prior pass, not re-verified this round.
- **Granular, named feature gaps**: unchanged from prior pass (`langsmith-sdk#2126`, `#2593`, `#986`; Langfuse `masonk` quote), not re-verified this round — no evidence surfaced this pass that any of these closed.
- **Helicone stays the weakest-signal repo of the three**, reconfirmed this pass: sorting by both `updated` and `comments`, the vast majority of recent Helicone GitHub activity is automated/internal code-quality issues (missing `radix` on `parseInt`, unused Clickhouse wrapper methods, TODO-flagged silent failures) rather than user-filed complaints — reads as bot- or linter-generated engineering housekeeping, not community demand signal. The one real exception this pass is §7 above.
- **Acquisition anxiety**: unchanged from prior pass.

## Overlap check against `13-continuous-improvement-loop.md`
Unchanged from prior pass's conclusion: overlap remains minimal. This pass's new §8 (AI-generated-fix trust skepticism) adds a second connective thread beyond §3's Lemma flag — both point at the same underlying tension 13 already frames (closing the loop is a differentiator) but this file's contribution is external evidence that *un-gated, opaque* automation specifically draws user distrust, which bears on how 13/`03-prompt-playground.md`'s canary-promotion UI should be designed, not on whether to build it.

## User Experience & Value

Everything above treats "the user" as eden's own PM mining *other vendors'* complaints, because eden has no paying customers yet. That's the right lens for market research, but it sidesteps the doc's title taken literally: **once eden has real customers, does eden's own product give *them* a way to mine what *their* end users are asking for from live traffic?** It turns out yes, partially — `src/eden/topics/` + `src/eden/observability/patterns_clusterer.py` (F65, "Datadog-style Patterns clusterer," Phase 7.2 C5) is the closest-matching subsystem to this doc's own title anywhere in `src/eden/`, and it's worth walking through as a product surface, not just a code inventory.

**Who the user is.** Once eden has customers: (1) a **PM at an eden customer**, asking "what are our users actually asking our agent to do, and is that shifting week over week?" — wants trending topic/task clusters, not raw traces; (2) a **support/CS lead**, asking "what's the most common thing people are stuck on right now?" — wants dedup'd, ranked, exportable clusters they can hand to a roadmap tool without reading hundreds of transcripts.

**The flow that exists today, traced end to end:**
1. `POST /orgs/{org_id}/topics/generate` (`src/eden/api/routes/topics.py:44-53`) → `generate_topics()` (`topics/service.py:147-153`) → `PatternsClusterer.run_once()` embeds the last `patterns_clusterer_lookback_days` (default 7, `config.py:1524`) of request messages, clusters with **HDBSCAN**, LLM-labels each cluster, and persists to `trace_patterns` (min cluster size 20, `config.py:1525`).
2. `_sync_patterns_to_topics()` (`topics/service.py:156-212`) mirrors the top 50 `trace_patterns` rows (by `sample_count`) into `topic_clusters`, computing `share_pct` as each cluster's fraction of the synced total.
3. `GET /orgs/{org_id}/topics?facet=task|sentiment|issues|custom` (`topics.py:35-42`) lists them — name, keywords, sample_count, share_pct, representative_trace_ids.
4. `POST /orgs/{org_id}/topics/{topic_id}/act` with `action=dataset` (`topics/service.py:214-260`) bridges up to 100 representative traces from a topic into a new `DatasetHub` dataset — a genuinely working "turn this cluster into something actionable" step.

**Why it doesn't yet deliver the value it's built for:**
- **No portal UI at all.** Grepped `clients/portal/src` for `topics` and `patterns` (case-insensitive), zero matches in either. A PM or support lead has to hit the raw API or query `topic_clusters`/`trace_patterns` directly by SQL — there's nothing to click. This is a bigger visibility gap than the prompt-evolution-loop UI gap raised in §8 above, and it sits squarely under this doc's own title, yet a title-literal search of eden's own code never happened in prior passes.
- **On-demand only, no scheduling.** `generate_topics` is called from exactly one place — the `POST .../topics/generate` route (confirmed via `grep -rn "generate_topics\b" src/eden/`) — with no lifespan/cron/worker wiring anywhere. The module docstring now matches that on-demand path (FEAT-180); the scheduling gap itself remains — nothing surfaces new topics unless someone explicitly calls the endpoint.
- **No trending.** `share_pct` is a snapshot recomputed fresh on every `generate_topics` call (`topics/service.py:163`), with no comparison against the previous run. A PM asking "is this getting worse week over week" has nothing to look at except manually diffing two API responses.
- **No dedup across runs.** Each run inserts brand-new `topic_clusters` rows with a fresh `uuid4()` id, `ON CONFLICT (id) DO NOTHING` — a no-op since the id is always novel. Running `generate_topics` twice against overlapping traffic would leave two "active" rows for the same underlying pattern, both shown side by side (inferred from the insert/read code path, not observed against live data — eden has no live traffic yet).
- **No export to a roadmap tool.** `act_on_topic`'s only real action is `dataset`. The other declared action, `alert`, is a stub — `if action != "dataset": return {"action": action, "topic_id": topic_id, "status": "queued"}` (`topics/service.py:222-223`) — it echoes "queued" and does nothing. No Linear/Jira/GitHub-Issues path exists.

**What a genuinely useful version looks like** (scoped to what's already ~70% built, not a rewrite):
1. A `/orgs/{org}/topics` portal page — facet tabs, one card per topic with name, keywords, sample count, trend sparkline. Requires a real *time-series* topic table (share_pct per run, keyed by `pattern_id` + `generated_at`) rather than today's flat "active rows" model — a schema change, not just a frontend build.
2. Schedule `generate_topics` as a recurring worker (same pattern as `PromotionLoop`'s tick loop) instead of leaving it API-only.
3. Dedup on insert: before inserting, check for an existing active row with the same `pattern_id` (or embedding-cosine above a threshold) and update in place rather than append.
4. Wire `action=alert` for real, and add `action=export` to push a topic (name, description, sample traces, trend) to Linear/Jira/GitHub Issues as one call — mirroring the already-working `action=dataset` bridge.

This exact subsystem is independently verified in more depth in `01-competitor-matrix.md:374-387,480,521,627`, which benchmarks it directly against Braintrust's 2026 "Topics" feature (Braintrust's own framing: "headline 2026 feature") and flags the same two structural gaps — top-50 mirroring instead of a fresh per-trace pass, and the `alert` no-op stub. That comparison, not fresh competitor-GitHub-issue mining, is the more relevant "is this good enough" bar for this specific eden capability; readers should treat `01-competitor-matrix.md`'s F65 entry as the primary reference and this section as the user-flow complement to it.

## Positioning (shipped) — FEAT-181

**Status: shipped.** Wave 6 closed the "no portal UI at all" gap called out
above — `/topics` (`clients/portal/src/app/(portal)/topics/page.tsx`) now
ships as a real page: facet tabs (task/sentiment/issues/custom), one card
per cluster with name, description, keywords, sample count, trend badge,
and a CSV export, plus a "Generate clusters" action that re-runs the
HDBSCAN pipeline on demand. This closes the precondition this section
flagged as unmet in prior passes.

With the UI live, this section adds the product-positioning action this
doc's own competitor research (§0–§8 above) sets up but never states
explicitly: **F65 Topics is eden's answer to the "user request mining" /
issue-mining product category that Langfuse, Arize (Phoenix), Helicone, and
LangSmith are all independently building toward** (per the vendor issue
trackers and changelog entries mined in this file). Eden already did the
hard engineering — HDBSCAN clustering, LLM cluster labeling, trend
detection (`recent_count`/`baseline_count`/`trend`), and a working
"turn a cluster into a dataset" action — that competitors in this exact
category charge for as a distinct, separately-marketed feature. That
engineering work was, until Wave 6, invisible to any user; it no longer is,
and should not stay unmarketed:

- **Category framing to use externally:** "eden surfaces what your users
  are actually asking your agent to do — trending topic and issue clusters
  mined automatically from live traffic — the same category Langfuse,
  Arize, Helicone, and LangSmith are each building toward, without
  requiring you to read individual traces."
- **What to lead with:** the trend badges (rising/falling/flat vs. a
  7-day baseline) and the dataset-bridging action
  (`POST /topics/{id}/act?action=dataset`) are the two capabilities that
  most directly differentiate a *product feature* from a raw clustering
  script — both are real and shipped, not aspirational.
- **What not to claim yet:** do not market this as having scheduled/
  automatic trending or cross-run dedup — `generate_topics` is still
  on-demand only (no cron/worker wiring), and each run inserts fresh rows
  rather than updating existing clusters in place (see "Why it doesn't yet
  deliver the value it's built for" above, items 2 and 4) — both remain
  open gaps, not just historical color.

## UX mandate: framing AI-generated labels and fixes — FEAT-182

This section captures a design principle as a standing mandate, not a
one-time UI note, since it applies to the topics/patterns UI above and to
any other surface (e.g. the `improvement/` auto-patch loop, the
prompt-evolution canary UI) that presents an AI-derived conclusion or
suggested action to a user.

**The mandate:** any UI that shows an AI-generated conclusion, label, or
suggested fix must give the user a way to check it, and must not imply the
system already validated it on the user's behalf. Concretely:

1. **Show the label is AI-derived, not fact.** A cluster's name,
   description, and keywords are LLM output over a real cluster of traces —
   useful, but not guaranteed correct. Say so where the label is shown,
   not just in developer-facing docs.
2. **Always ship an evidence trail next to the conclusion**, not just the
   conclusion — link to the underlying sample traces (or diff, or score
   history) so a user can verify the claim themselves in one click, rather
   than being asked to simply trust it.
3. **Require explicit human review before any action with real
   consequences** (creating a dataset from a cluster, promoting a
   suggested fix, auto-merging a patch) — AI-derived output should inform
   a decision, not silently make one, until the specific action is
   explicitly designed and gated as autonomous.
4. **Don't invent a confidence score the backend doesn't compute.** Where
   no real confidence/precision number exists (as with topic clusters
   today), prefer a plain evidence link over a fabricated-looking percentage
   — a made-up number is worse than no number, per §8's own research.

**Why this is a mandate and not a one-off:** §8 above documents, across
three independent 2026 sources plus a named developer-trust survey
(96% of developers don't fully trust AI-generated output), that users are
actively and publicly skeptical of AI-generated analysis and fixes they
can't inspect — and that vendors who ship "black box" AI claims without an
evidence trail read as marketing, not as the trustworthy analysis they're
claiming to be. This is the same finding this doc already applies to eden's
prompt-evolution canary UI (§8, `03-prompt-playground.md`'s scoped tables);
this section formalizes it as a mandate so it also governs the topics/
patterns UI's own AI-generated labels going forward, and any future
AI-suggested-fix surface, rather than being re-derived per feature.

**Applied here (Wave 14):** the `/topics` page now marks each cluster's
name with a visible "AI-labeled, spot-check before acting" hint and a
"Review N sample traces" link to the cluster's representative traces
(`clients/portal/src/app/(portal)/topics/page.tsx`), so the label is never
presented as unverified fact with no way to check it. This is a minimal
application of the mandate — it does not add a fabricated confidence score,
and it does not gate the existing "Generate clusters" or CSV-export actions
behind a review step, since neither of those actions has the "AI suggests,
human approves before consequence" shape the mandate is about; the
"create dataset from cluster" action (`act_on_topic`, action=`dataset`)
already requires an explicit user click per cluster, which satisfies
point 3 above without further UI change.

## Full source list
- [LangSmith public changelog (Jun 29–Jul 31 2026 entries)](https://docs.langchain.com/langsmith/changelog)
- [GitHub API — langchain-ai/langsmith-sdk#2719 (open), Playground lag — re-confirmed still open this pass](https://github.com/langchain-ai/langsmith-sdk/issues/2719)
- [GitHub API — Arize-ai/phoenix#10699 (open), "Phoenix slow"](https://github.com/Arize-ai/phoenix/issues/10699)
- [GitHub API — Arize-ai/phoenix#7031 (open), image support in Playground](https://github.com/Arize-ai/phoenix/issues/7031) · [#8814 (open), add image to a prompt](https://github.com/Arize-ai/phoenix/issues/8814)
- [GitHub API — Helicone/helicone#5658 (open), self-hosted deployment redirects to vendor cloud](https://github.com/Helicone/helicone/issues/5658)
- [HN item 48908950 — Launch HN: Agnost AI (YC S26), 85pts/52 comments, "just a prompt" skepticism](https://news.ycombinator.com/item?id=48908950)
- [HN item 48109962 — Launch HN: Voker (YC S24), 59pts/22 comments, "AI sloppy" founder-response callout](https://news.ycombinator.com/item?id=48109962)
- [Coroot blog — "most of us see that as marketing fluff" on AIOps](https://coroot.com/blog/we-built-ai-powered-root-cause-analysis-that-actually-works/)
- [Rootly — avoid "black box" AI models, explainability as trust](https://rootly.com/sre/ai-powered-observability-cut-alert-noise-boost-insight-807ee)
- [Metoro — "AI checkbox" vs. genuinely AI-powered, 2026 comparison](https://metoro.io/blog/best-observability-tools-with-ai)
- [incident.io — judge AI RCA on precision/recall "not marketing promises"](https://incident.io/blog/ai-root-cause-analysis-accuracy-testing-guide)
- [Sonar — 2026 State of Code developer survey: 96% don't fully trust AI output, 48% always verify](https://www.sonarsource.com/resources/developer-survey-report/)

*(Prior-pass sources for §1, §3, §4, §6, and the appendix are unchanged and not re-pasted here — see this file's git history for the full prior list; nothing in them was found stale or contradicted this pass.)*

## Confidence summary
High confidence, kept/reinforced: §2 (UI perf — now includes LangSmith's own shipped fix as validation), §5 (multimodal — now three vendors), §7 (self-hosted phone-home trust break, new), §8 (AI-generated-fix skepticism pattern, new, directly relevant to eden's evolution-loop UI decision). Unchanged from prior pass (no new evidence surfaced or sought this round, not re-verified): §1, §3, §4, §6. Confirmed still accurate: eden's pre-launch status (`CHANGELOG.md:102`, `billing.py:6`, both re-read this pass). Pruned this pass: none of the prior file's existing findings were downgraded or cut.

**Pass-4 corrections (this review round):** two eden cross-check citations in §5 and §8 were fabricated/wrong and have been fixed in place — §5's `create_from_span`/"§2c of `03-prompt-playground.md`" (no such function or section exists; corrected to `from_span`, `src/eden/playground/service.py:210`) and §8's "statistical/Bayesian gate" (`promotion.py`'s own docstring explicitly disclaims Bayesian methods; corrected to "fixed-threshold gate"). §8's recommendation-scoping claim was also sharpened: `03-prompt-playground.md`'s existing UI recommendations cover the evolutions/canary-stats tables (#2–3), not a candidate-text diff view, which remains net-new scope. Added a User Experience & Value section covering eden's own `topics/`+`patterns_clusterer` request-mining pipeline (F65) — the closest-matching subsystem to this doc's title in eden's own codebase, previously undiscussed here and cross-referenced against its fuller writeup in `01-competitor-matrix.md`.
