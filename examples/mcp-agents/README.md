# Eden for MCP-only agents

Ten agent products expose an MCP client but no hook surface — nothing Eden can observe
prompts, check tool calls or report replies through. They still get Eden's **pull** path:

- `ask_context(question, item?)` — a natural-language question about the user's context in
  their other apps, optionally going deeper on an item id from a `Sources` line.
- `pending_context()` — drains whatever the engine has queued for the session
  (partner-initiated packets, or anything a sibling hook stashed for a channel-less event).

| Agent | Config merged | Entry |
| ----- | ------------- | ----- |
| Cline | `~/.cline/data/settings/cline_mcp_settings.json` | `mcpServers.eden` |
| Roo Code | `~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/settings/mcp_settings.json` | `mcpServers.eden` |
| Amazon Q | `~/.aws/amazonq/mcp.json` | `mcpServers.eden` |
| Crush | `~/.config/crush/crush.json` | `mcp.eden` |
| Zed | `~/.config/zed/settings.json` (JSONC tolerated) | `context_servers.eden` |
| Goose | `~/.config/goose/config.yaml` | `extensions.eden` (`type: stdio`) |
| Codex CLI | `~/.codex/config.toml` | `[mcp_servers.eden]` |
| Kiro | `~/.kiro/settings/mcp.json` | `mcpServers.eden` |
| Warp | `~/.warp/.mcp.json` | `mcpServers.eden` |
| Continue | `~/.continue/mcpServers/eden.json` | own file (`mcpServers.eden`) |

## Install

```bash
python3 examples/mcp-agents/install.py                 # every detected agent, local eden-local
python3 examples/mcp-agents/install.py --agents goose,codex
python3 examples/mcp-agents/install.py --list          # show what's detected
python3 examples/mcp-agents/install.py --dry-run
python3 examples/mcp-agents/install.py --uninstall
EDEN_URL=… EDEN_API_KEY=… python3 examples/mcp-agents/install.py --remote
```

The payload lands once in `~/.eden-mcp/eden/` (override with `--eden-home` or
`EDEN_MCP_HOME`): `eden-mcp.py`, the vendored `eden_client` package and `bin/eden-local`
in local mode. Each agent's entry points its `python3` at that one copy — no per-agent
binary. Per-agent overrides: `--<agent>-config PATH` or `EDEN_MCP_<AGENT>_CONFIG`.

Remote mode writes `EDEN_URL`/`EDEN_API_KEY` into each server's `env`. A broken existing
config is warned about, never clobbered; reinstalls refresh in place; `--uninstall` removes
only Eden's entry.

Sources: `<eden-home>/eden/sources.json` (per-user sources), as for the other surfaces.

## What pull-only means

With no `user_prompt_submit`/`pre_tool_use` to observe, the engine never sees the agent's
prompts — so nothing is injected proactively and no tool call is party-checked. The agent
(or its instructions) calls `ask_context` when it wants Eden's view. Pairing with a
hook-capable surface on the same machine is how the queue fills.
