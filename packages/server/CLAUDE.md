# @eden/server

Eden as a service: the HTTP API (tenant API keys, per-tenant GCRA rate limit), the MCP `ask_context` server (HTTP
wiring and stdio), configuration from the environment, and `buildPartner`, which wires the engine with production
defaults.

## Files

| File | Owns |
|---|---|
| `src/http.ts` | `createHandler`: `/v1/events` (`?waitMs=`, clamped 0–5,000), `/v1/ask`, `/v1/check`, `/v1/pending`, `/v1/digest`, `/v1/feedback`, `/v1/forget`, `/healthz`; auth (the key fixes the tenant; dev mode accepts a missing key, never a wrong one); 429 with Retry-After past the tenant's rate |
| `src/build.ts` | `buildPartner` (production defaults: query planner serving D33, no experimental flag unless `engine` passes it), `startGatePool` (`EDEN_GATE_WORKERS`, D26) |
| `src/config.ts` | `loadConfig`: every `EDEN_*` variable validated at startup with a message naming it |
| `src/mcp.ts` | `createMcpServer`: one `ask_context` tool (guided description with `askGuard`, D88) |
| `src/mcp-stdio.ts` | One user's `ask_context` over stdio (`EDEN_TENANT`, `EDEN_USER`, `EDEN_SOURCES_FILE`) |
| `src/connectors.ts` | `staticResolver`: sources from a JSON file; per-user OAuth MCP connections are roadmap M2 |
| `src/main.ts` | `bun run dev` |

## Rules that apply here

- **Never 500 on caller input (CLAUDE.md).** Malformed input is a 4xx with `{error}`; an engine failure is 503
  ("temporarily unable to serve context"), which an integration treats as silence. Validation lives in
  `@eden/protocol`; anything it lets through that the engine cannot take is a protocol bug (see the audit regressions
  in `http.test.ts`).
- **Isolation (D9).** A body naming another tenant than its key is refused. Every route passes the scope through;
  nothing here holds per-user state of its own.
- **Production defaults (D12, D33, D43).** The environment turns on no experimental engine flag; only an embedding's
  `buildPartner({ engine })` does. Do not read lab options (`allowLogging`, Anthropic models) from the environment.
- **Read-only sources (D7)** are enforced in `@eden/sources`; `connectors.ts` must build sources through it.
- **Secrets.** Never log API keys or request bodies; `EDEN_API_KEYS` entries need keys of 16+ characters.

## Test

```bash
bun run test:pkg server          # ~3 s; two tests parse a 60,000-deep body on purpose (~2.5 s)
EDEN_DEV=1 bun run dev           # local server on 127.0.0.1:8790 with static sources from EDEN_SOURCES_FILE
```

## Where next

`docs/INTEGRATION.md`, `docs/PRIVACY.md`, `packages/client` (the caller), `packages/sim/src/server.ts` and
`bun run sim:perf` (the real server under simulated agents).
