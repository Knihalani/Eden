# Eden as a gptme plugin

Eden runs inside [gptme](https://gptme.org) as a plugin under `~/.config/gptme/plugins/eden/`: it reports
the conversation, injects context packets as system messages, answers `ask_context`, and holds tool calls
the party check flags.

## Install

```sh
python3 examples/gptme/install.py            # or a release archive's install.py
```

It writes `~/.config/gptme/plugins/eden/` (`__init__.py`, `hooks/`, `tools/`), vendors `eden_client` into
`vendor/`, and drops `bin/eden-local` (the local sidecar, used when no `EDEN_URL` is set). gptme discovers
packages under `~/.config/gptme/plugins` automatically.

## Configure

Local mode (default): put source declarations in `~/.config/gptme/eden/sources.json` — the same file other
agents' Eden integrations read — then start a new gptme session.

Remote mode: set `EDEN_URL` (and `EDEN_USER_ID`, `EDEN_API_KEY`, `EDEN_TENANT_ID` as your deployment
requires) in the environment gptme runs with; `eden-local` is not used. `EDEN_CHECK_TOOLS` picks which
tools the party check sees (comma list, `*` for all, unset for the acting-verb default);
`EDEN_LOCAL_BINARY` overrides the sidecar path.

## What it does

- `eden.generation` (`GENERATION_PRE`): fresh messages are reported — the latest `user_message` waits for
  its lookup, everything else waits 0 — and every not-yet-persisted packet is yielded as `system`
  messages (the hook's context is transient to that call, so packets are re-yielded until `TURN_POST`
  appends them to the log for good).
- `eden.tool_pre` (`TOOL_EXECUTE_PRE`): the call is reported, then checked; a finding's held result is
  reported too, and stashed for the confirm hook.
- `eden.tool_confirm` (`TOOL_CONFIRM`): a stashed finding answers `ConfirmationResult.skip` with the
  held result — tools that route through confirmation (`shell`, `save`, `patch`, …) are denied; tools
  that never confirm can't be blocked, but their finding is still reported.
- `eden.tool_post` (`TOOL_EXECUTE_POST`): the result is reported.
- `eden.turn` (`TURN_POST`): the turn's last assistant message is reported, and delivered packets are
  appended to the log so later turns keep them.
- `eden.session_start`/`eden.session_end` (`SESSION_START`/`SESSION_END`): each gptme logdir is its own
  Eden session.
- `ask_context` (tool): answered by `EdenClient.ask`; never reported, never checked.

Fails open (D14): Eden down or erroring never stops gptme.
