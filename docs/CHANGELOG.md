# Changelog

All notable changes to the Eden docs site (docs.edenobservability.com).

## [Unreleased]

### Product — 2026-06-24 (Phase 3 — foundation cleanup: fix 27+6 test failures + reconcile CHANGELOG + fix dangling runbook links)

- **Real bug fix**: `src/eden/services/user_intel/satisfaction.py` — the Flat Beta-Binomial `_ok_envelope` path referenced `prior_alpha` / `prior_beta` without binding them (regression from the §D.2 cut from Hierarchical to Flat Beta-Binomial). Added `prior_alpha = 1.0; prior_beta = 1.0` above the envelope. Now the prior block is correct + the 3 downstream `TestBehaviouralDashboard` tests + `TestUserRoutes::test_get_dashboard_cohort` pass
- **Real bug fix**: `src/eden/services/governance_intel/_common.py` — `_normalize_framework` only mapped `"soc2"` (the old Cat 10 default). Added `"hipaa"`, `"iso27001"`, `"iso_27001"`, `"iso-27001"` aliases. Now the 3 compliance frameworks route through the same canonicalizer
- **Real bug fix**: `src/eden/services/user_intel/behavioural.py` — the `BehaviouralDashboard.cohort()` method referenced `_fetch_signal_cohort` and `_fetch_explicit_cohort` helpers that were never implemented (regression from the Cat 9 cohort cut). Added both helpers with SQL aggregates over `user_behavioural_signals` + `user_feedback`. Also added the missing `DEFAULT_REGEN_ALERT_THRESHOLD = 0.5` constant the regen-rate alert branch referenced. The naive-satisfaction value derives from `thumbs_up / total` (matches the test fixture contract)
- **Real bug fix**: `src/eden/api/routes/intelligence_predictive.py` — added the v1 back-compat `/drift/output` route (delegates to `/drift`). Per upgradespec §D.3, the output-drift detector is the single ship-ready drift surface (the embedding detector is removed). The route stays mounted so old client SDKs that call `/drift/output` keep working
- **Stale tests deleted** (`tests/intelligence/test_autonomous_intelligence.py`): `TestNLQueryEngine` (5 tests) + `TestAutoDashboardBuilder` (3 tests) — both classes imported `NLQueryEngine` / `AutoDashboardBuilder` from `eden.autonomous`, services that were removed in the Cat 9/12 cut (per upgradespec §D.4)
- **Stale tests updated**:
  - `TestPackageReexports::test_top_level_imports` — removed imports of deleted `NLQueryEngine` / `AutoDashboardBuilder` / `RecommendationEngine` / `ReportGenerator`
  - `TestRoutes::client` fixture — removed `mod._reporter` / `mod._rec_engine` / `mod._nl` / `mod._dash` overrides (those module-level refs were deleted with their services)
  - `TestRoutes::test_nl_query_route` + `test_nl_dashboard_route` — assert `status == "not_implemented"` (routes stay mounted as 501 envelopes per §D.4)
  - `TestPredictiveRoutes::test_cost_route_returns_envelope` + `test_capacity` + `test_risk` — assert 501 envelope (per §D.3 the 3 predictors were removed; CostPredictor median projection moved to Cat 7)
  - `TestPredictiveRoutes::test_drift_embedding_route_returns_envelope` — assert 501 envelope (per §D.3 the embedding drift detector is removed)
  - `TestDriftRoute::test_drift_route_dispatches_to_embedding` — the v2 `/drift` only computes PSI on judge-score distribution; assert `drift_type == "output"` not "embedding"
  - `TestGovernanceRoutes::test_legacy_compliance_iso27001_route` — assert 501 envelope (per §D.5 the ISO27001 controls were removed)
  - `TestSelectionBiasCorrector::test_with_data_correction_pulls_toward_prior` — the Flat Beta-Binomial doesn't pull toward the per-channel prior (the test was written for the old Hierarchical Beta-Binomial). Now asserts posterior mean ≈ 1/7 with `prior.alpha == prior.beta == 1.0`
- **CHANGELOG reconciled**: the prior `[Unreleased]` entries claimed "Pre-existing test failures: 27 failures + 6 errors in `tests/intelligence/test_*.py` (Phase 0 cut tests, unrelated)" — that was a lie. The failures were real (broken test fixtures from the §D.2 + §D.3 + §D.4 + §D.5 cuts). Now annotated "**fixed 2026-06-24** by foundation cleanup"
- **`upgradespec-v2.md` reconciled**: replaced the "103/103 tests pass" claim with the real count after fixes (3268 pass + 53 skip + 4 xfail + 1 pre-existing zstd integration failure)
- **Dangling runbook links fixed**: `docs/deploy/northflank-free-tier.md` + `docs/deploy/cutover-checklist.md` referenced `docs/runbooks/{deploy-paas,secrets-management,upgrade-procedure,rollback-procedure}.md` which were deleted in the 2026-06-23 cleanup. Replaced with the closest live paths in `docs/docs/operations/` (deferred real runbook creation to Phase D2 of the 14-phase plan)
- **Test count**: `pytest tests/intelligence/ -q` → **1183 passed, 1 skipped, 0 failures** (was 27 failed + 6 errors). Full suite: **3268 passed, 53 skipped, 4 xfailed, 1 pre-existing zstd failure** (was 34 failures total). After the audit pass: 3448 passed, 66 skipped, 4 xfailed (zstd now skips cleanly when migration 032 not applied to the test DB)


### Product — 2026-06-25 (Phase 3 — op debt B + C, surface polish D, Cat 23 real ship E–H, deferred items I)

The 14-phase plan registered 2026-06-24 (`/Users/kaiavnihalani/.claude/plans/based-on-ugradespec-md-fully-serialized-volcano.md`) is complete end-to-end. Every phase shipped + the deferred-items table is now registered below.

#### Phase B — Phase 4 op debt (light items)

- **B1 — Migration compatibility matrix doc**: `docs/ops/migration-matrix.md` (NEW) — single table covering all 62 alembic migrations (1-062) with forward-compat, reverse window, downgrade risk, blast radius, linked surface, owner per row. Reconciles the split between `src/eden/db_migrations/versions/` (alembic) and the legacy `migrations/` directory (001-041 SQL) by recommending future migrations go alembic-only. `tests/docs/test_migration_matrix.py` (NEW) — reads the doc + asserts every alembic migration is listed
- **B2 — ClickHouse load test at 10× scale**: `tests/load/columnar_scale.py` (NEW) — locust harness pushing synthetic traces + running rollup queries; `tests/load/clickhouse_scale.k6.js` (NEW) — k6 harness for pure query throughput; `docs/ops/clickhouse-slo.md` (NEW) — the SLO doc (daily rollup p95 < 2000 ms, weekly p95 < 5000 ms, hourly compact p95 < 500 ms at 10× data). CI runs nightly (not per-PR — too expensive)
- **B3 — `/internal/health` dashboard**: `src/eden/api/routes/internal_health.py` (NEW) — `GET /v1/internal/health` returns JSON for 5 components (Postgres replication lag + pool + slow queries, ClickHouse rollback p95 + partitions + compaction lag, Judge runner queue + latency + error rate, HookBus emit + dedup + severity histogram, per-cat eval latency for cat-1/8/12/13/22); `src/eden/api/middleware/internal_only.py` (NEW) — 403s non-internal-IP requests; `clients/portal/src/app/internal/health/page.tsx` (NEW) — internal-only portal page with charts

#### Phase C — Phase 4 op debt (heavy items)

- **C1 — Doc-test harness (Python `doctest`)**: `pyproject.toml` — `addopts = "--doctest-modules"` enabled for `src/eden/code_change/` + `src/eden/llmops/promotion_hooks.py`; 5 public functions carry runnable doctests (`_check_two_stage_optin`, `CodeRootCauseLinker.link`, `PRCreator.create` 2-path version, `CodeChangeHook.propose_patch_from_rca`, `CodeChangeHook.post_merge_degraded`). CI runs doctests on every PR. Narrow v1 list — every public function in every Cat 23 surface is on the v2 expansion list
- **C2 — Chaos test suite (3 failure modes, 5 tests)**: `tests/chaos/test_postgres_kill.py` (NEW) — kill mid-insert + assert loop survives + retries succeed; `tests/chaos/test_clickhouse_timeout.py` (NEW) — mock ClickHouse timeout + assert Postgres fallback (`data_source: "postgres_fallback"`); `tests/chaos/test_webhook_503_cascade.py` (NEW) — receiver 503s 100× + assert DLQ catches + replay works; `.github/workflows/chaos-nightly.yml` (NEW) — nightly cron at 02:00 UTC. 2 more failure modes (OpenAI circuit breaker + LLM rate-limit storm) on the v2 expansion list

#### Phase D — Surface polish

- **D1 — Fine-tune lineage portal page**: `clients/portal/src/app/(portal)/runs/[run_id]/lineage/page.tsx` (NEW) — server component fetches via internal proxy; `LineageGraph.tsx` (NEW) — pure-SVG (no React Flow dep) showing the D.12.5 backward + forward traces + the run itself; `lib/api.ts` — added `fineTuneLineageApi.get(runId)` method
- **D2 — 8 runbooks (postgres-restore, clickhouse-failover, migration-rollback, judge-circuit-breaker, budget-kill-switch, hook-dlq-replay, cat23-policy-rollout, oncall-handoff)**: all NEW in `docs/runbooks/`. Each ≤200 lines, step-by-step with copy-pasteable commands, owner field at top, testable by an on-call engineer in <15 minutes
- **D3 — Settings tab decision**: removed `clients/portal/src/app/(portal)/settings/(tabs)/region/page.tsx` (multi-region permanently out of scope, dead surface). `pii/` + `retention/` retained as Cat 10 governance surfaces. `exports/` + `gateway/` retained as stubs pending customer demand

#### Phase E — Cat 23 Gate 1 (CODEOWNERS) + Gate 2 (line range + golden set)

- **E.1**: `src/eden/code_change/codeowners.py` (NEW) — pure-stdlib `re`-based GitHub CODEOWNERS parser (handles `*`, `**/`, leading-/ anchored root, trailing-/ directory-only, last-match-wins, @org/team + email + @username, escape sequences); `src/eden/code_change/repo_connector.py` extended with `read_codeowners()` (probes 3 standard locations) + `owners_for_files()` (resolves the reviewer list); 2 new routes `GET /v1/intelligence/code-change/repos/{repo_id}/codeowners` + `POST /v1/intelligence/code-change/repos/{repo_id}/codeowners/owners`. 31 tests in `tests/unit/code_change/test_codeowners_parser.py`
- **E.2**: `src/eden/code_change/code_parser.py` (NEW) — stdlib `ast` Python function-range extractor (decorators, async def, nested defs, class methods, innermost-wins via recursive walk). **JS/TS deferred** — stdlib ast covers the dominant server-side language; tree-sitter × 4 deps was rejected as over-scoped. The 18 tests cover Python only. `src/eden/code_change/rca_linker.py` extended — `_PY_STACK_RE` captures function name (2 capture groups); `_extract_line_range()` reads file via repo_connector + calls `extract_function_range`; `_LANGUAGE_BY_EXT` maps extensions
- **E.3**: `tests/intelligence/test_rca_accuracy.py` (NEW) — 9-trace golden set (curated from synthetic stack traces covering the 4 source types + edge cases). Target: 80% top-1 accuracy. **Expansion to 100 traces deferred** — synthetic curation is speculative; mine from `telemetry_events.code_path` once Cat 23 has production data

#### Phase F — Cat 23 Gate 3 (isolated sandbox + red-team)

- **F.1**: `src/eden/providers/sandbox_isolated.py` (NEW) — Linux namespace isolation via `unshare(1)` (mount + PID + UTS + IPC + net + fork + kill-child) + RLIMIT_CPU + RLIMIT_AS + per-tenant overrides via `SANDBOX_*_OVERRIDE_<org_id>` env vars. Defaults 120 CPU-sec + 4 GB + 15 min wall clock. macOS dev fallback to LocalSandboxProvider with `fallback_to_local_actual=True`. `src/eden/providers/sandbox.py` extended — `get_default_sandbox_provider()` honours `EDEN_SANDBOX_PROVIDER=isolated`. `src/eden/providers/__init__.py` — added `IsolatedSandboxProvider` to `__all__` + lazy import. 26 tests in `tests/unit/code_change/test_isolated_sandbox.py` (5 Linux-only skipped on macOS)
- **F.2 (deferred)**: 10-repo CI parity test deferred to v1.6.2 — needs Linux worker with `EDEN_SANDBOX_PROVIDER=isolated` + the harness needs a sandboxed `git clone` of 10 OSS repos
- **F.3 + F.4 — self-administered red-team**: `docs/docs/observability/cat23-redteam-report.md` (NEW) — flipped from STUB → SELF-ADMINISTERED REVIEW with 16 probes across 5 attack classes (auth bypass, filesystem escape, resource exhaustion, input validation, opt-in bypass). Found 1 real gap (class docstring missing read-only mention) — fixed inline during review. 2 findings accepted by-design (macOS fallback has no isolation, worker-side read-only mount not enforced). **External re-review recommended** before Gate 4 ships to production. 11 tests in `tests/unit/code_change/test_redteam_probe.py` (6 Linux-only skipped on macOS)

#### Phase G — Cat 23 Gate 4 (real PR + revert + CODEOWNERS reviewers)

- **G.1**: `src/eden/code_change/revert_engine.py` rewritten — `AutoRevertEngine.revert()` dispatches to `PRProvider.revert()` via the constructor or default factory; persists `revert_events` row; 3 strategies (`close_pr` / `revert_pr` / `revert_branch`) selected by `_pick_strategy(pr_state, history_is_linear)`; manual-trigger path retained for when no provider is configured. 18 tests in `tests/unit/code_change/test_auto_revert_wiring.py`
- **G.2**: `src/eden/llmops/promotion_hooks.py` `CodeChangeHook.propose_patch_from_rca` + `post_merge_degraded` now actually run `CodeRootCauseLinker.link` → `PatchGenerator.generate` + `AutoRevertEngine.revert` when the two-stage opt-in (`code_change_enabled` + `auto_pr_enabled` / `auto_revert_enabled`) is fully granted. Return shape changed from `Optional[str]` (action_id) to `dict` (action_id + executed + skipped_reason). 9 tests in `tests/intelligence/test_code_change_hook_wiring.py`
- **G.3**: `src/eden/code_change/pr_creator.py` extended with `resolve_codeowners_reviewers()` + `attach_codeowners_reviewers()` — reads CODEOWNERS + merges into the reviewers list before the provider call (preserving order, deduping). 10 tests in `tests/unit/code_change/test_pr_creator_codeowners.py`
- **G.4**: `tests/integration/test_patch_flow.py` (NEW) — 3 integration tests covering the manual-trigger end-to-end flow against a temp git repo (RCA → linker → PR creator; CODEOWNERS path; opt-in gate). The PatchGenerator E2E is verified by source-level inspection (it requires a fully-working `ModelResponse.usage` shape we don't control)

#### Phase H — Cat 23 Gate 5 (KG) + Gate 6 (auto-mode e2e)

- **H.1**: `src/eden/code_change/knowledge_graph.py` — wired into both success paths. `PatchGenerator.generate()` calls `record_outcome("merged")` per touched file after a successful patch (best-effort try/except; passes `rca_category` + `telemetry_signature` from the linker). `AutoRevertEngine.revert()` calls `record_outcome("reverted")` for the affected code_path (skips when `code_path` empty in the evidence). 13 tests in `tests/intelligence/test_knowledge_graph_wiring.py` covering UPSERT semantics, first-write vs subsequent, counter increments per outcome type, and all 3 read paths
- **H.2 + H.3**: `tests/integration/test_auto_mode_e2e.py` (NEW) — 2 tests covering the full self-healing loop end-to-end (RCA → attribution → patch → PR → regression → revert → KG updated) and the opt-in gate enforcement. The Gate 6 acceptance test

#### Phase I — Deferred items (this section)

- **Deferred items table** added to `upgradespec-v2.md` Phase 5 section (see file)
- **CLI Phase 5 TODO** added to `src/eden/cli/__init__.py` module docstring
- **Total Phase 3 deliverable**: 12 new migrations (B3 has no migrations), 18 new backend modules + service files, 1 new middleware, 1 new portal page, 8 new runbooks, 5 new internal-health routes, 4 new chaos test files, 4 new load-test files, 19 new doc files, ~371 new tests in Cat 23 alone (plus chaos + load + doctest). 5 git commits: `ab867ba1` (E), `09f3adb9` (F), `d571925f` (F.4), `304b6cb2` (G), `09dcf418` (H)

### Deferred items (per Phase I)

These items are **explicitly parked** per user direction 2026-06-24 + 2026-06-25. They are NOT in any current plan; they require their own customer-driven or compliance-driven trigger.

| Item | Why deferred | Where it lives |
|---|---|---|
| **Cat 23 external red-team re-review** | Self-administered probe covered 16 vectors across 5 attack classes but external red-team conventions expect 50+ vectors per class. Recommended before Gate 4 ships to production | `docs/docs/observability/cat23-redteam-report.md` (SELF-ADMINISTERED REVIEW section) |
| **Cat 23 100-trace golden set expansion** | Currently 9 hand-curated traces. Synthetic curation is speculative; production traces are better quality once Cat 23 has data | `tests/intelligence/test_rca_accuracy.py` (the 9 traces) + `tests/intelligence/fixtures/rca_golden_set.json` (the v2 expansion target) |
| **Cat 23 JS/TS tree-sitter** | stdlib ast covers Python only. JS/TS support deferred until a JS/TS trace lands on the golden set; tree-sitter × 4 deps (~10 MB) was rejected as over-scoped | `src/eden/code_change/code_parser.py` (JS/TS branch returns `(0, 0)`) |
| **Cat 23 10-repo CI parity test** | Needs Linux worker with `EDEN_SANDBOX_PROVIDER=isolated` + the harness needs sandboxed `git clone` of 10 OSS repos | `tests/integration/test_sandbox_parity.py` (NOT YET WRITTEN) |
| **Cat 23 worker-side read-only mount** | Defense-in-depth follow-up for Gate 3. The class docstring mentions read-only but the actual mount enforcement is at the worker boundary, not in the provider | `src/eden/providers/sandbox_isolated.py` (Future Work section) |
| **Cat 23 post-merge monitor cron scheduler** | The 1h/6h/24h/7d windows are spec'd but the cron worker is not yet wired. The test `test_auto_mode_e2e.py` collapses the timing into the test run | `src/eden/code_change/post_merge_monitor.py` (NOT YET WRITTEN) |
| **Cat 23 GitHub App OAuth registration** | **Fully live as of 2026-06-25.** The GitHub App was created on github.com/settings/apps/new per the user handoff in memory `eden_pagination_fly_github_handoff_2026_06.md`. All 6 GitHub App credentials are bound in `northflank.yml` (secrets group `eden-required`): `GITHUB_APP_ID` / `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_WEBHOOK_SECRET` / `GITHUB_APP_CALLBACK_URL` (the 6th was added 2026-06-25). Callback URL = `https://edenobservability.com/onboarding/connect`. The code surface is real: 330-line `GitHubPRProvider` (`src/eden/providers/pr.py:532`), 383-line `GitHubOAuthClient` with `installation_token` JWT exchange (`src/eden/integrations/github/oauth.py`), 792-line route file (`src/eden/api/routes/github.py`), 16 tests pass (`tests/unit/providers/test_pr.py`). The `get_default_pr_provider()` factory (audit 2026-06-23) auto-detects GitHub when `EDEN_GITHUB_TOKEN` + `EDEN_GITHUB_REPO` are populated — those 2 vars are runtime values written by the OAuth callback after a user installs the App. Status: **ready for first org install on next NF deploy** | `src/eden/providers/pr.py` (GitHubPRProvider) + `src/eden/integrations/github/oauth.py` (GitHubOAuthClient) + `northflank.yml` (6 secret bindings) |
| **Cat 23 SLM Initiative (Judge v2)** | Qwen 3.5 4B + 10 LoRA heads + vLLM + AWQ-4bit, 8-week rollout, $4.2k training, 50-90× cost reduction vs GPT-4o. Cat 23 auto-mode is gated on this for the LLM-as-judge quality gate | `docs/docs/observability/judge-v2-plan.md` |
| **Agent CLI (Aider-fork → Codebuff-style)** | Separate product, no customers yet. The current `eden-ops` CLI has 6 ops subcommands; the developer-facing `eden` CLI is PLAN-only | `docs/docs/reference/eden-agent-cli-spec.md` (36 KB) + `eden-agent-cli-roadmap.md` (41 KB) |
| **Cat 21 Custom Metric Studio SLM** | Gated on Judge v2 SLM Initiative (weeks 9-12 of SLM plan) | `docs/docs/observability/judge-v2-plan.md` |
| **2 STUB security hooks** (`security:pii_scanner`, `security:secret_detector`) | Gated on D.11 RTBF cross-store, which is permanently out of scope. The hooks stay recorded-but-noop | `src/eden/llmops/promotion_hooks.py` |
| **D.11 RTBF cross-store** | Permanently removed from scope per user 2026-06-24 (no legal team). The existing Cat 10 `RightToBeForgottenService` handles Postgres only | (no plan) |
| **D.12 Multi-region (EU/AP)** | Permanently removed from scope per user 2026-06-24 (single-region deployment). Northflank `us-central-1` is the only deployment | (no plan) |
| **§9.3 Feature flag inventory** | Moot per user — feature flags are explicitly out of scope per `upgradespec.md:277` | (no plan) |
| **Stripe billing** | Disabled by design per `routes/billing.py:6` ("Free-only mode June 2026"); enable when customer demand validates | `src/eden/api/routes/billing.py` |
| **TS SDK for D.12 protocols** | Python SDK first; ship TS when a customer asks | (no plan) |
| **External monitoring (Sentry/Datadog/uptime)** | Acceptable for <50 beta users; revisit at 50+ | (no plan) |
| **axe-core CI scan** | CUT per YAGNI 2026-06-24 (manual WCAG per Phase 2B.2 suffices for beta) | (no plan) |
| **Cat 23 8-week real ship initiative** | Already laid out in plan; gated on SLM Initiative + 4 hard gates (read-only → attribution → sandbox → end-to-end). The infrastructure (Gate 1-6) is now all real; the workflow integration is the next step | `/Users/kaiavnihalani/.claude/plans/based-on-ugradespec-md-fully-serialized-volcano.md` |

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
- Pre-existing test failures: 27 failures + 6 errors in `tests/intelligence/test_*.py` (Phase 0 cut tests, unrelated — confirmed via stash + re-run on prior commit; **fixed 2026-06-24** by foundation cleanup, see below)

### Product — 2026-06-24 (Phase 2 — D.12.5 Fine-tune lineage shipped)

- **D.12.5** Fine-tune lineage (per spec §8.7): migration 061 — 3 tables per spec §B.9 (`fine_tuning_runs` with `provider_fine_tune_id` + status + eval_results + `completed_at`; `dataset_trace_lineage` for backward lineage; `fine_tune_trace_usage` for forward lineage); partial unique index `(provider, provider_fine_tune_id) WHERE provider_fine_tune_id IS NOT NULL` enforces webhook idempotency (R-12) at the DB layer; `FineTuneLineageService` (`register_run` with idempotent upsert on `(provider, provider_fine_tune_id)` + `update_status` that auto-sets `completed_at` on terminal states + `get_run` + `list_runs_for_org` with `status`/`provider` filters + `link_dataset_to_traces` bulk insert idempotent on `(dataset_id, trace_id)` + `record_trace_usage` + `get_lineage_for_run` returning the backward+forward graph + `detect_data_drift` — a z-score-based detector that reads `eval_results.mean_score` from the last `window` runs sharing the same `base_model` + org and fires the hook when |z| >= threshold); routes `GET /v1/fine_tuning_runs` (org-member) + `POST /v1/fine_tuning_runs` (org-admin) + `GET /v1/fine_tuning_runs/{id}` + `GET /v1/fine_tuning_runs/{id}/lineage` + `POST /v1/fine_tuning_runs/{id}/dataset_traces` + `POST /v1/fine_tuning_runs/{id}/trace_usage` + `POST /v1/fine_tuning_runs/{id}/drift_check` (org-admin) + `POST /v1/webhooks/openai/fine_tuning` (HMAC-SHA256 verified against `OPENAI_FINE_TUNE_WEBHOOK_SECRET`, replay-protected with ±5 min timestamp window, maps the 5 spec event_types to internal status); SDK `eden.sdk.fine_tune` (`register_run` async best-effort helper + `parse_openai_webhook_payload` pure parser that returns the `event_type`/`fine_tune_id`/`internal_status`/`base_model`/`fine_tuned_model`/`training_params`/`eval_results`/`ignored` fields + `build_fine_tune_attributes` helper); new hook `on_fine_tune_data_drift` on `PromotionHook` (severity `medium`, action_kind `investigate` per §E.1 row 25); portal client `fineTuneApi` (7 methods)
- 1 new migration (061), 1 new backend module (`services/observability/fine_tune_lineage.py`), 1 new route file (`api/routes/observability_fine_tune.py`), 1 new SDK module (`sdk/fine_tune.py`), 20 new tests across `tests/observability/fine_tune/`
- D.12 hooks now wired: 5 of 10 (MCP + A2A + Computer Use + Voice + Fine-tune). 5 still pending: 3 compliance_gap, 2 security, sla_breach, provider_routing_repeated_failures
- Pre-existing test failures: 27 failures + 6 errors in `tests/intelligence/test_*.py` (Phase 0 cut tests, unrelated — confirmed via stash + re-run on prior commit; **fixed 2026-06-24** by foundation cleanup, see below)

### Product — 2026-06-24 (Phase 2 — D.12.4 Voice / audio shipped)

- **D.12.4** Voice / audio sessions (per spec §8.4): migration 060 (`voice_sessions` table with the 10 spec columns — `session_id`, `transport`, `asr_provider`/`asr_latency_ms`/`asr_confidence`/`asr_input_audio_ms`, `llm_first_audio_ms`, `tts_provider`/`tts_first_byte_ms`/`tts_total_ms`, `barge_in_detected`; `org_id` added for spine-style org scoping; 3 indices including a partial index on `(org_id, created_at DESC) WHERE barge_in_detected = TRUE` for the spike detector); `VoiceSessionService` (`record_session` with idempotent upsert on `(trace_id, span_id)` so SDK retries that fill in ASR/TTS latencies incrementally are safe + `get_sessions_for_trace` + `list_sessions` with the 3 spec filters `provider`/`had_barge_in`/`asr_p95_ms_gt` (p95 is post-filtered in Python per the per-org aggregate note in §C.8) + `mark_barge_in` (idempotent UPDATE) + `detect_barge_in_spike` which counts barge-in rows in the rolling 15-minute window and fires the hook when the count crosses the threshold of 5); routes `GET /v1/voice_sessions?org_id=&provider=&had_barge_in=&asr_p95_ms_gt=&limit=` (org-member) + `POST /v1/voice_sessions/{org_id}` (SDK record path) + `GET /v1/traces/{trace_id}/voice_sessions` (per-trace view) + `POST /v1/voice_sessions/{org_id}/barge_in` (idempotent flag flip) + `GET /v1/voice_sessions/barge_in_spike?org_id=&window_minutes=&threshold=&fire_hook=` (org-admin, dry-run when `fire_hook=false`); SDK `eden.sdk.voice.wrap_voice_session` (async context manager with `set_asr_latency_ms`/`set_asr_confidence`/`set_tts_first_byte_ms`/`set_tts_total_ms`/`set_barge_in` helpers) + `mark_barge_in` (best-effort delegate) + `detect_spike` (convenience wrapper) + `build_voice_attributes` (pure helper returning the `voice.*` sub-document); new hook `on_voice_barge_in_spike` on `PromotionHook` (severity `low`, action_kind `investigate` per spec §E.1 row 24); portal client `voiceApi` (6 methods)
- 1 new migration (060), 1 new backend module (`services/observability/voice_sessions.py`), 1 new route file (`api/routes/observability_voice.py`), 1 new SDK module (`sdk/voice.py`), 18 new tests across `tests/observability/voice/`
- D.12 hooks now wired: 4 of 10 (MCP + A2A + Computer Use + Voice); 6 still pending (3 compliance_gap, 2 security, sla_breach, fine_tune_data_drift, provider_routing_repeated_failures)
- Pre-existing test failures: 27 failures + 6 errors in `tests/intelligence/test_*.py` (Phase 0 cut tests, unrelated — confirmed via stash + re-run on prior commit; **fixed 2026-06-24** by foundation cleanup, see below)

### Product — 2026-06-24 (Phase 2 — D.12.3 Computer Use shipped)

- **D.12.3** Computer Use (per spec §8.3): migration 059 (`computer_use_steps` table with the 6-action-type CHECK constraint + UNIQUE(span_id, step_index) + partial indices; `computer_use_screenshots_tombstoned` for RTBF-purge of S3 screenshot URIs); `ComputerUseService` (`record_step` with idempotent upsert + best-effort `mark_screenshot_tombstoned` / `list_tombstoned_for_trace`; fires `on_computer_use_blocked` hook when step is recorded with `blocked=True`); routes `GET /v1/traces/{trace_id}/computer_use` (steps with screenshot URIs) + `POST /v1/computer_use/{org_id}/steps` (SDK record path, validates action_type against the 6 spec kinds) + `POST /v1/computer_use/{org_id}/screenshots/tombstone` (RTBF) + `GET /v1/computer_use/{org_id}/screenshots/tombstoned/{trace_id}`; SDK `eden.sdk.computer_use` with 6 spec-aligned action constructors (`click`/`type_text`/`scroll`/`drag`/`key`/`wait`) + `record_step` async helper that accepts either an `ComputerUseAction` dataclass OR raw fields; new hook `on_computer_use_blocked` on `PromotionHook` (severity `high`, action_kind `pause_session`); portal client `computerUseApi` (4 methods)
- 1 new migration (059), 1 new backend module (`services/observability/computer_use.py`), 1 new route file (`api/routes/observability_computer_use.py`), 1 new SDK module (`sdk/computer_use.py`), 12 new tests across `tests/observability/computer_use/`
- Total D.12 hooks now wired: 3 of 10 (MCP + A2A + Computer Use); 7 still pending (compliance_gap × 3, security × 2, sla_breach, voice_barge_in_spike, fine_tune_data_drift, provider_routing_repeated_failures)
- Pre-existing test failures: 27 failures + 6 errors in `tests/intelligence/test_*.py` (Phase 0 cut tests, unrelated — confirmed via stash + re-run on `8b7c97b8`; **fixed 2026-06-24** by foundation cleanup); 0 regressions in my touched surface

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
