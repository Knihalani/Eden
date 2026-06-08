# Eden — Master Architecture Index

> **Date:** May 29, 2026  
> **Purpose:** The central index for all Eden architectural specifications. This document maps the document ecosystem, defines reading order, tracks cross-document dependencies, and provides a unified roadmap for implementing Eden as a production-grade platform.

---

## Document Ecosystem

| # | Document | Lines | Focus Area | Priority | Target Audience |
|---|----------|-------|-----------|----------|-----------------|
| 0 | **[`eden-integration-dominance-architecture.md`](./eden-integration-dominance-architecture.md)** | ~3,400 | Strategic vision, integration targets, competitive moats, GTM strategy | **Critical** | Founders, investors, leadership |
| 1 | **[`eden-observability-and-knowledge-architecture.md`](./eden-observability-and-knowledge-architecture.md)** | ~1,200 | User-facing observability platform, unified trace model, dataset generation, insights engine, dual-layer KB, feedback flywheel | **Critical** | Platform engineers, data scientists |
| 2 | **[`eden-security-architecture.md`](./eden-security-architecture.md)** | ~1,100 | AuthN/Z, data isolation, secrets management, audit logging, prompt injection defense, sandboxing, supply chain security | **Critical** | Security engineers, compliance |
| 3 | **[`eden-multi-tenancy-billing-architecture.md`](./eden-multi-tenancy-billing-architecture.md)** | ~1,000 | Tenant isolation, resource quotas, billing & metering, rate limiting, data residency, onboarding | **Critical** | Backend engineers, product |
| 4 | **[`eden-sdk-integration-architecture.md`](./eden-sdk-integration-architecture.md)** | ~900 | Python/TypeScript SDK design, CLI, plugin architecture, IDE integrations, documentation, error handling | **High** | DX engineers, developer advocates |
| 5 | **[`eden-cicd-evaluation-architecture.md`](./eden-cicd-evaluation-architecture.md)** | ~800 | Automated evaluation, golden datasets, canary deployments, review gates, security scanning, versioning, rollback | **High** | MLOps engineers, QA |
| 6 | **[`eden-cost-optimization-architecture.md`](./eden-cost-optimization-architecture.md)** | ~700 | Model routing, caching layers, token optimization, request coalescing, compute optimization, cost attribution | **High** | Platform engineers, finance |
| 7 | **[`eden-realtime-streaming-architecture.md`](./eden-realtime-streaming-architecture.md)** | ~600 | SSE/WebSocket/gRPC, event sourcing, dashboards, stream processing, backpressure, connection management | **Medium** | Backend engineers, SRE |
| 8 | **[`eden-llmops-experiment-architecture.md`](./eden-llmops-experiment-architecture.md)** | ~1,100 | Model artifact registry, prompt versioning, feature store, experiment tracking, production monitoring, AI gateway | **High** | ML engineers, platform |
| 9 | **[`eden-api-developer-platform-architecture.md`](./eden-api-developer-platform-architecture.md)** | ~1,200 | REST + SSE API, versioning, webhooks, Python/TypeScript SDKs, CLI, API gateway, OpenAPI, docs | **Critical** | API engineers, DX |
| 10 | **[`eden-data-platform-architecture.md`](./eden-data-platform-architecture.md)** | ~1,000 | Lakehouse (Iceberg/Hudi), ETL/ELT, data quality, ClickHouse, tiered storage, GDPR, lineage | **Critical** | Data engineers, platform |
| 11 | **[`eden-multi-agent-orchestration-architecture.md`](./eden-multi-agent-orchestration-architecture.md)** | ~1,100 | Communication patterns, agent hierarchies, tool use, state management, memory, planning, coordination | **High** | AI researchers, platform |

**Total:** ~13,200 lines of architectural specification across 12 companion documents + 1 master index.

---

## Reading Order by Role

### For Platform Engineers (Building Eden)
1. Start with **#0** (this document) for strategic context
2. Read **#3** (multi-tenancy) and **#2** (security) for foundation
3. Read **#10** (data platform) and **#1** (observability) for the data layer
4. Read **#9** (API) and **#4** (SDK) for the developer interface
5. Read **#8** (LLMOps) for the ML infrastructure
6. Read **#11** (multi-agent) and **#5** (CI/CD) for the AI layer
7. Read **#6** (cost optimization) and **#7** (streaming) for scale

### For AI Researchers (Improving the Pipeline)
1. Start with **#0** for strategic context
2. Read **#11** for multi-agent patterns and environment design
3. Read **#8** for model selection and experiment tracking
4. Read **#1** for observability data and feedback loops
5. Read **#5** for evaluation methodologies

### For Developer Advocates (Onboarding Users)
1. Start with **#0** for strategic context
2. Read **#9** for API design and SDK philosophy
3. Read **#4** for detailed SDK and CLI design
4. Read **#1** for observability features users will love
5. Read **#6** for pricing and cost management to communicate value

### For Security & Compliance Teams
1. Start with **#0** for strategic context
2. Read **#2** for comprehensive security architecture
3. Read **#3** for tenant isolation and data residency
4. Read **#10** for data governance and GDPR
5. Read **#5** for security scanning of generated code

---

## Dependency Map

```
                    ┌──────────────────┐
                    │   #0 Strategic   │
                    │   (This Doc)     │
                    └────────┬─────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
        ▼                    ▼                    ▼
┌───────────────┐   ┌───────────────┐   ┌───────────────┐
│  #2 Security  │   │  #3 Multi-Ten │   │  #10 Data Plat│
│               │   │               │   │               │
└───────┬───────┘   └───────┬───────┘   └───────┬───────┘
        │                   │                   │
        └───────────┬───────┴───────┬───────────┘
                    │               │
                    ▼               ▼
            ┌───────────────┐ ┌───────────────┐
            │  #1 Observab  │ │  #8 LLMOps    │
            │               │ │               │
            └───────┬───────┘ └───────┬───────┘
                    │                   │
                    └─────────┬─────────┘
                              │
                    ┌─────────┴─────────┐
                    │                   │
                    ▼                   ▼
            ┌───────────────┐   ┌───────────────┐
            │  #9 API/Dev   │   │  #11 Multi-Agt│
            │  #4 SDK       │   │               │
            └───────┬───────┘   └───────┬───────┘
                    │                   │
                    └─────────┬─────────┘
                              │
                    ┌─────────┴─────────┐
                    │                   │
                    ▼                   ▼
            ┌───────────────┐   ┌───────────────┐
            │  #5 CI/CD     │   │  #7 Streaming │
            │               │   │               │
            └───────────────┘   └───────────────┘
                    │
                    ▼
            ┌───────────────┐
            │  #6 Cost Opt  │
            └───────────────┘
```

**Arrows indicate "depends on" or "references heavily."**

---

## Cross-Document Reference Matrix

| Document | #0 | #1 | #2 | #3 | #4 | #5 | #6 | #7 | #8 | #9 | #10 | #11 |
|----------|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:---:|:-----:|
| #0 Strategic | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| #1 Observability | ✓ | — | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| #2 Security | ✓ | ✓ | — | ✓ | ✓ | ✓ | — | — | ✓ | ✓ | ✓ | — |
| #3 Multi-Tenancy | ✓ | ✓ | ✓ | — | ✓ | — | ✓ | — | ✓ | ✓ | ✓ | — |
| #4 SDK | ✓ | ✓ | ✓ | ✓ | — | — | — | ✓ | — | ✓ | — | ✓ |
| #5 CI/CD | ✓ | ✓ | ✓ | — | — | — | ✓ | — | ✓ | — | ✓ | ✓ |
| #6 Cost Opt | ✓ | ✓ | — | ✓ | — | ✓ | — | — | ✓ | — | — | — |
| #7 Streaming | ✓ | ✓ | — | — | ✓ | — | — | — | — | ✓ | — | — |
| #8 LLMOps | ✓ | ✓ | ✓ | — | — | ✓ | ✓ | — | — | — | ✓ | ✓ |
| #9 API/Dev | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | — | — | — | ✓ |
| #10 Data Platform | ✓ | ✓ | ✓ | ✓ | — | ✓ | ✓ | — | ✓ | — | — | ✓ |
| #11 Multi-Agent | ✓ | ✓ | — | — | ✓ | ✓ | — | — | ✓ | ✓ | ✓ | — |

---

## Implementation Roadmap Overview

### Phase 0: Foundation (Months 1-3)
- [ ] Core pipeline (LangGraph nodes) — **#0**
- [ ] PostgreSQL + pgvector KB — **#0, #1**
- [ ] Basic job execution API — **#0, #9**
- [ ] Sandbox runner (Docker) — **#0, #2**

### Phase 1: Platform (Months 4-6)
- [ ] Multi-tenancy & auth — **#2, #3**
- [ ] Data platform (Bronze/Silver) — **#10**
- [ ] LLMOps (model registry, prompts) — **#8**
- [ ] API v1 + Python SDK — **#9, #4**
- [ ] Observability v1 (traces, metrics) — **#1**

### Phase 2: Scale (Months 7-9)
- [ ] CI/CD evaluation pipelines — **#5**
- [ ] Cost optimization layer — **#6**
- [ ] Real-time streaming — **#7**
- [ ] Advanced caching — **#6, #8**
- [ ] Multi-agent environments — **#11**

### Phase 3: Polish (Months 10-12)
- [ ] TypeScript SDK + CLI — **#4**
- [ ] Full observability platform — **#1**
- [ ] Insights engine + dataset generation — **#1, #10**
- [ ] Enterprise features (SSO, audit) — **#2, #3**
- [ ] Performance tuning — **#6, #7**

---

## Key Principles Across All Documents

1. **Feedback Flywheel:** Every subsystem feeds data into the observability platform, which generates insights, which improve the knowledge base, which makes better environments.
2. **Tenant-First:** Every design decision considers multi-tenancy — isolation, quotas, billing, and data residency.
3. **Security by Design:** No feature ships without considering auth, encryption, audit logging, and sandboxing.
4. **Developer Experience:** APIs must be predictable, SDKs must be idiomatic, and integration must be under 5 minutes.
5. **Cost Consciousness:** Every token is tracked, every model call is justified, every cache hit is celebrated.
6. **Observability Everywhere:** If it happens, it's traced. If it's traced, it's analyzed. If it's analyzed, it improves the system.

---

## Contributing to These Documents

When adding a new companion document:
1. Add it to the table in this index
2. Update the dependency map
3. Update the cross-document reference matrix
4. Add cross-references in the new document's footer
5. Update the reading order sections if necessary
6. Update `eden-integration-dominance-architecture.md` Section 18

---

*This is a living document ecosystem. As Eden evolves, these specifications should be updated to reflect new capabilities, learnings, and requirements.*
