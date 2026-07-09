# F30: Triage Agent

| Field | Value |
|---|---|
| **Feature ID** | F30 |
| **Slug** | `triage-agent` |
| **Priority** | P0 |
| **Effort** | M |
| **Eden status** | **PARTIAL** |
| **Competitive source** | Raindrop 2.0 (Triage) |
| **Closes gap** | 3.2, 5.1 |
| **Dependencies** | F29 (issues), F04 (MCP handoff), N08 (StatGate evidence) |

---

## 1. Summary

Given an **Issue** (F29), run a ReAct investigation agent over example traces to produce structured root cause, evidence spans, and suggested fix actions — stored as `triage_result` on the issue. Raindrop triage hands off to coding agents; Eden routes to F04 MCP payload.

---

## 2. Eden current state

| Component | Path | Gap |
|---|---|---|
| `InvestigationAgent` | `src/eden/autonomous/investigation.py:62` | Single-shot, not issue-scoped |
| RCA analyzer | `insights/rca/analyzer.py` | On-demand, no issue link |
| Cat 23 code change | stub | No triage→fix bridge |

---

## 3. Target behavior

```
POST /agent-issues/{id}/triage
    → Load issue + top 5 example stumbles/traces
    → If N08 StatGate P0: skip LLM, use deterministic triage_result
    → Else: TriageAgent ReAct loop (max 8 tool calls, 90s SLA)
    → Store triage_result JSON on issue
    → Return MCP handoff payload for F04
```

### triage_result schema

```json
{
  "root_cause": "Agent retries bash with python instead of python3 on macOS",
  "confidence": 0.87,
  "source": "llm|statgate",
  "evidence_span_ids": ["...", "..."],
  "suggested_actions": [
    {"type": "prompt_fix", "summary": "Add python3 note to system prompt"},
    {"type": "nudge", "summary": "F39 shadow nudge for bash failures"},
    {"type": "mcp_handoff", "tools": ["rerun_debugger", "run_autofix"]}
  ],
  "related_issue_ids": [],
  "completed_at": "2026-07-09T..."
}
```

---

## 4. Architecture

**`src/eden/issues/triage_agent.py`**

```python
class TriageAgent:
    tools = [
        GetTranscriptTool(),
        GetTraceQualityTool(),      # ETEC loops, StatGate
        SearchSimilarIssuesTool(),  # same fingerprint history
        GetToolCallDetailTool(),
        ComparePromptVersionsTool(),
    ]

    async def triage(self, issue_id: str) -> TriageResult:
        issue = await self._issues.get(issue_id)
        statgate = await self._statgate.score_issue(issue)
        if statgate.auto_escalate:
            return TriageResult.from_statgate(statgate)
        context = await self._build_context(issue, max_traces=5)
        return await self._react_loop(context, budget=IssueTriageBudget())
```

---

## 5. Agent tools (internal)

| Tool | Purpose | Cost |
|---|---|---|
| `get_transcript` | Read example traces | $0 |
| `get_trace_quality` | Loops, contradictions | $0 |
| `search_issues` | Historical pattern | $0 |
| `summarize_spans` | Compress long tool results | SLM ~$0.001 |

**No live gateway calls** during triage — read-only investigation.

---

## 6. API specification

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/orgs/{org_id}/agent-issues/{id}/triage` | `{force?: bool}` | `TriageResult` |
| `GET` | `/orgs/{org_id}/agent-issues/{id}/triage` | — | cached result or 404 |

- Auto-triage on P0/P1 issue create (async queue) unless `auto_triage=false`
- Rate limit: 10 triages/hour/org manual; unlimited auto for P0

**MCP (F04):** `triage_issue(issue_id)` — same result

---

## 7. Portal UX

Issue detail → **Triage** tab:
- Root cause headline
- Evidence span links (jump to transcript step)
- Suggested actions as buttons: "Rerun debugger", "Open fix chat", "Create nudge draft"
- Re-run triage button

---

## 8. Performance & cost optimization

### Latency budgets

| Path | p95 | SLA |
|---|---|---|
| StatGate-only (N08) | <200ms | immediate |
| Full LLM triage | <60s | 90s hard timeout |
| Auto-triage queue wait | <30s | — |

### Cost model

| Scenario | Est. cost |
|---|---|
| StatGate P0 (no LLM) | $0 |
| Standard triage (5 traces, 6 tool calls) | $0.03–0.08 (Sonnet) |
| With SLM summarization | +$0.005 |

**Budget:** `max_triage_cost_usd_per_day` org setting (default $25).

### Cost controls

1. **N08 first** — skip LLM when StatGate sufficient
2. **Trace compressor** — max 4k tokens/trace in context
3. **Tool call cap** — 8 max; early exit on high confidence
4. **Cache triage_result** — re-triage only if `force=true` or new stumbles >5

### Caching

- Redis: `triage:{issue_id}` → result, TTL until issue updated
- Embedding cache for similar issue search

### Degradation

- Budget exceeded → queue for next day + notify
- LLM timeout → partial result with `confidence=0.5`, `source=timeout`
- Model outage → StatGate-only fallback

### Monitoring

```
eden_triage_duration_seconds{source}
eden_triage_cost_usd_total
eden_triage_llm_skipped_total{reason}
eden_triage_timeout_total
```

---

## 9. Feature flags

| Flag | Default |
|---|---|
| `issue_triage_v1` | false |
| `issue_auto_triage_v1` | false (enable with F29) |

---

## 10. Test plan

- P0 StatGate issue → triage without LLM mock call
- Standard issue fixture → root_cause contains expected keyword
- 90s timeout returns partial
- MCP handoff payload validates against F04 schema

---

## 11. Acceptance criteria

- [ ] Triage completes p95 <60s for standard issue
- [ ] StatGate P0 skips LLM (verified in test)
- [ ] triage_result persisted on issue
- [ ] Portal Triage tab renders evidence links
- [ ] Daily cost stays under org budget with rate limits

---

*Hands off to F04 MCP and F22 fix chat. See N08 for deterministic fast path.*
