#!/usr/bin/env python3
"""Generate granular feature-by-feature implementation specs."""

from pathlib import Path

OUT = Path(__file__).parent

FEATURES = [
    # (id, slug, title, priority, effort, status, competitors, gaps, summary, current, target, arch, ddl, api, impl, client, flags, tests, accept, deps)
]

def spec(f):
    FEATURES.append(f)

# ── DEBUGGER & DEV LOOP ──────────────────────────────────────────────
spec(("01","cached-prefix-live-debugger","Cached Prefix Live Debugger","P0","XL","PARTIAL",
      "Laminar","1.1",
      "Rerun agent from step N with prefix served from recorded LLM cache; only tail runs live via AIGateway.",
      """**Exists:** `ReRunEngine` hermetic-only (`src/eden/debugger/checkpoints.py:243`); Cat 20 `TraceReplayer` live step-N (`src/eden/time_travel/replayer.py:57`); routes `src/eden/api/routes/debugger.py`.
**Missing:** `rerun_mode=cached_live`, `debugger_llm_cache` table, cache hash excluding system msgs, unified UX.
**Portal bug:** `debuggerApi.listCheckpoints` calls wrong path (`clients/portal/src/lib/api.ts:4490`).""",
      """Operator selects step 12, edits system prompt, clicks Rerun (live). Steps 1–11 return from cache in <2s p95. Step 12+ invoke `AIGateway.complete()`. New trace T′ linked to debug session. Show cache_hits/misses/cost_usd.""",
      """`CachedPrefixReplayer` in `src/eden/debugger/live_rerun.py` delegates to `PrefixCacheService` + `AIGateway`. Hash: SHA256 of messages excluding system role (Laminar parity). On miss at step N, all subsequent steps live.""",
      """```sql
CREATE TABLE debugger_llm_cache (
  org_id UUID NOT NULL, source_trace_id UUID NOT NULL, step_number INT NOT NULL,
  input_hash TEXT NOT NULL, response JSONB NOT NULL, model TEXT,
  PRIMARY KEY (org_id, source_trace_id, step_number, input_hash)
);
CREATE TABLE debug_sessions (id UUID PRIMARY KEY, org_id UUID NOT NULL, started_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE debug_session_runs (id UUID PRIMARY KEY, session_id UUID REFERENCES debug_sessions(id), trace_id UUID, parent_trace_id UUID, rerun_mode TEXT, from_step INT);
```""",
      """Extend `POST /orgs/{org_id}/debugger/rerun`:
- Body add: `rerun_mode: hermetic|cached_live|full_live`, `session_id?`, `cache_until_step?`, `budget_usd_cap: float`, `max_live_steps: int`
- Response add: `new_trace_id`, `cache_hits`, `cache_misses`, `cost_usd`, `tokens_saved`
New: `POST /debugger/sessions`, `GET /debugger/sessions/{id}`""",
      """1. `src/eden/debugger/cache.py` — PrefixCacheService
2. `src/eden/debugger/live_rerun.py` — CachedPrefixReplayer.replay()
3. Extend `debugger.py` RerunRequest/RerunResponse
4. Share cache with Cat 20 `_step_cache_key` (deprecate duplicate)
5. Budget cap via `src/eden/api/routes/budgets.py`
6. Fix portal `debuggerApi` paths + types""",
      """Portal: `debugger/page.tsx` — mode toggle, trace picker, diff panel. SDK: `EDEN_DEBUG_CACHE_UNTIL` env var.""",
      "`debugger_live_rerun_v1` default false; `organizations.features.debugger_allow_live_rerun` for HIPAA.",
      "`tests/unit/debugger/test_cache_hash.py`, `tests/integration/test_debugger_live_rerun.py`",
      "- [ ] p95 prefix replay <2s on 50-step trace\n- [ ] System prompt change at step 12 preserves cache 1–11\n- [ ] Hermetic regression tests pass",
      "F03 checkpoint ingest; F02 debug sessions; Cat 20 TraceReplayer"))

spec(("02","debug-session-timeline","Debug Session Timeline","P0","M","MISSING",
      "Laminar","1.1,1.2",
      "Group debugger runs, evals, and notes in one investigation session timeline (CLI + portal).",
      "No `debug_sessions` table. Laminar writes `.lmnr/debug-session.json`.",
      "First `EDEN_DEBUG=1` run creates session; subsequent runs attach. Portal shows ordered cards: run traces, eval scores, agent notes.",
      "`DebugSessionService` CRUD; WebSocket fanout on new run.",
      "See F01 `debug_sessions`, `debug_session_runs` tables.",
      "`GET /debugger/sessions/{id}` returns `{runs[], evals[], notes[]}` sorted by time.",
      "`src/eden/debugger/session.py`; wire CLI `eden debug session start`.",
      "Portal route `/debugger/sessions/[id]` with vertical timeline component.",
      "`debugger_sessions_v1`",
      "Unit: session attach idempotency",
      "- [ ] CLI + portal show same session id",
      "F01, F05"))

spec(("03","checkpoint-ingestion-from-spans","Checkpoint Ingestion from LLM Spans","P0","M","MISSING",
      "Laminar","1.1",
      "Auto-persist debugger checkpoints on every LLM span finalize + populate prefix cache.",
      "`CheckpointStore.save()` exists (`checkpoints.py:154`) but **never called from ingest pipeline**.",
      "On each LLM span commit: extract messages, tool_calls, response → save checkpoint + upsert `debugger_llm_cache`.",
      "Hook in `src/eden/observability/ingestion/framework.py` post-span-finalize callback.",
      "Uses existing `telemetry_events` event_type=`debugger.checkpoint`.",
      "Internal only (no public route).",
      "`src/eden/observability/ingestion/checkpoint_hook.py`",
      "None",
      "`debugger_checkpoint_ingest_v1` default true",
      "Integration: ingest synthetic trace → list checkpoints returns N rows",
      "- [ ] 50 LLM spans → 50 checkpoints within 5s of trace complete",
      "F01"))

# I'll continue with a compact generator for remaining features...
# For brevity in script, use shorter tuples for rest

REST = [
("04","mcp-query-server","MCP Query Server for Coding Agents","P0","L","MISSING","Laminar,Raindrop","1.2,3.10","Expose traces/SQL/rerun/issues as MCP tools for Claude Code/Cursor.","MCP ingest only (`observability_mcp.py`). No query server.","New `src/eden/mcp_server/` with 10 tools wrapping internal APIs.","stdio + HTTP transport; API key auth.","None new","MCP tools: search_traces, get_transcript, rerun_debugger, list_issues","Package `eden-mcp-server`; register in docs","None","`mcp_query_server_v1`","MCP integration test with mock client","- [ ] Claude Code skill doc works end-to-end","F01,F29"),
("05","eden-cli-debug","Eden CLI Debug Subcommands","P0","M","MISSING","Laminar,Sentrial","1.2,2.6","`eden debug session|trace|rerun|sql` terminal workflow.","CLI instrument only; no debug commands.","Click group in `sdk/cli/debug.py`.","Subprocess wrapper sets EDEN_DEBUG=1.","None","CLI commands","`.eden/debug-session.json`","None","CLI tests","- [ ] `eden debug rerun` prints JSON diff","F02,F04"),
("06","per-trace-signal-investigator","Per-Trace Signal Investigation Agent","P0","XL","MISSING","Laminar,Bento","1.3,5.4","NL signal + JSON schema → agent investigates each trace → structured events.","Phase Q regex metrics only (`services/cat2_intel/signals.py`).","Compressor → ReAct agent with span tools → signal_events.","Worker on `trace.finalized` Redis stream.","signal_definitions, signal_events, signal_clusters tables (see competitor spec 075)","CRUD + backfill routes","`src/eden/signals/{compressor,investigator,worker,clusterer}.py`","Portal Signals v2 tab","`per_trace_signals_v1`","Fixture loop trace fires event","- [ ] Backfill 1k traces <30min","F07,F08"),
("07","signal-cluster-lifecycle","Signal Cluster Hierarchy & Lifecycle","P1","L","MISSING","Laminar","1.3","AI-named cluster tree; resolve when quiet; reopen on recurrence.","Jaccard on signal definitions only.","Embedding clusters on event summaries; status open/resolved/reopened.","Async batch worker post-event.","signal_clusters table","POST /signal-clusters/{id}/resolve","`src/eden/signals/clusterer.py`","Portal cluster tree UI","Part of F06","Cluster naming test","- [ ] Cluster resolves after 7d quiet","F06"),
("08","signal-historical-backfill","Signal Historical Backfill","P1","M","MISSING","Laminar,Bento","1.3","Run signal against historical trace window on create/change.","Not implemented.","Job: `POST /signal-definitions/{id}/backfill` enqueues traces.","Celery/tick worker with rate limit.","backfill_jobs table","POST backfill, GET status","`src/eden/signals/backfill.py`","Portal backfill progress bar","Default on signal create","Job completes metric","- [ ] 7d backfill finishes with progress","F06"),
("09","browser-session-recording-rrweb","Browser Session Recording (RRWeb)","P0","L","PARTIAL","Laminar","1.4,5.5","Record DOM synced to trace; replay in sandboxed iframe.","Backend model only (`src/eden/replay/events.py`); no RRWeb, no routes.","`@eden-ai/browser-recorder` npm pkg; batch upload events.","browser_sessions + browser_session_events tables.","POST/GET session routes","`sdk/browser-recorder/`, routes in `observability_browser.py`","BrowserReplayPanel.tsx","`browser_recording_v1`","RRWeb roundtrip test","- [ ] Replay synced to trace step","F13"),
("10","local-debug-dev-server","Local Debug Dev Server","P1","L","MISSING","Laminar,Raindrop","1.5,5.2","`eden debug serve` proxies agent, streams spans locally.","None.","FastAPI on :9477; optional cloud sync.","Local collector + WS.","None","CLI command","`src/eden/debugger/local_server.py`","Deep link to portal","None","Local e2e","- [ ] Trace visible <5s","F05,F32"),
("11","trace-content-deduplication","Trace Content Blob Deduplication","P2","XL","MISSING","Laminar","1.6","Content-addressed storage for repeated span payloads (~5-20x savings).","Full JSON in telemetry_events/ClickHouse.","span_content_blobs(hash, content); spans store refs.","Ingest-time hash + intern.","span_content_blobs","Transparent","`src/eden/observability/compression/blob_store.py`","None","`trace_dedupe_v1`","Dedupe ratio test","- [ ] Duplicate system prompt stored once","None"),
("12","typesense-span-search","Typesense Full-Text Span Search","P1","M","PARTIAL","Laminar","1.6","Sub-200ms search all span inputs/outputs.","Phase B stub in `observability.py:514`; Typesense config in `config.py:130`.","Index on ingest; `search_spans` API production-ready.","Typesense collection per org.","None","GET /observability/search","Wire `typesense_client.py`","Search bar in traces page","`typesense_search_v1`","10M span load test","- [ ] p95 <200ms","None"),
("13","browser-use-integration","Browser Use SDK Integration","P1","S","MISSING","Laminar","1.7,5.5","One-line instrument Browser Use agents.","No integration module.","`eden.integrations.browser_use.instrument()`.","Monkeypatch session → spans.","None","Docs only","`sdk/python/eden/integrations/browser_use.py`","None","None","Integration test","- [ ] Sample trace ingested","F09"),
("14","stagehand-integration","Stagehand SDK Integration","P1","S","MISSING","Laminar","1.7","TS middleware for Stagehand → Eden spans.","None.","npm `@eden-ai/stagehand` middleware.","OTel bridge.","None","Docs","`sdk/ts-ai/src/integrations/stagehand.ts`","None","None","Test","- [ ] Doc quickstart works","F09"),
("15","playwright-puppeteer-integration","Playwright/Puppeteer Integration","P1","S","MISSING","Laminar","1.7","CDP hooks → computer_use + browser events.","computer_use routes exist (`observability_computer_use.py`).","Playwright wrapper emits steps + screenshots.","Extend computer_use ingest.","None","Docs","`sdk/python/eden/integrations/playwright.py`","Screenshot panel","None","Test","- [ ] Screenshot on trace","F09"),
("16","openhands-opencode-integration","OpenHands & OpenCode Integration","P2","S","MISSING","Laminar","1.7","Span attributes for sandbox/file/shell tools.","OpenHands agent stub in code_change (`code_change/agent/openhands.py`) not ingest.","Decoder for OpenHands OTel attributes.","Ingestion decoder.","None","Docs","`observability/ingestion/decoders/openhands.py`","None","None","Fixture","- [ ] OpenHands trace decodes","None"),
("17","sessions-multiturn-timeline","Sessions Multi-Turn Timeline UI","P2","M","MISSING","Laminar,Sentrial","1.8,2.4","Portal `/sessions/{id}` shows 1/N trace cards.","session_id attribute exists on traces; no UI.","Materialized view + card scroller.","Postgres MV refresh.","session_trace_timeline MV","GET /sessions/{id}/timeline","Cron refresh + route","`sessions/[sessionId]/page.tsx`","None","UI test","- [ ] 5 traces render as cards","F23"),
("18","custom-render-templates","Custom Render Templates for Annotation","P2","M","MISSING","Laminar","1.9","Jinja2/HTML templates for labeling queue span display.","Labeling queue exists (`routes/labeling.py`); no templates.","render_templates table + sandboxed iframe render.","Template CRUD.","render_templates","CRUD routes","`src/eden/labeling/render_templates.py`","Labeling UI dropdown","None","XSS safety test","- [ ] Custom template renders safely","None"),
("19","langgraph-visualization","LangGraph Native Visualization","P3","S","MISSING","Laminar","1.10","Render LangGraph node/edge graph from span attrs.","Generic workflow graph in replay.","LangGraphView.tsx parses langgraph.* attributes.","Cytoscape layout.","None","None","Portal component","None","None","LangGraph fixture","- [ ] Graph matches execution","None"),
("20","zero-config-auto-issue-detection","Zero-Config Automatic Issue Detection","P0","L","MISSING","Sentrial,Raindrop,Bento","2.1,5.4","Issues appear on SDK install without configuration.","RCA on-demand only (`insights/rca/analyzer.py`); ETEC not surfaced as issues.","AutoIssueScanner on trace.finalized: 7 detectors.","Redis consumer.","Uses F28 stumbles","GET /issues","`src/eden/issues/auto_scanner.py`","Issues list page","`auto_issue_detection_v1` default true new orgs","7 detector fixtures","- [ ] First fail trace → issue <60s","F28,F29"),
("21","tool-call-label-learning","Tool Call Label Learning","P0","L","MISSING","Sentrial","2.2","Mark tool ✓/✗ → learn → flag similar misuse.","Tool intelligence exists; no label learning.","Embedding classifier per agent after ≥5 labels.","tool_call_labels, tool_call_calibrators tables.","POST .../tool-calls/{span_id}/label","`src/eden/issues/tool_call_labels.py`","Tool row actions in TranscriptView","None","10-label precision test","- [ ] 8/10 similar flagged","F20"),
("22","issue-fix-github-chat","Issue Fix-in-Code GitHub Chat","P0","L","PARTIAL","Sentrial,Raindrop","2.3,3.10","Issue → AI chat with repo context → PR.","GitHub shipped (`github.py`); Cat 23 stub; no fix chat.","SSE chat + read_file/search_repo/propose_diff tools.","repo_file_index table.","POST /issues/{id}/fix/chat, /fix/apply","`code_change/issue_fix_chat.py`","`/issues/[id]/fix/page.tsx`","`issue_fix_chat_v1`","Happy path e2e","- [ ] PR URL returned","F29,F30"),
("23","session-first-sdk","Session-First SDK (eden.session)","P1","M","MISSING","Sentrial","2.4","Primary SDK unit is session not trace.","Trace-first OTel model.","Context manager + batch flush.","agent_sessions table.","Sessions API","`sdk/python/eden/session.py`","`/sessions` portal","None","SDK test","- [ ] complete_session improves detection","F17,F20"),
("24","claude-agent-sdk-integration","Claude Agent SDK Integration","P1","S","MISSING","Sentrial,Laminar","2.5","Wrap query() for 3-line setup.","Generic auto-instrument docs.","`docs/integrations/claude-agent-sdk.md` + wrapper.","None","None","Docs + `integrations/claude_code.py`","None","None","Walkthrough","- [ ] 5min to first trace","F20"),
("25","mastra-integration","Mastra AI Integration","P2","S","MISSING","Sentrial,Laminar","2.5","One-line Mastra middleware.","None.","Python + TS middleware files.","None","None","Integration modules","None","None","Test","- [ ] Mastra trace ingested","F20"),
("26","cli-session-inspection","CLI Session Inspection","P2","S","MISSING","Sentrial","2.6","`eden sessions list|show|issues`.","None.","Click commands → Sessions API.","None","None","`sdk/cli/sessions.py`","None","None","CLI test","- [ ] JSON output","F23"),
("27","use-with-ai-docs","Use-with-AI Documentation","P3","XS","MISSING","Sentrial","2.7","llms.txt + Cursor/Claude instrumentation guide.","Onboarding PR flow only.","Docusaurus page + generated llms.txt.","None","None","Docs only","None","None","Link check","- [ ] llms.txt valid","None"),
("28","agent-stumbles","Agent Stumbles (Single Failure Unit)","P0","M","MISSING","Raindrop","3.1","Atomic failure record including self-diagnostics.","None.","Insert on detect; fingerprint hash.","agent_stumbles table.","Internal + GET stumbles","`src/eden/issues/stumble_writer.py`","None","None","Promotion test","- [ ] Stumble on tool error span","F20,F29"),
("29","agent-issues-sentry","Agent Issues (Sentry-Style Grouping)","P0","L","MISSING","Raindrop","3.1,5.1","Recurring stumbles → issue with user impact.","incident_clusters different model.","Upsert by fingerprint; user_count; severity.","agent_issues, agent_issue_stumbles.","CRUD /agent-issues","`src/eden/issues/issue_promoter.py`","Replace/enhance /incidents UI","None","Grouping test","- [ ] 5 stumbles → 1 issue","F28,F30"),
("30","triage-agent","Triage Agent","P0","M","PARTIAL","Raindrop","3.2,5.1","Investigate issue → root cause → MCP handoff.","InvestigationAgent single-shot (`investigation.py:62`); not issue-scoped.","ReAct with trace tools; store triage_result on issue.","None","POST /agent-issues/{id}/triage","`src/eden/issues/triage_agent.py`","Triage button on issue page","None","90s SLA test","- [ ] MCP handoff payload valid","F29,F04"),
("31","interactive-slack-bot","Interactive Slack Bot","P0","L","MISSING","Raindrop,Laminar","3.3,5.3","@eden commands; interactive issue buttons.","Slack stub only (`alert_stream.py` placeholder).","Bolt app; OAuth per org.","slack_installations table.","/integrations/slack/events","`integrations/slack/{bot,blocks,verify}.py`","Settings connect UI","None","Mock Slack test","- [ ] Resolve from button","F29,F47"),
("32","eden-workshop-oss","Eden Workshop OSS Local Debugger","P1","XL","MISSING","Raindrop","3.4,5.2","Free local trace viewer localhost:9477 + eval loop.","Cloud portal only.","Separate `workshop/` package; Vite UI.","None","Localhost API","npm `@eden-ai/workshop`","Standalone SPA","None","Install script test","- [ ] curl install works offline UI","F10,F05"),
("33","issue-linked-experiments","Issue-Linked Production Experiments","P1","M","PARTIAL","Raindrop","3.5","A/B verify fix reduced stumble rate.","Cat 12 experiments disconnected from issues.","Link experiment_id on issue; stumble rate by variant.","ALTER agent_issues ADD experiment_id","POST /agent-issues/{id}/experiments","Extend `intelligence_experiments.py`","Issue experiment wizard","None","Bayesian test","- [ ] Shows stumble delta","F29,F12 experiments"),
("34","trained-signal-classifiers","Per-Org Trained Signal Classifiers","P2","XL","MISSING","Raindrop","3.6","Train small model per product on traces.","Metric rules only.","Training pipeline + inference worker.","signal_classifiers table.","Training job API","`src/eden/signals/classifier_pipeline/`","Signal training UI","None","F1 on fixtures","- [ ] Train <1h async","F06,F35"),
("35","default-signal-library","Default Signal Library","P1","M","MISSING","Raindrop","3.6,5.4","Prebuilt: Forgetting, Laziness, Wins, Jailbreak, etc.","None shipped as defaults.","8 templates enabled on org create.","Seed data migration.","Enable endpoint","`src/eden/signals/defaults.py`","Settings toggles","Auto-enable new orgs","Library coverage test","- [ ] Frustration fires on fixture","F34,F36"),
("36","deep-search-classifier","Deep Search → Classifier Pipeline","P2","M","MISSING","Raindrop","3.8","NL search → refine → save as signal/classifier.","AI sidebar search only.","Persist query embedding → cluster → generate rule.","saved_searches table.","POST /deep-search/save-as-signal","Wire ChatSidebar to signals","Save as Signal button","None","E2E test","- [ ] Chinese user classifier story","F06,F34"),
("37","mcp-run-autofix","MCP run_autofix Orchestration","P1","M","PARTIAL","Raindrop","3.10,5.1","trace → patch → verify → PR in one MCP tool.","Cat 23 stub.","Orchestrates F30+F22+PatchGenerator.","None","MCP tool run_autofix","`mcp_server/tools/autofix.py`","None","`mcp_autofix_v1` false default","Integration test","- [ ] Returns pr_url","F04,F22,F30"),
("38","transcript-ui-v2","Transcript UI v2 (Notion-Style)","P2","M","PARTIAL","Raindrop","3.9","Best-in-class conversation blocks; parallel tool lanes.","TranscriptView shipped (`TranscriptView.tsx`) but basic.","Blocks, swimlanes, keyboard nav, screenshots.","React components.","None","Portal only","`transcript-v2/` components","None","Visual regression","- [ ] Parallel tools render","F09,F15"),
("39","runtime-nudge-injection","Runtime Nudge Injection","P0","XL","MISSING","BentoLabs","4.1,5.1","Shadow/promoted triggers inject into live agent via gateway.","KB procedural storage only; no runtime hook.","NudgeEngine in AIGateway.pre_invoke.","nudges, nudge_outcomes tables.","CRUD /nudges, export","`src/eden/nudges/engine.py`","Nudges admin UI","Shadow default","Promotion test","- [ ] Shadow logs only","F41,F29"),
("40","the-book-agent-memory","The Book (Agent Memory Artifact)","P1","L","MISSING","BentoLabs","4.2","Versioned markdown memory of failures/fixes at inference.","KB semantic layer not exposed as Book.","Nightly generator → gateway injection ≤2k tokens.","agent_books table.","GET /agents/{id}/book","`src/eden/book/generator.py`","Book reader UI","None","Version diff test","- [ ] Updates on issue resolve","F39,F29"),
("41","evidence-gated-promotion","Evidence-Gated Promotion Pipeline","P0","L","PARTIAL","BentoLabs","4.3,5.1","StatGate generalized for nudges, PRs, guardrails.","StatGate in trace quality spec; Cat 23 separate.","EvidenceGate service + promotion_candidates queue.","promotion_candidates table.","GET /promotions queue","`src/eden/promotion/evidence_gate.py`","Promotions inbox","None","Demotion test","- [ ] Auto-archive on regression","F39,Cat23"),
("42","behavioral-drift-pinpoint","Behavioral Drift Pinpoint Reports","P1","M","PARTIAL","BentoLabs","4.4","What shifted: tools, routing, prompt version.","Cat 13 PSI on judges only.","Weekly baseline vs 24h rolling; PSI per dimension.","drift_baselines table.","GET /agents/{id}/drift","`src/eden/drift/behavioral.py`","Drift dashboard","None","Model swap detection","- [ ] Top 3 dimensions shown","F33"),
("43","alert-benign-triage","Alert Real/Benign AI Triage","P2","M","MISSING","BentoLabs","4.5","NL alerts filtered by real vs benign judge.","Alerts fire without triage.","AlertTriageJudge SLM on alert_events.","alert_events.triage_verdict column.","None","`src/eden/alerts/triage_judge.py`","Alert detail badge","None","Benign spike test","- [ ] No page for benign","F20"),
("44","auto-production-eval-slices","Auto-Curated Production Eval Slices","P1","M","PARTIAL","BentoLabs","4.6","Nightly cluster traces → eval datasets.","Manual golden datasets.","AutoCurator job → production_eval_slices.","production_eval_slices table.","GET /production-datasets","`src/eden/datasets/auto_curator.py`","Datasets tab","None","Cluster quality","- [ ] CI webhook on prompt change","Cat3 evals"),
("45","runtime-skill-export","Runtime Skill Export to Customer Repo","P2","M","MISSING","BentoLabs","4.1","Export nudges/skills as YAML/MD in customer git.","None.","`eden nudges export` CLI.","None","CLI","`sdk/cli/nudges_export.py`","None","None","Export schema test","- [ ] Valid YAML","F39"),
("46","closed-loop-orchestrator","Closed-Loop Orchestrator","P0","L","MISSING","All","5.1","Issue state machine wires detect→fix→verify.","Hooks exist (`promotion_hooks.py`) but disconnected.","Orchestrator on issue status transitions.","None","Internal","`src/eden/closed_loop/orchestrator.py`","Kanban dashboard","None","Demo script","- [ ] Full loop staging <30min","F20-F41"),
("47","slack-block-kit-alerts","Slack Block Kit Outbound Alerts","P0","M","MISSING","Raindrop,Laminar","5.3","Replace webhook placeholders with rich alerts.","`_dispatch_slack` logs only.","httpx POST Block Kit; issue templates.","None","None","`integrations/slack/webhook.py`","None","None","Template snapshot test","- [ ] P0 shows user_count","F29,F31"),
("48","portal-api-contract-fix","Portal API Contract Fix (Wave 0)","P0","S","BROKEN","Internal","Wave 0","Fix debugger/signals portal↔backend mismatches blocking UX.","debuggerApi wrong paths; signalsApi wrong schema (`api.ts:4459-4505`).","Align types to Pydantic models; add sidebar links.","Portal-only patch; no backend routes.","None","Match OpenAPI: GET /debugger/checkpoints/{trace_id}; POST /signals body {description,enabled}","Fix `api.ts`, `debugger/page.tsx`, `signals/page.tsx`, `sidebar-config.ts`","Portal only","None","E2E portal tests","- [ ] Debugger loads checkpoints for trace","None"),
]

FEATURES.extend(REST)

TEMPLATE = (OUT / "_SPEC_TEMPLATE.md").read_text()

def render(f):
    if len(f) == 19:
        # Compact tuples omit dedicated API section (insert placeholder after ddl)
        f = (*f[:13], "See implementation plan — no new public HTTP routes unless noted.", *f[13:])
    id_, slug, title, pri, eff, status, comp, gaps, summary, current, target, arch, ddl, api, impl, client, flags, tests, accept, deps = f
    body = f"""# F{id_}: {title}

| Field | Value |
|---|---|
| **Feature ID** | F{id_} |
| **Slug** | `{slug}` |
| **Priority** | {pri} |
| **Effort** | {eff} |
| **Eden status** | **{status}** |
| **Competitive source** | {comp} |
| **Closes gap** | {gaps} |

---

## 1. Summary

{summary}

## 2. Eden current state

{current}

## 3. Target behavior

{target}

## 4. Architecture

{arch}

## 5. Data model

{ddl}

## 6. API specification

{api}

## 7. Implementation plan

{impl}

## 8. SDK / CLI / Portal

{client}

## 9. Feature flags & rollout

{flags}

## 10. Test plan

{tests}

## 11. Acceptance criteria

{accept}

## 12. Dependencies

{deps}

---

*Spec generated from codebase audit + competitor research, July 2026. See [FEATURE-GAP-MASTER.md](../FEATURE-GAP-MASTER.md).*
"""
    path = OUT / f"f{id_.zfill(2)}-{slug}.md"
    path.write_text(body)
    return path

if __name__ == "__main__":
    paths = [render(f) for f in FEATURES]
    print(f"Wrote {len(paths)} feature specs to {OUT}")
