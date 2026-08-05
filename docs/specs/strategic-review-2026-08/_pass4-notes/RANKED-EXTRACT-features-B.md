# Ranked Extraction — Features B (09–16)

Raw extraction of distinct, actionable items from pass-4 feature-review docs 09–16. This is input material for a downstream consolidated ranked action list — not a finished recommendation document. Organized by source doc, numbered within each doc. Narrative-only content (background, market research with no implied action, verification methodology) is excluded.

---

## Source: `features/09-sdk-dx.md`

### B09-1. Document `agent_id`/`agentId` in both SDK READMEs
**Citation:** `features/09-sdk-dx.md` — SDK config/wiring section.
**Description:** `agent_id` (Python) and `agentId` (TS) are already fully plumbed end-to-end through both SDKs and the ingestion path, but the field is optional and undocumented in either SDK's README/quickstart. Users have no way to discover that setting it enables per-agent breakdowns downstream (session analytics, issue extraction, etc. all key off it where populated). Fix: add a short README section in `sdk/python` and `sdk/ts-ai` showing how to set it and what it unlocks.
**Why it matters:** Silent, already-built functionality that goes unused because nobody knows it exists is wasted engineering investment; every downstream feature that could segment by agent stays flat/unsegmented in practice.
**Severity:** Medium
**Effort:** Small
**Confidence:** High

### B09-2. Build real one-liner auto-instrumentation for the TypeScript SDK
**Citation:** `features/09-sdk-dx.md` — auto-instrumentation comparison section.
**Description:** Python's `eden.instrument()` does genuine class-level monkey-patching across 13 frameworks (a real one-liner). TypeScript has no equivalent: instrumentation is per-instance `Proxy`-based `wrap*()` factories that the caller must manually apply to every client instance they create. There is no mechanism that patches a framework's exported class/prototype once at import time the way Python does. Fix: implement prototype-level (or Node loader-hook-based, e.g. `import-in-the-middle`) auto-instrumentation for at least the top few frameworks, matching the Python UX.
**Why it matters:** TS/Node users get a materially worse onboarding experience than Python users for the exact same product promise ("one line of code"); this is a direct DX/adoption gap in a core acquisition funnel (SDK install → first trace).
**Severity:** High
**Effort:** Large
**Confidence:** High

### B09-3. Rename or fix `detect-installed.ts`'s `autoInstrument()` alias
**Citation:** `features/09-sdk-dx.md` — TS auto-instrumentation internals.
**Description:** The TS SDK exposes a function named `autoInstrument()` inside `detect-installed.ts` that is actually detection-only — it does not instrument anything, contrary to what its name promises. Callers reading the API surface will reasonably assume calling it wires up instrumentation, when it doesn't. Fix: either rename the function to something like `detectInstalledFrameworks()` or `listCandidates()`, or (see B09-2) make it actually perform auto-instrumentation.
**Why it matters:** Misleadingly-named public API surface causes silent integration failures (users think instrumentation is active when it isn't), producing empty/incomplete trace data downstream with no error signal.
**Severity:** Medium
**Effort:** Small
**Confidence:** High

### B09-4. Make Python's missing-`org_id` failure loud instead of silently swallowed
**Citation:** `features/09-sdk-dx.md` — error-handling comparison, `config.py:216`, `client.py:1238`.
**Description:** Python's `config.py:216` raises a `ValueError` when `org_id` is missing, but the only call site that matters (`client.py:1238`) wraps it in a broad `except` that just does `log.warning(...)` — so in practice the error is unreachable/silent from the user's perspective; they get no signal at all that ingestion will fail. Contrast: the TS SDK emits a synchronous, visible `console.warn` for the equivalent condition. Fix: in Python, surface the same class of visible warning (or raise, depending on desired strictness) at the actual usage site rather than swallowing it in a broad except.
**Why it matters:** A misconfigured Python SDK silently drops all telemetry with no diagnostic signal, which is one of the worst possible failure modes for an observability product — users won't know their data isn't arriving until they go looking for it and find nothing.
**Severity:** High
**Effort:** Small
**Confidence:** High

### B09-5. Wire `droppedTotal`/`sampledOut` into TS `doctor.ts` output
**Citation:** `features/09-sdk-dx.md` — TS diagnostics/doctor tooling section.
**Description:** The TS SDK already tracks `droppedTotal` and `sampledOut` counters internally, but `doctor.ts` (the SDK's self-diagnostic CLI/utility) does not read or surface them. A user running the doctor tool to debug "why don't I see my traces" gets no visibility into drop/sampling behavior even though the data already exists in memory.
**Why it matters:** This is a support-cost and self-serve-debugging gap: users hit a wall the doctor tool could resolve for free, and instead file support tickets or churn.
**Severity:** Medium
**Effort:** Small
**Confidence:** High

### B09-6. Add a `.sent`/`.failed`-equivalent counter to the TS SDK
**Citation:** `features/09-sdk-dx.md` — TS SDK observability of the SDK itself.
**Description:** The TS SDK has no equivalent of a `.sent`/`.failed` counter pair (implied contrast with Python, which does track this class of metric). Without it, TS users cannot programmatically or via `doctor.ts` determine how many spans/events were successfully sent vs. failed to send.
**Why it matters:** Same class of self-serve debuggability gap as B09-5 — without send/fail counts, diagnosing "my traces aren't showing up" requires either trusting a black box or filing a support ticket.
**Severity:** Medium
**Effort:** Small
**Confidence:** High

### B09-7. Reconcile TS and Python instrumentation UX so both meet the "one-liner" bar
**Citation:** `features/09-sdk-dx.md` — overall SDK DX comparison (synthesizes B09-2/B09-3).
**Description:** Beyond the specific auto-instrument gap, the doc frames the broader problem: eden's product story ("drop in one line, get full traces") is only true for Python today. Any marketing/docs/onboarding flow that promises this for "the eden SDK" generically is currently false for TS/Node users. Fix (product-level, not just code): either scope the one-liner promise explicitly to Python-only in all external-facing docs until B09-2 ships, or prioritize B09-2 so the promise becomes true for both.
**Why it matters:** Mismatched product claims vs. reality erode trust at the exact moment (first install) users are forming their opinion of the product; Node/TS is a large fraction of the LLM app ecosystem (LangChain.js, Vercel AI SDK, etc.).
**Severity:** High
**Effort:** Medium
**Confidence:** High

### B09-8. Extend Python monkey-patch auto-instrumentation coverage / keep it current
**Citation:** `features/09-sdk-dx.md` — Python auto-instrumentation, 13-framework list.
**Description:** Python's `eden.instrument()` currently covers 13 frameworks via class-level monkey-patching. The doc implies this list needs to be treated as a living target (new frameworks/SDKs emerge frequently in the LLM app space) rather than a one-time build. Fix: establish a lightweight process/checklist for adding new framework support as they gain adoption, so Python's advantage over TS doesn't quietly erode as the ecosystem shifts.
**Why it matters:** Auto-instrumentation coverage is a moving target; a framework list that goes stale silently degrades the "just works" promise for any user on a newer/less-common stack.
**Severity:** Low
**Effort:** Medium
**Confidence:** Medium — this is an inferred forward-looking recommendation rather than a specific bug the source doc pins to a line/behavior.

---

## Source: `features/10-model-gateway.md`

### B10-1. Delete the dormant `AIGateway` multi-provider routing engine
**Citation:** `features/10-model-gateway.md` — `AIGateway` assessment section (~900 lines of code).
**Description:** `AIGateway` is a fully-built, ~900-line multi-provider routing/failover engine that is dormant — not wired into any live production path that actually benefits from its routing logic. The doc's verdict is DELETE: the class should be removed rather than resurrected, because the market for hosted LLM gateway/routing (Portkey — acquired by Palo Alto Networks, OpenRouter at ~$1.3B valuation, LiteLLM) is already well-served by dedicated players, and eden reinventing this is not a differentiated bet.
**Why it matters:** ~900 lines of dead, unmaintained code create ongoing maintenance drag, confuse engineers who encounter it (see B10-4/B10-5 below — it has live callers that silently break), and represent sunk effort better redirected elsewhere.
**Severity:** Medium
**Effort:** Medium
**Confidence:** High

### B10-2. Keep `/gateway/v1` honest as a single-upstream pass-through — do not rebuild routing on top of it
**Citation:** `features/10-model-gateway.md` — `/gateway/v1` assessment section.
**Description:** `/gateway/v1` is real and working today, but only as a single-upstream pass-through (not a multi-provider router). The recommendation is explicit: keep it scoped to what it actually does rather than layering `AIGateway`-style routing ambitions onto it. Any product copy or roadmap language implying `/gateway/v1` does multi-provider routing/failover should be corrected to match reality.
**Why it matters:** Prevents scope creep into a market segment (routing/failover-as-a-service) eden has already decided not to compete in (see B10-1), and prevents customer-facing overpromising about what the endpoint does.
**Severity:** Medium
**Effort:** Small
**Confidence:** High

### B10-3. Extend `ProviderRoutingService` ingestion decoders rather than replacing the service's role
**Citation:** `features/10-model-gateway.md` — `ProviderRoutingService` assessment section.
**Description:** `ProviderRoutingService`'s correct role per the doc's verdict is observe-not-replace: it should continue decoding/ingesting routing decisions made by external tools (e.g., customers' own LiteLLM/Portkey deployments) rather than becoming eden's own routing decision-maker. The concrete action is to extend its ingestion decoders (parsing more providers'/routers' trace formats) rather than building decision logic into it.
**Why it matters:** Keeps eden positioned as an observability layer over whatever routing tool a customer already uses, which is the differentiated, lower-competition role versus trying to out-build dedicated routing vendors.
**Severity:** Medium
**Effort:** Medium
**Confidence:** High

### B10-4. Fix `time_travel/replayer.py:453` — always-raising `AIGateway.complete()` call site
**Citation:** `features/10-model-gateway.md` — undocumented production call sites, `time_travel/replayer.py:453`.
**Description:** This call site unconditionally calls `AIGateway.complete()`, and because `AIGateway` is dormant/non-functional, this call always raises an exception. This is a previously-undocumented, silently-broken production code path (the feature that depends on it — time-travel replay — is effectively non-functional whenever this path is hit). Fix: either repoint this call at eden's actual internal LLM client (`eden.llm.client.OpenRouterClient`, see B10-6) or remove/guard the code path pending `AIGateway`'s deletion (B10-1).
**Why it matters:** A production feature (time-travel replay) is silently broken end-to-end; any user or internal workflow depending on it fails with no prior warning, and this bug had not previously been surfaced/tracked anywhere before this review.
**Severity:** Critical
**Effort:** Small
**Confidence:** High

### B10-5. Fix `improvement/replay_verify.py:355` — always-raising `AIGateway.complete()` call site
**Citation:** `features/10-model-gateway.md` — undocumented production call sites, `improvement/replay_verify.py:355`.
**Description:** Same failure pattern as B10-4: this call site unconditionally calls `AIGateway.complete()` which always raises since `AIGateway` is dormant. This one sits inside the replay-verification step of eden's own autonomous improvement loop (see doc 13), meaning the closed-loop patch-verification pipeline itself is silently broken at this step whenever it's exercised. Fix: repoint to the real internal LLM client or remove/guard pending `AIGateway` deletion.
**Why it matters:** This is arguably more severe than B10-4 because it breaks eden's own flagship autonomous-improvement feature (doc 13) at a verification step meant to gate whether an autonomous patch is safe to merge — a broken verification step could mean patches are being verified incorrectly or verification is silently no-op'ing.
**Severity:** Critical
**Effort:** Small
**Confidence:** High

### B10-6. Populate `INTERNAL_CHAT_FALLBACKS` for eden's own internal LLM traffic
**Citation:** `features/10-model-gateway.md` — eden's internal LLM usage section, `eden.llm.client.OpenRouterClient`.
**Description:** 100% of eden's own internal LLM traffic (i.e., calls eden itself makes to LLMs, e.g. for evals, nudge generation, issue extraction, etc.) goes through `eden.llm.client.OpenRouterClient`. This client has an `INTERNAL_CHAT_FALLBACKS` mechanism for provider/model fallback that is currently unpopulated (empty), meaning there is no actual fallback behavior configured — a single OpenRouter/upstream outage takes down all internal LLM-dependent eden features simultaneously with no fallback.
**Why it matters:** eden's own product features (evals, nudges, issue extraction, all LLM-dependent internal pipelines) have a single point of failure with no fallback configured, despite the fallback mechanism already existing in code — this is a cheap reliability win being left on the table.
**Severity:** High
**Effort:** Small
**Confidence:** High

### B10-7. Correct roadmap/product narrative away from "build eden's own multi-provider gateway"
**Citation:** `features/10-model-gateway.md` — overall verdict framing, competitive landscape section.
**Description:** Given the DELETE verdict on `AIGateway` (B10-1) and the crowded, well-capitalized competitive landscape (Portkey/Palo Alto Networks, OpenRouter, LiteLLM), any existing roadmap items, pitch materials, or internal planning docs that describe eden building its own multi-provider LLM gateway/router as a strategic bet should be revised or removed. This is a documentation/planning hygiene action distinct from the code deletion itself.
**Why it matters:** Prevents future engineering time being allocated toward rebuilding what was just decided against, and keeps external-facing/investor-facing narrative consistent with actual product direction.
**Severity:** Medium
**Effort:** Small
**Confidence:** Medium — the doc's verdict clearly implies this, but it's an inferred follow-on action rather than something the source explicitly instructs as a checklist item.

### B10-8. Audit for other silent `AIGateway` call sites beyond the two found
**Citation:** `features/10-model-gateway.md` — undocumented production call sites section (implied completeness gap).
**Description:** The doc found two previously-undocumented, silently-broken call sites (B10-4, B10-5) via manual investigation, not via a systematic search. Given `AIGateway` is ~900 lines and dormant, there is a reasonable chance additional call sites exist elsewhere in the codebase that weren't caught by this pass. Fix: run a full repo-wide reference search for `AIGateway` usage before proceeding with deletion (B10-1), to ensure no other silent failures are lurking.
**Why it matters:** Deleting `AIGateway` (B10-1) without first confirming all call sites are accounted for risks either missing more broken production paths or breaking something unexpectedly during removal.
**Severity:** Medium
**Effort:** Small
**Confidence:** Medium — this is a reasonable inferred precaution rather than an explicit instruction in the source doc.

---

## Source: `features/11-session-analytics.md`

### B11-1. Consolidate or reconcile the three disconnected session tables
**Citation:** `features/11-session-analytics.md` — session data model section (`user_sessions`, `session_summaries`, `agent_sessions`).
**Description:** eden currently has three separate, disconnected tables all representing "sessions" in some form: `user_sessions`, `session_summaries`, and `agent_sessions`. They are not joined or reconciled with each other, meaning different parts of the product report different, potentially contradictory session data depending on which table they query. Fix: define a single canonical session representation (or explicit, documented relationships/foreign keys between the three) and migrate consumers onto it.
**Why it matters:** Fragmented session data undermines trust in any session-based metric eden reports (retention, engagement, session counts) since the "truth" depends on which internal table happened to be queried — a customer-facing credibility risk if surfaced inconsistently.
**Severity:** High
**Effort:** Large
**Confidence:** High

### B11-2. Repoint `cohorts.py` at `session_summaries` instead of `jobs`
**Citation:** `features/11-session-analytics.md` — analytics code / wrong-table bug section, `cohorts.py`.
**Description:** `cohorts.py` (cohort analysis logic) currently queries the `jobs` table, which is not the correct source for session/cohort analytics — it should be querying `session_summaries` (the N12 table). This appears to be orphaned code written against an earlier/wrong schema assumption. Fix: repoint the queries to `session_summaries` and validate output against expected cohort semantics.
**Why it matters:** Cohort analysis output is currently either wrong or meaningless (querying job records, not session records, for what should be session-based cohort retention data) — any feature or dashboard relying on `cohorts.py` is silently producing incorrect numbers.
**Severity:** High
**Effort:** Medium
**Confidence:** High

### B11-3. Repoint `funnels.py` at `session_summaries` instead of `audit_log`
**Citation:** `features/11-session-analytics.md` — analytics code / wrong-table bug section, `funnels.py`.
**Description:** `funnels.py` (funnel analysis logic) currently queries `audit_log`, which is both semantically wrong (audit logs are not funnel/session step data) and, per B11-4 below, references a table that doesn't even exist. Fix: repoint to `session_summaries` and rebuild funnel-step logic against the correct schema.
**Why it matters:** Same class of issue as B11-2 — funnel analytics are silently non-functional or wrong, and any downstream reporting or optimization decisions based on funnel data are built on broken foundations.
**Severity:** High
**Effort:** Medium
**Confidence:** High

### B11-4. Fix the nonexistent `audit_log` table reference (also breaks `export_audit_log`)
**Citation:** `features/11-session-analytics.md` — schema bug section, `audit_log` table.
**Description:** Beyond being the wrong semantic source for funnels (B11-3), `audit_log` as referenced in code does not actually exist as a table in the current schema. This is a harder failure than a wrong-table bug — it means any code path hitting this reference (including a separate `export_audit_log` function/feature) fails outright rather than just returning wrong data. Fix: either create the missing `audit_log` table with correct schema if audit logging is still a wanted feature, or remove/repoint all references (`funnels.py`, `export_audit_log`) to whatever the correct current audit/event source is.
**Why it matters:** This is a harder, more visible failure than B11-2/B11-3 (likely throws exceptions rather than silently returning wrong data), and it affects at least two independent code paths (`funnels.py` and `export_audit_log`), suggesting the underlying schema drift is broader than a single file.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

### B11-5. Wire the portal session list/header to read from `session_summaries`, not `agent_sessions`
**Citation:** `features/11-session-analytics.md` — portal wiring gap section (F23 vs N12).
**Description:** The shipped portal session list and session header UI (F23) currently reads from the `agent_sessions` table. Only the turn-detail view (N12) reads from the newer, more complete `session_summaries` table. This means the primary session list a user sees and the detail view they drill into are backed by different, disconnected data models — potentially showing inconsistent session counts, metadata, or timing between the list and the detail page.
**Why it matters:** Directly user-visible inconsistency: a user could see one session count/summary in the list view and a different (or missing) picture when they click into a session's detail, which is a confusing, trust-eroding UX bug in a core navigation flow.
**Severity:** High
**Effort:** Medium
**Confidence:** High

### B11-6. Add a `RetentionCurveChart` component to the portal
**Citation:** `features/11-session-analytics.md` — User Experience & Value section (component sketch provided in source).
**Description:** The doc includes a full sketch for a `RetentionCurveChart` React component that does not currently exist in the portal. This would visualize retention curves (e.g., session-over-time cohort retention) once the underlying data (B11-1/B11-2) is fixed. Fix: implement the component per the doc's sketch and wire it to corrected `session_summaries`-backed cohort data.
**Why it matters:** Retention curves are a standard, high-value analytics visualization that's currently entirely absent from the portal despite the backend groundwork (once fixed) supporting it — closes a visible feature gap for any product-analytics-minded customer.
**Severity:** Medium
**Effort:** Medium
**Confidence:** High

### B11-7. Provide exact migration SQL to consolidate/backfill session tables
**Citation:** `features/11-session-analytics.md` — migration section (exact SQL provided in source).
**Description:** The source doc includes exact migration SQL intended to address the session-table fragmentation (B11-1). This should be treated as a concrete, ready-to-review action item: run/adapt the provided migration to backfill and reconcile `user_sessions`/`session_summaries`/`agent_sessions` rather than starting the consolidation design from scratch.
**Why it matters:** Having ready-made migration SQL substantially lowers the effort bar for B11-1 — this is a "the hard design work is already done, just needs review and execution" item.
**Severity:** High
**Effort:** Medium
**Confidence:** High

### B11-8. Audit all other analytics modules for the same wrong-table pattern as `cohorts.py`/`funnels.py`
**Citation:** `features/11-session-analytics.md` — analytics code section (implied by the pattern found in two sibling files).
**Description:** Since both `cohorts.py` and `funnels.py` independently ended up pointed at wrong/legacy tables (`jobs`, `audit_log`), it's likely other analytics modules in the same package have the same class of bug (schema drift not propagated to all consumers). Fix: systematically review all modules under the analytics package for table references and validate each against the current canonical schema.
**Why it matters:** Given two out of however-many analytics modules were checked both had this exact bug, the prior probability of additional undiscovered instances is high; each one silently produces wrong numbers until found.
**Severity:** Medium
**Effort:** Medium
**Confidence:** Medium — this is an inferred audit recommendation based on the pattern found, not a specific additional bug the source doc names.

### B11-9. Document/decide the intended relationship between `user_sessions`, `session_summaries`, and `agent_sessions`
**Citation:** `features/11-session-analytics.md` — session data model section.
**Description:** Distinct from actually merging the tables (B11-1), there's a prerequisite product/architecture decision needed: what is each table's intended scope going forward (e.g., is `agent_sessions` meant to be agent-specific and `session_summaries` meant to be the general-purpose canonical one, with `user_sessions` deprecated)? This needs to be explicitly decided and documented before engineering work on B11-1 proceeds, to avoid the migration itself encoding an accidental/undiscussed decision.
**Why it matters:** Without an explicit decision, a migration (B11-7) risks silently making an architectural choice (which table "wins") that should be a deliberate product/eng decision, potentially requiring rework later.
**Severity:** Medium
**Effort:** Small
**Confidence:** Medium — this is a reasonable inferred prerequisite rather than something explicitly named as a separate action in the source.

### B11-10. Fix `export_audit_log` independent of the `funnels.py` fix
**Citation:** `features/11-session-analytics.md` — schema bug section, `audit_log` table (see also B11-4).
**Description:** Called out here as a distinct action because `export_audit_log` is a separate consumer of the nonexistent `audit_log` table from `funnels.py`, and may need its own fix (e.g., a genuinely different data source than `session_summaries`, since "audit log" and "session funnel" are different concepts) rather than being folded into the same repoint as B11-3/B11-4. Fix: determine `export_audit_log`'s correct intended data source (likely a real audit/event table, not session data) and repoint or rebuild it separately.
**Why it matters:** Treating this as identical to the funnels fix risks mis-fixing it (funnels and audit export are semantically different features that happened to share a broken table reference); calling it out separately ensures it gets its own correct fix rather than an incidental one.
**Severity:** High
**Effort:** Medium
**Confidence:** Medium — the underlying bug (B11-4) is High confidence; the specific claim that it needs an independently different fix from funnels is a reasonable inference, not explicit in the source.

---

## Source: `features/12-runtime-guardrails.md`

*(Flagged in-source as possibly the single highest-priority finding across the entire 3-pass review.)*

### B12-1. Neutralize or remove the `install_cat15_trajectory_replaces_intervention` hot-path monkey-patch
**Citation:** `features/12-runtime-guardrails.md` — core finding, monkey-patch section.
**Description:** A default-on hot-path monkey-patch, `install_cat15_trajectory_replaces_intervention`, silently swaps out eden's real content-safety guardrail checks (`InterventionEngine.evaluate_and_act`, which is fail-closed and correctly designed) for unrelated cost/loop/latency checks whenever a `trace_id` is passed. It also returns `edited_text` unredacted, meaning content that should have been redacted per policy passes through untouched. This happens with zero monitoring anywhere in the system to detect that it's occurring. Fix: remove this monkey-patch entirely, or at minimum make it opt-in/explicitly gated rather than default-on, and restore `evaluate_and_act` as the actual enforcement path whenever `trace_id` is present.
**Why it matters:** This is a silent safety-guardrail bypass in a product whose core value proposition includes runtime safety enforcement — any customer relying on eden's guardrails for content safety is currently not actually protected whenever this patch's trigger condition (`trace_id` present) is met, with no alerting anywhere to reveal this. This is a trust and liability-level issue, not just a bug.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

### B12-2. Add monitoring/alerting to detect when the trajectory-replaces-intervention patch fires
**Citation:** `features/12-runtime-guardrails.md` — monkey-patch section (monitoring gap explicitly noted).
**Description:** Independent of removing the patch (B12-1), there is currently zero monitoring anywhere that would catch this substitution happening. Even as an interim mitigation before B12-1 ships, adding a metric/log/alert every time the cost/loop/latency check path is taken instead of the real content-safety check would at least make the bypass observable rather than fully silent.
**Why it matters:** Defense in depth — even after B12-1 is fixed, this class of "safety check silently replaced" failure mode could recur elsewhere; observability into it is valuable independent of the specific current instance.
**Severity:** High
**Effort:** Small
**Confidence:** High

### B12-3. Reconcile the two differently-named `EvalToGuardrailLink` classes
**Citation:** `features/12-runtime-guardrails.md` — dual-implementation section.
**Description:** Two separate classes both effectively named/serving as `EvalToGuardrailLink` exist in the codebase with incompatible enforcement semantics. The documented one (presumably the one referenced in official docs/specs) is toothless — it doesn't actually enforce anything meaningful. The one that's actually working/wired into production is undocumented, and critically has no demote path (no way to walk back a guardrail once escalated/promoted via this link). Fix: pick one canonical implementation, deprecate/remove the other, document the surviving one accurately, and add a demote path to whichever becomes canonical.
**Why it matters:** Two conflicting implementations of the same concept is a significant maintainability and correctness risk — engineers modifying "the" `EvalToGuardrailLink` based on docs could be editing the toothless one while production runs the other; and the lack of any demote path means guardrail escalations made via the working path are currently one-directional/irreversible without manual intervention.
**Severity:** High
**Effort:** Medium
**Confidence:** High

### B12-4. Add a demote path to the working (undocumented) `EvalToGuardrailLink`
**Citation:** `features/12-runtime-guardrails.md` — dual-implementation section (demote-path gap specifically).
**Description:** Called out separately from B12-3 because it's independently actionable even before the two classes are reconciled: the production-active `EvalToGuardrailLink` implementation has no mechanism to demote/reverse a guardrail escalation it made. Fix: add a demote/reversal method mirroring whatever promotion mechanism currently exists.
**Why it matters:** Without a demote path, any false-positive or since-resolved guardrail escalation made through this link is stuck, requiring manual DB intervention to undo — an operational burden and a risk of guardrails becoming stale/overly restrictive over time with no self-correction.
**Severity:** Medium
**Effort:** Medium
**Confidence:** High

### B12-5. Upgrade guardrail detectors beyond v0 regex/trigram heuristics
**Citation:** `features/12-runtime-guardrails.md` — detector implementation section.
**Description:** While `InterventionEngine.evaluate_and_act` itself is a real, correctly fail-closed enforcement engine, all the detectors feeding it are v0-quality heuristics (regex and trigram matching). This limits both precision (false positives blocking legitimate content) and recall (real violations regex can't catch, e.g. paraphrased or semantically-equivalent unsafe content). Fix: incrementally replace/augment regex/trigram detectors with model-based (embedding or classifier) detection for the highest-value categories first.
**Why it matters:** The enforcement mechanism (fail-closed engine) is sound, but detector quality directly determines whether guardrails actually catch what they're supposed to catch — v0 heuristics are known to be weak against adversarial or simply varied phrasing, undermining the safety promise even where the patch bypass (B12-1) isn't in play.
**Severity:** High
**Effort:** Large
**Confidence:** High

### B12-6. Fix the guardrails portal policy-list page envelope-unwrap bug
**Citation:** `features/12-runtime-guardrails.md` — portal bugs section, policy-list page.
**Description:** The guardrails portal's policy-list page has a bug where it fails to properly unwrap a response envelope (i.e., an API response wrapper object), likely causing the page to either render broken/empty data or crash. Fix: correct the unwrap logic to match the actual API response shape.
**Why it matters:** A broken policy-list page means administrators/customers cannot reliably view or manage the guardrail policies protecting their deployment through the UI — forcing API-level workarounds for a core administrative task.
**Severity:** High
**Effort:** Small
**Confidence:** High

### B12-7. Fix the frontend/backend enum mismatch on the guardrails policy-list page
**Citation:** `features/12-runtime-guardrails.md` — portal bugs section, enum mismatch.
**Description:** Separately from the envelope-unwrap bug (B12-6), the same page has a mismatch between frontend and backend enum values (e.g., policy status/type enums defined differently or drifted out of sync on each side). This likely causes incorrect labels, filters, or dropdown options to be shown, or silent failures when the frontend sends a value the backend doesn't recognize. Fix: audit both enum definitions and unify them (ideally via a single shared schema/generated types).
**Why it matters:** Enum drift between frontend and backend causes subtle, hard-to-diagnose UI bugs (wrong labels, broken filters, rejected requests) specifically on the page administrators use to manage safety policy — compounding the trust issue from B12-6.
**Severity:** Medium
**Effort:** Small
**Confidence:** High

### B12-8. Establish a single source of truth for "which guardrail enforcement path is active"
**Citation:** `features/12-runtime-guardrails.md` — synthesizes B12-1/B12-3 (implied cross-cutting fix).
**Description:** The doc's overall picture is that there isn't one guardrail enforcement pipeline — there's `InterventionEngine.evaluate_and_act`, the trajectory-replacing monkey-patch, and two `EvalToGuardrailLink` implementations, with unclear precedence between them. Beyond fixing each individually (B12-1, B12-3), there's a broader architectural action: define and document a single canonical enforcement path so future engineers don't reintroduce a second silent bypass.
**Why it matters:** Point fixes (B12-1, B12-3) address the currently-known instances, but without an architectural single-source-of-truth, the same "silent parallel implementation" failure mode that caused this problem in the first place could recur.
**Severity:** High
**Effort:** Medium
**Confidence:** Medium — this is a reasonable synthesized architectural recommendation rather than something the source doc states as its own standalone checklist item.

### B12-9. Add regression tests asserting `evaluate_and_act` is the active path whenever `trace_id` is present
**Citation:** `features/12-runtime-guardrails.md` — monkey-patch section (implied test gap given the bug went undetected).
**Description:** The fact that B12-1's bypass existed undetected implies there is no existing test asserting the correct guardrail path runs under the exact condition (`trace_id` present) that triggers the bypass. Fix: add an explicit regression test (unit or integration) that fails if the trajectory/cost-check path is taken instead of `evaluate_and_act` under that condition, to prevent regression after B12-1 is fixed.
**Why it matters:** Without a regression test, fixing B12-1 once does not guarantee the bypass (or an equivalent one) won't be silently reintroduced by a future change — this is the actual root-cause-level fix that makes B12-1 durable.
**Severity:** Medium
**Effort:** Small
**Confidence:** Medium — inferred from the absence-of-monitoring finding rather than an explicit source instruction.

### B12-10. Audit all other hot-path monkey-patches in the codebase for similar silent-override risk
**Citation:** `features/12-runtime-guardrails.md` — monkey-patch section (pattern-level implication).
**Description:** Given that `install_cat15_trajectory_replaces_intervention` is one instance of a monkey-patch silently overriding intended behavior, and eden's Python SDK auto-instrumentation (doc 09) also relies heavily on monkey-patching as a technique, there's reasonable cause to audit other monkey-patches in the codebase (not just this one) for the same "silently swaps behavior with no monitoring" risk pattern.
**Why it matters:** If this pattern happened once in a safety-critical path, it's a codebase-culture signal worth checking elsewhere — better to proactively find other instances than wait for another one to be discovered post-incident.
**Severity:** Medium
**Effort:** Medium
**Confidence:** Low — this is a broad inferred audit suggestion, not something the source doc names as a specific finding beyond the one instance.

### B12-11. Clarify and document what "fail-closed" guarantees actually cover given the bypass existed
**Citation:** `features/12-runtime-guardrails.md` — core finding framing.
**Description:** `InterventionEngine.evaluate_and_act` is described as fail-closed by design, but the existence of a bypass that routes around it entirely (B12-1) means the fail-closed guarantee only holds when this specific code path is actually invoked — a nuance that isn't necessarily documented anywhere for customers or internal stakeholders relying on the "fail-closed" claim. Fix: once B12-1 is resolved, document precisely which conditions guarantee fail-closed behavior end-to-end, and any historical gap should be considered for incident/customer disclosure per eden's policies.
**Why it matters:** "Fail-closed" is a strong safety claim; if it was not actually true under a default-on condition, this has potential customer trust/disclosure implications beyond just the code fix.
**Severity:** High
**Effort:** Small
**Confidence:** Medium — the technical finding (bypass exists) is High confidence; the disclosure/documentation framing is an inferred product-policy action.

### B12-12. Redact `edited_text` correctly once the correct enforcement path is restored
**Citation:** `features/12-runtime-guardrails.md` — monkey-patch section, "returns unredacted edited_text."
**Description:** Called out separately from B12-1 because it's a distinct observable symptom worth its own acceptance criterion: currently, whenever the bypass fires, `edited_text` is returned unredacted even though redaction should have occurred per policy. When B12-1 is fixed, this specific behavior (redaction actually happening on `edited_text`) should be explicitly verified, not just "the right function gets called."
**Why it matters:** This is the concrete, customer-visible consequence of the bypass — unredacted sensitive/unsafe content reaching wherever `edited_text` is consumed (potentially end-user-facing) — and should be a specific test/verification target, not assumed to be automatically fixed by B12-1's broader fix.
**Severity:** Critical
**Effort:** Small
**Confidence:** High

### B12-13. Verify no customer-facing guardrail policy dashboards report enforcement metrics from the bypassed path as if from the real path
**Citation:** `features/12-runtime-guardrails.md` — synthesizes monkey-patch + portal sections.
**Description:** Given the portal has its own bugs (B12-6/B12-7) and the enforcement path itself can be silently substituted (B12-1), there's a compounding risk: any dashboard/metric surfaced to customers about "guardrail enforcement activity" may currently be reporting on the wrong (cost/loop/latency) checks rather than actual content-safety enforcement whenever the bypass is active, without anyone realizing the metrics don't mean what they claim to mean. Fix: audit any customer-facing guardrail metrics/dashboards for this specific conflation once B12-1/B12-2 are in place.
**Why it matters:** Compounds the core safety issue with a reporting-integrity issue — customers could be looking at dashboards that appear to confirm guardrails are working when they're actually seeing unrelated metrics.
**Severity:** High
**Effort:** Small
**Confidence:** Low — this is a speculative compounding risk inferred by combining two separate findings in the source doc, not something the source doc itself states as a single finding.

### B12-14. Prioritize this doc's fixes ahead of new guardrail feature work
**Citation:** `features/12-runtime-guardrails.md` — overall framing as possibly the #1 highest-priority finding of the review.
**Description:** The doc itself flags this area as potentially the single highest-priority finding across the entire 3-pass strategic review. This is a sequencing/prioritization action rather than a code fix: any roadmap planning that includes new guardrail features (new detector categories, new policy types, etc.) should be sequenced after B12-1 through B12-9 are resolved, not in parallel with them.
**Why it matters:** Building new features on top of a foundation with a silent safety-check bypass compounds risk and technical debt; the doc's own framing suggests this should override normal feature-prioritization processes.
**Severity:** Critical
**Effort:** Small
**Confidence:** High — the "possibly #1 priority" framing is explicitly stated in the source doc itself, not inferred.

---

## Source: `features/13-continuous-improvement-loop.md`

*(Flagged as the flagship finding of the entire review per INDEX.md Part 0.1.)*

### B13-1. Fix Loop 1 (shadow-detector confirm/dismiss loop): step P0-A per source's exact plan
**Citation:** `features/13-continuous-improvement-loop.md` — Loop 1 section, P0-A fix step.
**Description:** Loop 1 (the shadow-detector confirm/dismiss loop backing `soft_issue_review.py` and the `nl_signals` table) is currently fully dead code — built but not actually functioning end-to-end. The source doc provides an exact P0-A fix step (with SQL/code specifics) as the first of a four-step (P0-A/B/C/D) plan to revive it. Fix: implement P0-A exactly as specified in the source doc.
**Why it matters:** This is step one of reviving what the doc frames as the review's flagship finding — a fully-built but entirely non-functional feedback loop where user confirm/dismiss signals should be improving detector quality over time but currently do nothing.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

### B13-2. Fix Loop 1: step P0-B per source's exact plan
**Citation:** `features/13-continuous-improvement-loop.md` — Loop 1 section, P0-B fix step.
**Description:** Second step of the four-part fix plan to revive Loop 1's dead confirm/dismiss loop. The source doc provides exact specifics for this step (following directly from P0-A, B13-1).
**Why it matters:** Same as B13-1 — necessary sequential step to make the shadow-detector confirm/dismiss loop functional; also an explicit dependency named by doc 16 (B16 series below depends on P0-A/P0-B being done).
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

### B13-3. Fix Loop 1: step P0-C per source's exact plan
**Citation:** `features/13-continuous-improvement-loop.md` — Loop 1 section, P0-C fix step.
**Description:** Third step of the four-part fix plan to revive Loop 1. Continues from P0-A/P0-B (B13-1, B13-2) per the source's exact plan.
**Why it matters:** Same rationale as B13-1/B13-2 — required to complete the loop revival.
**Severity:** High
**Effort:** Medium
**Confidence:** High

### B13-4. Fix Loop 1: step P0-D per source's exact plan
**Citation:** `features/13-continuous-improvement-loop.md` — Loop 1 section, P0-D fix step.
**Description:** Fourth and final step of the plan to revive Loop 1's dead shadow-detector confirm/dismiss loop, completing the P0-A→D sequence.
**Why it matters:** Completes the fix for the review's flagship dead-code finding — without this final step the loop remains partially non-functional even after B13-1/B13-2/B13-3.
**Severity:** High
**Effort:** Small
**Confidence:** High

### B13-5. Close Loop 2's UI rendering gaps for the autonomous patch/merge/revert pipeline
**Citation:** `features/13-continuous-improvement-loop.md` — Loop 2 section, `src/eden/improvement/` (~9,800 lines).
**Description:** Loop 2 — eden's autonomous issue→patch→test→auto-merge→auto-revert pipeline with a graduated T0-T4 autonomy ladder (`autonomy_policy.py`) — is described as well-designed on the backend (~9,800 lines of real implementation) but has UI rendering gaps: the portal does not fully surface what this pipeline is doing (patch state, autonomy tier, merge/revert history) in a way users can inspect. Fix: identify and close the specific rendering gaps (the doc implies particular missing views, though the exact UI spec should be pulled from the source for implementation).
**Why it matters:** An autonomous system that can merge and revert code changes with minimal human oversight (per the T0-T4 ladder) is a high-trust-requirement feature; without adequate UI visibility, users/operators cannot build confidence in or effectively supervise what the autonomous loop is doing, which limits how far up the autonomy ladder it's safe to let it operate.
**Severity:** High
**Effort:** Medium
**Confidence:** High

### B13-6. Fix the confirmed UUID type-mismatch bug in `EvidenceGate`/`promotion_candidates`
**Citation:** `features/13-continuous-improvement-loop.md` — third mechanism section, `EvidenceGate`/`promotion_candidates`.
**Description:** The `EvidenceGate`/`PromotionLoop` mechanism (a third, separate "shadow→gate→promote" system backing prompt-canary and nudge promotion) has a confirmed UUID type-mismatch bug in its interaction with the `promotion_candidates` table — likely a column typed inconsistently (e.g., string vs. UUID type) between writer and reader, causing join/lookup failures. Fix: correct the type mismatch (align column types, add explicit casting, or migrate the column) per the source's specific finding.
**Why it matters:** A type-mismatch bug in the promotion gating table likely causes silent failures or exceptions when candidates should be gated/promoted, undermining the gate's core job of controlling what gets promoted to production.
**Severity:** High
**Effort:** Small
**Confidence:** High

### B13-7. Remove the hardcoded kind-gate blocking non-`nudge` promotion kinds
**Citation:** `features/13-continuous-improvement-loop.md` — third mechanism section, kind-gate restriction.
**Description:** `EvidenceGate`/`PromotionLoop` has a hardcoded restriction such that only `nudge`-kind candidates can actually be promoted through it — prompt-canary, guardrail, model_routing, and kb_skill kinds are all blocked from promotion despite (implicitly) being intended to use the same gating mechanism. Fix: remove or generalize the hardcoded kind check so all intended promotion kinds can flow through the gate, once B13-6's type bug is also fixed (they likely need to be fixed together to properly test the broader-kind path).
**Why it matters:** This is a scoping bug that silently limits a shared infrastructure piece (the promotion gate) to a fraction of its intended use cases — prompt-canary and guardrail promotion (both safety/quality-relevant) are currently unable to use the evidence-gated promotion path at all, likely forcing riskier ungated promotion paths or blocking those features from having a promotion path at all.
**Severity:** High
**Effort:** Medium
**Confidence:** High

### B13-8. Document the relationship/precedence between Loop 1, Loop 2, and `EvidenceGate`
**Citation:** `features/13-continuous-improvement-loop.md` — overall structure (three distinct mechanisms covered in one doc).
**Description:** The doc covers three separate "loop"/gating mechanisms (Loop 1 shadow-detector, Loop 2 autonomous patch pipeline, and `EvidenceGate`/`PromotionLoop`) that all relate to continuous improvement but aren't explicitly documented as to how they relate to or depend on each other architecturally. Fix: produce (or extract from the source doc if already present in narrative form) an explicit architecture note describing how these three mechanisms interact, to prevent future confusion or duplicate-effort fixes.
**Why it matters:** Without a clear map of how these three systems relate, engineers fixing one (e.g., B13-6/B13-7 on `EvidenceGate`) may not realize the fix has implications for Loop 1 or Loop 2, or vice versa — architectural clarity reduces the risk of fragmented, inconsistent fixes.
**Severity:** Medium
**Effort:** Small
**Confidence:** Medium — inferred organizational recommendation; the source doc's structure implies this need but doesn't necessarily instruct it as a standalone action item.

### B13-9. Add regression/integration tests for Loop 1 confirming the confirm/dismiss signal actually changes detector behavior
**Citation:** `features/13-continuous-improvement-loop.md` — Loop 1 section (implied by the loop having been fully dead-code undetected).
**Description:** Since Loop 1 was fully dead code without apparently being caught until this review, there is likely no test asserting the end-to-end effect (a user confirm/dismiss action measurably changes detector behavior/scoring going forward). Fix: after P0-A through P0-D (B13-1 through B13-4) are implemented, add an integration test asserting this causal chain actually holds.
**Why it matters:** Prevents Loop 1 from silently regressing back to dead-code status after being fixed — the same failure mode (built but not functioning, undetected) that caused this to be the flagship finding in the first place.
**Severity:** Medium
**Effort:** Small
**Confidence:** Medium — inferred from the absence-of-detection pattern, not an explicit source instruction.

### B13-10. Expose the T0-T4 autonomy tier prominently in whatever UI closes B13-5's gap
**Citation:** `features/13-continuous-improvement-loop.md` — Loop 2 section, `autonomy_policy.py` T0-T4 ladder.
**Description:** Specifically within the broader UI-gap fix (B13-5), the autonomy tier (T0 through T4) that governs how much independent action the loop can take on a given issue/patch should be a first-class, prominent piece of information in the UI — not buried. This is called out separately because it's the single most safety-relevant piece of state the UI needs to surface (how much autonomy is this specific action running under).
**Why it matters:** Operators need to be able to tell at a glance whether a given autonomous action was taken under a low-autonomy (heavily human-gated) or high-autonomy (near-fully-independent) tier, since the risk profile differs enormously between T0 and T4 — burying this in a UI that technically "shows the pipeline" but not this specific field would undercut the point of B13-5.
**Severity:** Medium
**Effort:** Small
**Confidence:** Medium — a specific implementation detail inferred as important within the broader B13-5 UI-gap fix, not separately named as its own bullet in the source.

### B13-11. Validate the auto-revert mechanism's trigger conditions are correctly tuned
**Citation:** `features/13-continuous-improvement-loop.md` — Loop 2 section, auto-merge/auto-revert pipeline.
**Description:** Given Loop 2 includes an auto-revert capability (automatically reverting a merged autonomous patch if it's later determined to be bad), and given the broader pattern in this review of components being built but not fully validated in production (mirroring Loop 1's fate), the doc's Loop 2 assessment implies auto-revert's trigger conditions (what counts as "bad enough to revert") warrant explicit validation/tuning review, distinct from the UI-visibility gap (B13-5).
**Why it matters:** An auto-revert mechanism that's too trigger-happy causes churn/instability; one that's not sensitive enough fails to catch genuinely bad autonomous patches — getting this tuning right is central to whether the autonomy ladder can be trusted at higher tiers (T3/T4).
**Severity:** Medium
**Effort:** Medium
**Confidence:** Low — this is a plausible inferred action based on the general pattern of the review rather than a specific bug or gap the source doc names for the revert mechanism itself.

---

## Source: `features/14-user-request-mining.md`

### B14-1. Build a portal UI for `topics`/`patterns_clusterer` (F65) — currently zero UI exists
**Citation:** `features/14-user-request-mining.md` — User Experience & Value section, `src/eden/topics/` + `patterns_clusterer.py` (F65).
**Description:** eden already has a real, working backend feature (F65) — `src/eden/topics/` combined with `src/eden/observability/patterns_clusterer.py` — that performs HDBSCAN-based trace clustering, functionally eden's own analog to "user request mining" (the competitor-market category researched in the rest of this doc). However, this feature has zero portal UI; it can only be accessed some other way (e.g., API/script), not through the product. Fix: build a portal view surfacing discovered topic clusters.
**Why it matters:** This is a fully-built backend capability that customers cannot actually use because there's no way to see it in the product — a pure UI-wiring gap sitting on top of otherwise-complete functionality, analogous to the artifacts/ledger routes gap in doc 15.
**Severity:** High
**Effort:** Medium
**Confidence:** High

### B14-2. Make topic clustering run on a background schedule, not on-demand only
**Citation:** `features/14-user-request-mining.md` — User Experience & Value section, scheduling gap.
**Description:** `patterns_clusterer.py`'s own docstring claims background-job scheduling, but in actual current behavior it only runs on-demand — the claimed scheduled/background execution doesn't happen. Fix: either implement actual background scheduling (e.g., periodic job via whatever eden's existing job/cron infrastructure is) to match the docstring's claim, or correct the docstring if on-demand-only is the intended final behavior.
**Why it matters:** A discovery feature like topic/pattern clustering is far more valuable running continuously in the background (so new emergent topics surface automatically) than requiring someone to remember to trigger it manually — the current gap between documented and actual behavior suggests this was an unfinished implementation, not an intentional design choice.
**Severity:** Medium
**Effort:** Medium
**Confidence:** High

### B14-3. Add trending detection to topic clustering output
**Citation:** `features/14-user-request-mining.md` — User Experience & Value section, missing capabilities list.
**Description:** The current F65 clustering output has no concept of "trending" (i.e., which topics/clusters are growing in volume/frequency recently vs. historically flat or declining). Fix: add a trend computation (e.g., comparing recent-window cluster volume against a longer baseline) to the clustering output/API, surfaced in the portal UI once B14-1 exists.
**Why it matters:** Without trending, users have to manually compare cluster sizes over time themselves to notice an emerging issue/request pattern — trending is typically the single most actionable signal in this category of feature (it's what tells a PM/support lead "look at this now").
**Severity:** Medium
**Effort:** Medium
**Confidence:** High

### B14-4. Add dedup to topic clustering output
**Citation:** `features/14-user-request-mining.md` — User Experience & Value section, missing capabilities list.
**Description:** The current clustering output has no deduplication — implying either duplicate clusters can appear across runs, or near-duplicate underlying traces/requests aren't collapsed within a cluster. Fix: add dedup logic (e.g., cluster-identity persistence across runs, or duplicate-trace collapsing within a cluster) matching the specific gap the source doc identifies.
**Why it matters:** Without dedup, users reviewing topic output may see redundant or fragmented views of what's actually a single underlying issue/request pattern, making the feature harder to act on and eroding trust in cluster counts as a genuine volume signal.
**Severity:** Medium
**Effort:** Medium
**Confidence:** High

### B14-5. Implement `action=alert` beyond its current stub
**Citation:** `features/14-user-request-mining.md` — User Experience & Value section, `action=alert` stub.
**Description:** There is an `action=alert` option/parameter in the topic-mining feature that is currently just a stub — it doesn't actually send an alert when invoked. Fix: implement real alerting behavior (e.g., notification via whatever eden's existing alerting/notification channel is) behind this action.
**Why it matters:** A stubbed alert action gives the false impression that proactive notification exists for emerging topics/requests when it doesn't — anyone configuring or relying on `action=alert` gets silently no alerts.
**Severity:** Medium
**Effort:** Small
**Confidence:** High

### B14-6. Add export capability for topic clustering results
**Citation:** `features/14-user-request-mining.md` — User Experience & Value section, missing capabilities list.
**Description:** There is currently no way to export topic/cluster results (e.g., to CSV, or to another system) from F65. Fix: add an export endpoint/button (likely alongside the portal UI work in B14-1) allowing results to be pulled out of eden for use elsewhere (reporting, sharing with product/support teams who may not have portal access).
**Why it matters:** Export is a common, low-effort, high-leverage feature for analytics/discovery tools — many teams' actual workflow for using this kind of data (sharing with stakeholders, feeding into other tools) requires getting the data out of the product, not just viewing it in-app.
**Severity:** Low
**Effort:** Small
**Confidence:** High

### B14-7. Correct or update the `patterns_clusterer.py` docstring to match actual behavior
**Citation:** `features/14-user-request-mining.md` — User Experience & Value section, scheduling gap (see also B14-2).
**Description:** Distinct from actually fixing the scheduling gap (B14-2), there's a lower-effort interim/parallel action: the docstring itself currently makes a claim (background scheduling) that's false about current behavior, which is actively misleading to any engineer reading the code to understand what it does. Fix: update the docstring to accurately reflect current on-demand-only behavior, regardless of whether/when B14-2 ships.
**Why it matters:** Inaccurate docstrings actively mislead engineers making changes near this code, independent of the scheduling feature gap itself — this is a quick, low-risk correctness fix that should not wait on the larger feature work.
**Severity:** Low
**Effort:** Small
**Confidence:** High

### B14-8. Position F65 explicitly against the competitor "user request mining" category in product messaging
**Citation:** `features/14-user-request-mining.md` — overall doc framing (competitor research + F65 as eden's analog).
**Description:** Given the bulk of the source doc is competitor market research (Langfuse/Arize/Helicone/LangSmith issue-mining features, HN skepticism threads on AI-fix reliability) establishing this as a real, validated product category, and given eden already has a working (if UI-less) analog in F65, there's a product-positioning action once B14-1 ships: explicitly message F65 as eden's answer to this category rather than leaving it undiscovered/unmarketed.
**Why it matters:** eden has already done the hard engineering work (HDBSCAN clustering) that competitors charge for as a distinct feature category — once the UI gap (B14-1) closes, capturing the positioning value requires deliberate messaging, not just shipping the UI silently.
**Severity:** Low
**Effort:** Small
**Confidence:** Medium — this is a reasonable product-marketing inference from the doc's framing, not an explicit build instruction in the source.

### B14-9. Incorporate the HN AI-fix-skepticism findings into how any auto-fix-suggestion UI (from B14-1 or elsewhere) is framed
**Citation:** `features/14-user-request-mining.md` — competitor research section, HN threads on AI-fix skepticism.
**Description:** The doc's research surfaces real user skepticism (from HN threads) about AI-generated fix suggestions in this product category — implying that if/when eden's topic-mining UI (B14-1) or related features (e.g., doc 13's autonomous patch loop) present AI-suggested fixes to users, framing/trust-building (e.g., showing confidence, evidence, or requiring explicit human review before action) matters more than raw AI-fix capability, per the researched market sentiment.
**Why it matters:** Building a feature that presents AI-generated fixes without accounting for documented user skepticism about this exact category risks lower adoption/trust even if the underlying suggestions are technically good — this is a UX-framing lesson from competitor research that should inform B14-1's design, not just its existence.
**Severity:** Low
**Effort:** Small
**Confidence:** Low — this is a speculative, indirect inference connecting competitor market research to a design recommendation for a not-yet-built UI; the source doc presents the research but doesn't explicitly prescribe this as a design mandate.

---

## Source: `features/15-artifacts-behavior-record.md`

### B15-1. Un-stub the `/artifacts` portal route
**Citation:** `features/15-artifacts-behavior-record.md` — portal wiring gap section.
**Description:** The `/artifacts` route in the portal is currently a dead stub that redirects to `/improve?mode=queue`, despite eden already having shipped the actual backend equivalent of Lemma's "Artifacts" feature (`nudges`/`ArtifactAuthor`/`ArtifactDemotionWorker`, GA-default-on, injected live into production prompts) and despite product copy already referencing this as a real feature. Fix: build the real `/artifacts` view backed by the existing API (which the doc confirms already exists), replacing the redirect stub.
**Why it matters:** This is a fully-built, GA-default-on production feature (already affecting live prompts) that customers cannot actually view or manage through the product UI — arguably worse than a feature gap, because the feature is actively running in production unobserved by the people it affects.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

### B15-2. Un-stub the `/ledger` portal route
**Citation:** `features/15-artifacts-behavior-record.md` — portal wiring gap section.
**Description:** Same pattern as B15-1: `/ledger` also redirects to `/improve?mode=queue` as a dead stub, despite the Ledger (`src/eden/kb/ledger/`) being a real, GA-default-on (`ledger_v1` flag) production system. Fix: build the real `/ledger` view backed by the existing Ledger API.
**Why it matters:** Same rationale as B15-1 — a live, production-affecting feature (the Ledger, which per the doc backs prompt injection via `BookGatewayFilter`) has no way for customers to see or audit what's in it, undermining transparency into a system actively shaping production prompts.
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

### B15-3. Wire `TriageAgent` to read from the Ledger
**Citation:** `features/15-artifacts-behavior-record.md` — gaps beyond portal routes section.
**Description:** `TriageAgent` (eden's triage/routing agent) currently does not read from the Ledger, despite the Ledger existing specifically to hold accumulated behavioral/context knowledge that would plausibly improve triage decisions. Fix: add Ledger-read integration to `TriageAgent`'s decision pipeline.
**Why it matters:** This is a missed opportunity to use already-built context infrastructure (the Ledger) to improve an existing agent's decision quality — the Ledger's value is partly measured by how many consumers actually use it, and currently a natural consumer doesn't.
**Severity:** Medium
**Effort:** Medium
**Confidence:** High

### B15-4. Build a team-uploaded-context feature
**Citation:** `features/15-artifacts-behavior-record.md` — feature gap section.
**Description:** There is currently no feature allowing a team to manually upload their own context (e.g., documentation, policy text, product knowledge) into the Book/Ledger/Artifacts system — all current content appears to be system-generated (from `ArtifactAuthor` etc.) rather than human-supplied. Fix: build an upload/ingestion path (UI + API) for teams to add their own context material into the same system that already injects content into production prompts.
**Why it matters:** A system that shapes live production prompts but can only be populated by automated processes (not by the humans who best understand their own product/domain) is missing a high-value, commonly-expected capability in this product category (compare to how competitor "artifacts"/context systems typically support manual curation).
**Severity:** Medium
**Effort:** Large
**Confidence:** High

### B15-5. Add a prompt-version-changed regeneration trigger
**Citation:** `features/15-artifacts-behavior-record.md` — feature gap section.
**Description:** There is currently no mechanism to trigger regeneration of artifacts/book content when the underlying prompt version changes. This means artifacts generated against an old prompt version may become stale or inconsistent once the prompt is updated, with nothing prompting a refresh. Fix: add a trigger (e.g., a hook on prompt-version bump) that flags or automatically regenerates affected artifacts.
**Why it matters:** Without this, artifacts can silently drift out of sync with the prompts they're meant to support/inject into, degrading quality over time as prompts evolve without corresponding artifact updates — a slow-burn data-quality issue.
**Severity:** Medium
**Effort:** Medium
**Confidence:** High

### B15-6. Build an MCP tool for Artifacts/Ledger/Book
**Citation:** `features/15-artifacts-behavior-record.md` — feature gap section.
**Description:** There is currently no MCP (Model Context Protocol) tool exposing the Artifacts/Book/Ledger system, meaning it can't be accessed/queried by MCP-compatible agent tooling. Fix: build an MCP tool surfacing read (and potentially write) access to this system, consistent with how eden exposes other functionality via MCP elsewhere (the doc references an existing MCP checkpoint/transcript tooling precedent from recent commits).
**Why it matters:** MCP tool support is increasingly the standard interface for agent tooling to access product context programmatically; without it, the Artifacts/Ledger system can only be used through the (currently also broken, per B15-1/B15-2) portal UI or direct API — missing a distribution channel that's become table-stakes for this category of feature.
**Severity:** Low
**Effort:** Medium
**Confidence:** Medium — the specific existence of an MCP precedent is confirmed context, but the priority/necessity of an MCP tool specifically for this feature is a reasonable but not explicitly emphasized recommendation in the source.

### B15-7. Create the `agent_artifact_context` table per the source's exact SQL
**Citation:** `features/15-artifacts-behavior-record.md` — schema section (exact SQL provided in source).
**Description:** The source doc provides exact SQL for a new `agent_artifact_context` table, presumably intended as the schema backing for the team-uploaded-context feature (B15-4) and/or richer per-agent artifact scoping. Fix: create this table per the provided SQL as a foundational step for B15-4 and related work.
**Why it matters:** Having ready-made schema SQL substantially lowers the effort bar for B15-4 and any related per-agent-context work — concrete, reviewable starting point rather than a design-from-scratch task.
**Severity:** Medium
**Effort:** Small
**Confidence:** High

### B15-8. Update product copy/marketing to accurately reflect what `/artifacts` and `/ledger` currently do (interim, pre-B15-1/B15-2)
**Citation:** `features/15-artifacts-behavior-record.md` — portal wiring gap section (implied by "product copy already existing" for a stubbed route).
**Description:** Since product copy already references Artifacts/Ledger as real features (per the doc) while the actual routes are dead stubs, there's an interim honesty/expectation-setting action distinct from the engineering fix (B15-1/B15-2): either temporarily adjust copy to not overclaim UI availability, or fast-track B15-1/B15-2 specifically because customer-facing copy is currently ahead of the shipped product.
**Why it matters:** Customer-facing copy describing a feature that, when clicked, redirects to an unrelated queue view is a direct, visible broken-promise moment for any customer who goes looking for it based on the copy — a credibility risk independent of the underlying engineering timeline.
**Severity:** High
**Effort:** Small
**Confidence:** Medium — the underlying fact (copy exists, routes are stubs) is High confidence per the source; the specific recommended interim copy action is an inferred mitigation, not explicitly instructed in the source.

### B15-9. Surface `ArtifactDemotionWorker` activity in the (to-be-built) `/artifacts` UI
**Citation:** `features/15-artifacts-behavior-record.md` — backend components section, `ArtifactDemotionWorker`.
**Description:** `ArtifactDemotionWorker` is named in the doc as one of the existing backend components (alongside `ArtifactAuthor`). Specifically within the B15-1 UI-build work, demotion activity (artifacts being demoted/removed from active injection) should be a visible part of the UI, not just creation/authoring — otherwise the UI would only tell half the artifact lifecycle story.
**Why it matters:** Understanding what's being demoted (and ideally why) is as important for trust/debuggability as understanding what's being created — an artifacts UI that only shows authoring without demotion history would be an incomplete picture of a system actively shaping production prompts.
**Severity:** Medium
**Effort:** Small
**Confidence:** Medium — a specific implementation detail reasonably inferred as necessary within B15-1's scope, not separately called out as its own bullet in the source.

### B15-10. Audit whether other GA-default-on features have similarly stubbed/misleading portal routes
**Citation:** `features/15-artifacts-behavior-record.md` — overall pattern (Artifacts and Ledger both independently found to have this exact issue).
**Description:** Given both `/artifacts` and `/ledger` independently turned out to be dead stubs despite backing GA-default-on production features, there's a reasonable concern that other portal routes may have the same "stub redirecting elsewhere despite a real, live feature behind it" pattern. Fix: audit portal routing config against the list of GA-default-on backend features to check for other instances of this pattern.
**Why it matters:** If this happened twice independently for two of eden's most consequential live-production features (Artifacts and Ledger both directly shape production prompts), the base rate for a third undiscovered instance elsewhere is non-trivial — worth a systematic check rather than assuming these two were the only cases.
**Severity:** Medium
**Effort:** Small
**Confidence:** Medium — inferred audit recommendation based on the pattern found twice in this doc, not an explicit instruction in the source.

---

## Source: `features/16-issue-extraction-online-evals.md`

*(Explicitly dependent on `features/13-continuous-improvement-loop.md`'s P0-A/P0-B being completed first — see B13-1/B13-2.)*

### B16-1. Implement composite issue ranking in `IssuesRepo.list_issues` (currently recency-only)
**Citation:** `features/16-issue-extraction-online-evals.md` — core finding, `IssuesRepo.list_issues`, exact rank-scoring SQL provided.
**Description:** `IssuesRepo.list_issues` currently sorts issues by recency only, despite eden already extracting and storing the raw ranking ingredients needed for a proper composite rank: severity, `user_count`, and `stumble_count`. These signals exist in the data but are never combined into an actual priority score. The source doc provides exact rank-scoring SQL to implement this. Fix: implement the composite ranking per the provided SQL, replacing (or supplementing as a sort option) the current recency-only ordering.
**Why it matters:** This is the doc's core finding — the single most consequential and highest-leverage fix in this document. Issues that are severe and affecting many users but happen to be older sink to the bottom of a recency-sorted list, meaning the highest-priority problems may not surface to whoever is triaging issues, directly undermining the entire point of issue extraction (surfacing what matters most).
**Severity:** Critical
**Effort:** Medium
**Confidence:** High

### B16-2. Fix `IssuePromoter._update` to actually escalate severity from `user_count`/`stumble_count`/`repetition_count`
**Citation:** `features/16-issue-extraction-online-evals.md` — code-comment-vs-behavior mismatch, `IssuePromoter._update`.
**Description:** `IssuePromoter._update` has a code comment claiming it escalates severity based on `user_count`, `stumble_count`, and `repetition_count` signals, but the actual implementation never does this escalation — the comment describes intended behavior that was never built (or was removed without updating the comment). Fix: implement the actual escalation logic the comment claims exists, using the three named signals.
**Why it matters:** This compounds B16-1 — even once ranking exists (B16-1), if severity itself never gets escalated as new evidence (repeated occurrences, more affected users) comes in, the severity input to that ranking stays artificially low/stale, undermining the value of B16-1's fix. Also a direct code-vs-comment correctness bug that could mislead future engineers into thinking this logic already works.
**Severity:** High
**Effort:** Medium
**Confidence:** High

### B16-3. Populate `IssueCard` DTO's `relatedSignalId` instead of hardcoding `None`
**Citation:** `features/16-issue-extraction-online-evals.md` — DTO bug, `IssueCard.relatedSignalId`.
**Description:** The `IssueCard` data-transfer-object's `relatedSignalId` field is currently hardcoded to always return `None`, regardless of whether an actual related signal exists. This breaks any downstream consumer (portal UI or otherwise) that expects to be able to navigate from an issue card to its underlying signal record. Fix: populate this field with the actual related signal ID from the underlying data model.
**Why it matters:** Breaks traceability from a surfaced issue back to the raw signal(s) that generated it — a core expectation for any triage workflow where a user wants to inspect "why was this flagged" and currently cannot navigate there from the issue card.
**Severity:** High
**Effort:** Small
**Confidence:** High

### B16-4. Add a Dismiss button to the portal issue view
**Citation:** `features/16-issue-extraction-online-evals.md` — portal gap section.
**Description:** The portal currently has no Dismiss button/action for issues, despite (per doc 13's Loop 1) a confirm/dismiss signal being the entire mechanism intended to feed back into detector quality improvement. Without a Dismiss action in the UI, users have no way to provide the "this isn't a real issue" signal at all, regardless of whether the backend loop (B13-1 through B13-4) is fixed. Fix: add a Dismiss button/action to the issue card/detail view, wired to whatever the correct backend dismiss endpoint is (or will be, post doc-13 fixes).
**Why it matters:** This is a hard blocker for Loop 1 (doc 13) ever actually working end-to-end in production usage — even a perfectly-fixed backend confirm/dismiss loop is useless if there's no UI affordance for a real user to actually dismiss an issue. This is the direct UI-side dependency the doc explicitly ties to doc 13's P0-A/P0-B.
**Severity:** Critical
**Effort:** Small
**Confidence:** High

### B16-5. Sequence B16-1/B16-2 implementation after doc 13's P0-A/P0-B (Loop 1 revival)
**Citation:** `features/16-issue-extraction-online-evals.md` — explicit build-sequence dependency on `13-continuous-improvement-loop.md`.
**Description:** The source doc explicitly states its recommended build sequence depends on `13-continuous-improvement-loop.md`'s P0-A and P0-B steps (B13-1, B13-2 in this document) being completed first. This is a sequencing constraint, not a standalone code fix: teams should not implement B16-1 (ranking) or especially B16-2 (severity escalation, which likely needs to consume the confirm/dismiss signal Loop 1 produces) before those prerequisite steps land.
**Why it matters:** Implementing ranking/escalation logic ahead of its prerequisite data pipeline being functional risks either building against incomplete/wrong data, or having to rework the logic once Loop 1 actually starts producing real confirm/dismiss signal data.
**Severity:** Medium
**Effort:** Small
**Confidence:** High — the dependency itself is explicitly stated in the source doc.

### B16-6. Add a way to view/filter issues by rank tier once B16-1 ships
**Citation:** `features/16-issue-extraction-online-evals.md` — User Experience & Value section (implied UI follow-on to B16-1).
**Description:** Once composite ranking exists (B16-1), the portal issue view should let users filter/sort by the new rank score (e.g., a "Top Priority" view or explicit rank-tier filter), not just implement the backend sort silently. Fix: add UI controls (sort toggle, tier filter/badges) surfacing the new ranking once it exists.
**Why it matters:** A backend ranking fix without a corresponding UI affordance to actually use/see the ranking (beyond default list order) under-delivers on the value of B16-1 — the whole point is helping a human triager quickly find what matters most, which benefits from an explicit visual/filterable signal, not just implicit list order.
**Severity:** Medium
**Effort:** Small
**Confidence:** Medium — a reasonable UI follow-on inferred from the ranking fix, not necessarily spelled out as its own bullet in the source beyond the User Experience & Value section's general framing.

### B16-7. Audit for other DTOs/fields with the same hardcoded-stub pattern as `relatedSignalId`
**Citation:** `features/16-issue-extraction-online-evals.md` — DTO bug section (pattern-level implication).
**Description:** Since `IssueCard.relatedSignalId` was found hardcoded to `None` despite apparently being intended to carry real data (B16-3), there's a reasonable chance other DTO fields in the issue-extraction/eval pipeline have similar stub-not-yet-wired patterns. Fix: review `IssueCard` and related DTOs for other fields that may be silently stubbed rather than fully wired.
**Why it matters:** The same class of bug (a DTO field silently hardcoded rather than genuinely populated) is easy to miss during code review since it type-checks and "works" (just always returns a default) — worth a broader pass once one instance is confirmed.
**Severity:** Low
**Effort:** Small
**Confidence:** Low — inferred audit suggestion from a single confirmed instance, not a specific additional finding in the source.

### B16-8. Correct or remove the misleading code comment in `IssuePromoter._update`
**Citation:** `features/16-issue-extraction-online-evals.md` — code-comment-vs-behavior mismatch (see also B16-2).
**Description:** Distinct from implementing the actual escalation logic (B16-2), there's a lower-effort interim action: the existing comment in `IssuePromoter._update` claiming severity escalation already happens is currently false and should be corrected or removed regardless of the timeline for B16-2's full fix, so engineers reading the code aren't misled in the meantime.
**Why it matters:** Same rationale as B14-7 (docstring accuracy) — a misleading comment actively misinforms anyone reading the code about current behavior, independent of when the real fix ships.
**Severity:** Low
**Effort:** Small
**Confidence:** High

### B16-9. Wire the new Dismiss action (B16-4) to also emit the signal Loop 1's P0 fixes expect to consume
**Citation:** `features/16-issue-extraction-online-evals.md` — portal gap section, synthesized with doc 13's Loop 1 dependency (B16-5).
**Description:** Called out separately from B16-4 because it's a specific integration-correctness requirement: the new Dismiss button shouldn't just remove/hide the issue in the UI — it needs to write the dismiss signal in the exact shape/location that Loop 1's revived pipeline (post B13-1/B13-2) expects to read from, per the source's explicit dependency note (B16-5). Fix: coordinate the Dismiss button's backend call with whatever data contract Loop 1's P0-A/P0-B establish.
**Why it matters:** If the Dismiss button is built independently of Loop 1's actual signal contract, it risks becoming another instance of "looks like it works in the UI but doesn't actually feed the intended downstream system" — the exact class of disconnect this entire pass-4 review repeatedly found (e.g., doc 11's portal wiring gap, doc 15's stub routes).
**Severity:** High
**Effort:** Small
**Confidence:** Medium — the integration risk is a reasonable inference from the explicitly-stated dependency (B16-5), not a separately named bullet in the source itself.

---

**Total extracted points: 79**
(09: 8, 10: 8, 11: 10, 12: 14, 13: 11, 14: 9, 15: 10, 16: 9)
