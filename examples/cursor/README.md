# Eden for Cursor

Eden runs beside [Cursor](https://cursor.com)'s agent (CLI and editor chat) through its
`hooks.json` hook system plus one MCP server: it reports the conversation, injects context
packets into each prompt, answers `ask_context`, and denies tool calls the party check flags.

## Install

```sh
python3 examples/cursor/install.py            # or a release archive's install.py
```

It writes `~/.cursor/eden/` (`eden-hook.py`, `eden-mcp.py`, the vendored `eden_client` package,
`bin/eden-local`), merges the hook entries into `~/.cursor/hooks.json` and registers an `eden`
MCP server in `~/.cursor/mcp.json` — both merges are additive and re-runnable.

## What each hook does

| Cursor event          | Eden behaviour                                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionStart`        | `session_start` reported (wait 0).                                                                                                                               |
| `beforeSubmitPrompt`  | the `user_message` is reported (waits for its lookup); the packet comes back as `additional_context`.                                                              |
| `preToolUse`          | the `tool_call` is reported and checked; a `finding` answers `permission: "deny"` with the held result as `agent_message` (which is itself reported as the `tool_result` the agent saw). |
| `postToolUse`         | the `tool_result` is reported, once per `tool_use_id`.                                                                                                           |
| `postToolUseFailure`  | the failure (error, timeout, denied) is reported as the call's `tool_result`.                                                                                     |
| `afterAgentResponse`  | the assistant message (`text`), reported once per copy.                                                                                                          |
| `preCompact`          | `context_reset`: compaction cleared the transcript, so delivered-item marks reset too.                                                                            |
| `sessionEnd`          | `end_session`; the on-disk dedup state is removed.                                                                                                                |

`beforeShellExecution`/`beforeMCPExecution` and their `after*` partners are deliberately not
registered: `preToolUse`/`postToolUse` fire for every tool including Shell and MCP calls, so
wiring the pairs too would report each call twice.

Cursor runs every hook as its own process, so dedup state lives in
`~/.cursor/eden/state/<conversation>.json` (bounded, deleted at `sessionEnd`) instead of
memory — the same copy-keyed dedup the other adapters keep in-process.

## ask_context

Hooks cannot add tools, so `ask_context` is `eden-mcp.py`: a minimal MCP stdio server
(newline-delimited JSON-RPC, stdlib only) registered as `mcpServers.eden` in `~/.cursor/mcp.json`.
It is never reported and never checked.

## Configure

Local mode (default): put source declarations in `~/.cursor/eden/sources.json` — the same file
the other agents' Eden integrations read — then start a new Cursor conversation. Each hook is
its own process, so the first one starts a detached `eden-local` (recorded at
`~/.cursor/eden/local-endpoint.json`) that every later hook attaches to; a fresh server per
hook would lose the session state the tool check reads. Re-running `install.py` refreshes only
the installed code — `sources.json`, `state/`, `data/` and `logs/` are left untouched.

Hosted mode: `EDEN_URL` + `EDEN_API_KEY` (+ `EDEN_TENANT_ID`, `EDEN_USER_ID`) in the environment
or the hook commands' env. `EDEN_LOCAL_BINARY` overrides the bundled sidecar.

Every hook fails open: Eden unreachable, missing, or erroring changes nothing about how
Cursor runs.

## Check

```sh
cd packages/client-python && python3 -m unittest test_cursor
```

`eden doctor` verifies the same integration obligations as the other agents once a session has
run: reported user/agent messages and tool events, the wait on the user message, `ask_context`
present, and acting tools checked.
