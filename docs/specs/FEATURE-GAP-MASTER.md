# Eden Feature Gap Master Document

> **Date:** July 9, 2026  
> **Purpose:** Single source of truth for every feature Eden lacks or significantly lags vs Laminar, Sentrial, Raindrop, and BentoLabs AI — organized **by feature**, not by competitor.  
> **Granular specs:** [`docs/specs/features/`](features/) — **48 individual feature specification files**  
> **Competitor analysis:** [`eden-competitor-gap-analysis-laminar-sentrial-raindrop-bento.md`](../eden-competitor-gap-analysis-laminar-sentrial-raindrop-bento.md)  
> **Spec review:** [`docs/specs/features/SPEC-REVIEW.md`](features/SPEC-REVIEW.md)

---

## 1. How to use this document

| If you want… | Go to… |
|---|---|
| Full list of what's missing | **Section 3** below |
| One feature's build spec | `docs/specs/features/fXX-{slug}.md` |
| Priority / dependency order | **Section 5** + [SPEC-REVIEW.md](features/SPEC-REVIEW.md) |
| What Eden already has | **Section 4** |
| Competitor motivation | Gap analysis report (linked above) |

Each of the **48 features** has its own spec file with: Eden file paths, target behavior, architecture, SQL DDL, API contracts, implementation steps, flags, tests, acceptance criteria, and dependencies.

---

## 2. Executive summary — what Eden is missing

Eden's **breadth** (22 intelligence categories, gateway, KB, governance, environment generation) exceeds all four competitors. Eden's **closed-loop product velocity** does not.

### The gap in one sentence

> Competitors ship sharp **detect → understand → fix → verify** loops with low-config production monitoring and coding-agent-first debugging; Eden has many backend modules marked "IMPLEMENTED v1" but **critical UX paths are broken, stubbed, or not wired end-to-end**.

### Five missing capabilities (themes)

1. **Production issue feed with zero config** — Sentrial/Raindrop/Bento detect loops, frustration, hallucinations automatically; Eden requires judges, EQL, or metric signals
2. **Live debugger with cached prefix replay** — Laminar/Raindrop dev loops; Eden has hermetic-only reruns + separate Cat 20 time-travel, portal API broken
3. **Coding-agent-native tooling** — Laminar MCP/CLI, Raindrop Workshop; Eden has portal-first UX, MCP ingest-only
4. **Sentry-style issues + triage → fix → verify** — Raindrop Stumbles/Issues/Triage/Experiments; Eden has deterministic incident clusters, Cat 23 stub
5. **Runtime learning injection** — Bento nudges/skills promoted into live runs; Eden KB is analyst-facing only

### Counts

| Status | Features | Meaning |
|---|---|---|
| **MISSING** | 38 | No shippable product surface |
| **PARTIAL** | 9 | Backend or UI fragment exists; not production-complete |
| **BROKEN** | 1 | F48 — portal calls wrong APIs |
| **SHIPPED** (Eden ahead) | — | See Section 4 |

---

## 3. Complete feature inventory — everything Eden is missing

### 3.1 Debugger & developer loop (F01–F05, F10, F32)

| ID | Feature | Status | Competitor | Spec |
|---|---|---|---|---|
| F01 | Cached prefix live debugger | PARTIAL | Laminar | [f01](features/f01-cached-prefix-live-debugger.md) |
| F02 | Debug session timeline | MISSING | Laminar | [f02](features/f02-debug-session-timeline.md) |
| F03 | Checkpoint ingestion from LLM spans | MISSING | Laminar | [f03](features/f03-checkpoint-ingestion-from-spans.md) |
| F04 | MCP query server for coding agents | MISSING | Laminar, Raindrop | [f04](features/f04-mcp-query-server.md) |
| F05 | Eden CLI debug subcommands | MISSING | Laminar, Sentrial | [f05](features/f05-eden-cli-debug.md) |
| F10 | Local debug dev server | MISSING | Laminar, Raindrop | [f10](features/f10-local-debug-dev-server.md) |
| F32 | Eden Workshop OSS local debugger | MISSING | Raindrop | [f32](features/f32-eden-workshop-oss.md) |

**What's missing in plain language:** You cannot today run `eden debug rerun --live` with sub-second prefix cache; checkpoints aren't auto-created from production traces; Claude Code cannot drive Eden via MCP; there is no free localhost debugger like Raindrop Workshop.

**Eden has but fragmented:** Hermetic `ReRunEngine` (`checkpoints.py:243`), Cat 20 `TraceReplayer` (`replayer.py:57`), broken portal debugger page (`debugger/page.tsx`).

---

### 3.2 Signals & detection (F06–F08, F20, F34–F36, F43)

| ID | Feature | Status | Competitor | Spec |
|---|---|---|---|---|
| F06 | Per-trace signal investigation agent | MISSING | Laminar, Bento | [f06](features/f06-per-trace-signal-investigator.md) |
| F07 | Signal cluster hierarchy & lifecycle | MISSING | Laminar | [f07](features/f07-signal-cluster-lifecycle.md) |
| F08 | Signal historical backfill | MISSING | Laminar, Bento | [f08](features/f08-signal-historical-backfill.md) |
| F20 | Zero-config automatic issue detection | MISSING | Sentrial, Raindrop | [f20](features/f20-zero-config-auto-issue-detection.md) |
| F34 | Per-org trained signal classifiers | MISSING | Raindrop | [f34](features/f34-trained-signal-classifiers.md) |
| F35 | Default signal library | MISSING | Raindrop | [f35](features/f35-default-signal-library.md) |
| F36 | Deep search → classifier pipeline | MISSING | Raindrop | [f36](features/f36-deep-search-classifier.md) |
| F43 | Alert real/benign AI triage | MISSING | Bento | [f43](features/f43-alert-benign-triage.md) |

**What's missing:** Phase Q signals compile English to 8 metric rules (`signals.py`) — they do **not** read each trace with an investigation agent. No backfill. No Raindrop-style trained classifiers or default Forgetting/Laziness/Wins library. No auto issue feed on SDK install.

**Eden has:** Regex NL compiler, ETEC loop detection (not surfaced as issues), judge framework (requires setup).

---

### 3.3 Issues, triage & fix loop (F28–F30, F21–F23, F37, F46)

| ID | Feature | Status | Competitor | Spec |
|---|---|---|---|---|
| F28 | Agent stumbles | MISSING | Raindrop | [f28](features/f28-agent-stumbles.md) |
| F29 | Agent issues (Sentry-style) | MISSING | Raindrop | [f29](features/f29-agent-issues-sentry.md) |
| F30 | Triage agent | PARTIAL | Raindrop | [f30](features/f30-triage-agent.md) |
| F21 | Tool call label learning | MISSING | Sentrial | [f21](features/f21-tool-call-label-learning.md) |
| F22 | Issue fix-in-code GitHub chat | PARTIAL | Sentrial, Raindrop | [f22](features/f22-issue-fix-github-chat.md) |
| F23 | Session-first SDK | MISSING | Sentrial | [f23](features/f23-session-first-sdk.md) |
| F37 | MCP run_autofix | PARTIAL | Raindrop | [f37](features/f37-mcp-run-autofix.md) |
| F46 | Closed-loop orchestrator | MISSING | All | [f46](features/f46-closed-loop-orchestrator.md) |

**What's missing:** No Stumble → Issue promotion; no user impact counts; no "Fix in Code" shipped UX; `InvestigationAgent` (`investigation.py:62`) is single-shot and not issue-scoped; Cat 23 code change is stub (`code_change_enabled=false`); no issue state machine tying detect→fix→verify.

**Eden has:** `IncidentClusterer` with deterministic keys (`clusterer.py`) — different abstraction; GitHub App infrastructure; `agent_pr_suggestions` partial UX.

---

### 3.4 Browser & computer-use (F09, F13–F16, F38)

| ID | Feature | Status | Competitor | Spec |
|---|---|---|---|---|
| F09 | Browser session recording (RRWeb) | PARTIAL | Laminar | [f09](features/f09-browser-session-recording-rrweb.md) |
| F13 | Browser Use integration | MISSING | Laminar | [f13](features/f13-browser-use-integration.md) |
| F14 | Stagehand integration | MISSING | Laminar | [f14](features/f14-stagehand-integration.md) |
| F15 | Playwright/Puppeteer integration | MISSING | Laminar | [f15](features/f15-playwright-puppeteer-integration.md) |
| F16 | OpenHands/OpenCode integration | MISSING | Laminar | [f16](features/f16-openhands-opencode-integration.md) |
| F38 | Transcript UI v2 | PARTIAL | Raindrop | [f38](features/f38-transcript-ui-v2.md) |

**What's missing:** RRWeb client, session routes, replay iframe (Phase O backend only in `replay/events.py`). No Browser Use/Stagehand/Playwright one-liners. TranscriptView exists but lacks Raindrop-polish (Notion blocks, parallel tool swimlanes).

**Eden has:** `observability_computer_use.py` (screenshots/steps), `TranscriptView.tsx`.

---

### 3.5 Runtime learning (F39–F41, F45)

| ID | Feature | Status | Competitor | Spec |
|---|---|---|---|---|
| F39 | Runtime nudge injection | MISSING | BentoLabs | [f39](features/f39-runtime-nudge-injection.md) |
| F40 | The Book agent memory | MISSING | BentoLabs | [f40](features/f40-the-book-agent-memory.md) |
| F41 | Evidence-gated promotion | PARTIAL | BentoLabs | [f41](features/f41-evidence-gated-promotion.md) |
| F45 | Runtime skill export to repo | MISSING | BentoLabs | [f45](features/f45-runtime-skill-export.md) |

**What's missing:** No gateway hook to inject learned skills/nudges; no shadow→promote→demote lifecycle in production; no "Book" markdown artifact at inference time; StatGate exists for guardrails but not unified promotion queue.

**Eden has:** `ProceduralClient` (`kb/procedural/client.py`), StatGate in trace quality spec, KB Archivist — all analyst-side.

---

### 3.6 Platform, search, experiments (F11–F12, F17–F19, F33, F42, F44)

| ID | Feature | Status | Competitor | Spec |
|---|---|---|---|---|
| F11 | Trace content deduplication | MISSING | Laminar | [f11](features/f11-trace-content-deduplication.md) |
| F12 | Typesense full-text span search | PARTIAL | Laminar | [f12](features/f12-typesense-span-search.md) |
| F17 | Sessions multi-turn timeline UI | MISSING | Laminar, Sentrial | [f17](features/f17-sessions-multiturn-timeline.md) |
| F18 | Custom render templates | MISSING | Laminar | [f18](features/f18-custom-render-templates.md) |
| F19 | LangGraph visualization | MISSING | Laminar | [f19](features/f19-langgraph-visualization.md) |
| F33 | Issue-linked experiments | PARTIAL | Raindrop | [f33](features/f33-issue-linked-experiments.md) |
| F42 | Behavioral drift pinpoint | PARTIAL | BentoLabs | [f42](features/f42-behavioral-drift-pinpoint.md) |
| F44 | Auto production eval slices | PARTIAL | BentoLabs | [f44](features/f44-auto-production-eval-slices.md) |

---

### 3.7 Integrations, Slack, docs (F24–F27, F31, F47, F48)

| ID | Feature | Status | Competitor | Spec |
|---|---|---|---|---|
| F24 | Claude Agent SDK integration | MISSING | Sentrial, Laminar | [f24](features/f24-claude-agent-sdk-integration.md) |
| F25 | Mastra integration | MISSING | Sentrial, Laminar | [f25](features/f25-mastra-integration.md) |
| F26 | CLI session inspection | MISSING | Sentrial | [f26](features/f26-cli-session-inspection.md) |
| F27 | Use-with-AI docs + llms.txt | MISSING | Sentrial | [f27](features/f27-use-with-ai-docs.md) |
| F31 | Interactive Slack bot | MISSING | Raindrop, Laminar | [f31](features/f31-interactive-slack-bot.md) |
| F47 | Slack Block Kit outbound alerts | MISSING | Raindrop, Laminar | [f47](features/f47-slack-block-kit-alerts.md) |
| F48 | Portal API contract fix | **BROKEN** | Internal | [f48](features/f48-portal-api-contract-fix.md) |

**Critical broken state (F48):**
- Portal `GET /debugger/checkpoints?trace_id=` → Backend expects `GET /debugger/checkpoints/{trace_id}`
- Portal `POST /debugger/rewind/{id}` → **Route does not exist**
- Portal signals expects `POST /signals/{id}/compile` → Backend compiles on create only
- `/debugger` and `/signals` not in sidebar (`sidebar-config.ts`)

**Slack:** `integrations/slack.py` referenced in docs **does not exist**; `alert_stream.py` Slack dispatch is placeholder log only.

---

## 4. What Eden has (not missing — competitive advantages)

Do **not** rebuild these; leverage in GTM:

| Capability | Eden location | vs competitors |
|---|---|---|
| OpenAI-compatible gateway + PII + budgets | `src/eden/api/routes/gateway.py` | Ahead of all four |
| 22 intelligence categories | `docs/docs/explanation/intelligence-categories.md` | Much broader |
| ETEC + StatGate guardrails | `eden-trace-quality-system-spec.md` | Unique non-LLM trace quality |
| Cat 3 evals / judges | `src/eden/evaluation/` | Deeper than Laminar/Raindrop |
| EQL + SQL query surface | Cat 19, `sql_query.py` | Laminar parity |
| Time-travel fork API (Cat 20) | `intelligence_time_travel.py` | Partial Laminar debugger parity |
| Transcript view | `TranscriptView.tsx` | Laminar parity (UI exists) |
| Hermetic debugger API | `debugger/checkpoints.py` | Subset of Laminar |
| Compliance / SOC2 / RTBF | Cat 10 governance | Ahead |
| Environment generation pipeline | PRD Part VIII | Unique — none have this |
| GitHub App + PR provider | `github.py`, `providers/pr.py` | Infrastructure for F22 |
| Investigation agent (single-shot) | `investigation.py` | Seed for F30 |
| Cat 12 experiments backend | `experiment_intel/` | Seed for F33 |
| Computer-use trace routes | `observability_computer_use.py` | Seed for F09/F15 |

---

## 5. Implementation waves (dependency order)

```
Wave 0 (immediate)     F48 Portal API fix
         │
Wave 1 (P0 loop)       F28 Stumbles → F29 Issues → F20 Auto-detect → F30 Triage
         │                    F03 Checkpoints → F01 Live debugger → F04 MCP
         │                    F47 Slack alerts → F22 Fix chat
         │
Wave 2 (P1 dev UX)     F05 CLI → F10 Local server → F32 Workshop
         │                    F09 RRWeb → F13-F15 Browser integrations
         │
Wave 3 (P1 signals)    F06 Per-trace signals → F07 Clusters → F08 Backfill
         │                    F35 Default library → F34 Classifiers
         │
Wave 4 (P2 Bento)      F39 Nudges → F41 Evidence gate → F40 Book
         │
Wave 5 (P2 polish)     F38 Transcript v2 → F31 Slack bot → F11 Dedupe
         │
Capstone               F46 Closed-loop orchestrator
```

---

## 6. Database objects to create (consolidated)

~20 new tables across features — recommend migration `080_feature_gap_wave1.sql`:

`debugger_llm_cache`, `debug_sessions`, `debug_session_runs`, `signal_definitions`, `signal_events`, `signal_clusters`, `browser_sessions`, `browser_session_events`, `agent_stumbles`, `agent_issues`, `agent_issue_stumbles`, `tool_call_labels`, `tool_call_calibrators`, `agent_sessions`, `nudges`, `nudge_outcomes`, `agent_books`, `promotion_candidates`, `production_eval_slices`, `slack_installations`, `signal_classifiers`, `backfill_jobs`

Full DDL per table: see individual feature specs.

---

## 7. Feature spec file index

All files in [`docs/specs/features/`](features/):

```
f01-cached-prefix-live-debugger.md      f25-mastra-integration.md
f02-debug-session-timeline.md           f26-cli-session-inspection.md
f03-checkpoint-ingestion-from-spans.md  f27-use-with-ai-docs.md
f04-mcp-query-server.md                 f28-agent-stumbles.md
f05-eden-cli-debug.md                   f29-agent-issues-sentry.md
f06-per-trace-signal-investigator.md    f30-triage-agent.md
f07-signal-cluster-lifecycle.md         f31-interactive-slack-bot.md
f08-signal-historical-backfill.md       f32-eden-workshop-oss.md
f09-browser-session-recording-rrweb.md  f33-issue-linked-experiments.md
f10-local-debug-dev-server.md           f34-trained-signal-classifiers.md
f11-trace-content-deduplication.md      f35-default-signal-library.md
f12-typesense-span-search.md            f36-deep-search-classifier.md
f13-browser-use-integration.md          f37-mcp-run-autofix.md
f14-stagehand-integration.md            f38-transcript-ui-v2.md
f15-playwright-puppeteer-integration.md f39-runtime-nudge-injection.md
f16-openhands-opencode-integration.md   f40-the-book-agent-memory.md
f17-sessions-multiturn-timeline.md      f41-evidence-gated-promotion.md
f18-custom-render-templates.md          f42-behavioral-drift-pinpoint.md
f19-langgraph-visualization.md          f43-alert-benign-triage.md
f20-zero-config-auto-issue-detection.md f44-auto-production-eval-slices.md
f21-tool-call-label-learning.md         f45-runtime-skill-export.md
f22-issue-fix-github-chat.md            f46-closed-loop-orchestrator.md
f23-session-first-sdk.md                f47-slack-block-kit-alerts.md
f24-claude-agent-sdk-integration.md     f48-portal-api-contract-fix.md
```

---

## 8. Document map (supersedes competitor-by-competitor specs)

| Document | Role |
|---|---|
| **This file** | Master inventory + what's missing + waves |
| `docs/specs/features/fXX-*.md` | **Canonical implementation spec per feature** |
| `docs/specs/features/SPEC-REVIEW.md` | Cross-feature review, risks, schema index |
| `docs/specs/competitor-gaps/` | Earlier competitor-organized specs (reference only) |
| `eden-competitor-gap-analysis-*.md` | Research + gap identification |

---

*Last updated: July 9, 2026 — 48 feature specs, codebase-verified.*
