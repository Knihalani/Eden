# Eden for Claude Code

Eden runs beside [Claude Code](https://docs.anthropic.com/en/docs/claude-code) through its hook
system plus one MCP server: it reports the conversation, injects context packets into each
prompt, answers `ask_context`, and denies tool calls the party check flags.

## Install

```sh
python3 examples/claude-code/install.py            # or a release archive's install.py
```

It writes `~/.claude/eden/` (`eden-hook.py`, `eden-mcp.py`, the vendored `eden_client` package,
`bin/eden-local`) and merges the hook entries into `~/.claude/settings.json` plus an `eden` MCP
server into `~/.claude.json` — both merges are additive and re-runnable.

## What each hook does

| Claude Code event  | Eden behaviour                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart`     | `session_start` reported (wait 0).                                                                                                                                            |
| `UserPromptSubmit` | the `user_message` is reported (waits for its lookup); the packet comes back as `additionalContext`. A question-shaped message with no packet gets the `ask_context` nudge.   |
| `PreToolUse`       | the `tool_call` is reported and checked; a `finding` answers `permissionDecision: "deny"` with the held result (which is itself reported as the `tool_result` the agent saw). |
| `PostToolUse`      | the `tool_result` is reported, once per `tool_use_id`.                                                                                                                        |
| `Stop`             | the turn's last assistant reply, read from the transcript, reported once per copy.                                                                                            |
| `SessionEnd`       | `end_session`; the on-disk dedup state is removed.                                                                                                                            |

Claude Code runs every hook as its own process, so dedup state lives in
`~/.claude/eden/state/<session>.json` (bounded, deleted at `SessionEnd`) instead of memory —
the same copy-keyed dedup the other adapters keep in-process.

## ask_context

Hooks cannot add tools, so `ask_context` is `eden-mcp.py`: a minimal MCP stdio server
(newline-delimited JSON-RPC, stdlib only) registered as `mcpServers.eden`. It is never reported
and never checked.

## Configure

Local mode (default): put source declarations in `~/.claude/eden/sources.json` — the same file
the other agents' Eden integrations read — then start a new Claude Code session. Each hook is its
own process, so the first one starts a detached `eden-local` (recorded at
`~/.claude/eden/local-endpoint.json`) that every later hook attaches to; a fresh server per hook
would lose the session state the tool check reads. Re-running `install.py` refreshes only the
installed code — `sources.json`, `state/`, `data/` and `logs/` are left untouched.

Hosted mode: `EDEN_URL` + `EDEN_API_KEY` (+ `EDEN_TENANT_ID`, `EDEN_USER_ID`) in the environment
or the hook commands' env. `EDEN_LOCAL_BINARY` overrides the bundled sidecar.

Every hook fails open: Eden unreachable, missing, or erroring changes nothing about how
Claude Code runs.

## Check

```sh
cd packages/client-python && python3 -m unittest test_claude
```

`eden doctor` verifies the same integration obligations as the other agents once a session has
run: reported user/agent messages and tool events, the wait on the user message, `ask_context`
present, and acting tools checked.
