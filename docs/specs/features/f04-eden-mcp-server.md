# F04: Eden MCP Server (Coding-Agent-First Interface)

| Field | Value |
|---|---|
| **Feature ID** | F04 |
| **Slug** | `eden-mcp-server` |
| **Priority** | P0 |
| **Effort** | L |
| **Eden status** | **MISSING** |
| **Competitive source** | Laminar MCP, Raindrop Workshop/MCP autofix |
| **Replaces** | F05 CLI debug, F10 local dev server, F26 session inspection, F37 run_autofix (absorbed into MCP tools) |
| **Dependencies** | F48 (portal fix), F29 (issues), F01 (debugger rerun), F30 (triage) |

---

## 1. Problem

**Coding agents are the primary debugger for agent engineers in 2026.** Cursor, Claude Code, and Windsurf do not open web portals — they connect to **MCP servers** and drive workflows via tools, resources, and prompts.

Eden today has:
- **MCP ingest only** — observe customer agents' MCP tool calls (`src/eden/sdk/mcp.py`, `observability_mcp.py`)
- **No Eden MCP server** — nothing for a coding agent to query traces, investigate issues, rerun debugger, or open fix PRs

Competitors ship this surface:
- **Laminar:** MCP tools for trace search, SQL, debugger rerun
- **Raindrop:** Workshop + MCP `run_autofix` orchestration

**Strategic decision:** Eden's coding-agent-first interface is **one MCP server**, not a parallel CLI (`eden debug`), local dev server, or OSS Workshop. Those deleted specs are **subsumed** by MCP tools + stdio transport (works in every IDE).

---

## 2. Market context

| Signal | Implication for F04 |
|---|---|
| MCP adopted as de-facto agent↔tool standard (Anthropic, OpenAI, Cursor) | Ship stdio + Streamable HTTP transports |
| OTel GenAI + MCP semantic conventions (SEP-414) | Align tool I/O attributes with existing `mcp.*` ingest |
| Eval + observability convergence (Braintrust, Langfuse, Raindrop 2.0) | MCP tools must bridge issues ↔ evals ↔ debugger |
| Enterprise buyers want audit + RBAC on agent actions | Every MCP tool call logged; org-scoped API keys |

---

## 3. Eden current state (exact)

| Component | Path | Status |
|---|---|---|
| MCP span ingest | `src/eden/api/routes/observability_mcp.py` | Shipped — read customer MCP telemetry |
| MCP SDK wrapper | `src/eden/sdk/mcp.py` | Shipped — `wrap_mcp_call()` |
| MCP trace service | `src/eden/services/observability/mcp_traces.py` | Shipped |
| Eden MCP server | — | **Missing** |
| Debugger API | `src/eden/api/routes/debugger.py` | Shipped — wrap in tools |
| Issues API | — | **Missing** (F29) — stub tools until shipped |
| EQL/SQL | Cat 19 `sql_query.py` | Shipped — wrap in tool |
| Triage agent | `investigation.py` | Partial — wrap in tool |
| Cat 23 autofix | `code_change/` stub | Partial — `run_autofix` tool gated |

**Gap:** Eden observes MCP in production but does not **participate** in the coding-agent loop.

---

## 4. Target behavior

### 4.1 User story

> As an engineer using Cursor, I add Eden to `.cursor/mcp.json`. When my agent fails in production, I ask: "Why did trace abc-123 fail?" Eden MCP returns structured transcript + quality report. I say: "Rerun from step 12 with this system prompt fix." Eden runs cached-prefix live rerun (F01) and returns diff. I say: "Open a fix PR." Eden triages the linked issue, proposes patch, runs hermetic verify, opens GitHub PR — all without leaving the IDE.

### 4.2 Design principles

1. **MCP-native first** — no CLI parity requirement; MCP tools are canonical
2. **Thin wrapper** — tools call existing Eden HTTP/internal APIs; no duplicate business logic
3. **Progressive disclosure** — `search_traces` → `get_trace` → `get_transcript` → `rerun_debugger` depth ladder
4. **Safe by default** — `run_autofix` and `rerun_debugger(live)` require explicit opt-in + org policy
5. **Observable** — log every MCP tool invocation as Eden span (`eden.mcp_server.tool_call`)

---

## 5. Architecture

```
┌─────────────────┐     stdio / Streamable HTTP      ┌──────────────────────┐
│ Cursor /        │ ◄──────────────────────────────► │  eden-mcp-server     │
│ Claude Code     │         MCP JSON-RPC             │  (Python package)    │
└─────────────────┘                                  └──────────┬───────────┘
                                                                │ HTTPS + API key
                                                                ▼
                                                     ┌──────────────────────┐
                                                     │  Eden API (FastAPI)  │
                                                     │  debugger, issues,   │
                                                     │  eql, triage, github │
                                                     └──────────────────────┘
```

### 5.1 Package layout

```
packages/eden-mcp-server/
  pyproject.toml
  src/eden_mcp/
    __init__.py
    server.py           # FastMCP or mcp SDK Server
    auth.py             # API key → org_id resolution
    client.py           # Typed Eden API HTTP client
    tools/
      traces.py         # search, get, transcript
      debugger.py       # list_checkpoints, rerun
      issues.py         # list, get, triage
      query.py          # eql_query, sql_query
      fix.py            # run_autofix (orchestrator)
      evals.py          # list_datasets, run_eval
    resources/
      issue_summary.py  # mcp://eden/issues/{id}
      trace_digest.py   # mcp://eden/traces/{id}/digest
    prompts/
      investigate.md    # System prompt for triage handoff
      fix_issue.md      # System prompt for fix workflow
    logging.py          # Self-telemetry to Eden ingest
```

### 5.2 Transports

| Transport | Use case | Config |
|---|---|---|
| **stdio** | Cursor, Claude Code local | `"command": "eden-mcp", "args": ["--transport", "stdio"]` |
| **Streamable HTTP** | Remote/cloud IDE, team shared | `POST /mcp` on Eden API or sidecar |

### 5.3 Authentication

```json
// .cursor/mcp.json
{
  "mcpServers": {
    "eden": {
      "command": "uvx",
      "args": ["eden-mcp-server"],
      "env": {
        "EDEN_API_KEY": "eden_sk_...",
        "EDEN_BASE_URL": "https://api.eden.ai"
      }
    }
  }
}
```

- API keys scoped: `mcp:read`, `mcp:debug`, `mcp:fix` (fix requires admin)
- Key rotation via portal Settings → MCP Keys
- All tool calls include `org_id` from key — no cross-org leakage

---

## 6. MCP tool catalog

### 6.1 Discovery & search

| Tool | Input | Output | Wraps |
|---|---|---|---|
| `search_traces` | `query`, `agent_id?`, `since?`, `limit?` | `{traces: [{id, title, status, cost, steps}]}` | EQL or Typesense F12 |
| `search_issues` | `status?`, `severity?`, `agent_id?` | `{issues: [{id, title, user_count, last_seen}]}` | F29 `/agent-issues` |
| `eql_query` | `eql: str`, `limit?: int` | Tabular JSON rows | Cat 19 EQL |
| `sql_query` | `sql: str` (read-only) | Rows + column types | `sql_query.py` sandbox |

### 6.2 Trace inspection

| Tool | Input | Output | Wraps |
|---|---|---|---|
| `get_trace` | `trace_id` | Metadata, cost, latency, agent_id, session_id | Trace API |
| `get_transcript` | `trace_id`, `from_step?`, `to_step?` | Step-by-step messages, tools, results | Transcript service |
| `get_trace_quality` | `trace_id` | Loops, contradictions, StatGate verdicts | `trace_quality.py` |
| `get_mcp_tool_calls` | `trace_id` | Customer MCP calls in trace (N02 synergy) | `GET /v1/traces/{id}/mcp` |

### 6.3 Debugger (absorbs F05, F10, F26)

| Tool | Input | Output | Wraps |
|---|---|---|---|
| `list_checkpoints` | `trace_id` | Ordered checkpoints with step numbers | `GET /debugger/checkpoints/{trace_id}` |
| `rerun_debugger` | `trace_id`, `from_step`, `rerun_mode`, `prompt_override?`, `session_id?` | `new_trace_id`, diff, cache stats | F01 `POST /debugger/rerun` |
| `create_debug_session` | `title?` | `session_id` | F01 debug sessions (absorbs F02 timeline) |
| `list_debug_sessions` | `limit?` | Recent sessions with run counts | Debug session API |

**Note:** Local dev server (deleted F10) is unnecessary — agent runs locally, Eden MCP queries cloud (or self-hosted) API. Optional `EDEN_LOCAL=1` points at docker-compose for air-gapped.

### 6.4 Issues & fix loop (absorbs F37)

| Tool | Input | Output | Wraps |
|---|---|---|---|
| `get_issue` | `issue_id` | Full issue + example stumbles + triage | F29 |
| `triage_issue` | `issue_id` | `{root_cause, evidence_spans, suggested_actions}` | F30 triage agent |
| `run_autofix` | `issue_id`, `repo?`, `branch?`, `dry_run?: bool` | `{pr_url?, patch_summary, verify_trace_id}` | F30→F22→Cat23 orchestrator |
| `label_tool_call` | `span_id`, `label: good\|bad`, `reason?` | Ack + model update status | F21 |

### 6.5 Evals & verification

| Tool | Input | Output | Wraps |
|---|---|---|---|
| `list_eval_datasets` | `agent_id?` | Dataset list with case counts | Cat 3 evals |
| `run_eval` | `dataset_id`, `prompt_version?` | `{run_id, pass_rate, failures[]}` | Eval runner |
| `add_trace_to_dataset` | `trace_id`, `dataset_id`, `expected?` | Case ID | N01 synergy |

---

## 7. MCP resources & prompts

### Resources (read-only context for agents)

| URI | Content |
|---|---|
| `eden://issues/{id}/summary` | Markdown: title, impact, top 3 example traces, triage |
| `eden://traces/{id}/digest` | Compressed transcript (≤8k tokens) for LLM context |
| `eden://agents/{id}/book` | F40 Book excerpt when available |
| `eden://org/signal-library` | Active signal definitions (F35) |

### Prompts (workflow templates)

| Prompt | Purpose |
|---|---|
| `investigate_trace` | Guides agent through search → transcript → quality → hypothesis |
| `fix_production_issue` | Issue → triage → rerun → patch → eval verify checklist |
| `write_regression_eval` | N01 — turn failing trace into dataset case |

---

## 8. `run_autofix` orchestration (absorbed F37)

```python
async def run_autofix(issue_id: str, *, dry_run: bool = False) -> AutofixResult:
    issue = await eden.get_issue(issue_id)
    triage = issue.triage_result or await eden.triage_issue(issue_id)

    # 1. Gather context
    traces = await eden.get_transcripts(issue.example_stumble_ids[:3])
    repo = await eden.resolve_github_repo(issue.agent_id)

    # 2. Generate patch (Cat 23 PatchGenerator)
    patch = await patch_generator.propose(traces, triage, repo)

    if dry_run:
        return AutofixResult(patch_summary=patch.summary)

    # 3. Hermetic verify on example traces
    verify = await eden.run_hermetic_verify(patch, traces)

    # 4. Open PR if verify passes + F41 EvidenceGate
    if verify.passed and await evidence_gate.approve(patch, issue):
        pr_url = await github.create_pr(repo, patch)
        await eden.link_issue_pr(issue_id, pr_url)
        return AutofixResult(pr_url=pr_url, verify_trace_id=verify.trace_id)

    return AutofixResult(failed_reason=verify.reason)
```

**Gates:** `mcp_autofix_v1` flag (default false), org `mcp_fix_enabled`, GitHub App installed.

---

## 9. Self-telemetry

Every Eden MCP tool call emits a span to the **customer's own Eden project** (optional, default on):

```python
attributes = {
    "eden.mcp_server.tool": "rerun_debugger",
    "eden.mcp_server.org_id": org_id,
    "eden.mcp_server.duration_ms": 142,
    "mcp.server_name": "eden",  # SEP-414 alignment
    "mcp.tool_name": "rerun_debugger",
}
```

Enables N02: observe how **coding agents use Eden** to fix production agents (meta-observability).

---

## 10. API additions (minimal)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/v1/mcp/keys` | Create scoped MCP API key |
| `GET` | `/v1/mcp/keys` | List keys |
| `DELETE` | `/v1/mcp/keys/{id}` | Revoke |
| `POST` | `/v1/mcp` | Streamable HTTP MCP endpoint (optional Phase 2) |

Most tools reuse existing routes — **no duplicate REST surface**.

---

## 11. Implementation plan (ordered)

1. **`packages/eden-mcp-server/`** — scaffold with `mcp` Python SDK + httpx client
2. **`auth.py`** — API key header `Authorization: Bearer eden_sk_*` → org context
3. **Phase 1 tools** — `search_traces`, `get_transcript`, `get_trace`, `list_checkpoints` (read-only)
4. **Phase 2 tools** — `rerun_debugger`, `create_debug_session` (requires F01 + F48)
5. **Phase 3 tools** — `search_issues`, `get_issue`, `triage_issue` (requires F29, F30)
6. **Phase 4 tools** — `run_autofix`, `label_tool_call` (requires F22, Cat 23)
7. **Resources + prompts** — issue summary, trace digest
8. **Docs** — `docs/integrations/eden-mcp-server.md`, Cursor/Claude Code quickstarts, `llms.txt` entry
9. **PyPI publish** — `eden-mcp-server` package
10. **Portal** — Settings → MCP connection wizard with copy-paste config

---

## 12. Feature flags & rollout

| Flag | Default | Scope |
|---|---|---|
| `eden_mcp_server_v1` | false | Enable MCP key issuance |
| `mcp_debug_tools_v1` | false | `rerun_debugger` live modes |
| `mcp_autofix_v1` | false | `run_autofix` PR creation |

Rollout: design partners → beta (read-only tools) → GA (full loop).

---

## 13. Test plan

| Test | Path |
|---|---|
| stdio handshake | `tests/mcp/test_stdio_connect.py` |
| search_traces mock API | `tests/mcp/test_tools_traces.py` |
| rerun_debugger integration | `tests/mcp/test_tools_debugger.py` (requires F01) |
| run_autofix dry_run | `tests/mcp/test_tools_autofix.py` |
| Auth scope enforcement | `tests/mcp/test_auth_scopes.py` |
| Cursor config validation | `tests/mcp/test_cursor_config.py` |

**E2E acceptance:** Claude Code skill file `skills/eden-debug/SKILL.md` completes investigate → rerun → report in <5 min.

---

## 14. Acceptance criteria

- [ ] `eden-mcp-server` installable via `uvx eden-mcp-server`; stdio connects in Cursor
- [ ] `search_traces` + `get_transcript` work against staging with real API key
- [ ] `rerun_debugger(cached_live)` returns new trace + cache stats when F01 shipped
- [ ] `triage_issue` returns structured root cause when F30 shipped
- [ ] `run_autofix(dry_run=true)` returns patch summary without side effects
- [ ] All tool calls logged as Eden spans with SEP-414 attributes
- [ ] Docs: 5-minute quickstart for Cursor and Claude Code
- [ ] Deleted F05/F10/F26/F37 explicitly documented as absorbed (see DELETED-FEATURES.md)

---

## 15. What we are NOT building

| Deleted spec | Reason | Covered by |
|---|---|---|
| F05 Eden CLI debug | MCP is universal across IDEs | F04 tools |
| F10 Local debug dev server | Cloud/self-hosted API sufficient | F04 + optional `EDEN_LOCAL` |
| F26 CLI session inspection | `list_debug_sessions` tool | F04 |
| F37 MCP run_autofix standalone | Merged into F04 tool catalog | F04 §8 |
| F32 Eden Workshop OSS | Portal + MCP cover dev loop; OSS maintenance cost | F04 + portal |

---

*See also: [MARKET-HYPOTHESES.md](../MARKET-HYPOTHESES.md) §2, [N02 MCP toolchain observability](n02-mcp-toolchain-observability.md), F01 debugger, F29 issues, F30 triage.*
