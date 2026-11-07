# eden-client (Python)

The Python client for Eden: the same calls and the same fail-open contract as `@eden/client` (TypeScript). Standard
library only (`urllib`), Python 3.9+, synchronous (from asyncio, wrap calls in `asyncio.to_thread`).

```python
from eden_client import EdenClient, with_context, eden_id, ASK_CONTEXT_DESCRIPTION

eden = EdenClient(api_key=KEY, user_id=eden_id(user.email), session_id=eden_id(chat.id),
                  base_url="http://127.0.0.1:8790", on_error=log.warning)
assert eden.health()["ok"]                                         # at startup: key, tenant and ids accepted

result = eden.observe({"kind": "user_message", "text": text})      # each event (waits up to 3 s on a user message)
messages = with_context(messages, eden.collect(result["injection"]))  # before each model call
answer = eden.ask("What did Dana say about the renewal?")          # behind your ask_context tool
eden.source_changed("gmail", items=[{"ref": msg_id, "title": subject, "text": body}])  # from a source's webhook
for d in eden.explain():                                           # why Eden spoke or stayed silent (no content)
    print(d["turn"], d["decision"], d["why"])
```

- **Fails open (D14).** A network error, a timeout, a non-2xx or an answer of the wrong shape is "no context"
  (`None`, `[]`, `proceed` for `check`), never an exception. Set `on_error`: otherwise a refused key looks exactly
  like Eden's normal silence. Errors carry the server's reason (`eden /v1/whoami: 401 missing or unknown API key`),
  never the request or the key.
- **Ids.** `user_id`, `session_id` and `tenant_id` are 1-128 characters of `[A-Za-z0-9._:@-]`; map any other string
  with `eden_id`, which gives exactly the TypeScript `edenId`'s id (tested), so a mixed stack finds one user's state.
- **Events** are the protocol's (`docs/INTEGRATION.md`): `user_message`, `agent_message`, `tool_call`
  (`tool`, `input`), `tool_result` (`tool`, `output`), `external`, `session_end`. Report every one.
- Register Eden's ask tool with `ASK_CONTEXT_DESCRIPTION` (docs/INTEGRATION.md, "Keep `ask_context`").

Install from a checkout: `pip install ./packages/client-python` (or copy `eden_client/__init__.py`; it is one file).
Tests: `bun run test:pkg client-python` (the unit tests, an end-to-end run against the real HTTP handler, and id
parity with TypeScript), or `python3 -m unittest -v test_eden_client` from this directory.
