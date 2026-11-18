# eden-client (Python)

The Python client for Eden: the same calls and the same fail-open contract as `@eden/client` (TypeScript). Standard
library only (`urllib`), Python 3.9+, synchronous (from asyncio, wrap calls in `asyncio.to_thread`).

```python
from eden_client import EdenClient, with_context, eden_id, ASK_CONTEXT_DESCRIPTION

eden = EdenClient(api_key=KEY, user_id=eden_id(user.email), session_id=eden_id(chat.id),
                  base_url="http://127.0.0.1:8790", on_error=log.warning)
assert eden.health()["ok"]                                         # at startup: key, tenant and ids accepted
eden.observe({"kind": "session_start"})                            # when the user connects: Eden starts reading

result = eden.observe({"kind": "user_message", "text": text})      # each event (waits up to 3 s on a user message)
messages = with_context(messages, eden.collect(result["injection"]))  # before each model call
answer = eden.ask("What did Dana say about the renewal?")          # behind your ask_context tool
eden.source_changed("gmail", items=[{"ref": msg_id, "title": subject, "text": body}])  # from a source's webhook
for d in eden.explain():                                           # why Eden spoke or stayed silent (no content)
    print(d["turn"], d["decision"], d["why"])
```

- **Fails open (D14).** A network error, a timeout, a non-2xx or an answer of the wrong shape is "no context"
  (`None`, `[]`, `proceed` for `check`), never an exception. With no `on_error`, each problem is printed to stderr
  once with its fix (with `EDEN_ENV=production`, the first of each kind; D850); pass your logger, or `on_error=None`
  to silence it. Errors carry the server's reason (`eden /v1/whoami: 401 missing or unknown API key`),
  never the request or the key.
- **A local dev server** (`EDEN_DEV=1`): pass no `api_key` at all (a made-up one is refused with a 401). Unset
  `base_url` and `api_key` come from `EDEN_URL` and `EDEN_API_KEY` (D856), default `http://127.0.0.1:8790`.
- **One `session_id` per conversation.** Eden hands an item out once per session; an ask in the same session cites
  it as `(shown above)` (it is in the packet already in your messages). A second script reusing a session id sees
  that too.
- **What comes back:** `observe` returns `{"injection": dict or None, "pending": bool}`; `collect` and `pending` a
  list of injections (`{"id", "text", "citations", …}`); `ask` `{"answer", "citations", …}` or None; `check`
  `{"verdict": "proceed" or "finding", "finding": …}`; `health` `{"ok": bool, "error"?: str}`.
- **Ids.** `user_id`, `session_id` and `tenant_id` are 1-128 characters of `[A-Za-z0-9._:@-]`; map any other string
  with `eden_id`, which gives exactly the TypeScript `edenId`'s id (tested), so a mixed stack finds one user's state.
- **Events** are the protocol's (`docs/INTEGRATION.md`): `user_message`, `agent_message`, `tool_call`
  (`tool`, `input`), `tool_result` (`tool`, `output`), `external`, `session_end`. Report every one.
- Register Eden's ask tool with `ASK_CONTEXT_DESCRIPTION` (docs/INTEGRATION.md, "Keep `ask_context`").

Install from a checkout: `pip install ./packages/client-python` (or copy `eden_client/__init__.py`; it is one file).
Tests: `bun run test:pkg client-python` (the unit tests, an end-to-end run against the real HTTP handler, and id
parity with TypeScript), or `python3 -m unittest -v test_eden_client` from this directory.

Install from a checkout: `pip install ./packages/client-python` (not yet on PyPI). `bun run publish:check` builds the
sdist and wheel and runs `twine check` (D853).

### Local process ownership

`eden_client.local.LocalEden(binary, data_dir, ...)` lazily supervises a local-protocol binary, independently of
Hermes. `endpoint()` returns `(base_url, token, generation)` or `None`; discard cached clients when the generation
changes. Use `EdenClient(..., bypass_proxies=True)` for that endpoint. Redirects remain disabled in both modes.
The owner must register `close()` with `atexit` and any plugin unload callback; closing stdin ends the child's lifetime.

Child configuration starts with only runtime/path/locale variables, plus connector credentials named by exact
`{"env": "NAME"}` objects in `user_sources_file`. Runtime variables, proxy variables, `EDEN_`, `LD_`, `DYLD_`,
`PYTHON`, `BUN_`, `NODE_` prefixes and `OPENROUTER_API_KEY` cannot be imported as connector credentials.
Local token, loopback host, ephemeral port, data directory and supplied sources paths are applied last. Invalid or
unreadable sources files forward no credentials. Other ambient secrets and Eden configuration are never inherited.
Startup is bounded to 10 seconds, crashes back off from 1 to 60 seconds, and optional stderr logs rotate at 1 MiB
with one backup. `close()` is idempotent; it waits up to two seconds each before terminate and kill escalation.
