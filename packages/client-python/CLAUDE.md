# @eden/client-python

`eden_client`: Eden's Python client (D278), one stdlib-only file mirroring `@eden/client` call for call. The
workspace package exists so `bun run test` runs its tests.

## Files

| File | Owns |
|---|---|
| `eden_client/__init__.py` | `EdenClient` (`observe`, `pending`, `collect`, `ask`, `check`, `feedback`, `health`, `explain`, `source_changed`, `source_notice`; `shadow=True` sends `?shadow=1` on events and pending, D282), `with_context`, `held_result`, `guard_tool`/`guard_tools` (D420; an `async` tool stays `async`), `eden_id`, `ASK_CONTEXT_DESCRIPTION` |
| `eden_client/hermes.py` | The Hermes Agent plugin (D422, `hermes-eden` shape): `ask_context` tool, `pre_llm_call` (new packet only), `pre_tool_call` (check; a finding blocks), `post_tool_call`/`transform_tool_result`, `on_session_end`; one client per Hermes session; env `EDEN_USER_ID` (required), `EDEN_URL`, `EDEN_API_KEY`, `EDEN_TENANT_ID`, `EDEN_CHECK_TOOLS`. Hermes loads it through `examples/hermes/eden` |
| `test_hermes.py` | The plugin's unit tests on a stand-in Hermes context |
| `test_eden_client.py` | Unit tests: every call fails open on every failure shape (unreachable, non-2xx, wrong shape, bad JSON) |
| `src/python.test.ts` | Runs both unit test files, then the client end to end against the real handler, and `eden_id` against `edenId` |

## Rules

- **Fail open (D14)**, as `packages/client/CLAUDE.md` says: a new call gets a test for each failure shape.
- **Parity.** A change to `@eden/client` (a call, a default such as `DEFAULT_WAIT_MS`, `edenId`, `withContext`) is
  made here too; `python.test.ts` checks the ids. `ASK_CONTEXT_DESCRIPTION` and `MAX_PUSHED_ITEMS` are copies of
  `@eden/protocol`'s.
- **No dependencies.** Standard library only.
- **Secrets.** Never log the key; `on_error` gets the route, status and server reason only.

## Test

```bash
bun run test:pkg client-python    # ~4 s; skipped when python3 is missing
```
