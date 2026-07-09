#!/usr/bin/env python3
"""Generate granular feature-by-feature implementation specs (F-features only).

Revised July 2026: pruned from 48 → 24 F-features.
N-features (n01–n08) are hand-authored — not generated.
Hand-edited specs are never overwritten — see SKIP_FILES.
"""

from pathlib import Path

OUT = Path(__file__).parent

# Hand-edited specs — generator must not overwrite
SKIP_FILES = {
    "f01-cached-prefix-live-debugger.md",
    "f04-eden-mcp-server.md",
    "f06-per-trace-signal-investigator.md",
    "f09-browser-session-recording-rrweb.md",
    "f20-zero-config-auto-issue-detection.md",
    "f29-agent-issues-sentry.md",
    "f39-runtime-nudge-injection.md",
    "f48-portal-api-contract-fix.md",
}

FEATURES: list[tuple] = []

def spec(f: tuple) -> None:
    FEATURES.append(f)

# ── SURVIVING F-FEATURES (24) ────────────────────────────────────────
# Deleted: F02,F05,F07,F08,F10-F11,F13-F19,F24-F27,F31-F32,F36-F38,F43,F45,F37
# See DELETED-FEATURES.md

spec(("03","checkpoint-ingestion-from-spans","Checkpoint Ingestion from LLM Spans","P0","M","MISSING",
      "Laminar","1.1",
      "Auto-persist debugger checkpoints on every LLM span finalize + populate prefix cache.",
      "`CheckpointStore.save()` exists (`checkpoints.py:154`) but never called from ingest pipeline.",
      "On each LLM span commit: extract messages, tool_calls, response → save checkpoint + upsert debugger_llm_cache.",
      "Hook in observability ingestion post-span-finalize callback.",
      "Uses existing telemetry_events event_type=debugger.checkpoint.",
      "Internal only.",
      "`src/eden/observability/ingestion/checkpoint_hook.py`",
      "None",
      "`debugger_checkpoint_ingest_v1` default true",
      "Integration: ingest synthetic trace → list checkpoints returns N rows",
      "- [ ] 50 LLM spans → 50 checkpoints within 5s of trace complete",
      "F01"))

REST = [
("12","typesense-span-search","Typesense Full-Text Span Search","P1","M","PARTIAL","Laminar","1.6","Sub-200ms search all span inputs/outputs.","Phase B stub; Typesense config in config.py.","Index on ingest; search_spans API production-ready.","Typesense collection per org.","None","GET /observability/search","Wire typesense_client.py","Search bar in traces page","`typesense_search_v1`","10M span load test","- [ ] p95 <200ms","None"),
("20","zero-config-auto-issue-detection","Zero-Config Automatic Issue Detection","P0","L","MISSING","Sentrial,Raindrop,Bento","2.1,5.4","Issues appear on SDK install without configuration.","RCA on-demand only; ETEC not surfaced as issues.","AutoIssueScanner on trace.finalized: 7 detectors.","Redis consumer.","Uses F28 stumbles","GET /issues","`src/eden/issues/auto_scanner.py`","Issues list page","`auto_issue_detection_v1` default true new orgs","7 detector fixtures","- [ ] First fail trace → issue <60s","F28,F29"),
("21","tool-call-label-learning","Tool Call Label Learning","P2","L","MISSING","Sentrial","2.2","Mark tool ✓/✗ → learn → flag similar misuse.","Tool intelligence exists; no label learning.","Embedding classifier per agent after ≥5 labels.","tool_call_labels, tool_call_calibrators tables.","POST .../tool-calls/{span_id}/label","`src/eden/issues/tool_call_labels.py`","Tool row actions in TranscriptView","None","10-label precision test","- [ ] 8/10 similar flagged","F20"),
("22","issue-fix-github-chat","Issue Fix-in-Code GitHub Chat","P0","L","PARTIAL","Sentrial,Raindrop","2.3,3.10","Issue → AI chat with repo context → PR.","GitHub shipped; Cat 23 stub; no fix chat.","SSE chat + read_file/search_repo/propose_diff tools.","repo_file_index table.","POST /issues/{id}/fix/chat, /fix/apply","`code_change/issue_fix_chat.py`","`/issues/[id]/fix/page.tsx`","`issue_fix_chat_v1`","Happy path e2e","- [ ] PR URL returned","F29,F30"),
("23","session-first-sdk","Session-First SDK (eden.session)","P1","M","MISSING","Sentrial","2.4","Primary SDK unit is session not trace.","Trace-first OTel model.","Context manager + batch flush.","agent_sessions table.","Sessions API","`sdk/python/eden/session.py`","`/sessions` portal","None","SDK test","- [ ] complete_session improves detection","F20"),
("28","agent-stumbles","Agent Stumbles (Single Failure Unit)","P0","M","MISSING","Raindrop","3.1","Atomic failure record including self-diagnostics.","None.","Insert on detect; fingerprint hash.","agent_stumbles table.","Internal + GET stumbles","`src/eden/issues/stumble_writer.py`","None","None","Promotion test","- [ ] Stumble on tool error span","F20,F29"),
("30","triage-agent","Triage Agent","P0","M","PARTIAL","Raindrop","3.2,5.1","Investigate issue → root cause → MCP handoff.","InvestigationAgent single-shot; not issue-scoped.","ReAct with trace tools; store triage_result on issue.","None","POST /agent-issues/{id}/triage","`src/eden/issues/triage_agent.py`","Triage button on issue page","None","90s SLA test","- [ ] MCP handoff payload valid","F29,F04"),
("33","issue-linked-experiments","Issue-Linked Production Experiments","P1","M","PARTIAL","Raindrop","3.5","A/B verify fix reduced stumble rate.","Cat 12 experiments disconnected from issues.","Link experiment_id on issue; stumble rate by variant.","ALTER agent_issues ADD experiment_id","POST /agent-issues/{id}/experiments","Extend intelligence_experiments.py","Issue experiment wizard","None","Bayesian test","- [ ] Shows stumble delta","F29"),
("34","trained-signal-classifiers","Per-Org Trained Signal Classifiers","P2","XL","MISSING","Raindrop","3.6","Train small model per product on traces.","Metric rules only.","Training pipeline + inference worker.","signal_classifiers table.","Training job API","`src/eden/signals/classifier_pipeline/`","Signal training UI","None","F1 on fixtures","- [ ] Train <1h async","F06,F35"),
("35","default-signal-library","Default Signal Library","P1","M","MISSING","Raindrop","3.6,5.4","Prebuilt: Forgetting, Laziness, Wins, Jailbreak, etc.","None shipped as defaults.","8 templates enabled on org create.","Seed data migration.","Enable endpoint","`src/eden/signals/defaults.py`","Settings toggles","Auto-enable new orgs","Library coverage test","- [ ] Frustration fires on fixture","F34,F06"),
("40","the-book-agent-memory","The Book (Agent Memory Artifact)","P1","L","MISSING","BentoLabs","4.2","Versioned markdown memory of failures/fixes at inference.","KB semantic layer not exposed as Book.","Nightly generator → gateway injection ≤2k tokens.","agent_books table.","GET /agents/{id}/book","`src/eden/book/generator.py`","Book reader UI","None","Version diff test","- [ ] Updates on issue resolve","F39,F29"),
("41","evidence-gated-promotion","Evidence-Gated Promotion Pipeline","P0","L","PARTIAL","BentoLabs","4.3,5.1","StatGate generalized for nudges, PRs, guardrails.","StatGate in trace quality spec; Cat 23 separate.","EvidenceGate service + promotion_candidates queue.","promotion_candidates table.","GET /promotions queue","`src/eden/promotion/evidence_gate.py`","Promotions inbox","None","Demotion test","- [ ] Auto-archive on regression","F39,Cat23"),
("42","behavioral-drift-pinpoint","Behavioral Drift Pinpoint Reports","P1","M","PARTIAL","BentoLabs","4.4","What shifted: tools, routing, prompt version.","Cat 13 PSI on judges only.","Weekly baseline vs 24h rolling; PSI per dimension.","drift_baselines table.","GET /agents/{id}/drift","`src/eden/drift/behavioral.py`","Drift dashboard","None","Model swap detection","- [ ] Top 3 dimensions shown","F33"),
("44","auto-production-eval-slices","Auto-Curated Production Eval Slices","P1","M","PARTIAL","BentoLabs","4.6","Nightly cluster traces → eval datasets.","Manual golden datasets.","AutoCurator job → production_eval_slices.","production_eval_slices table.","GET /production-datasets","`src/eden/datasets/auto_curator.py`","Datasets tab","None","Cluster quality","- [ ] CI webhook on prompt change","Cat3 evals,N01"),
("46","closed-loop-orchestrator","Closed-Loop Orchestrator","P0","L","MISSING","All","5.1","Issue state machine wires detect→fix→verify.","Hooks exist but disconnected.","Orchestrator on issue status transitions.","None","Internal","`src/eden/closed_loop/orchestrator.py`","Kanban dashboard","None","Demo script","- [ ] Full loop staging <30min","F20-F41,N01"),
("47","slack-block-kit-alerts","Slack Block Kit Outbound Alerts","P0","M","MISSING","Raindrop,Laminar","5.3","Replace webhook placeholders with rich alerts.","`_dispatch_slack` logs only.","httpx POST Block Kit; issue templates.","None","None","`integrations/slack/webhook.py`","None","None","Template snapshot test","- [ ] P0 shows user_count","F29"),
]

FEATURES.extend(REST)


def render(f: tuple) -> Path | None:
    if len(f) == 19:
        f = (*f[:13], "See implementation plan — no new public HTTP routes unless noted.", *f[13:])
    id_, slug, title, pri, eff, status, comp, gaps, summary, current, target, arch, ddl, api, impl, client, flags, tests, accept, deps = f
    filename = f"f{id_.zfill(2)}-{slug}.md"
    path = OUT / filename
    if filename in SKIP_FILES:
        return None
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
    path.write_text(body)
    return path


if __name__ == "__main__":
    paths = [p for f in FEATURES if (p := render(f)) is not None]
    print(f"Wrote {len(paths)} skeleton specs to {OUT} (skipped {len(SKIP_FILES)} hand-edited)")
    print("N-features n01–n08 are NOT generated — edit manually.")
