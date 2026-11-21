# Eden × Windsurf Cascade

The [Windsurf legacy agent (Cascade)](https://docs.windsurf.com/windsurf/cascade/hooks) shipped in Devin Desktop runs hook commands at
eleven events in an agent turn and reads MCP servers from
`~/.codeium/windsurf/mcp_config.json`. This example wires Cascade's `trajectory_id` into an
Eden session: prompts report and stash their packet, every `pre_*` action reports the call
and blocks on a party finding, every `post_*` action reports the result, and
`post_cascade_response` reports the turn's reply.

## Install

```bash
python3 examples/windsurf/install.py            # local daemon (default)
python3 examples/windsurf/install.py --dry-run  # preview
python3 examples/windsurf/install.py --uninstall
```

- `EDEN_HERMES_URL`/`EDEN_API_KEY` or `--remote` installs against a remote endpoint instead.
- `WINDSURF_HOME` (or `CODEIUM_WINDSURF_HOME`) overrides the `~/.codeium/windsurf` home.

The installer merges one `bash` hook command into each of these event lists in
`~/.codeium/windsurf/hooks.json` and registers `mcpServers.eden` in `mcp_config.json`:

| `agent_action_name` | What Eden does |
| --- | --- |
| `pre_user_prompt` | Reports the `user_message`; parks the packet for the next `post_*` hook or an MCP ask — Cascade shows hook stdout in the UI only |
| `pre_run_command` / `pre_write_code` / `pre_read_code` / `pre_mcp_tool_use` | Reports the `tool_call`; a party finding **exits 2 with the held text on stderr**, Cascade's only blocking channel |
| `post_run_command` / `post_write_code` / `post_read_code` / `post_mcp_tool_use` | Reports the `tool_result` (and `mcp_result` on the MCP event); a stashed packet rides stdout into the transcript |
| `post_cascade_response` | Reports the turn's final reply once per copy |

`post_user_prompt`, `post_setup_worktree` and `post_cascade_response_with_transcript` are
ignored (the prompt and response are already reported; a worktree is no agent action).

## Context injection: MCP only

Cascade puts a hook's **stdout in the UI, not the model context** — a pre-hook cannot inject.
Two channels remain:

- `post_*` hooks echo a stashed packet on stdout, which lands in the trajectory transcript.
- The `eden` MCP server exposes `pending_context` (the queue plus anything a prompt/check
  stashed for a channel-less event) and `ask_context` (a natural-language question, plus an
  optional `item` id from a Sources line to go deeper).

Cascade has no session lifecycle events: the session starts with the first hook that reports
it and `session_end` is never sent — a documented gap, matching what the contract offers.

## How it works

`eden-hook.py` reads the whole payload from stdin and dispatches on `agent_action_name`;
`eden-mcp.py` is a stdlib MCP stdio server. Every hook is its own process, so dedup lives in
`<windsurf-home>/eden/state/` and the shared local server (`eden-local`) outlives each
process. Everything fails open (D14): an error returns nothing and the agent proceeds.
