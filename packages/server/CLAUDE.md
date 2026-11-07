# @eden/server

Eden as a service: the HTTP API (tenant API keys, per-tenant GCRA rate limit), the MCP `ask_context` server (HTTP
wiring and stdio), configuration from the environment, and `buildPartner`, which wires the engine with the unified default (D112) and
its model roles.

## Files

| File                   | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/http.ts`          | `createHandler`: `/v1/events` (`?waitMs=`, clamped 0–5,000), `/v1/ask`, `/v1/check`, `/v1/pending`, `/v1/whoami` (the client's `health()`: checks the key and ids, changes nothing), `/v1/explain` (the session's last decisions with `explainTrace`'s sentence each, content-free, D277), `/v1/feedback`, `/v1/forget` (also closes the user's source connections), `/v1/sources` (the user's sources, 422 for a broken config, D108), `/v1/sources/changed`, `/v1/sources/items` and `/v1/sources/removed` (change notifications, their items and deletions, `syncPush`, D125/D126; checked by `@eden/protocol`'s `checkSourceChanged`/`checkSourceItems`/`checkSourceRemoved`), `/healthz`; auth (the key fixes the tenant; dev mode accepts a missing key, never a wrong one); 429 with Retry-After past the tenant's rate; 413 when the declared content-length passes `maxBodyBytes` (D100)                                                                                                                     |
| `src/build.ts`         | `buildPartner` (`DEFAULT_CONFIG`, D112; `processes` divides the tenant spend cap, `tenantSpendFor`, D163; the query planner serving, D33; `models`: a `CardEnricher` and an `AskReader`, each with its own `Budget` and one shared `TenantSpend` cap; no judge; starts the sync timer), `startGatePool` (`EDEN_GATE_WORKERS`, D26)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `src/models.ts`        | `modelRolesFromEnv`: the reader (throughput-routed) and card models (price-routed, retried on default routing) on `EDEN_MODEL` (default `anthropic/claude-haiku-5.5`) through OpenRouter, all null without `OPENROUTER_API_KEY`; `EDEN_MODEL_USD_PER_TENANT_DAY` (default 25)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `src/config.ts`        | `loadConfig`: every `EDEN_*` variable validated at startup with a message naming it; `stdioSourceMapPath` (one source-map file per tenant/user under `$EDEN_HOME/mcp-stdio`, or `EDEN_SOURCE_MAP`); `EDEN_PROCESSES` (1-64, default `machineCores()` capped at 64: the core count, lowered to a cgroup v2 `cpu.max` quota, D178; 1 on a one-core machine; a child is always 1) and `EDEN_ROUTER_CHILD` (a child divides the tenant rate and burst by N), `childSourceMapPath`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `src/engine-config.ts` | `engineConfig`: `EDEN_ENGINE_CONFIG`, a JSON file of `EngineConfig` keys over the default (D103, D112); unknown keys, wrong types, out-of-range numbers (`RANGES`) and unknown list entries stop startup; the checks are @eden/engine's `checkEngineConfig`, called with both deps wired and without its parent-flag check; `docs/profiles/minus-*.json` (each exactly a `PARTS` entry) are parsed by its test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `src/mcp.ts`           | `createMcpServer`: one `ask_context` tool (the standard description); a new session id after 2 h with no ask or at UTC midnight, the old one ended (D281)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `src/mcp-stdio.ts`     | One user's `ask_context` over stdio (`EDEN_TENANT`, `EDEN_USER`, `EDEN_SOURCES_FILE`); persists its source map per user, falling back to an in-memory map (logged to stderr) when the file cannot be opened (`openSourceMap`); warms the gate before connecting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/connectors.ts`    | `staticSources`/`staticResolver` (`EDEN_SOURCES_FILE`, static and shared by every user; every entry checked by `checkSpecs` as static, `SourceConfigError` naming the entry); `sourcesFromEnv` (adds `UserSources` when `EDEN_USER_SOURCES_FILE` is set); `sourcesOrExit` (both servers: a bad sources file prints one line, no stack, and exits 2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `src/user-sources.ts`  | `UserSources` (D108): per-(tenant, user) sources from a `SourceDirectory` (`fileDirectory` for `EDEN_USER_SOURCES_FILE`, or an embedding's vault), MCP connections cached per scope and closed on forget, idle (15 min), the per-tenant cap (10,000 users), a changed spec, or a directory error or timeout (5 s); `checkSpecs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `src/main.ts`          | `bun run dev`; with `EDEN_PROCESSES` > 1 it starts the router instead, and as a router child (`EDEN_ROUTER_CHILD`) passes `processes` to `buildPartner`, logs its divided caps and reports its port over IPC; passes `EDEN_MAX_BODY_BYTES` to `Bun.serve` as `maxRequestBodySize`; warms the secret gate (`warmGate`) before listening and logs `startup N ms` and the shared source count                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `src/trace-report.ts`  | `bun run trace-report [log …] [--json]` (D279): an integrator's self-check over an `EDEN_TRACE=1` log (decisions, silent reasons, time per decision p50/p95/p99, source and model calls per event, request-time spend); background cards and intent are not traced |
| `src/router.ts`        | The multi-process router (D113, D163): `startRouter`/`runRouter` spawn N `main.ts` children (each `PORT=0`, its own `source-map.<i>.db`), route each request by `childFor(tenant, userId, N)` (tenant from the key, `userOf` parses the body's top-level `userId`), forward the bytes unchanged, answer `/healthz` (200 while any child is up, 503 when none is) and an oversized declared length themselves, send `/v1/forget` to every child (owner's answer, 503 if any failed), return 503 for a dead child and restart it (1 s, doubling to 30 s), give every start (restarts too) a `startTimeoutMs` deadline after which the child is SIGKILLed and retried (D172); `rehomeSourceMaps` merges source-map files no child of the current N opens into the current set and deletes them (router before its children, `main.ts` before `buildPartner` with one process); `bench/router.bench.ts` is its gate |

## Rules that apply here

- **Never 500 on caller input (CLAUDE.md).** Malformed input is a 4xx with `{error}`; an engine failure is 503
  ("temporarily unable to serve context"), which an integration treats as silence. Validation lives in
  `@eden/protocol`; anything it lets through that the engine cannot take is a protocol bug (see the audit regressions
  in `http.test.ts`).
- **Isolation (D9).** A body naming another tenant than its key is refused. Every route passes the scope through;
  the only per-user state held here is `UserSources`' connections, keyed by scope (D108).
- **One product (D112).** The servers run `DEFAULT_CONFIG`; `EDEN_ENGINE_CONFIG` names settings over it (usually a
  `minus-<part>` profile). Unset, the partner's config deep-equals `DEFAULT_CONFIG` (`engine-config.test.ts`). Never
  import presets from `@eden/sim` here, and do not read lab options (`allowLogging`, Anthropic models) from the
  environment.
- **Model roles only with a key (D112).** `modelRolesFromEnv` builds the card and reader models only when
  `OPENROUTER_API_KEY` is set; without it `buildPartner` builds no `CardEnricher` and no `AskReader`, and the same
  default runs its no-model path (the push's candidates included: they make no model call, D276). Every role goes through its own `Budget` and the tenant's shared daily cap
  (`TenantSpend`); a new role needs a decision and a docs/COST-MODEL.md entry. No judge is wired.
- **Sync reads per-user listable sources (D108, D112).** Static sources have no list tool and list nothing; a user's
  MCP source with a `listTool` is synced for that user only (`engine-config.test.ts`, sync over per-user sources).
- **Credentialed sources are per user (D108).** `EDEN_SOURCES_FILE` is shared by every tenant and user, so it holds
  static documents only (an entry without `docs`, a bad or duplicate id, or a non-string doc field stops startup
  with exit 2). MCP sources go in `EDEN_USER_SOURCES_FILE` or an embedding's `SourceDirectory`, through `UserSources`: built per scope from that scope's spec, cached per (tenant,
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
- **Several processes (D113, D163, D178).** `EDEN_PROCESSES` unset (or empty) is the core count (`machineCores`:
  `os.availableParallelism()`, lowered to a cgroup v2 `cpu.max` quota when one is set, capped at 64): the router over
  that many children, since D172's gate passed on the merged tree (below). Bun 1.4.4's `availableParallelism()`
  already honours CPU affinity and a cgroup v1 quota (on 4 cores: 1 under `taskset -c 0`, 1 under a 1-CPU v1 quota,
  2 under 2.5 CPUs); v2 is read by `cgroupCpuQuota` because it could not be checked on this v1 host. Containers
  should still set `EDEN_PROCESSES` explicitly (docs/INTEGRATION.md, "Processes and per-tenant caps"): a quota the
  container cannot see, or a memory limit, is not detected. A one-core machine, and an explicit
  `EDEN_PROCESSES=1`, is one process with no router; a router child (`EDEN_ROUTER_CHILD`) is always 1. Each child
  holds 1/N of every per-tenant cap, so under the default a tenant whose traffic comes from one user gets $25/N a
  day, 200/N rps and a burst of 400/N ($6.25, 50, 100 on 4 cores); the operator docs (README, INTEGRATION.md,
  COST-MODEL.md) say so and tell such tenants to raise the caps or run 1. `scripts/test-preload.ts` clears `EDEN_*`,
  so every test or bench that spawns `main.ts` and needs one process sets `EDEN_PROCESSES=1` itself
  (`connectors.test.ts`, the example's `agent.test.ts`, the bench's single arm); otherwise each start spawns a child
  per core. Each process costs memory: idle, one process was 67.0-67.5 MB RSS against 325 MB summed over the router
  (55 MB) and its 4 children (66.6-68.1 MB each), two runs each (`ps -o rss` 3 s after `listening`, `EDEN_DEV=1`, no
  sources; shared pages are counted in each). Above
  1, a user's state lives only on the child `childFor` names, so anything new that is per user must stay keyed so
  (never routed by session or at random), and any new per-tenant cap must be divided by N in the child, as the rate,
  burst (`loadConfig`) and spend cap (`buildPartner`'s `processes`) are, or N children raise it N-fold. Each child
  writes its own source-map file; never point two children at one. The router answers only `/healthz`, an oversized
  declared length (413) and a dead child (503); every other answer, auth included, is the child's.
  Every start of a child has its own deadline (`startTimeoutMs`, default 30 s, D172): a restart that hangs before
  reporting its port is killed and retried with the same backoff, never left holding its users at 503; a first start
  past it fails `startRouter` and leaves no process. The router tests start real child processes: `router.test.ts`
  holds the pure tests and the shared two-child router (routing, forget, auth, dead child 503);
  `router-processes.test.ts` holds the tests that start routers of their own (divided burst, a child that cannot
  start, N 2 -> 3 -> 2, the hanging restart) and runs them with `test.concurrent` (each has its own temp dir and
  router), so `--parallel` runs the two files side by side: 1.70-1.76 s for both against 2.56-2.65 s for the one
  file before (3 runs each, load average 5-6). Do not move a router-starting test back into the first file. The gate is `bun packages/server/bench/router.bench.ts` (events/s at
  a fixed observe p99, one process vs the router over 1 and N children; trial row in docs/DECISIONS.md). Its source
  is an in-process 400-doc `StaticSource`, whose search is much of each event's CPU, so the figure moves when
  StaticSource does. One run is noise (1.32-3.70 on one tree, D172): it runs each arm at least 3 times (5th argument,
  default 3), rotating the arm order every repetition, 5 s steps by default, and reports per-arm median, min and max,
  each repetition's ratio, `medianRatio` and `lowestRatio`; D172's bar to make N > 1 the default is median >= 1.5x
  with the lowest >= 1.2x on 4 cores (`meetsD172`). It held on the merged tree (D178; `... 4 5 100 0 3`, 4 cores,
  load average 0.15): single 1,122 ev/s, router over 4 children 3,713 (medians), ratios 3.26/3.35/3.18 (median
  3.26, lowest 3.18), hop ratio 1.02; before the StaticSource fix single 378 and router 1,302, median 3.44, lowest
  3.36. So the default became the core count. Re-run on this change (the single arm now sets `EDEN_PROCESSES=1`,
  load average 1.25 at start): single median 1,169, router over 4 children 3,759, ratios 3.48/3.22/3.23 (median
  3.23, lowest 3.22), hop ratio median 0.95.
  The same gate on simulated users (per-user connectors, sync, real latency) is
  `packages/sim/src/lab/router-sim.bench.ts`: 5.96x on REALISTIC and 3.36x on hosted latency (D172's outcome); its
  children keep their own heaps, about 650 MB of user state per 100 users there, so plan memory per child.
- **Changing N reshuffles users (D163).** Their in-memory state starts over on their new child and their old
  child's source-map rows are no longer read, but they still hold entity names: `/v1/forget` therefore goes to every
  child (a 503 unless all succeed), and `rehomeSourceMaps` moves rows out of files no process of the new N opens
  (`source-map.db` when N > 1, `.<i>` for i >= N, all `.<i>` when N = 1) before anything opens them, then deletes
  those files; an unreadable one stops the start. Any new per-user file must get the same treatment.
  `/healthz` stays 200 while any child is up (`up` < `processes` is degraded); load balancers use it.
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
