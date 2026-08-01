---
title: What's new
sidebar_label: What's new
sidebar_position: 99
---

# What's new

## SDK 0.3.2 — July 2026

### SDKs

- **Python `eden-sdk` 0.3.2** — Pydantic AI instrumentation, Bedrock + Gemini
  auto-instrumentation, HTTP capture, OTel bridge, logging forwarder,
  session-first API, `python -m eden_sdk.doctor` / `eden-doctor` CLI.
- **TypeScript `@eden-ai/sdk` 0.3.2** — Mastra `wrapMastra`, HTTP capture,
  `detectInstalledFrameworks` + `wrap*` pattern (replaces broken
  `instrument()` global patch docs), session API, `npx eden-doctor`.

### Docs

- [Connect any agent](/how-to/connect-any-agent) — three-tier instrumentation guide
- [Agent sessions](/how-to/agent-sessions) — F23 session-first SDK reference
- [Failure fixtures](/how-to/failure-fixtures) — D6 export + local replay
- [Security model](/explanation/security-model) — tenancy, encryption, audit
- [Quickstart](/quickstart) — **Fill in** creates an API key into a runnable snippet (when signed in)
- SDKs default to `https://api.edenobservability.com` (no `EDEN_BASE_URL` required)
- Auto-instrumentation matrix: Pydantic AI, Bedrock, Gemini, Mastra, HTTP capture tiers
- [API endpoint](/how-to/deploy) — connect your app; DNS for `api.edenobservability.com`
### Portal

- Settings hub for API keys, autonomy, and workspace (Eden MCP server soft-retired for free beta)

## v1.7 — June 2026

### Docs

- **Massive docs overhaul.** Restructured around the Diátaxis
  framework (tutorials / how-to / reference / explanation).
  Replaced the ad-hoc guide tree with four dropdown sidebars
  in the navbar.
- **SDK reference** — full pages for the two production SDKs
  (Python and TypeScript), plus an auto-instrumentation matrix
  covering every framework the SDKs patch.
- **REST API reference** — every endpoint that was previously
  in `guide/api.md` is now in dedicated, navigable pages
  (`/reference/api`, `/reference/api-ingestion`, `/reference/api-traces`,
  `/reference/api-eval`, `/reference/api-cost`,
  `/reference/api-organization`, `/reference/api-error-codes`).
- **How-to guides** — auth, API keys, deploy, GitHub, PII policy,
  cost budgets, auto-instrument, judges, custom LLM providers,
  SSO, webhooks.
- **Explanation pages** — architecture, data model, the 22
  intelligence categories, security model, multi-tenancy,
  sampling and retention.

### Platform

- **Jobs feature removed.** The async env-gen "jobs" pipeline
  (route handlers, pydantic models, DB tables, quota tracking,
  RBAC permissions, SDK exports) has been retired. The
  corresponding code, billing quotas, permissions, and docs
  references have been deleted. The two production SDKs that remain
  (Python `eden-sdk`, TypeScript `@eden-ai/sdk`) focus on the
  observability + ingestion surface. Experimental language SDKs
  (Go / Rust) are not GA.
- **Env-gen SDK packages deleted.** The `src/eden/sdk/` Python
  module and `sdk/ts/` TypeScript package (both job-centric
  clients) are gone. The remaining SDKs all live under their
  top-level language folders in `sdk/`.

## v1.6 — June 2026

- Cat 23 (Autonomous Code Modification) STUB surface shipped:
  21 services + 19 tables + 24 routes. Two-stage opt-in enforced.
  Real end-to-end ship remains gated on the SLM Initiative.

## v1.5 — June 2026

- Cat 14 (Autonomous Intelligence) shipped: 7 services for NL
  queries, investigations, recommendations, and self-heal proposals.
- Master observability doc bumped to v1.5 with 22 intelligence
  categories, "what we do NOT build" transparency, and a
  competitive matrix.

## v1.4 — June 2026

- Cat 22 (APM Depth + Tracing Depth) shipped: 5-keep-rule sampling,
  tail sampling buffer, K8s enrichment, Pyroscope continuous profiling.

## v1.3 — June 2026

- Cat 19 (Trace Query DSL / EQL) and Cat 20 (Time-Travel Debug)
  shipped. SQL-only EQL parser, per-step edit DSL.

## v1.2 — June 2026

- Cat 12 (Experimentation Intelligence) shipped: traffic splitter,
  Bayesian recommender, replay-in-staging simulator.

## v1.1 — June 2026

- Cat 8 (Cost Intelligence), Cat 10 (Governance), Cat 11
  (Outcome / ROI), Cat 13 (Predictive) shipped.

## v1.0 — June 2026

- The five SDKs (Python, TypeScript, Go, Rust, TS AI Runtime)
  GA. Multi-format ingestion. Portal GA with 22 intelligence
  surfaces.