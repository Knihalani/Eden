# @eden/client-python

`eden_client`: Eden's stdlib-only Python client (D278) mirroring `@eden/client` call for call, plus adapters. The
workspace package exists so `bun run test` runs its tests.

## Files

| File | Owns |
|---|---|
| `eden_client/__init__.py` | `EdenClient` (`observe`, `pending`, `collect`, `ask`, `check`, `feedback`, `health`, `explain`, `source_changed`, `source_notice`; `shadow=True` sends `?shadow=1` on events and pending, D282), `with_context`, `held_result`, `guard_tool`/`guard_tools` (D420; an `async` tool stays `async`), `eden_id`, `ASK_CONTEXT_DESCRIPTION` |
| `eden_client/hermes.py` | The Hermes Agent plugin (D422): `ask_context`, packet/check/tool-result and finalize/reset hooks (never per-turn `on_session_end`). Non-empty `EDEN_URL`: hosted, `EDEN_USER_ID` required. Otherwise local: tenant/user default `local`, optional mapped user, API key/tenant ignored. `EDEN_CHECK_TOOLS` selects checks. Profile-scoped, generation-aware clients per session; wrapper passes `plugin_file` for binary discovery |
| `eden_client/local.py` | Thread-safe lazy sidecar supervisor: bounded readiness, generation/token rotation, crash backoff, isolated environment and stderr log rotation; owner registers `close` with atexit/unload |
| `test_hermes.py`, `test_local.py` | Stand-in Hermes context, vendored wrapper loading, real fake-binary lifecycle and loopback HTTP tests |
| `test_eden_client.py` | Unit tests: every call fails open on every failure shape (unreachable, non-2xx, wrong shape, bad JSON) |
| `src/python.test.ts` | Runs the Python unit tests, then the client end to end against the real handler, and `eden_id` against `edenId` |

## Rules

- **Fail open (D14)**, as `packages/client/CLAUDE.md` says: a new call gets a test for each failure shape.
- **Parity.** A change to `@eden/client` (a call, a default such as `DEFAULT_WAIT_MS`, `edenId`, `withContext`) is
  made here too; `python.test.ts` checks the ids. `ASK_CONTEXT_DESCRIPTION` and `MAX_PUSHED_ITEMS` are copies of
  `@eden/protocol`'s.
- **No dependencies.** Standard library only.
- **Secrets.** Never log the key; `on_error` gets the route, status and server reason only.
- **Hermes scope.** Check active vs routing/process home before reading environment, and active vs registered home
  on every callback. Never borrow launch-profile credentials/sources for a routed home. No Hermes config reads.
- **Local lifecycle.** Discover explicit `EDEN_LOCAL_BINARY`, wrapper-local `bin/eden-local`, then home plugin bin;
  no PATH/download. Data/logs/sources default under `<home>/eden`. Do not spawn at registration or session end.
  Rebuild session clients on generation change; bypass proxies and close on both atexit and `ctx.on_unload`.
  Keep startup + calls below Hermes' 30 s hook budget; its timed-out pre-tool policy can fail closed.

## Test

```bash
bun run test:pkg client-python    # ~4 s; skipped when python3 is missing
```
