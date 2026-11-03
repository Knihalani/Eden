# @eden/server

Eden as a service: the HTTP API (tenant API keys, per-tenant GCRA rate limit), the MCP `ask_context` server (HTTP
wiring and stdio), configuration from the environment, and `buildPartner`, which wires the engine with production
defaults.

## Files

| File | Owns |
|---|---|
| `src/http.ts` | `createHandler`: `/v1/events` (`?waitMs=`, clamped 0–5,000), `/v1/ask`, `/v1/check`, `/v1/pending`, `/v1/digest`, `/v1/feedback`, `/v1/forget` (also closes the user's source connections), `/v1/sources` (the user's sources, 422 for a broken config, D104), `/healthz`; auth (the key fixes the tenant; dev mode accepts a missing key, never a wrong one); 429 with Retry-After past the tenant's rate; 413 when the declared content-length passes `maxBodyBytes` (D100) |
| `src/build.ts` | `buildPartner` (production defaults: query planner serving D33, no experimental flag unless `engine` passes it), `startGatePool` (`EDEN_GATE_WORKERS`, D26) |
| `src/config.ts` | `loadConfig`: every `EDEN_*` variable validated at startup with a message naming it; `stdioSourceMapPath` (one source-map file per tenant/user under `$EDEN_HOME/mcp-stdio`, or `EDEN_SOURCE_MAP`) |
| `src/engine-config.ts` | `engineConfig`: `EDEN_ENGINE_CONFIG`, a JSON file of `EngineConfig` keys over the defaults (D103); unknown keys, wrong types and flags needing an unwired dep stop startup |
| `src/mcp.ts` | `createMcpServer`: one `ask_context` tool (guided description with `askGuard`, D88) |
| `src/mcp-stdio.ts` | One user's `ask_context` over stdio (`EDEN_TENANT`, `EDEN_USER`, `EDEN_SOURCES_FILE`); persists its source map per user, falling back to an in-memory map (logged to stderr) when the file cannot be opened (`openSourceMap`); warms the gate before connecting |
| `src/connectors.ts` | `staticSources`/`staticResolver` (`EDEN_SOURCES_FILE`, static and shared by every user); `sourcesFromEnv` (adds `UserSources` when `EDEN_USER_SOURCES_FILE` is set) |
| `src/user-sources.ts` | `UserSources` (D104): per-(tenant, user) sources from a `SourceDirectory` (`fileDirectory` for `EDEN_USER_SOURCES_FILE`, or an embedding's vault), MCP connections cached per scope and closed on forget, idle (15 min), cap (10,000 users) or a changed spec; `checkSpecs` |
| `src/main.ts` | `bun run dev`; passes `EDEN_MAX_BODY_BYTES` to `Bun.serve` as `maxRequestBodySize`; warms the secret gate (`warmGate`) before listening and logs `startup N ms` |

## Rules that apply here

- **Never 500 on caller input (CLAUDE.md).** Malformed input is a 4xx with `{error}`; an engine failure is 503
  ("temporarily unable to serve context"), which an integration treats as silence. Validation lives in
  `@eden/protocol`; anything it lets through that the engine cannot take is a protocol bug (see the audit regressions
  in `http.test.ts`).
- **Isolation (D9).** A body naming another tenant than its key is refused. Every route passes the scope through;
  the only per-user state held here is `UserSources`' connections, keyed by scope (D104).
- **Production defaults (D12, D33, D43, D103).** No experimental engine flag is on unless an embedding's
  `buildPartner({ engine })` or the deployment's `EDEN_ENGINE_CONFIG` file turns it on; unset, the partner's config
  deep-equals `DEFAULT_CONFIG` (`engine-config.test.ts`). Never import presets from `@eden/sim` here. Do not read lab
  options (`allowLogging`, Anthropic models) from the environment.
- **The file turns on only what the servers can run (D103).** `buildPartner` wires no cards, bridge or reader, so
  `engineConfig` refuses `cards`, `intent`, `bridgeQuery`, `askReader`, `readerPush` and their sub-flags (`NEEDS_DEP`)
  set to true: the engine would accept them and do nothing. ALL3 and the NEW family therefore cannot run from the
  shipped servers. Wire a paid model dep only under a decision with a COST-MODEL.md entry, then drop its keys from
  `NEEDS_DEP`. An explicit `buildPartner({ askWithModel })` (true or false) wins over `engine.askWithModel`; the
  servers pass it only for `EDEN_ASK_MODEL=1`, so the file's value holds otherwise.
- **Credentialed sources are per user (D104).** `EDEN_SOURCES_FILE` is shared by every tenant and user, so it holds
  static documents only (an entry without `docs` stops startup). MCP sources go in `EDEN_USER_SOURCES_FILE` or an
  embedding's `SourceDirectory`, through `UserSources`: built per scope from that scope's spec, cached per (tenant,
  user, source id), never shared. A new piece of per-user source state is keyed by scope, torn down by `forget`, and
  gets a two-user test in `user-sources.test.ts`. A user's broken config is silence on lookups and a 422 on
  `/v1/sources`, never a 5xx.
- **Warm the gate before serving.** The secret gate compiles its ~230 rules on first use; `warmGate()` moves that to
  startup. Measured (3 runs each, `bun packages/engine/bench/pipeline.bench.ts 1500 300`, with and without a preload
  calling it): event #0 49.3/46.1/36.7 ms cold vs 9.6/14.2/12.6 ms warm; warm-up lag max 71.8/69.7/56.2 vs
  57.6/43.8/41.4 ms. First `sanitizeForStore` in a fresh process 36-44 ms cold vs 1.0-1.8 ms after `warmGate` (64-92
  ms at startup instead). Gate workers (D25) still warm lazily: `WorkerPool` has no init hook. Do not call it at the
  top level of `engine/src/gate.ts` (every importer would pay).
- **Read-only sources (D7)** are enforced in `@eden/sources`; `connectors.ts` and `user-sources.ts` must build
  sources through it (every MCP source is an `McpSource`).
- **Body size (D100).** `EDEN_MAX_BODY_BYTES` (default 8 MB = 8,388,608) caps every request body twice: the handler
  refuses a declared content-length past it with 413 before `req.json()`, and `Bun.serve` refuses bodies with no
  length (chunked) past `maxRequestBodySize`. Bun's own 413 has an empty body, not the handler's JSON message:
  accepted at the transport layer, since the handler never runs for it. Keep it above the ~6 MB worst case of a valid
  event (one 1,000,000-unit field, all `\uXXXX`-escaped).
- **Secrets.** Never log API keys or request bodies; `EDEN_API_KEYS` entries need keys of 16+ characters.

## Test

```bash
bun run test:pkg server          # one test sends a 60,000-deep body, refused by the depth walk in milliseconds (D100)
EDEN_DEV=1 bun run dev           # local server on 127.0.0.1:8790 with static sources from EDEN_SOURCES_FILE
                                 # and per-user ones from EDEN_USER_SOURCES_FILE (D104)
```

## Where next

`docs/INTEGRATION.md`, `docs/PRIVACY.md`, `packages/client` (the caller), `packages/sim/src/server.ts` and
`bun run sim:perf` (the real server under simulated agents).
