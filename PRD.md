# Eden
## Product Requirements Document — v3.0

**Date:** June 2026 | **Status:** Implementation Complete (Repositioned)

---

> *Eden does not just observe your LLM app. It improves it.*
> *Every trace, prompt, and eval feeds a closed loop that turns telemetry into better behaviour — automatically, continuously, and without an eval team on staff.*

---

## Part I — Vision and Philosophy

### 1.1 What Eden Is

**Eden is the observability + improvement platform for AI agents and LLM apps.** It sits between your application and the upstream LLMs you call, giving you production-grade observability and a workspace for analysis and AI-assisted debugging. Comparable to Helicone or Langfuse for the observability layer, with a **closed-loop improvement layer** they don't have.

Eden is delivered as two pillars, designed to be adopted individually or together:

1. **Observability** — Drop-in SDKs (Python, TypeScript) and an **OpenAI-compatible HTTP gateway** that proxies every request to whichever upstream model you configure (OpenAI, Anthropic, Bedrock, self-hosted). Traces, costs, latencies, prompt/response payloads, tool calls, eval results — captured automatically, queryable in seconds.

2. **Web platform** — An org-aware workspace for managing teams, projects, API keys, and budgets; rich visualisations of traces, tokens, costs, and eval scores; data export (JSONL/CSV) and webhook delivery; and a **persistent AI assistant sidebar** in every view that lets you ask questions of your data in plain language and get cited answers.

The two pillars close the loop: the **Observability** layer captures what is happening, the **Web platform** lets humans investigate, and every run, eval, and KB write feeds back into the system, so the platform gets sharper the more you use it.

### 1.2 Who It's For

- **LLM application teams** shipping chat, RAG, agents, copilots — who need Helicone-class observability and want their own upstream models, not a vendor-locked LLM.
- **Platform / ML infra teams** running evaluations and regression tests, who need trace-level drill-down and a CLI to ship prompt and code improvements without filing tickets.
- **Agent product teams** running tool-using or multi-step agents, who need full tool-call traces, token accounting, and the ability to replay and branch from any step.
- **Eval / research teams** building benchmark suites (advanced opt-in pipeline) for training, red-teaming, or capability testing.

### 1.3 The Problem

Teams shipping LLM apps in 2026 face the same recurring pains:

- **Black-box production behaviour.** Most teams still rely on vendor dashboards (OpenAI, Anthropic) that show their usage but not *why* a prompt failed, *which* call in a multi-step agent loop blew up the cost, or *how* a model change shifted quality.
- **Vendor lock-in at the proxy layer.** Most "observability" SaaS products also route your traffic through their model gateway — forcing you to use their model allowlist and pricing. Teams that have already chosen their upstream providers have to build their own proxy.
- **Observability is not improvement.** Helicone and Langfuse are excellent at *showing* you traces. Neither ships the patched prompt, the regenerated test, or the PR. The loop from "this eval regressed" to "here is a fix" is still entirely manual and lives in a Slack thread.
- **No shared memory across runs.** Evaluations are run, results are filed, knowledge is lost. The same regression gets debugged from scratch three sprints later.

### 1.4 Solution Architecture

Eden solves these by combining:

1. **OpenAI-compatible HTTP gateway as the primary integration.** Change your `base_url` to Eden's gateway, keep your existing OpenAI/Anthropic SDK calls, point each request at whichever upstream model you want. Capture is automatic. No code changes for the 80% case; full SDKs for the 20% that needs custom spans, tool traces, and structured evaluations.

2. **Workspace + AI assistant sidebar.** Org management, member roles, API keys, budgets; rich visualisations of traces, costs, and eval scores; a persistent AI assistant that can query your data, summarise regressions, and draft improvements — every answer is cited against a trace ID or eval record.

3. **Knowledge base with temporal model.** Captured traces, evals, and KB writes feed a Knowledge Base that lets the system answer questions like "what was the failure rate on this prompt variant before the 0.7 model bump?" — essential for debugging LLM apps where context shifts weekly.

4. **Advanced opt-in environment generation pipeline** (legacy). For teams that need auto-generated, verified training/eval/simulation environments, the original multi-agent pipeline is still available behind an explicit opt-in. See Part VIII.

---

## Part II — The Two Pillars

```
╔═══════════════════════════════════════════════════════════════════════╗
║                              EDEN PLATFORM                           ║
║   Pillar 1: Observability  │  Pillar 2: Web Platform                 ║
║   (SDKs + Gateway)          │  (org + viz + export +                 ║
║                             │   AI assistant)                        ║
║                             │                                         ║
║   capture ────────────► analyse ────────────► KB write              ║
║                                                                      ║
║                       Knowledge Base (temporal, cited)               ║
╚═══════════════════════════════════════════════════════════════════════╝
```

### 2.1 Pillar 1 — Observability

**Primary integration: OpenAI-compatible HTTP gateway.** This is the headline "5-minute integration" story. Existing OpenAI SDK code (Python or TypeScript) works unchanged by swapping `base_url`:

```python
from openai import OpenAI
client = OpenAI(
    base_url="https://gateway.eden.example/v1",  # Eden gateway
    api_key=os.environ["EDEN_API_KEY"],
)
resp = client.chat.completions.create(
    model="gpt-4o",                 # any upstream you want
    messages=[{"role": "user", "content": "Hello"}],
)
```

Every request is captured, traced, evaluated (if you configured evaluators), and made queryable. The gateway forwards to whichever upstream model you point at — OpenAI, Anthropic, Bedrock, self-hosted, or any OpenAI-compatible endpoint. Eden is a *proxy*, not a model vendor.

**SDKs (Python, TypeScript) for advanced capture:**
- Manual span creation for multi-step agents
- Tool-call tracing with structured I/O
- Streaming token capture
- Custom evaluations (LLM-as-judge, code-based, or third-party)
- Thread/coroutine context propagation
- Local evaluation runs that post results to Eden

**Ingestion formats supported** (multi-format, source-aware): OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, Google Gemini, AWS Bedrock Converse, LangChain, LlamaIndex, Vercel AI SDK, raw JSON. PII is pre-masked at ingest; per-source decoder normalises payloads into a canonical trace schema.

**Storage:** Each trace captures request, response, latency, cost (computed from token counts × configured model pricing), tool calls, and any structured eval outputs. Backed by a temporal knowledge graph (chronological + transactional validity) so you can ask "what was the failure rate on prompt v3 between deploys?" with confidence.

### 2.2 Pillar 2 — Web Platform

A workspace that scales from a single developer to multi-org enterprise:

- **Organisation management** — multi-tenant orgs, member roles (Owner, Admin, Member, Viewer), SSO/SAML, SCIM provisioning, audit log, 2FA enforcement.
- **Projects, API keys, environments** — multiple projects per org, per-environment API keys (`prod`, `staging`, `dev`), per-key rate limits and budget caps.
- **Visualisations** — traces list, single-trace drill-down (full message tree, tool calls, eval results), time-series of cost/latency/quality, model-upgrade diffs, regression alerts.
- **Data export** — JSONL and CSV export, scheduled exports to S3/GCS, webhook delivery to your downstream (Slack, Datadog, internal warehouse).
- **Persistent AI assistant sidebar** — a chat surface anchored to whichever view you are in. Ask "show me the worst 1% of traces this week" or "why did the latency spike Tuesday?" — answers are generated against your real data and cite trace IDs / eval records you can click through. The assistant remembers context as you navigate.
- **Billing & plan limits** — per-org usage tracking, plan upgrades, invoice history.

---

## Part III — Closed-Loop Self-Improvement

### 3.1 The Knowledge Base

The KB is what makes the loop close. It is the platform's long-term memory and the substrate every agent (web assistant, CLI agent, future automation) reasons against.

**Four layers with distinct data models and retrieval mechanisms.**

**Layer 1 — Episodic Memory.** Raw, immutable records of traces, eval runs, and improvement attempts. PostgreSQL + JSONB. Full-text search on prose via `tsvector`. Time-series indexing on cost, latency, and quality. Retrieval scored by recency, semantic relevance, and salience (regressions and breakthrough improvements score high).

**Layer 2 — Semantic Memory — Temporal Knowledge Graph.** A bitemporal graph (Zep/Graphiti model) where every fact has both *chronological validity* (when it was true in the world) and *transactional validity* (when Eden learned it). This is the only way to answer "what did Eden know about this prompt variant on the day we shipped it?" with audit-grade confidence. Edge types: `CAUSES`, `PREVENTS`, `ENABLES`, `IMPROVES`, `CONTRADICTS`, `DISCOVERED_IN`, `VALIDATED_BY`, `VALID_FOR`, `SUPERSEDED_BY`.

**Layer 3 — Procedural Memory.** Skill Library: verified prompt patterns, retrieval strategies, evaluation recipes, model-routing policies. Each entry has a natural language description, parameterisable implementation, applicable context, and quality metrics from validating runs. Indexed by semantic similarity; retrieved and applied by the web assistant and the CLI agent.

**Layer 4 — Exploit / Regression Library.** Parameterisable adversarial probes and regression markers. New regressions and eval failures feed the library; future runs are pre-checked against known patterns to surface them earlier.

### 3.2 The Improvement Cycle

```
TRACES ────► ASSISTANT INSIGHT ────► HYPOTHESIS (cited)
   ▲                                          │
   │                                          ▼
   │                                     PATCH + RUN EVALS
   │                                          │
   │                                          ▼
   └────────────────────── EVAL RESULT ◄─────┘
                                   │
                                   ▼
                          PR (human-approved)
                                   │
                                   ▼
                          KB updated; next cycle is shorter
```

Every step leaves a trail in the KB. Regressions are not re-debugged — the assistant retrieves the prior fix pattern, the CLI agent reuses the validated skill, and the next improvement is shorter than the last.

### 3.3 Knowledge Base Health

- **AUDN write protocol.** Every semantic memory write applies one of: Add, Update, Delete, None. Prevents KB pollution.
- **Contradiction resolution.** If a newly extracted fact contradicts an existing entry, the system creates a `CONTRADICTS` edge and resolves it (supersede, coexist with documented conditions, or flag for investigation).
- **Staleness hygiene.** Entries that haven't been retrieved or used in N runs lose confidence; entries that get validated by subsequent runs gain confidence. Framework/model changes trigger `VALID_UNTIL` updates and `SUCCEEDED_BY` edges.
- **Retention policy.** Raw episodic records are archived after 90 days when learnings are fully promoted to semantic memory. Gold outcomes and breakthrough improvements are never archived.

---

## Part IV — Technical Architecture

### 4.1 Observability Stack

| Component | Technology | Rationale |
|---|---|---|
| Gateway (Pillar 1) | FastAPI + httpx async | Drop-in OpenAI-compat proxy; supports streaming, tool calls, batch |
| SDKs (Pillar 1) | Python, TypeScript | First-class trace context propagation; manual spans; structured evals |
| Ingestion adapters | 7+ source decoders | OpenAI Chat/Responses, Anthropic, Gemini, Bedrock, LangChain, LlamaIndex, Vercel AI SDK |
| PII pre-mask | Regex + Presidio | Strip emails, phones, IDs at ingest, before storage |
| Storage — traces | PostgreSQL + JSONB | Structured queries, time-series, full-text |
| Storage — semantic | Neo4j Aura + Graphiti | Temporal KG, bitemporal, causal edges |
| Storage — vector | Qdrant Cloud | Hybrid dense+sparse, metadata filtering, <100ms retrieval |
| Eval runners | In-process (Python/TS) + hosted | Local eval during dev; hosted eval runs in CI/webhook |

### 4.2 Web Platform Stack

| Component | Technology | Rationale |
|---|---|---|
| Frontend | Next.js (App Router) + dark-terminal theme | Reused in marketing, portal, docs |
| Auth | JWT cookies, OAuth (Google/GitHub), SSO/SAML, SCIM | Enterprise-friendly |
| Org management | Postgres-backed RBAC | Owner/Admin/Member/Viewer roles |
| Visualisations | Server-rendered time-series + client drill-down | Scales to millions of traces/day |
| AI assistant sidebar | Persistent context, KB-grounded, cited answers | Connects to all portal views |
| Export | JSONL/CSV, scheduled S3/GCS, webhooks | Standard downstream consumers |

### 4.3 LLM Routing Per Agent

| Agent | Default Model | Notes |
|---|---|---|
| Gateway (Pillar 1) | N/A — pure proxy | No Eden-side LLM in the request path |
| Web assistant (Pillar 2) | Claude Sonnet 4 | KB-grounded Q&A, summarisation, drafting |
| KB writer / Archivist | Claude Sonnet 4 | AUDN decisions, contradiction resolution, archival |
| Distiller | Claude Haiku 4.5 | Nightly batch at scale |
| Prompt Evolver | Claude Sonnet 4 | Per 50-job rolling window |
| Research Harvester | Claude Sonnet 4 | Weekly crawl, framework/model release notes |
| Pattern Miner | Claude Sonnet 4 | Monthly cross-job analysis |

---

## Part V — Pricing & Plans

| Plan | Includes | Price |
|---|---|---|
| **Free** | 1 user, 100K trace events/mo, 7-day retention, gateway + Python SDK, 1 project | $0 |
| **Team** | 10 users, 10M trace events/mo, 90-day retention, all SDKs, unlimited projects, AI assistant sidebar, webhooks | $0.20/1K trace events |
| **Pro** | Everything in Team + custom retention, SSO, SCIM, audit log, scheduled exports, advanced AI-assistant | $0.15/1K trace events (volume discount) |
| **Enterprise** | Self-hosted gateway, BYO storage, custom SLA, dedicated support, advanced env-gen pipeline | Contact sales |

AI-assistant queries and KB writes are metered at the platform level. Most teams see net cost *savings* within the first month because the assistant surfaces regressions and fix patterns that would otherwise be re-debugged.

---

## Part VI — Metrics

### Observability (Pillar 1)
- Gateway p50/p95 added latency
- Trace capture success rate
- Eval run completion rate
- p50 query latency for trace list / single trace

### Platform (Pillar 2)
- DAU/WAU/MAU per org
- Time-to-first-trace after signup (target: <5 minutes)
- AI assistant sidebar query success rate (cited answer rate)
- Export/webhook delivery success rate

### Platform (Pillar 2) — extended
- KB leverage rate: fraction of assistant runs that retrieved and used a canonical entry
- Mean time from regression to resolved investigation

### Knowledge Base
- KB retrieval latency (p50, p95)
- Repeat regression rate (should approach zero over time)
- AUDN write ratio (Add vs Update vs Delete)
- Archivist extraction durability: fraction of canonical writes still used and uncontradicted after 30 subsequent runs

---

## Part VII — Seed Corpus & Knowledge

The Knowledge Base ships seeded with patterns Eden has learned from production runs and from the public literature:

- **OpenTelemetry GenAI spec compliance** — semconv-aligned trace schema, span semantics, span attributes for LLM calls.
- **Adversarial probe library** — known LLM failure modes (prompt injection, jailbreak, context overflow, PII leakage, tool misuse, hallucination) packaged as parameterisable probes.
- **Eval recipes** — LLM-as-judge templates, code-based scorers, pairwise comparison harnesses.
- **Model pricing snapshots** — current $/1K-token for every supported upstream, used for cost computation.
- **Framework facts** — OpenAI SDK, Anthropic SDK, LangChain, LlamaIndex, Vercel AI SDK release notes and known incompatibilities.

The seed corpus is augmented continuously by the Distiller, Research Harvester, and Pattern Miner.

---

## Part VIII — Advanced: Opt-In Environment Generation Pipeline

> **Status:** Available to all customers as an advanced, opt-in feature. Not the default. Most teams adopt Eden for the three pillars above and only enable this if they specifically need auto-generated, verified eval/training/simulation environments.

The original Eden product is a multi-agent pipeline that takes a natural-language description of an environment and produces runnable, verified, production-quality code for it. The full pipeline (Planner → Critic → Refiner → Fact Checker → Executor → Code Quality Pipeline → Verifier → Tester → Archivist) is described in detail in **PRD-Legacy-Environments.md** at the root of this repository.

When a team enables the advanced pipeline in their Eden workspace, they get access to:

- **Eval harness generation** — auto-generate Gymnasium / PettingZoo / AgentBench-style environments from a description, with the full reward-pathology and exploit-scan QA pass.
- **Adversarial environment generation** — red-team environments that probe known agent failure modes.
- **Multi-agent arena generation** — competitive and collaborative sandboxes for agent training.
- **Curriculum suite generation** — difficulty-monotonic environment sequences.

The pipeline is opt-in per project. Enabling it does not affect your observability, web platform, or CLI agent — those are always on.

For the full specification (agent roles, test categories, EDP schema, AUDN protocol details, outcome tier definitions), see `PRD-Legacy-Environments.md`.

---

## Appendices

### A. Quickstart — Pillar 1 (Gateway)

```bash
# 1. Install the SDK (or use the gateway with any OpenAI client)
pip install eden-sdk

# 2. Set your key
export EDEN_API_KEY="..."
export EDEN_PROJECT_ID="..."

# 3. Point your existing OpenAI client at Eden
#    (one-line change in your code)
from openai import OpenAI
client = OpenAI(
    base_url="https://gateway.eden.example/v1",
    api_key=os.environ["EDEN_API_KEY"],
)
```

Done. Every call is captured, traced, and made queryable. Visit the web portal to see your first trace within 30 seconds.

### B. Glossary

- **Trace** — a single captured LLM call (request + response + metadata).
- **Span** — a unit of work within a trace; allows nested multi-step agent timelines.
- **Eval** — a structured scoring of a trace or batch of traces (LLM-as-judge, code-based, or third-party).
- **KB canonical entry** — a fact in semantic memory that has been audited and promoted by the Archivist via AUDN.
- **OpenAI-compatible gateway** — Eden's HTTP proxy that speaks the OpenAI Chat Completions / Responses API and forwards to your configured upstream.

---

**Document version:** 3.0 | **Owner:** Eden founding team | **Date:** June 2026
