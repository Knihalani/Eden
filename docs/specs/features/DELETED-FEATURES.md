# Deleted Feature Specs — Rationale & Merge Map

> **Date:** July 9, 2026  
> **Action:** Removed 24 of 48 feature specs after value/pruning review.  
> **Remaining:** 24 F-features + 8 N-features (next-level).  
> **Strategy:** Coding-agent-first via **F04 Eden MCP Server**; avoid parallel CLI/workshop/integration sprawl.

---

## Summary

| Metric | Before | After |
|---|---|---|
| F-feature specs | 48 | 24 |
| N-feature specs (new) | 0 | 8 |
| Primary coding-agent interface | F05 CLI + F04 MCP + F32 Workshop | **F04 Eden MCP only** |

---

## Deleted features (24)

### Absorbed into F04 Eden MCP Server

| ID | Title | Merge destination |
|---|---|---|
| F05 | Eden CLI debug subcommands | F04 tools: `rerun_debugger`, `list_debug_sessions`, `search_traces` |
| F10 | Local debug dev server | F04 stdio transport + optional `EDEN_LOCAL` base URL |
| F26 | CLI session inspection | F04 `list_debug_sessions`, `create_debug_session` |
| F37 | MCP run_autofix | F04 `run_autofix` tool (§8) |

### Absorbed into other surviving specs

| ID | Title | Merge destination |
|---|---|---|
| F02 | Debug session timeline | F01 §debug_sessions / F04 `create_debug_session` |
| F07 | Signal cluster lifecycle | F06 §cluster lifecycle (deferred P2 within F06) |
| F08 | Signal historical backfill | F06 §backfill (deferred P2 within F06) |
| F45 | Runtime skill export to repo | F39 §customer repo export (`eden-nudges/*.yaml`) |

### Deprioritized — low ROI vs market needs

| ID | Title | Rationale |
|---|---|---|
| F11 | Trace content deduplication | Infra cost optimization; no competitive deal loss signal |
| F13 | Browser Use integration | Generic OTel + `@eden-ai/browser-recorder` (F09) sufficient |
| F14 | Stagehand integration | Same — framework-specific one-liners don't close deals |
| F15 | Playwright/Puppeteer integration | Computer-use routes exist; F09 RRWeb is the spec |
| F16 | OpenHands/OpenCode integration | Ingestion decoder low priority; Cat 23 stub separate |
| F17 | Sessions multi-turn timeline UI | Portal polish; session_id exists on traces |
| F18 | Custom render templates | Labeling queue niche |
| F19 | LangGraph visualization | Niche framework; generic workflow graph enough |
| F24 | Claude Agent SDK integration | F04 MCP quickstart + OTel docs replace |
| F25 | Mastra integration | Same |
| F27 | Use-with-AI docs + llms.txt | F04 integration docs include llms.txt |
| F31 | Interactive Slack bot | F47 Block Kit alerts higher value/effort ratio |
| F32 | Eden Workshop OSS | OSS maintenance; MCP + portal cover dev loop |
| F36 | Deep search → classifier | F06 investigator + F34 classifiers cover path |
| F38 | Transcript UI v2 | Incremental portal work, not spec-worthy gap |
| F43 | Alert benign triage | F30 triage + N08 StatGate cover severity |

---

## Surviving F-features (24)

| ID | Title | Priority |
|---|---|---|
| F01 | Cached prefix live debugger | P0 |
| F03 | Checkpoint ingestion from spans | P0 |
| F04 | Eden MCP Server | P0 |
| F06 | Per-trace signal investigator | P0 |
| F09 | Browser session recording (RRWeb) | P1 |
| F12 | Typesense span search | P1 |
| F20 | Zero-config auto issue detection | P0 |
| F21 | Tool call label learning | P0 |
| F22 | Issue fix GitHub chat | P0 |
| F23 | Session-first SDK | P1 |
| F28 | Agent stumbles | P0 |
| F29 | Agent issues (Sentry-style) | P0 |
| F30 | Triage agent | P0 |
| F33 | Issue-linked experiments | P1 |
| F34 | Trained signal classifiers | P2 |
| F35 | Default signal library | P1 |
| F39 | Runtime nudge injection | P0 |
| F40 | The Book agent memory | P1 |
| F41 | Evidence-gated promotion | P0 |
| F42 | Behavioral drift pinpoint | P1 |
| F44 | Auto production eval slices | P1 |
| F46 | Closed-loop orchestrator | P0 |
| F47 | Slack Block Kit alerts | P0 |
| F48 | Portal API contract fix | P0 (BLOCKER) |

---

## New N-features (8)

See [MARKET-HYPOTHESES.md](../MARKET-HYPOTHESES.md):

| ID | Title | Priority |
|---|---|---|
| N01 | Production trace → regression eval | P0 |
| N02 | MCP toolchain observability | P0 |
| N03 | Continuous production eval sampling | P1 |
| N04 | Agent change impact preview | P1 |
| N05 | Multi-agent fleet health | P1 |
| N06 | Compliance audit trail automation | P1 |
| N07 | Environment from production failures | P0 |
| N08 | StatGate incident response | P1 |

---

## Git history

Deleted files remain in git history at commit `5b3da62` and earlier. Do not restore without product review.

---

*If you need content from a deleted spec, run: `git show 5b3da62:docs/specs/features/fXX-*.md`*
