# Eden Competitive Gap Analysis
## Laminar · Sentrial · Raindrop · BentoLabs AI

> **Date:** July 9, 2026  
> **Scope:** Deep research on four YC-backed agent observability/monitoring competitors. Documents features each competitor has that Eden lacks or where Eden is **significantly lagging** — not a full feature parity matrix.  
> **Method:** Public product sites, YC profiles, docs, launch posts, blog posts, GitHub/README, and Eden codebase/docs cross-reference.  
> **Implementation specs:** [`docs/specs/FEATURE-GAP-MASTER.md`](docs/specs/FEATURE-GAP-MASTER.md) — **48 feature-by-feature specs** in [`docs/specs/features/`](docs/specs/features/)  
> **Legacy (competitor-organized):** [`docs/specs/competitor-gaps/`](docs/specs/competitor-gaps/)

---

## Executive Summary

These four competitors cluster around the same buyer — teams shipping AI agents to production — but each owns a different wedge:

| Competitor | YC Batch | Wedge | One-line positioning |
|---|---|---|---|
| **Laminar** | S24 | Open-source agent observability | "Understand why your agent breaks. Iterate fast to fix it." |
| **Sentrial** | W26 | Production behavior monitoring | "Datadog for agent reliability — detect, diagnose, fix in code" |
| **Raindrop** | W24 | Sentry for AI agents | "Agents fail silently. Fix them fast." |
| **BentoLabs AI** | Spring 2026 | Self-learning production layer | "Run 101 is measurably better than run 1" |

**Eden's structural advantage** remains breadth: 22+ intelligence categories, gateway, KB closed loop, governance, environment generation, and deep vertical modules (RCA, memory, tool, cost, ROI). **Eden's structural weakness** vs. this cohort is **product polish and closed-loop velocity** — competitors ship narrower but sharper "detect → understand → fix → verify" loops with production-proven UX, while Eden often has backend parity docs marked "IMPLEMENTED v1" with deferred UI, hermetic-only debug paths, or stub surfaces.

The highest-priority gaps cluster into five themes:

1. **Per-trace semantic detection** (not just metric rules) — all four competitors lead here.
2. **Fix-in-code / self-healing loops** — Sentrial, Raindrop, Laminar (MCP/CLI), Bento (nudges) are further along in shippable UX.
3. **Local dev + coding-agent iteration** — Laminar Debugger + Raindrop Workshop are category-defining; Eden has no equivalent OSS/local product.
4. **Sentry-style issue hierarchy** — Raindrop's Stumbles → Issues model and Laminar's signal cluster lifecycle are more operator-native than Eden's incident clusters.
5. **Runtime learning injection** — BentoLabs is alone in promoting production-learned skills/nudges back into live agent runs; Eden's KB is analyst-facing, not runtime-injected.

---

## How to Read This Report

Each section lists **gaps only** — capabilities where the competitor is meaningfully ahead. Severity:

- 🔴 **Critical lag** — competitor has shipped, production-proven UX; Eden missing or stub-only
- 🟠 **Significant lag** — Eden has partial/backend implementation; competitor is clearly ahead in UX, reliability, or go-to-market
- 🟡 **Moderate lag** — Eden has related capability under different abstraction; gap is mainly positioning, integration breadth, or polish

"Eden status" references come from Eden docs (`docs/docs/observability/`), route inventory (`src/eden/api/routes/`), and portal (`clients/portal/`).

---

# 1. Laminar (YC S24)
**Founders:** Robert Kim, Din Mailibay — founders@lmnr.ai  
**Site:** https://laminar.sh · **GitHub:** https://github.com/lmnr-ai/lmnr (Apache 2.0)

### Positioning
Open-source, OpenTelemetry-native observability purpose-built for AI agents. Rust backend, self-hostable, strong among browser/computer-use agent companies (Browser Use, OpenHands, etc.).

---

### Gap 1.1 — Real Agent Debugger with cached prefix replay 🔴

**What Laminar has:** Debugger runs agents with `LMNR_DEBUG=true`. On rerun, **cached LLM responses serve the prefix** up to a chosen boundary; only the changed segment runs live. Supports prompt/tool edits in UI, side-by-side session timeline, eval cards in same session. Sub-second iteration vs. full multi-minute runs.

**Eden status:** Phase P Agent Debugger (`docs/docs/observability/39-agent-debugger.md`) ships **hermetic reruns only** — recorded responses, no live LLM, no tool re-execution. Real reruns explicitly deferred to Phase P.5.

**Why it matters:** Laminar's debugger is built for the actual dev loop ("change prompt → rerun from step 40 in 2 seconds"). Eden's hermetic mode answers "what if wording changed" but not "does the fix actually work."

---

### Gap 1.2 — Coding-agent-owned iteration loop (CLI + MCP + skill) 🔴

**What Laminar has:** `lmnr-cli`, MCP server for SQL/trace queries, "Laminar skill" so Claude Code/Cursor/Codex can: run agent → read trace → edit code → rerun → write eval — autonomously. Debugger session UI shows the agent's notes and runs live.

**Eden status:** MCP **trace ingestion** exists (`observability_mcp.py`); autonomous agent has `search_spans` tool. No first-party MCP/CLI product for external coding agents to drive Eden's debug loop. Cat 23 code-change is stub/gated.

**Why it matters:** Laminar treats the coding agent as the primary debugger user. Eden treats the human operator as primary.

---

### Gap 1.3 — Signals: per-trace LLM investigation (not metric compilation) 🔴

**What Laminar has:** Signals are plain-English instructions + JSON schema. For each matching trace, Laminar:
1. Compresses trace to ~10% tokens (dedupe system prompts, drop plumbing)
2. Runs an **investigation agent** with tools (search spans, fetch full span by ID)
3. Emits structured `signal_events` with severity
4. Supports **backfill** on historical traces and **real-time triggers**

Plus: hierarchical **clustering** with AI-generated names, parent/child tree, resolve/reopen lifecycle, SQL-queryable `clusters` table.

**Eden status:** Phase Q Plain English Signals (`38-plain-english-signals.md`) compiles NL to **8 fixed metrics** (refusal_rate, error_rate, etc.) via regex patterns — not per-trace semantic analysis. Live matcher, backfill, and auto-cluster are deferred (Phase Q.5). Clustering is Jaccard on signal definitions, not on event payloads across traces.

**Why it matters:** Laminar Signals answer "did the agent get stuck in a retry loop on this trace?" Eden Signals answer "is refusal_rate > 5%?" — different abstraction layers.

---

### Gap 1.4 — Browser session recording synced to trace 🔴

**What Laminar has:** Full browser session capture for browser agents — operator sees what the agent saw at each step, synced with trace timeline. Production feature with shared trace demos.

**Eden status:** Phase O (`44-session-recording.md`) — **backend event model + redaction only**. RRWeb client, routes, sandbox replay iframe, side-by-side compare all deferred to O.5.

---

### Gap 1.5 — Run agent from platform UI + local dev server 🟠

**What Laminar has:** Local dev server connects to Laminar platform; run agent from UI; on failure jump to exact step; tweak prompt/tools in UI; rerun with context preserved.

**Eden status:** No equivalent local dev server or in-platform agent runner. Eden captures production/gateway traffic; debugging is trace-retrospective.

---

### Gap 1.6 — 20× trace compression + Rust performance engine 🟠

**What Laminar has:** Rust implementation, 20× trace compression (dedupe repeated content), custom realtime engine, ultra-fast full-text search, gRPC OTLP exporter. Explicit cost/latency advantage at scale.

**Eden status:** Typesense full-text search planned/Partial (`observability.py` Phase B); ClickHouse + Postgres stack. No content-level compression story comparable to Laminar's dedupe architecture.

---

### Gap 1.7 — Framework integration breadth (browser/computer-use agents) 🟠

**What Laminar has:** First-class integrations and docs for: Browser Use, Stagehand, Playwright, Puppeteer, OpenHands SDK, OpenCode, Skyvern, Kernel (computer-use), Temporal Workflows, eve Durable Agents, LangChain DeepAgents, Pydantic AI, Mastra, LiteLLM, Cohere — often one-line auto-instrument.

**Eden status:** OpenAI, Anthropic, LangChain, LlamaIndex, CrewAI, AutoGen, Vercel AI SDK. **Missing** dedicated paths for Browser Use, Stagehand, OpenHands, Playwright, Temporal, OpenCode, Skyvern, Pydantic AI, Mastra.

---

### Gap 1.8 — Sessions as first-class multi-turn timeline 🟡

**What Laminar has:** `session_id` groups traces; Sessions view shows numbered cards (1/5, 2/5) with input/output previews per turn.

**Eden status:** Trace-centric model; multi-agent span trees exist but no dedicated Sessions UX matching Laminar's conversation-over-time view.

---

### Gap 1.9 — Custom render templates + labeling UI for datasets 🟡

**What Laminar has:** Render templates for custom data views; fast annotation UI; build labeled datasets from traces, dataset rows, or SQL results.

**Eden status:** Labeling queue (`36-labeling-queue.md`) and dataset spreadsheet (`40-dataset-spreadsheet.md`) exist; custom render templates for annotation not evident.

---

### Gap 1.10 — LangGraph visualization 🟡

**What Laminar has:** Dedicated LangGraph visualization doc/feature.

**Eden status:** Workflow graph (Cytoscape-style) in trace replay; no LangGraph-specific visualization.

---

### Eden areas of parity or advantage vs Laminar
- Transcript view — Eden portal ships `TranscriptView.tsx` (Laminar-style)
- SQL query surface — Eden EQL + read-only SQL (`32-sql-query-surface.md`)
- Time-travel debugging API — Cat 20 shipped
- Self-host — both offer Docker/Helm; Eden Helm exists
- Evals — Eden Cat 3 is deeper; Laminar eval UI is strong but narrower
- Gateway, budgets, governance — Eden ahead

---

# 2. Sentrial (YC W26)
**Founders:** Neel Sharma, Anay Shukla — neel@sentrial.com / anay@sentrial.com  
**Site:** https://www.sentrial.com

### Positioning
"Production monitoring for AI agent behavior" — semantic detection of loops, hallucinations, tool misuse, and user frustration, with AI diagnosis and **fix-in-code via GitHub**.

---

### Gap 2.1 — Zero-config automatic semantic issue detection 🔴

**What Sentrial has:** Every session analyzed automatically for: task failures, tool errors, hallucinations, user frustration, confusion loops, slow responses, high cost — **no manual signal definition**. Issues grouped by pattern; severity assigned.

**Eden status:** Cat 2 RCA uses rule-based pre-filter + deterministic cluster keys `(category, error_type, agent_id)` — not semantic per-session LLM scanning out of the box. Loop detection exists in ETEC (`eden-trace-quality-system-spec.md`) but is trace-quality focused, not a production issue feed like Sentrial's.

**Why it matters:** Sentrial's pitch is "install SDK, issues appear." Eden requires more operator configuration (signals, rules, judges).

---

### Gap 2.2 — Learn-from-labeled-tool-calls (few-shot agent calibration) 🔴

**What Sentrial has:** (From Launch HN) Operators mark tool calls right/wrong in context; Sentrial learns the pattern for that agent and flags similar mistakes automatically from conversation state, tool choice, arguments, and what happened next.

**Eden status:** No equivalent "learn correct tool usage from sparse labels" feature. Eden has tool intelligence (attribution, comparator, drift) but not interactive few-shot calibration from operator labels.

**Why it matters:** This is a practical moat for customer-specific agents where generic loop/hallucination detectors miss domain errors.

---

### Gap 2.3 — Diagnosis → GitHub code chat → one-click PR (shipped UX) 🔴

**What Sentrial has:** Connect GitHub repo; index agent-relevant files; from any issue, "Fix in Code" opens AI chat with issue + session + codebase context; review diff; create PR in one flow. Documented as core product, not stub.

**Eden status:** Cat 23 Autonomous Code Modification (`23-autonomous-code-modification.md`) — **STUB surface**; 4-gate rollout not complete. GitHub App infrastructure exists (`github.py`, `GitHubPRProvider`) but end-to-end "click issue → chat → PR" is not production-default.

---

### Gap 2.4 — Session-first data model 🟠

**What Sentrial has:** Sessions are the foundation — `begin()` → track events/tool calls/decisions → `complete_session(success, failure_reason, cost)`. Optimized for "one user interaction" as unit of monitoring.

**Eden status:** Trace/span-first (OpenTelemetry model). Session abstraction exists in various routes but Sentrial's SDK API is cleaner for agent-product teams.

---

### Gap 2.5 — Integrations: Claude Code, Mastra, AutoGen as one-liners 🟠

**What Sentrial has:** Dedicated integration guides for Claude Agent SDK (Python + TS), Mastra, AutoGen, CrewAI, LangChain, Vercel AI SDK — positioned as "5 minutes to first issue detected."

**Eden status:** Auto-instrument docs cover major frameworks; Sentrial's Claude Code / Mastra positioning is sharper for 2026 agent-builder stack.

---

### Gap 2.6 — CLI for scaffolding and session inspection 🟡

**What Sentrial has:** CLI to install, scaffold integrations, inspect sessions from terminal.

**Eden status:** CLI for instrument/uninstrument exists; no equivalent session inspection CLI.

---

### Gap 2.7 — "Use with AI" docs for auto-instrumentation 🟡

**What Sentrial has:** Explicit docs page for Cursor/Claude Code to search Sentrial docs and instrument agents automatically.

**Eden status:** Onboarding + GitHub App auto-instrument PRs; no equivalent "point your AI at our docs" page.

---

### Eden areas of parity or advantage vs Sentrial
- OpenTelemetry ingestion — both support
- PII redaction — Eden gateway + Presidio deeper
- Evals/judges — Eden Cat 3 far deeper
- Cost intelligence, budgets, gateway — Eden ahead
- Compliance/SOC2 evidence packs — Eden ahead
- Breadth of intelligence categories — Eden ahead

---

# 3. Raindrop (YC W24)
**Founders:** Zubin Koticha, Alexis Gauba, Ben Hylak  
**Site:** https://www.raindrop.ai · **Workshop (OSS):** https://raindrop.sh

### Positioning
"Sentry for AI Agents" — detect silent failures, alert in Slack, triage, experiment behind flags, self-healing via coding agents. Strong UX reputation; used by Vercel/v0, Speak, Clay, Framer, Fortune 100.

---

### Gap 3.1 — Sentry-style Issues hierarchy (Stumbles → Issues) 🔴

**What Raindrop has (Raindrop 2.0):**
- **Stumbles** — single failure in one run (including agent self-diagnostics mid-run)
- **Issues** — same stumble recurring across runs/users; ranked by severity, user impact count, examples
- **Signals** — classifiers scoring every trace over time

Operator workflow mirrors Sentry: issue page, frequency chart, affected users, linked traces.

**Eden status:** Cat 2 incident clustering groups by deterministic keys; no stumble/issue promotion hierarchy or Sentry-parity issue lifecycle UX documented.

---

### Gap 3.2 — Triage Agent (AI investigator) 🔴

**What Raindrop has:** Triage Agent investigates issues, finds root cause, packages context for coding agent via MCP. Pro tier feature; central to Raindrop 2.0 "self-healing agents" narrative.

**Eden status:** Cat 14 Investigation Agent exists at service level; not productized as "Triage Agent" with issue → root cause → handoff-to-coding-agent workflow matching Raindrop's shipped loop.

---

### Gap 3.3 — Slack bot (@Raindrop) as operational interface 🔴

**What Raindrop has:** Raindrop lives in Slack — ask questions, triage issues, create signals, get severe-issue alerts with user impact counts. Described as "just @Raindrop for everything."

**Eden status:** Slack **webhooks** for alerts (`integrations/slack.py`, budget alerts, code-change notify). No interactive Slack bot product.

---

### Gap 3.4 — Workshop: OSS local debugger 🟠

**What Raindrop has:** Free, local, open-source debugger (`curl -fsSL https://raindrop.sh/install | bash`):
- Live-streamed traces to localhost:5899
- Integrates with Claude Code/Codex/Cursor/OpenCode
- Self-healing eval loop: agent writes eval from trace → fixes code → reruns until passing
- Code-aware evals asserting on tool-call sequence, state, files

**Eden status:** No OSS local debugger product. Portal trace replay exists but requires cloud account; no localhost streaming dev tool.

**Why it matters:** Workshop is Raindrop's developer acquisition funnel and local iteration surface — strong community love ("finally somebody built this").

---

### Gap 3.5 — Production experiments tied to issue verification + feature flags 🟠

**What Raindrop has:** Experiments A/B suite on live traffic — compare model/prompt/tool/pipeline changes; roll out behind feature flag; verify issue frequency dropped; reverse lookup from issue to flag/model/tool causing it.

**Eden status:** Cat 12 Experimentation (traffic splitter, Bayesian winner, staging replay) is backend-strong; **feature-flag-native production experiments** tied to issue resolution workflow not productized like Raindrop.

---

### Gap 3.6 — Per-product trained signal classifiers 🟠

**What Raindrop has:** Custom signals via pipeline that trains small models adapted to each product (~1 hour training, reviews every event, backfills 3 days). Default signal library: Forgetting, Task Failure, User Frustration, Laziness, Wins, Jailbreaking, NSFW, etc.

**Eden status:** Phase Q signals compile to metric rules; Raindrop trains **per-customer classifiers**. Eden judge-v2 SLM plan exists but different architecture.

---

### Gap 3.7 — Wins / positive signal detection as first-class 🟡

**What Raindrop has:** "Wins" — user praise/thanks surfaced as signals to double down and create evals from.

**Eden status:** User intelligence tracks regeneration/edit/return/abandonment; no equivalent "Wins" product surface.

---

### Gap 3.8 — Deep Search → auto-generated classifier rules 🟡

**What Raindrop has:** NL Deep Search refines into classifier rules with "Update Search" generating rules from refinements (e.g., "user speaking Chinese" classifier built in minutes — customer story).

**Eden status:** NL query in AI sidebar; no Deep Search → classifier pipeline.

---

### Gap 3.9 — Conversation UI praised as category-best 🟡

**What Raindrop has:** Notion-like conversation blocks; "beautiful way to look at data, not soulless JSON dump" — repeatedly cited by developers (Hamel Husain, Reid Draper, etc.).

**Eden status:** TranscriptView exists; market perception (from public testimonials) favors Raindrop's UX polish for multi-agent/parallel workflows.

---

### Gap 3.10 — MCP auto-fix loop (`mcp.run_autofix`) 🟡

**What Raindrop has:** Documented MCP workflow: trace → patch → verify for coding agents.

**Eden status:** Cat 23 stub; no shipped `run_autofix` MCP equivalent.

---

### Eden areas of parity or advantage vs Raindrop
- Trace capture breadth — Eden comparable
- Eval depth — Eden Cat 3 deeper
- Gateway/PII/budgets — Eden ahead
- Governance/compliance — Eden ahead
- Environment generation — Eden unique
- Self-host maturity — Eden Helm; Raindrop VPC is enterprise beta

---

# 4. BentoLabs AI (YC Spring 2026)
**Founders:** Abhinav, Kaushik — abhinav@bentolabs.ai / kaushik@bentolabs.ai  
**Site:** https://bentolabs.ai · **SDK:** `bentolabs-sdk` on PyPI

### Positioning
"Monitoring and learning layer for long-running agents" — detect silent failure/drift, suggest fixes, **compound learnings so run 101 beats run 1**. Founders from Emergent (5M+ user production coding agents).

---

### Gap 4.1 — Runtime-injected self-learning (nudges/skills) 🔴

**What Bento has:**
- Detect recurring failure patterns across traces
- Auto-draft **trigger-based nudges** (skills, subagents, tools)
- Ship in **shadow mode** → score against outcome → **promote to 100% traffic** only if provably helpful
- Demote/archive nudges that regress
- Artifacts are **Markdown/YAML in repo** — model-agnostic, git-versioned

**Eden status:** KB (episodic/semantic/procedural) + Archivist + closed-loop hooks improve **analyst recommendations** and optional code-change PRs. **No runtime injection of learned skills into live agent execution.** Bento's loop closes inside the agent run; Eden's loop closes in the portal/KB.

**Why it matters:** This is Bento's core differentiation vs every observability tool including Eden. FAQs explicitly position against LangSmith/Langfuse: "They stop at observability; Bento injects learnings into the next run."

---

### Gap 4.2 — "The Book" — living plain-language agent memory 🔴

**What Bento has:** Persistent, human-readable memory of every failure pattern, fix, and outcome — compounding across runs.

**Eden status:** Eden KB semantic/procedural layers are architecturally similar but **not marketed or UX'd as runtime agent memory**. No "Book" artifact consumable by the agent at inference time.

---

### Gap 4.3 — Evidence-gated promotion pipeline (shadow → promote → demote) 🔴

**What Bento has:** Formal lifecycle: candidate nudge → shadow mode → outcome scoring → promote or archive. FAQ: "What if a nudge makes things worse? It gets demoted."

**Eden status:** StatGate (`eden-trace-quality-system-spec.md`) gates auto-actions on traces; Cat 23 has auto-approval workflow stubs. **No shadow-mode nudge promotion pipeline** matching Bento's production evidence model.

---

### Gap 4.4 — Behavioral drift with "what exactly shifted" 🟠

**What Bento has:** Detect when agent behavior changes across production runs without code deploy — pinpoint what shifted (tool selection, routing, decision patterns).

**Eden status:** Cat 13 predictive/drift (PSI on judge scores, embedding drift) exists; Bento's **agent-behavior drift** narrative (goal/prompt/tool-contract drift) is sharper for long-running agents.

---

### Gap 4.5 — NL alerts with real/benign incident triage 🟠

**What Bento has:** Write alerts in English; Bento groups fires into incidents and **judges each real or benign** — reduce alert fatigue.

**Eden status:** Eden alerts + RCA clustering; no explicit "benign vs real drift" AI judge on grouped incidents.

---

### Gap 4.6 — Auto-curated production eval datasets 🟠

**What Bento has:** Production datasets curated automatically from traces — grouped by outcome, intent, user segment; evals run offline, CI, and live on every release.

**Eden status:** Golden datasets, synthetic QA, dataset spreadsheet — strong but **manual curation** heavier than Bento's "production traces are the dataset" default.

---

### Gap 4.7 — Long-running agent operational focus 🟡

**What Bento has:** Explicit positioning for agents running minutes/hours (coding agents, workflows) with Emergent-scale production credibility. Published ARC-AGI-3 / Terminal-Bench improvement claims with self-learning layer.

**Eden status:** Eden supports long traces; positioning and proof points skew toward observability platform breadth, not "long-running agent reliability at Emergent scale."

---

### Gap 4.8 — No labeled data required for improvement loop 🟡

**What Bento has:** FAQ: production traces alone sufficient; labeled evals optional for tighter guardrails.

**Eden status:** Eden judges/evals often assume rubric/dataset setup; faster time-to-improvement loop not as clearly articulated.

---

### Eden areas of parity or advantage vs BentoLabs
- OTel-native tracing — both
- Plain-English signals — both (different implementations)
- Prompt/skill versioning — Eden prompts_v2 + canary
- Self-host — Eden Helm shipped; Bento "on request"
- Compliance depth — Eden SOC2 mapping, RTBF, evidence packs ahead
- Gateway, 22 intelligence cats — Eden far broader
- Environment generation — Eden unique

---

# 5. Cross-Competitor Themes (Eden Lagging Collectively)

## 5.1 Detect → Fix → Verify loop completeness 🔴

| Stage | Laminar | Sentrial | Raindrop | Bento | Eden |
|---|---|---|---|---|---|
| Detect | Signals (per-trace) | Auto issues | Stumbles/Issues | NL signals + drift | Rules + judges + ETEC |
| Understand | Transcript + TraceChat | AI diagnosis | Triage Agent | Root cause + Book | RCA + AI sidebar |
| Fix | MCP/CLI debugger | GitHub PR chat | MCP + Workshop | Nudges/skills | Cat 23 stub |
| Verify | Eval in session | — | Experiments + evals | CI/live eval gate | Cat 12 experiments |

**Eden gap:** Fix and Verify stages are least production-ready relative to this cohort.

---

## 5.2 Developer experience / local iteration 🔴

- **Laminar:** LMNR_DEBUG local server + cached rerun
- **Raindrop:** Workshop OSS localhost debugger
- **Sentrial:** 5-minute SDK quickstart, session CLI
- **Bento:** 30-minute OTel drop-in
- **Eden:** Cloud portal + gateway proxy; no beloved local OSS tool

---

## 5.3 Slack as product (not webhook) 🔴

Raindrop @-mention bot and Laminar signal alerts in Slack are **interactive workflows**. Eden routes alerts to Slack webhooks — notification, not collaboration surface.

---

## 5.4 Semantic monitoring without configuration 🔴

Sentrial (auto-scan), Raindrop (default signal library + trained classifiers), Laminar (Signals backfill), Bento (NL signals on traces) all emphasize **low setup**. Eden's power requires more operator sophistication (EQL, judges, signal compilation, intelligence categories).

---

## 5.5 Browser/computer-use agent observability 🟠

Laminar leads clearly (Browser Use, Stagehand, Playwright, synced screen recording). Eden has computer-use trace routes (`observability_computer_use.py`) and session recording backend stub — not end-to-end.

---

## 5.6 Production proof / market perception 🟡

Public testimonials and named customers (Vercel/v0, Browser Use, Speak, Clay, Framer, Fortune 100 for Raindrop; Browser Use/OpenHands for Laminar; Emergent scale for Bento) exceed Eden's public social proof in this specific segment. Not a feature gap but affects competitive sales cycles.

---

# 6. Prioritized Recommendations for Eden

### P0 — Close the loop (next 1-2 product cycles)
1. **Ship real debugger reruns** (Laminar P.5 parity) — cached prefix + live tail, not hermetic-only
2. **Sentry-style Issues** — stumble detection → issue promotion → user impact counts
3. **Sentrial-parity diagnosis UX** — zero-config issue feed + optional tool-call labeling loop
4. **MCP/CLI for coding agents** — query traces, open issue, propose fix (even before full Cat 23)

### P1 — Developer acquisition
5. **Eden Workshop equivalent** — OSS local trace viewer with live stream (Raindrop parity)
6. **Browser agent bundle** — Stagehand/Browser Use/Playwright integration + RRWeb replay (Laminar parity)

### P2 — Differentiation vs Bento
7. **Runtime skill injection pilot** — promote KB procedural entries to shadow-mode nudges (Bento counter)
8. **Evidence-gated auto-actions** — extend StatGate to nudge/PR promotion lifecycle

### P3 — Polish / GTM
9. **Interactive Slack app** — triage, search, signal creation
10. **Per-trace Signals v2** — replace metric-only Phase Q with Laminar-style investigation agent on compressed traces

---

# 7. Sources

## Laminar
- https://laminar.sh/
- https://www.ycombinator.com/companies/laminar
- https://github.com/lmnr-ai/lmnr
- https://laminar.sh/docs/signals/introduction
- https://laminar.sh/docs/signals/clusters
- https://laminar.sh/docs/debugger/introduction
- https://laminar.sh/article/agent-observability

## Sentrial
- https://www.sentrial.com/
- https://www.ycombinator.com/companies/sentrial
- https://www.ycombinator.com/launches/PNE-sentrial-production-monitoring-for-ai-agent-behavior
- https://www.sentrial.com/docs
- https://www.sentrial.com/docs/concepts/diagnosis.md
- https://www.sentrial.com/docs/concepts/code-integration.md
- https://news.ycombinator.com/item?id=47337659

## Raindrop
- https://www.raindrop.ai/
- https://www.ycombinator.com/companies/raindrop
- https://www.raindrop.ai/blog/introducing-raindrop-2/
- https://www.raindrop.ai/docs/platform/signals/
- https://raindrop.sh/ (Workshop)

## BentoLabs AI
- https://bentolabs.ai/
- https://www.ycombinator.com/companies/bentolabs-ai
- https://bentolabs.ai/faqs
- https://pypi.org/project/bentolabs-sdk/

## Eden (internal)
- `README.md`, `PRD.md`
- `docs/docs/observability/` (Phases P, Q, O, Cat 2, 12, 14, 23)
- `eden-trace-quality-system-spec.md`
- `clients/portal/src/components/observability/TranscriptView.tsx`
- `eden-competitive-analysis-report.md` (prior report — Langfuse/LangSmith/Maxim focus)

---

*Report generated for Eden product/strategy use. Competitor features based on public materials as of July 2026.*
