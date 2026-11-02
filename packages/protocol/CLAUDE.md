# @eden/protocol

The wire contract every other package shares: event, item, injection and ask types; ids and scope keys; input
validation for what arrives over HTTP; Eden's data directory; the `ask_context` tool descriptions. No dependencies.

## Files

| File | Owns |
|---|---|
| `src/types.ts` | `AgentEvent` (user/agent message, tool call/result, external, session start/end; `draft` on a user message), `ContextItem`, `Injection`, `ObserveResult`, `AskRequest`/`AskResponse`, `ActionCheck`, `Feedback`, `Scope` |
| `src/ids.ts` | `newId`, `itemId`, `scopeKey` (`tenant/user`, the key every piece of per-user state uses) |
| `src/validate.ts` | `checkEvent`, `checkAsk`, `isId`: hand-written checks that return `{ok:false,error}` instead of throwing |
| `src/home.ts` | `edenHome()`: `$EDEN_HOME`, else `~/.eden`, created 0700 |
| `src/describe.ts` | `ASK_CONTEXT_DESCRIPTION` and the guided `ASK_CONTEXT_GUIDED` (D88), used by the server's MCP tool and the lab |

## Rules that apply here

- **Isolation (D9).** Ids may not contain `/` or `#` (`isId`: `[A-Za-z0-9._:@-]{1,128}`) because `scopeKey` joins
  them with those separators. Do not loosen `isId` without changing every key format.
- **Fail open at the edge.** Validation never throws: the server turns `{ok:false}` into a 400 with the message. A
  shape the engine cannot handle later (e.g. a tool input nested past the stack limit, > 1,000,000 JSON chars) must be
  rejected here, not become a 503 (`validate.test.ts`, `server/src/http.test.ts` "audit regressions").
- **Untrusted text (D11, D19).** Types carry source and event text as data; nothing here interprets it.
- Code that defaults to `~/.eden` must read `EDEN_HOME` first: Bun reads `os.homedir()` once at startup, so the test
  preload's temp HOME only reaches code that goes through `edenHome()`.
- A type change here reaches every package: run the dependents' tests (`bun run test:changed` does).

## Test

```bash
bun run test:pkg protocol            # ~2.3 s, most of it one test (a 60,000-deep array overflowing JSON.stringify)
bun test ./packages/protocol/src/validate.test.ts   # from the repo root only: bunfig.toml's preload is read from cwd
```

## Where next

`docs/ARCHITECTURE.md` "Identity and isolation"; `packages/server/src/http.ts` (how validation errors become 400s);
`packages/client` (the SDK that builds these events).
