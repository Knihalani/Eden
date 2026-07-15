---
id: mcp-cursor
title: MCP in Cursor and Claude Code
sidebar_label: MCP in Cursor
sidebar_position: 9
---

# How-to — MCP in Cursor and Claude Code

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

**c) Docker / self-hosted API image**

`eden-mcp` is on `PATH` in the Eden API Docker image. Set the env vars
and point Cursor at the container's exec.

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `EDEN_API_KEY` | yes | Org API key (`sk_eden_…`) |
| `EDEN_ORG_ID` | yes | Org id (`org_…`) |
| `EDEN_BASE_URL` | no | API base (default `https://api.edenobservability.com`) |

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

You can also copy a pre-filled config from **Portal → Settings → MCP**.

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
| `rerun_debugger` | debug | Rerun from a checkpoint step (returns cache hit stats when F03 prefix cache is populated; `new_trace_id` deferred until F01 live gateway ships) |
| `search_issues` | read | List agent issues |
| `get_issue` | read | Full issue + example stumbles |
| `triage_issue` | debug | Root-cause triage for an issue |
| `run_autofix` | fix | Propose patch + optional PR |
| `get_improvement_queue` | read | N17 closed-loop action queue |

Scopes `mcp:read`, `mcp:debug`, and `mcp:fix` gate debug and autofix
tools. Today all org API keys authenticate as full-access; dedicated
MCP-scoped keys ship behind the `eden_mcp_server_v1` feature flag.

## Example prompts

Try these in Cursor's agent chat after MCP connects:

- **"Why did trace `abc-123` fail? Show the transcript and any quality signals."**
- **"List open P0 agent issues from the last 24 hours."**
- **"Triage issue `iss_456` and summarize the root cause."**
- **"Rerun trace `abc-123` from step 12 with this system prompt fix."**
- **"Run autofix on issue `iss_456` in dry-run mode first."**

## Smoke test

1. Copy config from **Settings → MCP** (or paste the JSON above).
2. Replace `<your-api-key>` with a real key.
3. In Cursor agent chat: *"Call `search_traces` for org `{org_id}` with limit 5."*
4. You should see recent traces returned as JSON.

If the server fails to start, check:

- `eden-mcp` (or `python -m eden.mcp_server`) runs in a terminal with the same env vars.
- `EDEN_BASE_URL` points at your API (not the portal URL).
- Firewall allows HTTPS to the Eden API.

## Self-hosted

Point `EDEN_BASE_URL` at your API ingress, e.g.
`https://eden.your-domain.com/api` or `http://localhost:8000` for local
docker-compose.

## What's next

- [Connect any agent](/how-to/connect-any-agent) — SDK instrumentation tiers
- [Agent sessions](/how-to/agent-sessions) — session-first tracing (F23)
- [Failure fixtures](/how-to/failure-fixtures) — export redacted traces for local replay
