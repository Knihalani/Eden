# Eden for Devin CLI / Devin Desktop

Eden runs beside [Devin CLI](https://docs.devin.ai/cli) (and Devin Desktop's Devin Local
agent — same harness) through its hook system plus one MCP server: it reports the
conversation, injects context packets into each prompt, answers `ask_context`, and blocks
tool calls the party check flags.

## Install

```sh
python3 examples/devin-cli/install.py            # or a release archive's install.py
```

It writes `~/.config/devin/eden/` (`eden-hook.py`, `eden-mcp.py`, the vendored `eden_client`
package, `bin/eden-local`), merges the hook entries into `config.json`'s `hooks`, and an
`eden` server into `mcp_config.json`'s `mcpServers` — all merges are additive and
re-runnable.

## What each hook does

| Devin event        | Eden behaviour                                                                                                                      |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`     | `session_start` reported (wait 0); `source` (`startup`/`resume`) passes through.                                                    |
| `UserPromptSubmit` | the `user_message` is reported (waits for its lookup); the packet comes back as `additionalContext`.                                 |
| `PreToolUse`       | the `tool_call` is reported and checked; a `finding` answers `decision: "block"` (which is itself reported as the result the agent saw). |
| `PostToolUse`      | the `tool_result` is reported — `tool_response`'s `output`, or its `error` when the call failed.                                     |
| `PostCompaction`   | `context_reset`: compaction cleared the context, so delivered-item marks reset too.                                                  |
| `SessionEnd`       | `end_session`; the on-disk dedup state is removed (local sessions only — cloud sessions never fire it).                              |

Devin runs every hook as its own process, so dedup state lives in
`~/.config/devin/eden/state/<session>.json` (bounded, deleted at `SessionEnd`) — the same
copy-keyed dedup the other adapters keep in-process. `PreToolUse` carries no per-call id,
so an identical repeat call counts its copies from that file and reports as its own event.

Two events are skipped on purpose: `Stop` carries only `stop_hook_active` — no reply text —
so the turn's final message goes unreported, and `PermissionRequest` is covered by the
`PreToolUse` check (a second check would re-report the same call).

## ask_context

Hooks cannot add tools, so `ask_context` is `eden-mcp.py`: a minimal MCP stdio server
(newline-delimited JSON-RPC, stdlib only) registered as `mcpServers.eden` in
`mcp_config.json`. It is never reported and never checked.

## Configure

Local mode (default): put source declarations in `~/.config/devin/eden/sources.json` — the
same file the other agents' Eden integrations read — then start a new session. Each hook is
its own process, so the first one starts a detached `eden-local` (recorded at
`~/.config/devin/eden/local-endpoint.json`) that every later hook attaches to; a fresh
server per hook would lose the session state the tool check reads. Re-running `install.py`
refreshes only the installed code — `sources.json`, `state/`, `data/` and `logs/` are left
untouched.

Hosted mode: `EDEN_URL` + `EDEN_API_KEY` (+ `EDEN_TENANT_ID`, `EDEN_USER_ID`) in the
environment or the hook commands' env. `EDEN_LOCAL_BINARY` overrides the bundled sidecar.

Every hook fails open: Eden unreachable, missing, or erroring changes nothing about how
the agent runs.

## Check

```sh
cd packages/client-python && python3 -m unittest test_devincli
```

`eden doctor` verifies the same integration obligations as the other agents once a session
has run: reported user messages and tool events, the wait on the user message,
`ask_context` present, and acting tools checked.
