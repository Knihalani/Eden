# @eden/server

Eden as a service: the HTTP API (tenant API keys, per-tenant GCRA rate limit), the MCP `ask_context` server (HTTP
wiring and stdio), configuration from the environment, and `buildPartner`, which wires the engine with the unified default (D111) and
its model roles.

## Files

| File                   | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/http.ts`          | `createHandler`: `/v1/events` (`?waitMs=`, clamped 0–5,000), `/v1/ask`, `/v1/check`, `/v1/pending`, `/v1/whoami` (the client's `health()`: checks the key and ids, changes nothing), `/v1/feedback`, `/v1/forget` (also closes the user's source connections), `/v1/sources` (the user's sources, 422 for a broken config, D108), `/healthz`; auth (the key fixes the tenant; dev mode accepts a missing key, never a wrong one); 429 with Retry-After past the tenant's rate; 413 when the declared content-length passes `maxBodyBytes` (D100)                                                                                                                                                        |
| `src/build.ts`         | `buildPartner` (`DEFAULT_CONFIG`, D111; the query planner serving, D33; `models`: a `CardEnricher` and an `AskReader`, each with its own `Budget` and one shared `TenantSpend` cap; no judge; starts the sync timer), `startGatePool` (`EDEN_GATE_WORKERS`, D26) |
| `src/models.ts`        | `modelRolesFromEnv`: the reader (throughput-routed) and card models (price-routed, retried on default routing) on `EDEN_MODEL` (default `anthropic/claude-haiku-5.5`) through OpenRouter, all null without `OPENROUTER_API_KEY`; `EDEN_MODEL_USD_PER_TENANT_DAY` (default 25) |
| `src/config.ts`        | `loadConfig`: every `EDEN_*` variable validated at startup with a message naming it; `stdioSourceMapPath` (one source-map file per tenant/user under `$EDEN_HOME/mcp-stdio`, or `EDEN_SOURCE_MAP`)                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/engine-config.ts` | `engineConfig`: `EDEN_ENGINE_CONFIG`, a JSON file of `EngineConfig` keys over the default (D103, D111); unknown keys, wrong types, out-of-range numbers (`RANGES`) and unknown `anticipateOff` parts stop startup; the checks are @eden/engine's `checkEngineConfig`, called with both deps wired and without its parent-flag check; `docs/profiles/minus-*.json` (each exactly a `PARTS` entry) are parsed by its test |
| `src/mcp.ts`           | `createMcpServer`: one `ask_context` tool (the standard description)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/mcp-stdio.ts`     | One user's `ask_context` over stdio (`EDEN_TENANT`, `EDEN_USER`, `EDEN_SOURCES_FILE`); persists its source map per user, falling back to an in-memory map (logged to stderr) when the file cannot be opened (`openSourceMap`); warms the gate before connecting                                                                                                                                                                                                                                                                                                                                                                      |
| `src/connectors.ts`    | `staticSources`/`staticResolver` (`EDEN_SOURCES_FILE`, static and shared by every user); `sourcesFromEnv` (adds `UserSources` when `EDEN_USER_SOURCES_FILE` is set)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `src/user-sources.ts`  | `UserSources` (D108): per-(tenant, user) sources from a `SourceDirectory` (`fileDirectory` for `EDEN_USER_SOURCES_FILE`, or an embedding's vault), MCP connections cached per scope and closed on forget, idle (15 min), the per-tenant cap (10,000 users), a changed spec, or a directory error or timeout (5 s); `checkSpecs`                                                                                                                                                                                                                                                                                                      |
| `src/main.ts`          | `bun run dev`; passes `EDEN_MAX_BODY_BYTES` to `Bun.serve` as `maxRequestBodySize`; warms the secret gate (`warmGate`) before listening and logs `startup N ms`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Rules that apply here

- **Never 500 on caller input (CLAUDE.md).** Malformed input is a 4xx with `{error}`; an engine failure is 503
  ("temporarily unable to serve context"), which an integration treats as silence. Validation lives in
  `@eden/protocol`; anything it lets through that the engine cannot take is a protocol bug (see the audit regressions
  in `http.test.ts`).
- **Isolation (D9).** A body naming another tenant than its key is refused. Every route passes the scope through;
  the only per-user state held here is `UserSources`' connections, keyed by scope (D108).
- **One product (D111).** The servers run `DEFAULT_CONFIG`; `EDEN_ENGINE_CONFIG` names settings over it (usually a
  `minus-<part>` profile). Unset, the partner's config deep-equals `DEFAULT_CONFIG` (`engine-config.test.ts`). Never
  import presets from `@eden/sim` here, and do not read lab options (`allowLogging`, Anthropic models) from the
  environment.
- **Model roles only with a key (D111).** `modelRolesFromEnv` builds the card and reader models only when
  `OPENROUTER_API_KEY` is set; without it `buildPartner` builds no `CardEnricher` and no `AskReader`, and the same
  default runs its no-model path. Every role goes through its own `Budget` and the tenant's shared daily cap
  (`TenantSpend`); a new role needs a decision and a docs/COST-MODEL.md entry. No judge is wired.
- **Sync reads per-user listable sources (D108, D111).** Static sources have no list tool and list nothing; a user's
  MCP source with a `listTool` is synced for that user only (`engine-config.test.ts`, sync over per-user sources).
- **Credentialed sources are per user (D108).** `EDEN_SOURCES_FILE` is shared by every tenant and user, so it holds
  static documents only (an entry without `docs` stops startup). MCP sources go in `EDEN_USER_SOURCES_FILE` or an
  embedding's `SourceDirectory`, through `UserSources`: built per scope from that scope's spec, cached per (tenant,
  user, source id), never shared. A new piece of per-user source state is keyed by scope, torn down by `forget`, and
  gets a two-user test in `user-sources.test.ts`. A user's broken config leaves them the shared sources and is a
  422 on `/v1/sources`, never a 5xx. Caps on per-user state are per tenant, so one tenant cannot evict another's.
- **Warm the gate before serving.** The secret gate compiles its ~230 rules on first use; `warmGate()` moves that to
  startup. Measured (3 runs each, `bun packages/engine/bench/pipeline.bench.ts 1500 300`, with and without a preload
  calling it): event #0 49.3/46.1/36.7 ms cold vs 9.6/14.2/12.6 ms warm; warm-up lag max 71.8/69.7/56.2 vs
  57.6/43.8/41.4 ms. First `sanitizeForStore` in a fresh process 36-44 ms cold vs 1.0-1.8 ms after `warmGate` (64-92
  ms at startup instead). Gate workers (D25) warm too: `startGatePool` passes `warm: "warmGateItem"`, which every
  worker (a replacement too) runs before it is ready. Measured (scratch script, 3 runs, `startGatePool(2)`, 4 items of
  ~3 KB with keywords): first batch 45.6/51.3/74.9 ms before vs 5.2/6.0/13.8 ms after (steady state 1.4-2.4 ms); pool
  start 36-50 ms before vs 155-182 ms after (the cost moves to startup). Never warm at the top level of
  `engine/src/gate.ts` (every importer, the main thread included, would pay).
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
                                 # and per-user ones from EDEN_USER_SOURCES_FILE (D108)
```

## Where next

`docs/INTEGRATION.md`, `docs/PRIVACY.md`, `packages/client` (the caller), `packages/sim/src/server.ts` and
`bun run sim:perf` (the real server under simulated agents).
