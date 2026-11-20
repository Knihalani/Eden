# Eden for OpenClaw

Eden is a context partner that runs privately beside OpenClaw: it reads the sources you connect (read-only),
injects relevant context before each prompt build, answers `ask_context`, and checks acting tool calls before
they run.

## Install

```bash
python3 examples/openclaw/install.py            # repo checkout: bundles the plugin + builds eden-local
python3 install.py                              # inside a release archive (prebuilt index.js + bin/eden-local)
```

It writes `~/.openclaw/extensions/eden/` (`index.js`, `openclaw.plugin.json`, `package.json`, `bin/eden-local`);
`--openclaw-home PATH` picks another home. OpenClaw's conversation hooks then need a grant in
`~/.openclaw/openclaw.json` — the installer merges it when the file exists, otherwise it prints the block:

```json
{ "plugins": { "entries": { "eden": { "enabled": true, "hooks": { "allowConversationAccess": true } } } } }
```

Restart the gateway or run `openclaw plugins reload`.

## Sources

With no sources Eden stays quiet. Write `~/.openclaw/eden/sources.json`:

```json
{"users": {"local/local": [
  {"kind": "static", "id": "notes", "description": "My notes",
   "docs": [{"ref": "1", "title": "Gym renewal", "text": "Your gym membership renews on 1 December."}]}
]}}
```

Or point the gateway process at a file with `EDEN_SOURCES_FILE` / `EDEN_USER_SOURCES_FILE`. Live connectors
are `"kind": "mcp"` entries — see `docs/INTEGRATION.md`. A hosted Eden is `EDEN_URL` +
`EDEN_API_KEY`/`EDEN_TENANT_ID`.

## What the plugin does

- Reports each message as prompts are built (`user_message` waits for its lookup; the rest wait 0), tool
  results from `after_tool_call`, and the last reply from `llm_output`/`agent_end`.
- Places packets via `prependContext` ahead of the turn that needs them — mid-turn packets via
  `appendContext` — and keeps them in place on later calls (64 KB cap).
- Registers `ask_context` so the agent can pull context on demand.
- Runs the party check on every `before_tool_call`; a `finding` blocks the call with the held finding as
  `blockReason`.
- Fails open: Eden down or erroring never stops OpenClaw.
