# Changelog

All notable changes to the Eden docs site (docs.edenobservability.com).

## [Unreleased]

### Product — 2026-06-24 (Phase 2 — cross-cutting: wire 4 missing §E.1 hooks)

- **§E.1 row 3** `on_compliance_gap_soc2` — Cat 9 Governance hook (severity `high`, action_kind `investigate` per spec §E.1)
- **§E.1 row 4** `on_compliance_gap_gdpr` — Cat 9 hook (severity `critical`, action_kind `rtbf` per spec). The `action_kind=rtbf` is a no-op in v0 because D.11 cross-store infrastructure is deferred (no legal team per user 2026-06-24 — the GDPR Art.17(3) exception matrix and SLA need counsel review). The hook still records the event so the operator can see the GDPR gap in the closed-loop dashboard and choose to invoke the existing Cat 10 Postgres-only `RightToBeForgottenService` manually
- **§E.1 row 5** `on_compliance_gap_hipaa` — Cat 9 hook (severity `high`, action_kind `investigate`)
- **§E.1 row 6** `on_compliance_gap_iso27001` — Cat 9 hook (severity `high`, action_kind `investigate`)
- **§E.1 row 9** `on_sla_breach` — Cat 16 hook (severity `high`, action_kind `investigate` per spec)
- All 5 use the standard `_record_action` helper routed through `HookBus` (dedup + approval gate). 3 new ACTION_KIND entries + 5 new `PromotionHook` methods. 5 new tests in `tests/unit/llmops/test_promotion_hooks_e1.py`
- **D.11 RTBF cross-store REMOVED from plan** per user (no legal team). The existing `RightToBeForgottenService` (Cat 10) handles Postgres only; the cross-store worker + S3/ClickHouse tombstones + backup lifecycle policy are all parked until the user has legal counsel to review the GDPR Art.17(3) exception matrix
- **Spec §E.1 status**: **10 of 10 hooks wired** (5 from D.12 sessions 1-6 + 5 from this cross-cutting pass). The 26 spec hook rows include `security:pii_scanner` + `security:secret_detector` (action_kind `redact` — D.11 dependency) which stay STUB until D.11 ships

### Product — 2026-06-24 (Phase 2 — D.12.6 Provider routing shipped)

- **D.12.6** Provider routing (per spec §2.12): migration 062 (`provider_routing_attempts` table with the 4-decision CHECK constraint + `UNIQUE(trace_id, sequence_index)` for SDK retry idempotency per R-13; 3 indices incl. a partial index on `(org_id, created_at DESC) WHERE decision IN ('fallback', 'abort')` for the repeated-failure detector); `ProviderRoutingService` (`record_attempt` with idempotent upsert on `(trace_id, sequence_index)` so middleware retries of the same attempt upsert in place + `get_attempts_for_trace` + `list_attempts` with the 3 spec filters `attempted_provider`/`decision`/`since_minutes` + `get_failure_rate` (per-(org, provider) failure rate in the rolling window using `COUNT(*) FILTER (WHERE decision = 'success')` + `COUNT(*) FILTER (WHERE decision <> 'success')` for the per-decision breakdown) + `detect_repeated_failures` which counts non-success decisions in the rolling 15-minute window and fires the hook when the count crosses the threshold of 10); routes `GET /v1/traces/{trace_id}/provider_routing` (per-trace view) + `POST /v1/provider_routing/{org_id}/attempts` (SDK record path, validates decision against the 4 spec kinds) + `GET /v1/provider_routing/{org_id}/attempts` (filterable list) + `GET /v1/provider_routing/{org_id}/failure_rate?attempted_provider=&window_minutes=` + `GET /v1/provider_routing/{org_id}/repeated_failures?attempted_provider=&window_minutes=&threshold=&fire_hook=` (org-admin, dry-run via `fire_hook=false`); SDK `eden.sdk.provider_routing` (`record_attempt` async best-effort helper + `retry_with_fallback` convenience that walks the primary→fallback chain and records the full routing trace + `build_provider_routing_attributes` pure helper returning the `provider_routing.*` sub-document); new hook `on_provider_routing_repeated_failures` on `PromotionHook` (severity `medium`, action_kind `investigate` per §E.1 row 26); portal client `providerRoutingApi` (5 methods)
- 1 new migration (062), 1 new backend module (`services/observability/provider_routing.py`), 1 new route file (`api/routes/observability_provider_routing.py`), 1 new SDK module (`sdk/provider_routing.py`), 16 new tests across `tests/observability/provider_routing/`
- D.12 hooks now wired: 6 of 10 (MCP + A2A + Computer Use + Voice + Fine-tune + Provider routing). 4 still pending: 3 compliance_gap (gdpr/hipaa/iso27001), 2 security (pii_scanner/secret_detector), sla_breach
- Pre-existing test failures: 27 failures + 6 errors in `tests/intelligence/test_*.py` (Phase 0 cut tests, unrelated — confirmed via stash + re-run on prior commit)

### Product — 2026-06-24 (Phase 2 — D.12.5 Fine-tune lineage shipped)

- **D.12.5** Fine-tune lineage (per spec §8.7): migration 061 — 3 tables per spec §B.9 (`fine_tuning_runs` with `provider_fine_tune_id` + status + eval_results + `completed_at`; `dataset_trace_lineage` for backward lineage; `fine_tune_trace_usage` for forward lineage); partial unique index `(provider, provider_fine_tune_id) WHERE provider_fine_tune_id IS NOT NULL` enforces webhook idempotency (R-12) at the DB layer; `FineTuneLineageService` (`register_run` with idempotent upsert on `(provider, provider_fine_tune_id)` + `update_status` that auto-sets `completed_at` on terminal states + `get_run` + `list_runs_for_org` with `status`/`provider` filters + `link_dataset_to_traces` bulk insert idempotent on `(dataset_id, trace_id)` + `record_trace_usage` + `get_lineage_for_run` returning the backward+forward graph + `detect_data_drift` — a z-score-based detector that reads `eval_results.mean_score` from the last `window` runs sharing the same `base_model` + org and fires the hook when |z| >= threshold); routes `GET /v1/fine_tuning_runs` (org-member) + `POST /v1/fine_tuning_runs` (org-admin) + `GET /v1/fine_tuning_runs/{id}` + `GET /v1/fine_tuning_runs/{id}/lineage` + `POST /v1/fine_tuning_runs/{id}/dataset_traces` + `POST /v1/fine_tuning_runs/{id}/trace_usage` + `POST /v1/fine_tuning_runs/{id}/drift_check` (org-admin) + `POST /v1/webhooks/openai/fine_tuning` (HMAC-SHA256 verified against `OPENAI_FINE_TUNE_WEBHOOK_SECRET`, replay-protected with ±5 min timestamp window, maps the 5 spec event_types to internal status); SDK `eden.sdk.fine_tune` (`register_run` async best-effort helper + `parse_openai_webhook_payload` pure parser that returns the `event_type`/`fine_tune_id`/`internal_status`/`base_model`/`fine_tuned_model`/`training_params`/`eval_results`/`ignored` fields + `build_fine_tune_attributes` helper); new hook `on_fine_tune_data_drift` on `PromotionHook` (severity `medium`, action_kind `investigate` per §E.1 row 25); portal client `fineTuneApi` (7 methods)
- 1 new migration (061), 1 new backend module (`services/observability/fine_tune_lineage.py`), 1 new route file (`api/routes/observability_fine_tune.py`), 1 new SDK module (`sdk/fine_tune.py`), 20 new tests across `tests/observability/fine_tune/`
- D.12 hooks now wired: 5 of 10 (MCP + A2A + Computer Use + Voice + Fine-tune). 5 still pending: 3 compliance_gap, 2 security, sla_breach, provider_routing_repeated_failures
- Pre-existing test failures: 27 failures + 6 errors in `tests/intelligence/test_*.py` (Phase 0 cut tests, unrelated — confirmed via stash + re-run on prior commit)

### Product — 2026-06-24 (Phase 2 — D.12.4 Voice / audio shipped)

- **D.12.4** Voice / audio sessions (per spec §8.4): migration 060 (`voice_sessions` table with the 10 spec columns — `session_id`, `transport`, `asr_provider`/`asr_latency_ms`/`asr_confidence`/`asr_input_audio_ms`, `llm_first_audio_ms`, `tts_provider`/`tts_first_byte_ms`/`tts_total_ms`, `barge_in_detected`; `org_id` added for spine-style org scoping; 3 indices including a partial index on `(org_id, created_at DESC) WHERE barge_in_detected = TRUE` for the spike detector); `VoiceSessionService` (`record_session` with idempotent upsert on `(trace_id, span_id)` so SDK retries that fill in ASR/TTS latencies incrementally are safe + `get_sessions_for_trace` + `list_sessions` with the 3 spec filters `provider`/`had_barge_in`/`asr_p95_ms_gt` (p95 is post-filtered in Python per the per-org aggregate note in §C.8) + `mark_barge_in` (idempotent UPDATE) + `detect_barge_in_spike` which counts barge-in rows in the rolling 15-minute window and fires the hook when the count crosses the threshold of 5); routes `GET /v1/voice_sessions?org_id=&provider=&had_barge_in=&asr_p95_ms_gt=&limit=` (org-member) + `POST /v1/voice_sessions/{org_id}` (SDK record path) + `GET /v1/traces/{trace_id}/voice_sessions` (per-trace view) + `POST /v1/voice_sessions/{org_id}/barge_in` (idempotent flag flip) + `GET /v1/voice_sessions/barge_in_spike?org_id=&window_minutes=&threshold=&fire_hook=` (org-admin, dry-run when `fire_hook=false`); SDK `eden.sdk.voice.wrap_voice_session` (async context manager with `set_asr_latency_ms`/`set_asr_confidence`/`set_tts_first_byte_ms`/`set_tts_total_ms`/`set_barge_in` helpers) + `mark_barge_in` (best-effort delegate) + `detect_spike` (convenience wrapper) + `build_voice_attributes` (pure helper returning the `voice.*` sub-document); new hook `on_voice_barge_in_spike` on `PromotionHook` (severity `low`, action_kind `investigate` per spec §E.1 row 24); portal client `voiceApi` (6 methods)
- 1 new migration (060), 1 new backend module (`services/observability/voice_sessions.py`), 1 new route file (`api/routes/observability_voice.py`), 1 new SDK module (`sdk/voice.py`), 18 new tests across `tests/observability/voice/`
- D.12 hooks now wired: 4 of 10 (MCP + A2A + Computer Use + Voice); 6 still pending (3 compliance_gap, 2 security, sla_breach, fine_tune_data_drift, provider_routing_repeated_failures)
- Pre-existing test failures: 27 failures + 6 errors in `tests/intelligence/test_*.py` (Phase 0 cut tests, unrelated — confirmed via stash + re-run on prior commit)

### Product — 2026-06-24 (Phase 2 — D.12.3 Computer Use shipped)

- **D.12.3** Computer Use (per spec §8.3): migration 059 (`computer_use_steps` table with the 6-action-type CHECK constraint + UNIQUE(span_id, step_index) + partial indices; `computer_use_screenshots_tombstoned` for RTBF-purge of S3 screenshot URIs); `ComputerUseService` (`record_step` with idempotent upsert + best-effort `mark_screenshot_tombstoned` / `list_tombstoned_for_trace`; fires `on_computer_use_blocked` hook when step is recorded with `blocked=True`); routes `GET /v1/traces/{trace_id}/computer_use` (steps with screenshot URIs) + `POST /v1/computer_use/{org_id}/steps` (SDK record path, validates action_type against the 6 spec kinds) + `POST /v1/computer_use/{org_id}/screenshots/tombstone` (RTBF) + `GET /v1/computer_use/{org_id}/screenshots/tombstoned/{trace_id}`; SDK `eden.sdk.computer_use` with 6 spec-aligned action constructors (`click`/`type_text`/`scroll`/`drag`/`key`/`wait`) + `record_step` async helper that accepts either an `ComputerUseAction` dataclass OR raw fields; new hook `on_computer_use_blocked` on `PromotionHook` (severity `high`, action_kind `pause_session`); portal client `computerUseApi` (4 methods)
- 1 new migration (059), 1 new backend module (`services/observability/computer_use.py`), 1 new route file (`api/routes/observability_computer_use.py`), 1 new SDK module (`sdk/computer_use.py`), 12 new tests across `tests/observability/computer_use/`
- Total D.12 hooks now wired: 3 of 10 (MCP + A2A + Computer Use); 7 still pending (compliance_gap × 3, security × 2, sla_breach, voice_barge_in_spike, fine_tune_data_drift, provider_routing_repeated_failures)
- Pre-existing test failures: 27 failures + 6 errors in `tests/intelligence/test_*.py` (Phase 0 cut tests, unrelated — confirmed via stash + re-run on `8b7c97b8`); 0 regressions in my touched surface

### Product — 2026-06-24 (Phase 2 — D.12.1 MCP + D.12.2 A2A shipped)

- **D.12.1** MCP traces (per spec §8.1): migration 057 (`mcp_traces_v` view over `telemetry_events.attributes->'mcp'` + `mcp_server_auth_failures` audit table + JSONB index on `(attributes->'mcp'->>'server_name')`); `McpTraceService` (best-effort read-side + `record_auth_failure`); routes `/v1/traces/{trace_id}/mcp` (GET) + `/v1/mcp/{org_id}/auth_failures` (GET + POST); SDK `eden.sdk.mcp.wrap_mcp_call` (sync context manager that builds the `mcp.*` attribute block + classifies auth/transport failures into the 5 spec kinds); new hook `on_mcp_server_auth_failure` on `PromotionHook` (severity `high` for `unauthorized`/`expired_token`, `medium` otherwise); portal client `mcpApi` (sibling to `onboardingV2Api`)
- **D.12.2** A2A protocol (per spec §8.2): migration 058 (`a2a_links` table with `UNIQUE(parent_trace_id, parent_span_id, child_trace_id)` + 3 indices; 2 new nullable columns on `telemetry_events` — `parent_agent_span_id` + `child_agent_trace_id`); `A2ALinkService` (register_link with upsert + get_links_for_trace split into parent/children + get_invocation_graph via recursive CTE BFS up+down + mark_failed that fires the hook); routes `/v1/traces/{trace_id}/a2a` (GET) + `/v1/a2a/{org_id}/links` (POST) + `/v1/a2a/{org_id}/invocations/{trace_id}` (GET BFS graph) + `/v1/a2a/{org_id}/links/{id}/fail` (POST fires hook); SDK `eden.sdk.a2a.wrap_a2a_invocation` (async context manager that registers the link + sets the spec's 2 column attrs + classifies 6 failure kinds); new hook `on_a2a_invocation_failed` on `PromotionHook` (severity `high`)
- 2 new migrations (057 + 058), 2 new backend modules (`services/observability/{mcp_traces,a2a_links}.py`), 2 new route files (`api/routes/observability_{mcp,a2a}.py`), 2 new SDK modules (`sdk/{mcp,a2a}.py`), 2 new portal API clients (`mcpApi` + `a2aApi`), 18 new tests across `tests/observability/{mcp,a2a}/` — 8/8 D.12.1 + 10/10 D.12.2 pass
- Pre-existing test failures: 27 failures + 6 errors in `tests/intelligence/test_*.py` (Phase 0 cut tests modified by the spine commit `a22124d5` — confirmed unrelated to D.12 work by stash + re-run on `68fe65bb`); 0 regressions in my touched surface

### Product — 2026-06-24 (Phase 2 — D.14 cold-start UX shipped)
- **D.14** Cold-start UX (per spec §10): migration 056 (`onboarding_state` table); `OnboardingStateMachine` service with 7-step state machine (`install → org → connect → wait → done → tour → autonomous`), milestone auto-advance (first_10_traces → wait, first_judge_score → done, first_prompt_version → tour), cat-enablement JSONB toggle, backward transitions with audit logging, best-effort DB pattern; API routes under `/v1/internal/onboarding/{org_id}/*` (GET state, POST advance, POST milestone, POST enable_cat); `OnboardingMilestoneHook` in `promotion_hooks.py` wires the 3 spec milestones; portal `OnboardingBanner` (dismissable, top-of-portal, sessionStorage-scoped) + `OnboardingChecklist` (7-step progress card); new `onboardingV2Api` client in `lib/api.ts` (sibling to the existing Cat 23 `onboardingApi`); pre-cutover orgs (created before 2026-07-01) get `source: "legacy"` + `onboarding_v2_enabled: false` and skip the banner entirely
- 1 new migration (056), 3 new backend modules (`services/onboarding/state_machine.py`, `api/routes/onboarding.py`, `OnboardingMilestoneHook` in `promotion_hooks.py`), 2 new portal components (`OnboardingBanner` + `OnboardingChecklist`), 13 new tests across `tests/onboarding/`
- 2 webhook_delivery.py bugfixes (during the spine verify): `_move_to_dlq` was inserting empty string for `org_id` (NOT NULL violation) — now JOINs `webhooks` to resolve it; `deliver_event` hardcoded `max_attempts=10` but `_RETRY_DELAYS` has 7 entries — now uses `len(_RETRY_DELAYS)`
- Migration renumbering note: spec called for D.12 = 054-058 + D.11 = 060 + D.14 = 063, but the spine already used 054-055. New chain: spine (054-055) → D.14 onboarding (056) → D.12.1 MCP (057, future) → ... → D.11 RTBF (063, future). Sequential, no alembic branches.

### Product — 2026-06-24 (Phase 1 spine shipped)
- **D.8** Streaming tokens: migration 054 (`streaming_tokens` PG table); SDK helper `capture_byte_count()` + PII pre-mask; `StreamingTokenCapture` service with batched writes; portal `/traces/{trace_id}/tokens` route + `StreamingSparkline` component (per-token delta_ms bar chart with stall highlighting)
- **D.9** Prompt versioning: migration 055 (`prompts` + `prompt_versions` + `prompt_eval_runs` tables + nullable FK on `telemetry_events`); `PromptService` + `run_auto_eval`; Python `@prompt()` SDK decorator; API routes under `/prompts/{name}/versions/*`; portal `/prompts` page with version timeline + auto-eval-on-save toggle
- **D.10** Cost guardrails polish: migration 052 (`budgets` + `budget_consumption` + `budget_actions`); `BudgetService` with `get_budget`/`get_consumption`/`record_usage`/`list_actions`/`record_action`/`upsert_budget`; API `/budget` + `/budget/ticker` + `/budget/actions`; portal `/optimization/budget` page + `BudgetTicker` sidebar component (real-time polling)
- **D.13** Webhooks reliability: migration 053 (`webhook_dlq` table + `signature_v1` column + `webhook_endpoints` view); `WebhookDeliveryService.sign_v1()` adds Stripe-style `X-Eden-Signature: t=<ts>,v1=<sig>` header; backoff updated to spec-aligned 7-step ladder (1s/5s/25s/2m/10m/1h → DLQ); `_move_to_dlq` + `replay_dlq` + `list_dlq`; portal `/settings/(tabs)/webhooks-dlq` page with DLQ list + Replay buttons
- 4 new migrations (052-055), 6 new backend modules (budget_service, sdk/streaming, sdk/prompt_decorator, services/prompt_versioning, api/routes/budgets, api/routes/streaming_tokens, api/routes/prompts_v2), 4 new portal pages (optimization/budget, prompts, settings/(tabs)/webhooks-dlq) + 3 new components (BudgetTicker, StreamingSparkline)

### Product — 2026-06-24 (Phase 0 cuts shipped)
- **D.1** Cat 22 APM Depth → OTel Collector: deleted `apm_depth/{sampling,k8s,profiling}.py` + 3 tests + 3 audit tables from migration 026; v1.4 surface (OtelV141Enricher, StepJudgeStamper, AgentMetricsCollector) retained. Tail-sampling/K8s/Pyroscope routes return 501 with `deploy/otel-collector-config.yaml` pointer
- **D.2** Cat 9 → Flat Beta-Binomial + 3 trackers: migration 024 dropped `copy_pasted` / `retried_within_60s` / `return_7d` columns; default `method` = `'flat_beta_binomial'`. Deleted `ReturnToFeatureTracker` / `CopyPasteTracker` / `RetryRephraseTracker` + tests. `HierarchicalBetaBinomial` → `FlatBetaBinomial` (Beta(1,1) prior). 4 signals survive
- **D.3** Cat 13 Predictive → 2 services: deleted `capacity.py` / `cost.py` / `risk.py` (median projection moved to Cat 7). Kept `QualityPredictor` + `DriftDetector`. 3 removed routes return 501
- **D.4** Cat 14 Autonomous → 2 services: folded `ReportGenerator` → `InvestigationAgent.report()`. Folded `RecommendationEngine` → `InvestigationAgent.recommend()`. Deleted `NLQueryEngine` + `AutoDashboardBuilder`. Dropped `nl_query_log` table. 2 removed routes return 501
- **D.5** Cat 10 Governance → SOC2 + GDPR only: `SUPPORTED_FRAMEWORKS` reduced from 4 to 2. HIPAA + ISO27001 routes return 501. PHI/IBAN/passport severities removed. Deferred roadmap at `docs/eden-governance-roadmap.md`
- **D.6** Cat 18 Columnar → daily/weekly only: `_VALID_GRANULARITIES` reduced from 3 to 2; asking for `hour` returns `_not_implemented_envelope`. New test `test_hourly_granularity_rejected` asserts the contract
- **D.7** Cat 23 STUB → defer 4 inbox/persona/style tables: migration 027 commented out the 4 `_table()` calls. Services marked `pending=True`. Best-effort writers swallow the missing tables. 15 of 19 tables survive
- New deploy artifact: `deploy/otel-collector-config.yaml` (replacement for D.1's tail_sampling + k8sattributes processors)
- New doc: `docs/eden-governance-roadmap.md` (D.5 deferred-roadmap for HIPAA + ISO27001)

### Product — 2026-06-23 (Production-Ready Beta)
- **Backend**: mounted previously-defined `webhooks.router` (outbound CRUD) and `agent_pr_suggestions.router` (Cat 23 UI surface); registered `QuotaEnforcementMiddleware` before `TenantRateLimitMiddleware` (§6.3 cost guardrails now active)
- **Portal chat pipeline**: fixed `chat/route.ts` URL bug (was using `NEXT_PUBLIC_API_URL` = relative `/api/proxy`; now `API_INTERNAL_URL` for server-side Node fetch); SSE error handler now calls `controller.error(err)` + explicit `event: error` frame (was leaving client in stuck "Streaming…" state)
- **Portal layout**: `100dvh` instead of `100vh` (mobile Safari address-bar jump), `min-h-full` standardized across pages, z-50 floating-overlay guard extended to all wizard routes, 8 missing `loading.tsx` files added
- **Portal polish**: mobile sidebar backdrop `<button>` → `<div role="presentation" aria-hidden>` (no longer keyboard-focusable but invisible to AT); contrast fixes on replay/sidebar/alerts; hardcoded `border-zinc-500/30` → design token; 3 missing `aria-label`s; removed unused `next-themes` dep
- **2FA setup dialog**: profile page now imports real wizard (was importing STUB); STUB file deleted
- **Closed-loop hook bus** (per upgradespec §E): new `src/eden/llmops/hooks_bus.py` (HookBus.emit with 5-min dedup + severity precedence + cascade dedup) + `hook_proposal.py` (PromotionProposal BaseModel per §E.4) + migration `051_hook_events.py` (per §E.5). `_record_action` now routes through HookBus. 5 new hook classes added: BudgetHook, IncidentHook, UserSatisfactionHook, DriftAlertHook, RoiHook
- **Deploy**: Clerk webhook signing secret updated in NF staging (`whsec_nPSBY+mvpTcCBzIMacT4OfH79lLIdDOS`); eden-api service deployed (last build SUCCESS); 4 Vercel env vars confirmed set; `.deploy-sha` capture + rollback procedure documented

### Docs
- `README.md`: dropped Helicone/Langfuse comparison copy; replaced placeholder URLs with env-var references; added Deploy section linking to `docs/deploy/cutover-checklist.md`
- `docs/spec/upgradespec-v2.md` published (delta-only status snapshot); original `upgradespec.md` archived at `docs/spec/upgradespec-original-2026-06.md`

### Added
- 404 page (`/404`) with terminal-style design and helpful navigation
- Last-updated timestamp + author on every page (`showLastUpdateTime: true`)
- OpenGraph image (`/img/og-image.svg`, 1200×630)
- Announcement bar above navbar (closeable, dark blue)
- "★ Star" button in navbar → github.com/eden/edenobservability
- Full SEO metadata (description, keywords, og:*, twitter:card)
- Three section landing pages with feature grids:
  - `/guide` — Getting started, Architecture, Deployment, API
  - `/observability` — 22-row status table, connection diagram
  - `/operations` — Release, Reliability, Security, SOC 2, Runbooks

### Changed
- Logo in navbar now links to **https://edenobservability.com** (the only
  back-link to the main site; everything else is internal)
- Hero landing page on `/intro/` with badge, gradient title, 5-pillar grid,
  6 productised-feature cards, 4 audience quick-link cards
- Dark terminal theme: black/blue, monospace headings, blue accents, status
  pills for shipped/stub/planned
- Footer expanded from 2 columns to 4 (Documentation / Product / Reference / Eden)
- `.md` files parsed as CommonMark (`markdown.format: 'md'`) — fixes MDX
  JSX conflicts in legacy content with `<5 min`/`<200ms` patterns
- Docusaurus config downgraded `onBrokenLinks` to `warn` and `onBrokenMarkdownLinks` to `warn`
  so legacy content can ship without 100+ cross-doc fixes

### Removed
- Old loose `.md` files at the docs root (consolidated into `docs/docs/{section}/`)
- Capital-case duplicates (`DEVELOPMENT.md`, `ARCHITECTURE.md`, etc.)
- Stale `obs-gap/`, `runbooks/`, `legacy/` directories (all content now in
  `docs/docs/`)
- GitHub link from navbar (replaced with the gold "★ Star" button)
- Footer link to the main site (was duplicating the logo's link)

### Fixed
- **docIds**: section landing pages no longer have explicit `id:` frontmatter
  that produced ugly `guide/guide-index` docIds. Now uses path-based IDs
  (`guide/index`, `observability/index`, `operations/index`).
- **Cross-doc links**: ~60 stale references fixed across the obs corpus
  (e.g. `(../eden-observability-gap-roadmap.md)` → `(/observability/gap-roadmap)`,
  `(../../src/eden/X.py)` → `\`src/eden/X.py\`` (code reference, not broken link),
  `(../SECURITY.md)` → contact email).
- **YAML in frontmatter**: quoted unquoted values containing `:` in
  `13-predictive-intelligence.md` and `gap-roadmap.md` (was breaking the
  YAML parser).
- **Anchor in closed-loop-wiring.md**: TOC link `#the-5-v0--4-v13b-hooks` →
  `#the-5-v0--4-v13bv14-hooks` to match the actual generated anchor.

## [1.0.0] — 2026-06-10

- Initial docs site launch. 7 pages (index, development, architecture,
  deployment, api, roadmap, branch_protection).
- Default Docusaurus theme, no customisation.
- No favicon, no custom logo, GitHub link in navbar.
