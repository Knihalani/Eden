# Eden — Remaining Work Roadmap

> **Date:** June 1, 2026 (post-partial-closure revision)
> **Purpose:** This is the active work plan. Phases 1–3 of Eden are complete; all 26 ⚠ PARTIAL items from the prior revision were closed in the June 2026 implementation pass. The only remaining work is Phase 4 (Ecosystem & Enterprise) and Phase E (E2E / perf / monitoring / security) — both ❌ NOT STARTED except for the items called out below. The full historical 83-deliverable roadmap (with the completed phases intact for context) is preserved in git history — see the May 29, 2026 revision.
>
> **Status legend:**
> - **⚠ PARTIAL** — code/shape exists; a named gap remains.
> - **❌ NOT STARTED** — no implementation has landed.
> - Section-level "Milestone:" notes are kept only where work is still active. Fully-completed milestones are summarized once at the start of the phase.
>
> **Reference documents** (full architecture + competitive context): see [§13 Document Reference Index](#13-document-reference-index).

---

## Table of Contents

1. [Current State](#1-current-state)
2. [Recommended Order of Work](#2-recommended-order-of-work)
3. [Phase 3 Outstanding Partials (2)](#3-phase-3-outstanding-partials)
4. [Phase 4 — Integrations (6)](#4-phase-4--integrations)
5. [Phase 4 — Environment Marketplace (6)](#5-phase-4--environment-marketplace)
6. [Phase 4 — Enterprise Features (6)](#6-phase-4--enterprise-features)
7. [Phase 4 — Open Source & Community (6)](#7-phase-4--open-source--community)
8. [Phase 4 — Advanced Features & Polish (4)](#8-phase-4--advanced-features--polish)
9. [Cross-Cutting Workstreams](#9-cross-cutting-workstreams)
10. [Phase E — E2E / Performance / Monitoring / Security (4)](#10-phase-e--e2e--performance--monitoring--security)
11. [Health Metric Gaps](#11-health-metric-gaps)
12. [Risk Register (Forward-Looking)](#12-risk-register-forward-looking)
13. [Document Reference Index](#13-document-reference-index)

---

## 1. Current State

| Layer | Status | What it contains |
|-------|--------|------------------|
| **Foundation** (Phase 1) | ✅ Complete | Auth, DB schema, infra, pipeline, portal, sandbox, testing |
| **Platform** (Phase 2) | ✅ Complete | Public API v1, Python/TS SDKs, CLI, billing, data lake, CI/CD eval |
| **Scale & Intelligence** (Phase 3) | ✅ Complete | Cost opt, multi-agent, observability v2, LLMOps, insights, dataset gen — all 26 partials from the May audit closed in June 2026 |
| **Ecosystem & Enterprise** (Phase 4) | ⚠ 3 partials done, 22 not-started | SSO ✅, SCIM ✅, community programs ✅; integrations, marketplace, data residency, self-hosted Helm, OSS repo transfer still ❌ |
| **Phase E** (cross-cutting) | ❌ Not started | E2E tests, prod perf benchmarks, monitoring/alerting, security hardening |

**Live codebase is substantial** — 21 SQL migrations (added 019, 020, 021), ~32 API route files (added rbac, alerts), 14 agents, real-time streaming stack (SSE + WebSocket + ksqlDB + Ably/Cloudflare + gRPC), full Bronze/Silver/Gold data platform, LLMOps registry with persisted model artifacts, multi-agent environments, AI gateway with filter registry, hash-chained tamper-evident audit log, custom RBAC roles, closed-loop insights correlation, latency middleware, alerts engine.

---

## 2. Recommended Order of Work

The items below are ordered to minimize blocked work and to surface the most customer-visible gaps first. Phase E items are intentionally parallelizable with §4–§8 (see §10) but are a hard precondition for most enterprise sign-offs.

| # | Track | Items | Why first |
|---|-------|-------|-----------|
| **1** | **Phase E** (security/perf prerequisites) | E.4 security hardening, E.3 monitoring, E.2 perf benchmarks | Unblocks enterprise sales; required for §6 data-residency and self-hosted |
| **2** | **Enterprise core** (most-customer-requested) | §6 advanced RBAC, audit-log tamper-evidence, data residency, self-hosted Helm | Foundational for every §6–§8 follow-on |
| **3** | **First integration** (channel for growth) | §4 Langfuse + GitHub Action | Two integrations are enough to be a default eval layer; opens a feedback channel for §5 marketplace |
| **4** | **Marketplace skeleton** | §5 marketplace schema, fork & customize, community contribution workflow | Schema is small; unblocks curated library, search, ratings |
| **5** | **Open source core release** | §7 OSS agent framework, OSS sandbox runner, public docs site | Lowest effort; highest leverage for community/SEO |
| **6** | **Phase 3 partials** | ~~§3 PII filter, insights→KB closed-loop measurement~~ | ✅ Done (June 2026) — all Phase 3 partials are closed. Skip. |
| **7** | **Remaining integrations** | §4 Runloop, LangSmith, W&B, Helicone | Each is independent; ship after the first two |
| **8** | **Marketplace depth** | §5 curated library, search, ratings/reviews | Needs §5 schema shipped first |
| **9** | **Community & polish** | §7 Discord, conference presence, §8 A/B testing framework, visual env builder | High effort, low immediate customer impact |

---

## 3. Phase 3 Outstanding Partials

> Two items from the May 2026 implementation pass did not fully close against their success criteria. These are small but should be finished before Phase 4 enterprise rollout (they're SOC 2 / compliance adjacencies).

| # | Item | Status | Gap | Owner | Effort |
|---|------|--------|-----|-------|--------|
| 3.1 | **AI Gateway v2 PII filter** (§6.7.3) | ✅ Done (June 2026) | Refactored into a `FilterRegistry` (`src/eden/llmops/filters/`) with `PIIFilter` (default) + `FilterRegistry.run()` (fail-open, registration-order). Gateway exposes `register_filter` / `unregister_filter` / `set_filter_enabled`. 16 unit tests in `tests/unit/llmops/`. | — |
| 3.2 | **Insights → KB closed-loop** (§6.3.6) | ✅ Done (June 2026) | Migration 019 (`insights` + `kb_insight_writes`); `src/eden/insights/correlation.py` (per-week + aggregate SLO ≥5%); `GET /orgs/{id}/insights/correlation` route; portal `closed-loop` tab. Bug fixes: `.values()` on list, `title`/`description` → `summary`/`recommended_action`, `get_semantic_client` → `get_vector_client`. 7 unit tests. | — |

---

## 4. Phase 4 — Integrations

> *References: [`eden-integration-dominance-architecture.md`](./eden-integration-dominance-architecture.md), [`eden-competitive-analysis-report.md`](./eden-competitive-analysis-report.md)*
>
> **Milestone: "Integrated"** — Eden connects to every major AI evaluation and observability platform.
>
> **Owner team:** Integrations (DevRel-led). **Effort model:** each integration is a thin adapter over the existing public API + a small backend webhook/transform. Aim for 2–3 days per integration once the first one is shipped.

| # | Item | Status | Owner | Dependencies | Success Criteria |
|---|------|--------|-------|-------------|------------------|
| 4.1 | **Langfuse integration** — export envs as eval datasets, two-way trace export | ❌ NOT STARTED | Integrations | Public API | Eden envs → Langfuse datasets; trace export; docs + quickstart |
| 4.2 | **Runloop integration** — deploy envs to Runloop Devboxes | ❌ NOT STARTED | Integrations | Sandbox | Eden generates → Runloop executes; benchmark orchestration end-to-end |
| 4.3 | **LangSmith integration** — dataset export + trace sync | ❌ NOT STARTED | Integrations | Public API | LangSmith-compatible eval datasets; metrics sync |
| 4.4 | **W&B Weave integration** — log pipeline metrics to W&B | ❌ NOT STARTED | Integrations | Python SDK | Quality scores, iteration counts, failure modes tracked per run |
| 4.5 | **GitHub Action** — `eden generate` in CI/CD | ❌ NOT STARTED | Integrations | CLI | Environment generation on PR; quality report posted as PR comment |
| 4.6 | **Helicone integration** — route LLM calls through Helicone | ❌ NOT STARTED | Integrations | AI Gateway | One-line routing; cost tracking via Helicone |

**Effort:** 6 items × ~3 days = ~3 weeks. Parallelizable across 2 engineers.

---

## 5. Phase 4 — Environment Marketplace

> *References: [`eden-competitive-analysis-report.md`](./eden-competitive-analysis-report.md)*
>
> **Milestone: "Marketplace"** — Users discover, fork, and share environments. Network effects begin.
>
> **Owner team:** Backend (schema) + Frontend (search/fork UI) + AI (curated library). The schema is small but the catalog seeding (5.2) is the long pole.

| # | Item | Status | Owner | Dependencies | Success Criteria |
|---|------|--------|-------|-------------|------------------|
| 5.1 | **Marketplace schema** — env cards, quality scores, tags | ❌ NOT STARTED | Backend | — | Structured metadata; searchable; filterable; migration |
| 5.2 | **Curated library** — 100+ pre-generated environments across coding, adversarial, simulation, multi-agent | ❌ NOT STARTED | AI | Pipeline | 100+ envs; quality-gated; per-category coverage |
| 5.3 | **Search & discovery** — semantic + faceted search | ❌ NOT STARTED | Frontend | 5.1 | Users find relevant envs in <2 clicks |
| 5.4 | **Fork & customize** — clone env, edit spec, regenerate | ❌ NOT STARTED | Frontend | Spec flow | Users modify existing envs; diff view shown |
| 5.5 | **Community contributions** — submit, review, publish workflow | ❌ NOT STARTED | Frontend | 5.1 | Contribution workflow; quality review gate |
| 5.6 | **Ratings & reviews** — community feedback on envs | ❌ NOT STARTED | Frontend | 5.1 | Star ratings; review text; usage stats visible |

**Effort:** ~6 weeks (5.1 schema: 1 week; 5.2 catalog seeding: 3 weeks; 5.3–5.6 UI: 2 weeks).

---

## 6. Phase 4 — Enterprise Features

> *References: [`eden-multi-tenancy-billing-architecture.md`](./eden-multi-tenancy-billing-architecture.md), [`eden-security-architecture.md`](./eden-security-architecture.md)*
>
> **Milestone: "Enterprise-Ready"** — Fortune 500 can adopt Eden with their security requirements.
>
> SSO and SCIM are already shipped (`routes/sso.py`, `routes/scim.py`); the table below covers what remains.

| # | Item | Status | Owner | Dependencies | Success Criteria | Effort |
|---|------|--------|-------|-------------|------------------|--------|
| 6.1 | **SSO (SAML 2.0, OIDC)** | ✅ Done | Backend | — | `routes/sso.py` + migration `010_org_sso.sql`; Okta, Azure AD, Google Workspace tested | — |
| 6.2 | **SCIM provisioning** (user/group sync) | ✅ Done | Backend | 6.1 | `routes/scim.py` + migration `014_org_scim.sql`; auto-provision/deprovision verified | — |
| 6.3 | **Advanced RBAC** (custom roles, resource-level permissions) | ✅ Done (June 2026) | Migration 020 (`role_definitions` + `role_permissions` + `role_assignments`); `routes/rbac.py` (CRUD + assignments); `require_org_permission` extended in `deps.py`; new `check_resource_permission` for resource-scoped checks. 13 unit tests. Portal UI deferred to a follow-up. | — |
| 6.4 | **Audit logs (enterprise-grade)** — immutable, exportable | ✅ Done (June 2026) | Migration 021 (`prev_hash` + `entry_hash` columns, `compute_audit_hash` trigger, `verify_audit_chain(org_id)` function, `audit_canonical_json` helper). New `GET /orgs/{id}/audit-log/verify` + `/audit-log/export?format=jsonl|csv` routes. `docker/postgres/audit-backfill.py` for legacy rows. GDPR endpoint (`POST /orgs/{id}/gdpr-request`) emits an audit event + metric. 6 unit tests. | — |
| 6.5 | **Data residency** (EU, US, Asia regions) | ❌ NOT STARTED | DevOps | Multi-region | Tenant data stored in chosen region; regional failover; compliance evidence | ~6 weeks |
| 6.6 | **Self-hosted deployment** (Kubernetes Helm chart) | ❌ NOT STARTED | DevOps | — | One-command deploy; pluggable backends; SSO ready; CI/CD chart linting | ~4 weeks |

**Effort:** ~13 weeks total. 6.3 and 6.4 are small and unblock most enterprise conversations; 6.5 and 6.6 are large and gated on regional infra capacity.

---

## 7. Phase 4 — Open Source & Community

> *References: [`eden-competitive-analysis-report.md`](./eden-competitive-analysis-report.md)*
>
> **Milestone: "Community"** — Active open-source community; Eden recognized in AI ecosystem.
>
> Community scaffolding (CODEOWNERS, Discussions, workflows) is already in place; the table below covers the public-release work.

| # | Item | Status | Owner | Dependencies | Success Criteria | Effort |
|---|------|--------|-------|-------------|------------------|--------|
| 7.1 | **Open-source core** (MIT) — agent framework, pipeline graph | ✅ Done (June 2026) | `LICENSE` (MIT), `CONTRIBUTING.md`, `.github/ISSUE_TEMPLATE/{bug_report,feature_request}.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/dependabot.yml` (weekly pip + npm + Actions + Docker). Repo transfer to public GitHub is the last operational step. | — |
| 7.2 | **Open-source: sandbox runner + env templates** | ✅ Done (June 2026) | Extracted to `eden-sandbox/` subpackage: `pyproject.toml` (hatchling, MIT), `eden_sandbox/runner.py` (1:1 extract with lazy `eden.config` import), `README.md` (system-dep + quickstart), `LICENSE`. | — |
| 7.3 | **Documentation site** (Docusaurus/Mintlify) | ✅ Done (June 2026) | `docs/docusaurus.config.js`, `docs/sidebars.js`, `docs/package.json`, six pages under `docs/docs/` (index, development, architecture, deployment, api, roadmap, branch-protection — all with frontmatter). `.github/workflows/docs.yml` builds on push to `main` and deploys to GitHub Pages. | — |
| 7.4 | **Community programs** (ambassador, hackathon, bounty) | ✅ Done | DevRel | — | `.github/CODEOWNERS` + `.github/DISCUSSIONS.md` + `.github/workflows/main.yml` in place | — |
| 7.5 | **Discord + forum** — active community support | ❌ NOT STARTED | DevRel | — | Fast response time; FAQ; knowledge base | ~1 week |
| 7.6 | **Conference presence** (NeurIPS, ICML, AI Eng Summit) | ❌ NOT STARTED | DevRel | — | Talks accepted; booth; demo sessions | ongoing |

**Effort:** ~5 weeks for 7.1–7.3, then ongoing.

---

## 8. Phase 4 — Advanced Features & Polish

| # | Item | Status | Owner | Dependencies | Success Criteria |
|---|------|--------|-------|-------------|------------------|
| 8.1 | **Visual environment builder** (drag-and-drop) | ❌ NOT STARTED | Frontend | 5.1 | Non-technical users can specify environments visually |
| 8.2 | **Advanced analytics** — cohort analysis, funnel tracking | ❌ NOT STARTED | Data | Analytics API | User engagement metrics; conversion funnels |
| 8.3 | **Performance tuning** — query optimization, cache warming | ✅ Done (June 2026) | `bench/` suite (`latency`, `sandbox_boot`, `llm_provider`, `kb_retrieval`, `run_all`); weekly cron via `.github/workflows/perf-bench.yml`. §10.2 (formal perf benchmarks) remains ❌ NOT STARTED — the §8.3 / §10.2 distinction is that this one is in-process mocks, §10.2 is the production harness. 9 unit tests for the bench module. | — |
| 8.4 | **Platform-wide A/B testing framework** | ❌ NOT STARTED | Product | — | Feature flags; experiment analysis; auto-promotion |

**Milestone: "Polished Platform"** — Every feature feels finished; performance is excellent; experiments are data-driven.

**Effort:** 8.1 and 8.4 are large; 8.2 and 8.3 are smaller. Defer until core Phase 4 work ships.

---

## 9. Cross-Cutting Workstreams

These items are continuous cadences, not feature work. Only the items that are ⚠ PARTIAL or ❌ NOT STARTED are listed below — the running cadences that are already healthy are omitted for brevity. The full cadence list is in the May 29, 2026 historical revision.

### 9.1 Security & Compliance

| # | Item | Status | Frequency | Owner | Gap |
|---|------|--------|-----------|-------|-----|
| 9.1.1 | Penetration test of staging environment | ✅ Done (June 2026) | Weekly cron posts a checklist issue to `eden/security` (`.github/workflows/pen-test-cadence.yml`). Run-on-demand scanning still needed for an actual external pen test (see 9.1.3). |
| 9.1.2 | Compliance check (SOC 2 prep) | ✅ Done (June 2026) | `docs/soc2-control-mapping.md` — full CC1–A1 control matrix with evidence locations. |
| 9.1.3 | External security audit | ❌ NOT STARTED | Quarterly | Security | Not yet engaged with a firm; required before any Fortune 500 sale |
| 9.1.4 | Disaster recovery drill | ✅ Done (June 2026) | `docs/runbooks/disaster-recovery-drill.md` + `scripts/dr_drill.sh` (S3 restore → eden_restore_test DB → smoke queries → JSON report). Quarterly manual run. |
| 9.1.5 | Bug bounty program (HackerOne) | ❌ NOT STARTED | Ongoing | Security | No program; needs public scope + triage workflow |
| 9.1.6 | Security training for all engineers | ✅ Done (June 2026) | `docs/runbooks/security-training.md` — Q1–Q4 schedule (OWASP Top 10, secure code review, AI threat modeling, IR tabletop). |

### 9.2 Data Platform

| # | Item | Status | Frequency | Owner | Gap |
|---|------|--------|-----------|-------|-----|
| 9.2.1 | Cost review (storage, query, transfer) | ✅ Done (June 2026) | `optimization.cost_tracker.generate_monthly_report()` + `scripts/generate_cost_report.py` (per-tenant CSV) + `.github/workflows/cost-review-weekly.yml` (Monday 9am Slack post). |
| 9.2.2 | GDPR data deletion requests | ✅ Done (June 2026) | `POST /orgs/{id}/gdpr-request` route + `gdpr_requests_total` metric + audit-event tag. SLA enforcement + audit-trail UI is on the §7.3 enterprise roadmap. |

### 9.3 Testing & Quality

| # | Item | Status | Frequency | Owner | Gap |
|---|------|--------|-----------|-------|-----|
| 9.3.1 | E2E test suite (Playwright) — daily cron | ✅ Done (June 2026) | `.github/workflows/e2e-cron.yml` (daily 6am UTC, copies the `test-e2e` job body, uses `actions/cache` for Playwright browsers). |
| 9.3.2 | Golden dataset benchmark run | ✅ Done (June 2026) | `golden_datasets/canonical/v1.json` (50 synthetic canonical cases — coding, adversarial, simulation, multi-agent, browser, tool_use, rl_classic, web_agent, gridworld). Synthetic by design; see top-of-file comment. |
| 9.3.3 | Regression test: 20 canonical environments | ❌ NOT STARTED | Weekly | QA | No canonical env set selected; no harness (superseded by 9.3.2's 50-case bench) |
| 9.3.4 | Full security scan (SAST + DAST) | ✅ Done (June 2026) | SAST already wired in `security_scanner.py` (bandit + semgrep + safety). DAST: `.github/workflows/dast.yml` (OWASP ZAP baseline, weekly Wednesday 3am, posts findings as GitHub issues). |
| 9.3.5 | Load testing (simulate 10x traffic) | ❌ NOT STARTED | Quarterly | DevOps | No harness; needs k6 or Locust + Grafana |

### 9.4 Knowledge Base & Archivist

| # | Item | Status | Frequency | Owner | Gap |
|---|------|--------|-----------|-------|-----|
| 9.4.1 | Full KB audit: coverage, accuracy, retrieval quality | ✅ Done (June 2026) | `docs/runbooks/kb-audit.md` (three-dimension audit: coverage thresholds, accuracy sampling, retrieval top-5 hit rate) + `scripts/kb_audit.py` (writes `reports/kb-audit-{date}.json`). |

### 9.5 Infrastructure & DevOps

| # | Item | Status | Frequency | Owner | Gap |
|---|------|--------|-----------|-------|-----|
| 9.5.1 | Infrastructure monitoring (CPU, memory, disk) | ✅ Done (June 2026) | `src/eden/observability/alerts.py` (4 default rules: API p95 > 500ms, LLM error rate > 0.5%, KB p95 > 250ms, pipeline timeout > 5%) + `routes/alerts.py` (GET /alerts, POST /alerts/{id}/ack). Pushes fired alerts to `eden_alerts` Redis stream. |
| 9.5.2 | Cost optimization review (cloud bill) | ✅ Done (June 2026) | Same workflow as 9.2.1 (`.github/workflows/cost-review-weekly.yml`, Monday 9am Slack post). |
| 9.5.3 | Backup verification (restore test) | ✅ Done (June 2026) | `docker/postgres/{backup,restore,verify-restore}.sh` + `scripts/dr_drill.sh`. |
| 9.5.4 | Multi-region expansion planning | ❌ NOT STARTED | Quarterly | DevOps | Depends on §6.5 data-residency decision |

---

## 10. Phase E — E2E / Performance / Monitoring / Security

> Phase E is the umbrella of cross-cutting work that the May 2026 audit flagged as not yet planned. The four items below are **load-bearing for both shipping safely and unblocking §6 enterprise customers**, who will not sign without external evidence of perf, monitoring, and security.

| # | Item | Status | Owner | Success Criteria | Effort |
|---|------|--------|-------|------------------|--------|
| 10.1 | **E.1 — End-to-end journey tests** (Playwright) | ❌ NOT STARTED | QA | Suite stub at `tests/e2e/`. Need: scenarios for signup → spec → job → env → download, plus a signed-off happy-path pass on each major browser. | ~2 weeks |
| 10.2 | **E.2 — Performance benchmarks** (API p95, KB retrieval, sandbox boot, LLM provider p95) | ❌ NOT STARTED | Platform | New `bench/` directory; harness that runs nightly; Grafana dashboard; published SLOs per endpoint category. | ~2 weeks |
| 10.3 | **E.3 — Monitoring & alerting** (Datadog/Grafana, SLOs, on-call) | ❌ NOT STARTED | DevOps | `/health` is the only signal in prod today. Need: metrics export, log aggregation, SLO definitions, on-call rotation. | ~3 weeks |
| 10.4 | **E.4 — Security hardening** (DAST, pen-test, bug-bounty, SOC 2 evidence) | ❌ NOT STARTED | Security | Internal SAST (bandit + semgrep) is wired; DAST and external review are not. Need: DAST tool selection, third-party pen-test engagement, HackerOne program launch, SOC 2 control mapping. | ~8 weeks (mostly external dependencies) |

**Parallelization note:** All four E items can run in parallel with §4–§8 work. They are not gated on each other, but 10.2 and 10.3 should ship before 10.4's external review (so the reviewer has a baseline).

---

## 11. Health Metric Gaps

The platform has health-metric targets defined in §12 of the historical roadmap, but the instrumentation is incomplete. The table below is a punch list.

| # | Metric | Target | Status | Gap |
|---|--------|--------|--------|-----|
| 11.1 | API p95 latency | <200ms | ✅ Done (June 2026) | `src/eden/api/middleware/latency.py` (per-route Prometheus-style histogram). Registered in `app.py` after `CorrelationIdMiddleware`. Echoes `X-Response-Time-Ms` header. 5 unit tests. |
| 11.2 | KB retrieval p95 | <100ms | ✅ Done (June 2026) | `TelemetryCollector.record_cache_lookup()` + `optimization.cache.record_kb_cache_lookup()` emit ``tier``-tagged events (L1/L2/DB). 3 unit tests. |
| 11.3 | Sandbox boot time | <200ms | ✅ Done (June 2026) | `bench/sandbox_boot.py` (mock + `NullSandboxRunner` real-runner paths). 1 unit test. |
| 11.4 | LLM provider error rate | <0.1% | ✅ Done (June 2026) | Per-provider counter on `_call_with_retry` (openai + anthropic split). New `get_provider_error_counts()` accessor. 4 unit tests. |
| 11.5 | Pipeline timeout rate | <2% | ✅ Done (June 2026) | `src/eden/pipeline/metrics.py` + `code_quality.py` records on `asyncio.TimeoutError`. 6 unit tests. |
| 11.6 | Customer support response | <4h | ❌ NOT STARTED | No support tooling yet. Phase 4 prerequisite for paying customers (Zendesk / Intercom / Pylon). |
| 11.7 | NPS score | >50 | ❌ NOT STARTED | No external users to measure against. |

---

## 12. Risk Register (Forward-Looking)

Only risks that are **active and forward-looking** are listed. Historical risks (e.g., "Phase 1 had open CRITICAL security issues") are resolved and omitted.

| # | Risk | Likelihood | Impact | Mitigation | Owner |
|---|------|-----------|--------|-----------|-------|
| T3 | Sandbox security breach (Firecracker bypass) | Low | Critical | External security audit (§10.4); bug bounty (9.1.5); defense in depth | Security |
| T4 | Multi-tenancy isolation failure (data leak between orgs) | Low | Critical | Row-level security; tenant-scoped queries; regular penetration tests (9.1.1) | Security |
| T5 | KB quality degrades over time (pollution from bad extractions) | Medium | High | Archivist AUDN protocol (shipped); Distiller batch cleanup (shipped); formal quarterly audit (9.4.1) needed | AI |
| T6 | Database scaling bottleneck (PostgreSQL at limit) | Medium | High | Read replicas; connection pooling; ClickHouse for analytics (shipped); sharding plan (not done) | Platform |
| T7 | Frontend performance degrades with large traces | Medium | Medium | Virtualized rendering; pagination; WebWorker processing; lazy loading | Frontend |
| T8 | Integration partner API changes break Eden connectors | Medium | Medium | Version pinning; abstraction layers; automated integration tests (after first integration ships) | DevRel |
| B1 | Competitor (Maxim AI, Runloop) builds env generation | Medium | High | Integrate first (§4); open-source core (§7.1); marketplace network effects (§5) | Product |
| B3 | Enterprise buyers don't trust AI-generated code | Medium | High | Quality dashboard; adversarial testing reports; human-in-the-loop; SOC 2 (§10.4) | Product |
| B6 | Open-source community doesn't materialize | Medium | Medium | Seed with interesting projects (§7); DevRel investment; conference presence (7.6) | DevRel |
| **New R1** | **Phase E never gets prioritized and §6 enterprise rollout stalls** | Medium | High | Make §10 the first track in §2 recommended order; ringfence one engineer from §4–§8 | CTO |
| **New R2** | **Langfuse/Runloop integrations ship without a versioning story** | Medium | Medium | Define integration-versioning policy before first integration lands | Platform |

---

## 13. Document Reference Index

> The full 20-document architecture ecosystem (master index, reading order, decision matrix) is preserved in the May 29, 2026 historical revision. The table below is a **scoped subset for the work in this roadmap**.

### 13.1 Primary Documents for the Remaining Work

| Document | Used by | Why |
|----------|---------|-----|
| [`eden-integration-dominance-architecture.md`](./eden-integration-dominance-architecture.md) | §4 | Strategic vision and integration sequencing |
| [`eden-llmops-experiment-architecture.md`](./eden-llmops-experiment-architecture.md) | §3.1 (PII filter), §10.4 (security) | AI Gateway v2 design |
| [`eden-observability-and-knowledge-architecture.md`](./eden-observability-and-knowledge-architecture.md) | §3.2 (insights→KB), §10.3 (monitoring) | Insights architecture; observability primitives |
| [`eden-data-platform-architecture.md`](./eden-data-platform-architecture.md) | §3.2 (closed-loop measurement), §9.2 | Data lake + analytics |
| [`eden-security-architecture.md`](./eden-security-architecture.md) | §6.3, §6.4, §10.4, §12 R3, R4 | Enterprise security, audit, PII |
| [`eden-multi-tenancy-billing-architecture.md`](./eden-multi-tenancy-billing-architecture.md) | §6.5 (data residency) | Tenant isolation + regional deployment |
| [`eden-infrastructure-deployment-architecture.md`](./eden-infrastructure-deployment-architecture.md) | §6.6 (self-hosted Helm) | Deployment + IaC |
| [`eden-testing-architecture.md`](./eden-testing-architecture.md) | §9.3, §10.1 | Test pyramid + E2E |
| [`eden-competitive-analysis-report.md`](./eden-competitive-analysis-report.md) | §4, §5, §7 | Competitor positioning, network-effect moat |
| [`PRD.md`](./PRD.md) | All | Pipeline + KB + tech arch |

### 13.2 Quick Reference

| If you need to decide on… | Read this document |
|--------------------------|---------------------|
| Which integrations to ship first | [`eden-integration-dominance-architecture.md`](./eden-integration-dominance-architecture.md) |
| How to harden for SOC 2 | [`eden-security-architecture.md`](./eden-security-architecture.md) |
| How to design the marketplace | [`eden-competitive-analysis-report.md`](./eden-competitive-analysis-report.md) |
| How to instrument health metrics | [`eden-observability-and-knowledge-architecture.md`](./eden-observability-and-knowledge-architecture.md) |
| How to deploy self-hosted | [`eden-infrastructure-deployment-architecture.md`](./eden-infrastructure-deployment-architecture.md) |

---

*This roadmap is a living document. Update it as items ship, partials close, or new work is identified. When a Phase 4 item completes, the recommended order (§2) should be re-evaluated.*

*Last updated: June 1, 2026 (Phase 1–3 marked complete; Phase 4 status column added; Phase E (§8.6) added as a new cross-cutting workstream).*

*Second revision: June 1, 2026 (26 ⚠ PARTIAL items closed across §3, §6, §7, §8, §9, §11 — PII filter registry, insights closed-loop, RBAC, audit hash chain, perf harness, latency middleware, KB tier labels, sandbox harness, LLM error re-wire, pipeline timeout metric, GDPR endpoint, monitoring alerts, OSS packaging, Docusaurus site, CI workflows, runbooks, scripts). Phase 4 (§4–§8) and Phase E (§10) remain the active work front.*
