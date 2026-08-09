---
id: mcp-cursor
title: MCP in Cursor and Claude Code
sidebar_label: MCP in Cursor (retired)
sidebar_position: 9
draft: true
unlisted: true
---

# How-to — MCP in Cursor and Claude Code

> **Soft-retired for free beta (2026-07-31).** Eden MCP is not a
> first-class product surface. HTTP transport and org MCP key routes
> are off/unmounted. This page is kept for internal/dev reference only
> and is hidden from the docs sidebar. Prefer the portal debugger,
> improve cockpit, and REST APIs.

Eden's MCP server lets coding agents search production traces, triage
issues, rerun the debugger, and open fix PRs — without leaving your IDE.

## Prerequisites

1. An Eden org with at least one ingested trace.
2. An org API key (`Settings → API Keys` in the portal).
3. The Eden platform package installed (see **Installation** below).

## Installation

Three supported paths — all use the same `eden-mcp` binary:

**a) Monorepo checkout (preferred)**

```bash
pip install -e .
eden-mcp --help   # verify
```

**b) Module invocation (no install needed)**

```bash
python -m eden.mcp_server
```

**c) Cloud API**

Point Cursor MCP at the hosted Eden API with your org API key. No
local Eden platform install is required for cloud use.

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `EDEN_API_KEY` | yes | Org API key (`sk_eden_…`) |
| `EDEN_ORG_ID` | yes | Org id (`org_…`) |

## Cursor

Create `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "eden": {
      "command": "eden-mcp",
      "args": [],
      "env": {
        "EDEN_API_KEY": "sk_eden_…",
        "EDEN_ORG_ID": "org_…",
        "EDEN_BASE_URL": "https://api.edenobservability.com"
      }
    }
  }
}
```

If `eden-mcp` is not on your `PATH` (e.g. inside a virtualenv), use
the module form instead:

```json
{
  "mcpServers": {
    "eden": {
      "command": "python",
      "args": ["-m", "eden.mcp_server"],
      "env": {
        "EDEN_API_KEY": "sk_eden_…",
        "EDEN_ORG_ID": "org_…",
        "EDEN_BASE_URL": "https://api.edenobservability.com"
      }
    }
  }
}
```

Restart Cursor (or reload MCP servers from settings). Eden appears under
**MCP Tools** in the agent panel.

## Claude Code

Create `.claude/mcp.json`. Claude Code expects an explicit `"type": "stdio"`:

```json
{
  "mcpServers": {
    "eden": {
      "type": "stdio",
      "command": "eden-mcp",
      "args": [],
      "env": {
        "EDEN_API_KEY": "sk_eden_…",
        "EDEN_ORG_ID": "org_…",
        "EDEN_BASE_URL": "https://api.edenobservability.com"
      }
    }
  }
}
```

## Available tools

| Tool | Scope | What it does |
|------|-------|--------------|
| `search_traces` | read | Search traces by query / agent |
| `get_trace` | read | Trace metadata and span tree |
| `get_transcript` | read | Step-by-step messages and tool calls |
| `list_checkpoints` | read | Debugger checkpoints for a trace |
| `rerun_debugger` | debug | Rerun from a checkpoint step |
| `search_issues` | read | List agent issues |
| `get_issue` | read | Full issue + example stumbles |
| `get_trace_stumbles` | read | Stumble detections for a trace |
| `triage_issue` | debug | Root-cause triage for an issue |
| `run_autofix` | fix | Propose patch + optional PR |
| `get_improvement_queue` | read | N17 closed-loop action queue |
| `list_improvement_plans` / `get_improvement_plan` / `approve_improvement_plan` | read/fix | N23 plans |
| `export_fixture` / `create_regression_case` | read/fix | Failure fixtures + regression cases |
| `preview_change_impact` | read | N04 change impact preview |
| `eden_health` | read | F84 self-obs health |
| `tail_trace` | read | N11 live session tail |
| `label_tool_call` | debug | F21 tool-call labels |
| `query_eql` | read | Compile / preview EQL filters |
| `query_sql` | read | Org-scoped read-only SQL |
| `list_datasets` / `list_experiments` | read | Eval surface mirrors |
| `get_judge_scores` | read | Layer A / judge scores for a trace |
| `get_cost_breakdown` | read | FinOps explorer rollup |
| `get_agentic_metrics` | read | F64 agentic metrics pack |

Scopes `mcp:read`, `mcp:debug`, and `mcp:fix` gate tools. Use an org API
key from **Settings → API Keys** in the portal (`EDEN_API_KEY`). Dedicated
MCP key routes (`POST /orgs/{org}/mcp/keys`) are **not mounted** in the
current beta — do not rely on them.

## Streamable HTTP (W28)

In addition to stdio (`eden-mcp` / `python -m eden.mcp_server`), Eden
exposes JSON-RPC over HTTP:

```
POST https://api.edenobservability.com/v1/mcp
Authorization: Bearer <org-api-key>
X-Org-Id: org_…
```

Methods: `initialize`, `tools/list`, `tools/call`, `ping`. GET on the
same path returns a short SSE hello for endpoint discovery. Prefer
stdio for Cursor; use HTTP for remote agents.

## Example prompts

Try these in Cursor's agent chat after MCP connects:

- **"Why did trace `abc-123` fail? Show the transcript and any quality signals."**
- **"List open P0 agent issues from the last 24 hours."**
- **"Triage issue `iss_456` and summarize the root cause."**
- **"Show F64 agentic metrics for this org."**
- **"Run a read-only SQL cost breakdown for the last day."**

## Smoke test

1. Paste the JSON config above (or build it from **Settings → API Keys**).
2. Set `EDEN_API_KEY` to a real org API key (`sk_eden_…`).
3. In Cursor agent chat: *"Call `search_traces` for org `{org_id}` with limit 5."*
4. Optionally: *"Call `get_agentic_metrics`"* and *"Call `query_eql` with nl_text errors"*.
5. You should see JSON tool results.

If the server fails to start, check:

## What's next

- [Connect any agent](/how-to/connect-any-agent) — SDK instrumentation tiers
- [Agent sessions](/how-to/agent-sessions) — session-first tracing (F23)
- [Failure fixtures](/how-to/failure-fixtures) — export redacted traces for local replay
