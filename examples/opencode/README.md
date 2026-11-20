# Eden as an opencode plugin

Eden runs inside [opencode](https://opencode.ai) as a plugin under `~/.config/opencode/plugins/eden/`:
it reports the conversation, injects context packets as text parts on the latest user message, answers
`ask_context`, and holds tool calls the party check flags.

## Install

```sh
python3 examples/opencode/install.py            # or a release archive's install.py
```

It writes `~/.config/opencode/plugins/eden/` (`index.js` — `eden.ts` bundled with its dependencies —
plus `package.json`) and drops `bin/eden-local` (the local sidecar, used when no `EDEN_URL` is set).
opencode discovers plugin packages under `~/.config/opencode/plugins` automatically.

## Configure

Local mode (default): put source declarations in `~/.config/opencode/eden/sources.json` — the same file
other agents' Eden integrations read — then start a new opencode session.

Remote mode: set `EDEN_URL` (and `EDEN_USER_ID`, `EDEN_API_KEY`, `EDEN_TENANT_ID` as your deployment
requires) in the environment opencode runs with; `eden-local` is not used. `EDEN_LOCAL_BINARY`
overrides the sidecar path; `OPENCODE_HOME` overrides the install root.

## What it does

- `experimental.chat.messages.transform`: fresh messages are reported — the latest `user_message`
  waits for its lookup, everything else waits 0 — and every kept packet is re-applied as a `text` part
  on the last user message (the transform rebuilds the prompt each call, so injections are re-applied
  rather than persisted; deterministic part ids prevent duplicates when the list carries over).
- `tool.execute.before`: the call is reported, then checked — a finding throws, so opencode blocks the
  tool with the held result as its error; the held result is also reported so Eden sees what the agent
  saw.
- `tool.execute.after`: the result is reported, deduped by callID with what the transcript reports.
- `message.part.updated` / `session.idle` (event hook): a reply's finalized text and the turn's last
  assistant message are reported — the reply no later transform carries.
- `session.deleted`: the Eden session is dropped.
- `ask_context` (tool): answered by `EdenClient.ask`; never reported, never checked.

Fails open (D14): Eden down or erroring never stops opencode.
