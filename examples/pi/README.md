# Eden for Pi

Eden is a context partner that runs privately beside Pi: it reads the sources you connect (read-only), injects
relevant context before each model call, answers `ask_context`, and checks acting tool calls before they run.

## Install

```bash
python3 examples/pi/install.py            # repo checkout: bundles the extension + builds eden-local
python3 install.py                        # inside a release archive (prebuilt index.js + bin/eden-local)
```

It writes `~/.pi/agent/extensions/eden/index.js` and `bin/eden-local` (`--pi-home PATH` for another home). Start a
new Pi session or `/reload`.

## Sources

With no sources Eden stays quiet. Write `~/.pi/eden/sources.json`:

```json
{"users": {"local/local": [
  {"kind": "static", "id": "notes", "description": "My notes",
   "docs": [{"ref": "1", "title": "Gym renewal", "text": "Your gym membership renews on 1 December."}]}
]}}
```

Or point the Pi process at a file with `EDEN_SOURCES_FILE` / `EDEN_USER_SOURCES_FILE`. Live connectors are
`"kind": "mcp"` entries — see `docs/INTEGRATION.md`. A hosted Eden is `EDEN_URL` + `EDEN_API_KEY`/`EDEN_TENANT_ID`.

## Local mode

One detached `eden-local` daemon serves every Pi process of this home (D1993): its endpoint lives at
`~/.pi/eden/local-endpoint.json`, logs to `~/.pi/eden/logs/eden-local.log`, and keeps its source map and
frozen users under `~/.pi/eden/` (D1994), so a restart resumes instead of re-reading every source. A stale
sources file replaces the daemon; nothing else has to be managed — delete the directory to reset it.

## What the extension does

- Reports each message as it reaches a model call (`user_message` waits for its lookup; the rest wait 0).
- Places packets as a leading text block on the user message they answer — mid-turn packets after the last
  message — and keeps them in place on later calls (64 KB cap).
- Registers `ask_context` (`EDEN_ASK_HINT` is not needed: the tool is direct in Pi).
- Runs the party check on every `tool_call`; a `finding` blocks the call with the held finding as its reason.
- Fails open: Eden down or erroring never stops Pi.
