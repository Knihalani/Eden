# Tech audit (2026-11-12)

This audit reviewed every technical choice in the repository against one bar: switch only where an alternative is at
most medium effort and gives a clear, measurable gain in speed, cost, security, reliability, maintenance or the number
of dependencies. Each choice was checked against docs/DECISIONS.md and docs/DEAD-ENDS.md first, and nothing measured and
decided was reopened without new evidence. Every number below comes from a command run in this session, or is labelled
with the decision it comes from. Decisions: D1600, D1700, D1702, D1704 (switches), D1701 and D1703 (this audit's findings).

**Method and its limits.** Two passes. The first, below as the inventory, went module by module. For each package and
directory it read the package's `CLAUDE.md` file table and the README (the files, and the choices each one makes, with
the decisions that measured them), and the imports, `package.json` and lockfile. Code was read where a choice could be
switched: the Dockerfile, `.dockerignore`, the compose files, cloud-init, OpenTofu, the backup script, Alloy,
`blob-store.ts`, `persist.ts`, the type-check, format and test scripts, and `tsconfig`. The repository holds about
250,000 lines outside `archived/`: engine 57.6k, sim/src 90.8k, sim/lab 33.2k (251 Python files), primitives 17.3k. Most
of those lines are lab or engine logic whose choices are behavioural and have their own decisions. For them this audit
records the technical substrate (data structures, formats, concurrency), not each heuristic. The registry versions were
read from registry.npmjs.org on 2026-11-12. `archived/` is history and was not reviewed (CLAUDE.md).

The second pass went file by file over the 1,420 source and data files under `packages/`, `scripts/`, `deploy/`,
`examples/`, `bench/` and `native/`. Results under `bench/runs/` and the lab's `.txt`, `.jsonl`, `.gz` and `.md`
outputs were left out as data. A script read every file and recorded three things:

- its header comment;
- its imports;
- counts of the patterns that mark a technical choice: synchronous file I/O, timers and whether they are `unref`'d,
  regular expressions built per call, `await` inside loops, deep copies, crypto, compression, typed arrays, SQLite,
  subprocesses and empty `catch` blocks.

The files those counts flagged were then read at the flagged lines, together with every file the tables below name.
That covers the timers in `cache.ts`, `partner.ts`, `cluster.ts` and `user-sources.ts`, every `await` in a loop in
the engine, sync, client and proxy, the per-call patterns, `gloss.ts`, `persist.ts`, the router, the cluster and the
deploy kit. The appendix gives one line per file. Its verdict quotes the decisions that the package's `CLAUDE.md`
names beside the file, or else those the file cites most.

This pass is not a line-by-line reading of the 250,000 lines. A choice the scan has no pattern for (a heuristic, a
threshold, a prompt) was reviewed at the design level under "Product design choices", against its decisions.

## Switches made

| PR | Decision | Change | Measured benefit |
|---|---|---|---|
| #333 | D1600 | The server image runs on `oven/bun:1.4.4-distroless`, with a two-stage build. It runs as uid 1000, so old volumes stay writable. HEALTHCHECK and CMD are in exec form | 430 → 260 MB on disk, 118 → 72.3 MB compressed. Debian packages 80 → 14 status entries. No shell, so `/bin` has no entries (was 261) |
| #335 | D1700 | `.dockerignore` leaves out `packages/sim` (except its package.json), `*.test.ts` and `packages/*/bench`. A test walks the servers' imports | 260 → 230 MB on disk, 72.3 → 65.5 MB compressed. No lab or paid-run script in the production image |
| `claude/own-mcp` | D1704 | Eden's own MCP client, streamable HTTP transport, `ask_context` server and stdio transport (`packages/sources/src/mcp/`, `server/src/mcp.ts`, `stdio-transport.ts`) replace `@modelcontextprotocol/sdk`, which with zod becomes a devDependency (tests and the lab keep it as the reference implementation). Bounded: per-POST deadline, 16 MiB reply cap, shape check before `JSON.parse`, same-origin redirects, only the POSTed id's response taken | Production install 93 packages, 31 MB `node_modules` → 1 package (re2js), 940 KB. Image 230 → 196 MB on disk, 65.3 → 61.8 MB as `docker save \| gzip`. On the same SDK server (two runs), `callTool` p50 279 / 246 → 222 / 222 µs (JSON) and 298 / 456 → 227 / 302 µs (SSE), RSS 59.1 / 58.9 → 50.7 / 49.9 MB (`bench/mcp-client.bench.ts`). The connector lab (memory, mcpvault) reports identically to the SDK client's apart from latency |
| #338 | D1702 | A node's cloud-init loads a DOCKER-USER rule through ufw's `after.rules`: port 8790 only from the private range. A test renders every role's cloud-init as YAML | In network namespaces, a peer that routed to the node's private IP from another interface got Eden's answer before and was dropped after. The private peer was served both times. The test caught an unquoted runcmd entry that parsed as a mapping |

Together: **430 → 230 MB (−47%) on disk, 118 → 65.5 MB (−44%) to pull** (before D1704, which takes the image to
196 MB on disk). The attack surface also shrinks: no shell, no
apt, no coreutils, no lab code. Both images were checked as follows:

- Docker's health check reads `healthy`.
- `/readyz` reports 2 of 2 children up under `EDEN_PROCESSES=2`.
- `eden doctor` runs.
- A volume written by the old image is read and written by the new one.

## Candidates not switched

| Candidate | Gain | Why not now |
|---|---|---|
| `typescript` 7.0.2 (stable, released 2026-07-08) replacing `@typescript/native-preview` 7.0.0-dev.20260707.2 and `typescript` 5.9.3 | One checker instead of two devDependencies (−23.6 MB unpacked for 5.9.3), and a stable release instead of a dev snapshot | `scripts/check-line-length.ts` and `packages/client/pack.ts` use TypeScript 5's JS compiler API (`import ts from "typescript"`), which TypeScript 7 does not ship (its package is a 2.5 MB native shim). Both names cannot be `typescript`. Needs: those two scripts moved off the JS API, or an aliased install, then `typecheck:parity` |
| `hashicorp/aws` provider in `deploy/tofu/hetzner`, used for one bucket on Hetzner Object Storage, replaced by a small S3-compatible provider (e.g. `aminueza/minio`) | `tofu init` downloads far less: the AWS provider is several hundred MB [unverified here: not downloaded in this session] | Effort is small, but it cannot be checked here. Hetzner's lifecycle rule (the 7-day expiry, D428) must be applied against a real account. DEPLOY.md §12 already lists lifecycle as not validated. Needs: a Hetzner Object Storage account and `tofu apply` |
| The model route: OpenRouter → Anthropic's API directly for `anthropic/claude-haiku-5.5` | Removes one intermediary that sees prompts (OpenRouter runs ZDR and `data_collection: deny`, D12). Removes OpenRouter's fee on credit purchases [unverified here] | Paid calls, plus a privacy and routing decision. Throughput routing (`sort`, D66) and the OpenRouter-only ZDR guarantees would need equivalents. The lab already speaks Anthropic directly (`AnthropicModel`, D97). Needs: a paid A/B under a cap and an owner decision; the D1196 cache probe is pending on the same route |
| `re2js` 2.9.0 → 2.10.0 | Unknown: no changelog found | Released 2026-11-10, two days before this audit. Nothing measured. Needs: `bun packages/redact/bench/*` and the gate's warm/cold numbers before and after |
| `prettier` 3.9.9 → 3.10.1 | None measured | A formatter bump reformats nothing measurable for speed; the content-addressed set (D819) makes cold checks cheap already. Take it with the next deliberate tooling bump |
| A faster formatter (Biome, oxfmt) in place of Prettier | Format check speed | Prettier is not the slow step of the gate: the cold check ran 138-161 s here, dominated by tests (scripts/check.sh runs all three at once), and D819's known-formatted set skips unchanged files. A switch rewrites formatting across the repository, and Biome does not format Markdown. No clear gain |
| Bun `--smol` for the server | Memory per user | Measured and did nothing (docs/research/INDEX.md, the disk-only frozen-user trial's line). Not reopened |
| Rust kernels (tokenizer, secret gate) through FFI, napi or WASM | Speed | D22, measured in `native/`: the kernels stay TypeScript. Not reopened |
| Docker's `local` log driver in place of `json-file` | Smaller rotated logs (compressed) | Eden's logs are content-free count lines, small at the 20 MB × 5 cap, and Alloy reads the json-file logs (config.alloy). No measurable gain |
| Pin base images by digest (`oven/bun`, `caddy`, `seaweedfs`) | Reproducible builds, an immutable base | A real gain, but Dependabot and CI are off (CLAUDE.md), so digests would go stale silently. Needs: an owner's call on who bumps them |
| Read the request glossary (`gloss.bin`) as bytes instead of gzip-of-JSON into strings (`gloss.ts`) | Memory per process. Measured here: retained heap +3.5 MB, but steady RSS +15.5-18 MB a process 1.5 s after the load (3 runs). Building the English set without regex match objects changed nothing (+15.8-18.2 MB), so the parse's garbage is the cost. The gain is about 15 MB × N router children, since every child loads it (D1153) | An engine change with a format change in the lab's packer (`gloss-pack.ts`). D1153 accepted +29 MB at promotion. The gain is real but small beside 2-3.4 MB a user. Experiment: pack each language as a sorted UTF-8 byte arena with offsets and look words up by byte comparison. Bar: steady RSS −10 MB a process (median of 3), load ≤ 118 ms, and `glossOf` identical on `gloss.test.ts` and on every reworded request of train and dev20. **Done (D1710):** sorted UTF-8 keys with binary search, a prefix (function words, English words, keys' Bloom filters) read at the load and the lexicons on first need, CRC-32 checked; identical on every glossary word, 50,000 fuzzed requests and the review's 716,634 inputs; in a process that has served, +11.05 → +3.06 MB RSS with the lexicons read, +0.77 MB English-only (contractions included); bare process +16.77 → +12.51 MB (anonymous 8.82 → 4.28; the rest is Bun's shared code pages); load 68 → 4 ms |
| Hoist the per-call regular expressions (`probes.ts` date spans, `conflict.ts:918`, `grounding.ts:103/107`, `days.ts:81`) | About 80 ns a call (a microbenchmark here: ~190 ns built per call against ~115 ns hoisted, since JSC caches the compiled pattern) | Not material. These run per candidate on the slow path, whose cost is in milliseconds (`pipeline.bench.ts`). Below the bar |
| Asynchronous writes of frozen users (`persist.ts` writes and renames synchronously, without fsync) | Event-loop stalls during freeze bursts | D425 measured it (1-3 ms a user to load). A blob is re-syncable state, so a lost write costs a re-read, not data. Experiment: `bench/storm.bench.ts` and `users.bench.ts` with an async writer. Bar: observe p99 during a freeze burst −20%, with nothing persisted lost at SIGTERM (`persist.test.ts`) |
| Pin the lab's Python dependencies (torch, numpy, lightgbm, sentence-transformers, onnxruntime: no requirements file outside `sim/modal`) | Reproducible lab runs | Lab only; nothing measures the gain. Worth doing the next time a lab track retrains a shipped model (`turn-gate.bin`) |

## Owed checks

- **CLAUDE.md's repository line** already reads `Knihalani/Eden` on main (since #331). Nothing to change.
- **arm64 image, D1600.** The distroless tag publishes linux/arm64 (`docker buildx imagetools inspect`), but this host
  has no QEMU binfmt, and installing it was not permitted here. D990's check under QEMU needs re-running on the new
  Dockerfile.

## Findings (no switch)

- **ufw does not filter Docker's published ports** (D1701; fixed for nodes by D1702, #338). Docker forwards published
  ports through its own iptables chains, which ufw's INPUT rules never see. On a node, `ufw allow from <private cidr> to
  any port 8790` is therefore not what limits access. The limit is the bind address in compose (`${PRIVATE_IP}:8790`).
  Any host on the private network reaches 8790, and Hetzner's cloud firewall (`hcloud_firewall.node`) covers only the
  public interface (Hetzner's documentation; not tested here). API keys and `EDEN_CLUSTER_KEY` still guard every route.
  This follows Docker's documented behaviour. D1702 then showed it in network namespaces: a peer that routed to the
  private address from another interface reached Eden. The node's cloud-init now drops port 8790 from outside the
  private range in DOCKER-USER. Single boxes and routers publish 8790 on loopback only.
- **AES-256-GCM with random 96-bit nonces under one derived key** (`persist.ts`). This is sound up to about 2^32 writes
  per key (NIST SP 800-38D). At 1,000 frozen-user writes a minute, one key reaches that in about 8 years. Rotating
  `EDEN_PERSIST_KEY` resets the count. Recorded so a much busier deployment knows the bound. The header and scope are
  bound as AAD, and file names are a keyed HMAC.

## Product design choices

These choices are reviewed at the same bar. Each is kept with the decision that measured it, switched, or left as a
candidate with the evidence it needs. None was switched: every one is a measured decision, and no new evidence came up
in this session. Where a better design would need a live or paid A/B, the experiment and its bar are written out here
instead of being built.

### Architecture

| Choice | Verdict |
|---|---|
| Item content in memory, per user, with a TTL and a size bound; only content-free metadata in SQLite | keep (D8; D4) |
| Idle users frozen into one zstd blob, warm after 2 min and compact after 30, thawed exactly on next use | keep (D325, D860, D862); `--smol` measured as no help; a binary layout of the blob measured and rejected (D1715: at most 11% smaller, the compact thaw is indexing) |
| Frozen users persisted encrypted on disk by default; a key that opens none stops the start | keep (D425, D991, D1071). Async writes are a candidate (above) |
| One process per core behind a local router, placed by jump hash over 65,536 buckets, per-tenant caps divided by N | keep (D113, D163, D172, D178): 3.2x events/s at a fixed p99 on 4 cores |
| Cluster: rendezvous placement of buckets over nodes, the S3 store as the hand-off, epoch fencing, the whole tenant rate at the cluster router | keep (D992-D995, D1070) |
| Ingest off the event loop (a worker per page) | rejected earlier (D216): 1.46x capacity at 1.19x CPU, worse on router-sim |
| Card state left live while a user is frozen | keep (D998: freezing it missed its rule) |

### Retrieval

| Choice | Verdict |
|---|---|
| Per-user BM25F over a packed CSR index plus delta; fused tokenizer with interning | keep (D20, D111, D861); ask depth top 12 (D162) |
| Tokenizer and kernels in TypeScript | keep (D22) |
| Embedding retrieval beside the lexical pool | rejected earlier (D450, D451, D1150, D1151): it raises look-alikes as much as facts |
| Turn gate: int8 hashed n-gram bag, 43 µs a turn, loaded once | keep (D1014, D1015) |
| Implication cards and the intent index on Haiku, read best first in up to four lanes | keep (D59, D87, D482, D521, D1062). A GPU card model pays only as a busy shared service (D447); no batch tier (D146, D242) |
| The rule sheet in the push check | keep (D1180, D1183, D1197) |
| Request gloss for 26 languages, no model | keep (D1153); answered from the file's bytes, lexicons read on first need (D1710) |
| No-model delivery bar (`confidentScore` 1.1, whole-word entity, coverage) | keep (D3, D6, D34) |
| Candidates' re-rank with no model, shorter excerpts, k 3 | rejected earlier (D258, D259, D266) |

### Model use

| Choice | Verdict |
|---|---|
| One model, `anthropic/claude-haiku-5.5` through OpenRouter with ZDR and `data_collection: deny`; roles only with a key | keep (D12, D112). The direct route is a candidate: experiment below |
| The push check: one budgeted call a push, compare-first reply, silent when it names nothing | keep (D500, D527, D823, D828); its wording is not to change without a live screen (D822) |
| Reply formats: indexes only, everything delivered inside the data envelope | keep (D19, D221) |
| No reasoning sent by the reader, cards or check | keep (D144, D149, D155) |
| Reader's stop sequence | keep (D240) |
| Budgets per session and user-day, and one tenant cap a UTC day shared by every role | keep (D5, D112, D163, D993) |
| Anthropic cache breakpoints on the stable system prefix | trial, open (D1196): the owner's one OpenRouter probe decides it |
| `speculate` in the proxy: the turn goes upstream during Eden's wait | keep (D1273) |
| A distilled open model for cards | finding only (D445, D447): cheaper than Haiku only as a busy shared service |

**Experiment for the direct route (paid; not run).** The same shipped wiring is run twice, `bun run eval --live
--usd-cap 0.05` through OpenRouter and the lab's Anthropic transport with the reader and check on
`claude-haiku-5-5`, interleaved, 3 runs an arm. Then the Pi harness on train seeds 41-44 for wall time.

Bar to switch:
- Push-check p95 latency no worse than 5%.
- Dollars per 1,000 tasks at least 3% lower, which is the fee.
- The identical model and prompt, so no quality metric may move beyond run noise.
- An owner's decision on the provider's data terms (OpenRouter's ZDR route against Anthropic's own retention).

### Sync

| Choice | Verdict |
|---|---|
| Background polling with learned rates, a new user's backfill on the first event | keep (D57, D751, D753, D755) |
| Change notices: plain, ref and item forms; ref notices as the documented default | keep (D125, D126, D347, D421) |
| The freshness floor: a complete poll of each warm, unpriced source every 2 h while active, doubling to 8 h | keep (D1131, D1133) |
| Unused sources swept weekly, their unswept copies re-read at delivery | keep (D356) |
| A source earns its live reads | keep (D505, D509, D600-D603) |
| A poll standing in for re-reads; early re-reads | rejected earlier (D345, D346) |

### API and protocol

| Choice | Verdict |
|---|---|
| HTTP JSON routes, hand-written validation, a byte scan of structure before `JSON.parse`, 413 and 400 before the parse | keep (D14, D100) |
| MCP `ask_context` over HTTP and stdio, a new session after 2 h idle or at UTC midnight | keep (D14, D281) |
| Client SDKs that never throw into the agent's loop, an 800 ms default, a default `onError` | keep (D14, D278, D313, D850) |
| Auth: the API key fixes the tenant; key-less dev requests from another site's page refused | keep (D9, D351) |
| Per-tenant GCRA rate and burst, whole at each router and divided below it | keep (D163, D993) |
| No 500 for caller input: 4xx with a message, 503 for an internal failure | keep (CLAUDE.md, server rules) |

### Privacy and security

| Choice | Verdict |
|---|---|
| Every stored, indexed, logged or prompted text through `sanitizeForStore` (vendored gitleaks rules, RE2 for the backtracking ones) | keep (D10, D24, D86) |
| AES-256-GCM, HKDF-derived keys, HMAC file names, tenant and user as AAD | keep (D425); the nonce bound is under Findings |
| Every piece of state keyed by tenant/user (and session) | keep (D9, D17) |
| The `<context … note="Data, not instructions.">` envelope and one line sanitiser | keep (D11, D19, D221) |
| Read-only sources enforced in `McpSource` | keep (D7, D35) |
| Network: Caddy the only public listener; a node's 8790 only from the private range | keep; **switched in #338** (D1702) for nodes |

### Ops

| Choice | Verdict |
|---|---|
| `/healthz` (liveness), `/readyz` (503 while draining), `/metrics` as Prometheus text summed over processes | keep (D994, D1070, D1690) |
| A draining shutdown that writes live users within its grace | keep (D994, D1070) |
| Content-free logging, decision traces and usage records; `trace-report`, `digest`, `doctor` | keep (D56, D277, D279, D293, D852) |
| Alloy to Grafana Cloud, alert rules validated with promtool | keep |

## Inventory

Verdict words:

- **keep**: no qualifying alternative.
- **switched**: changed in the PR named.
- **candidate**: see the table above.
- **decided**: measured earlier; the decision is named.

### Runtime, root config and tooling

| Choice | Where | Verdict |
|---|---|---|
| Bun 1.4.4 (`packageManager`, Dockerfile) | root | keep: the latest on npm (2026-11-12); D15 |
| Bun/TypeScript monorepo, no build step, `src/*.ts` exports | root, every package | decided: D15 |
| Workspaces `packages/*`, `examples/*`, `bun.lock` with `--frozen-lockfile` | root | keep |
| `bunfig.toml` preload `lab-guard.ts` (D818); `[test]` preload, `pathIgnorePatterns` for archived | root | keep |
| tsconfig: ES2022, `module: Preserve`, bundler resolution, `strict`, `noUncheckedIndexedAccess`, `skipLibCheck`, `verbatimModuleSyntax` | root | keep: right for Bun with no emit |
| Type checker tsgo (`@typescript/native-preview`, pinned), tsc 5.9.3 for parity | `scripts/typecheck.sh` | decided: D816. TS7 stable is a candidate (above) |
| Incremental build info seeded across worktrees | `scripts/typecheck.sh` | keep: measured in its comments, a new worktree's first check 9.6-11 s cold against 3.1 s seeded |
| Prettier 3.9.9, `printWidth` 120, with a content-addressed known-formatted set | `scripts/format.sh` | keep: D819. Bump or switch are candidates (above) |
| 120-column check on the TS scanner | `scripts/check-line-length.ts` | keep: it closes Prettier's comment and literal gap |
| `bun test --parallel`, slowest first, a tail of timing tests (D811), a content-addressed pass cache (D650, D657), dependents' selection (D161) | `scripts/test*.ts`, `test.sh` | keep: measured in docs/TESTING.md |
| Gate runs format, types and tests at once | `scripts/check.sh` | decided: D811 |
| Decision index generator | `scripts/decision-index.ts` | decided: D812 |
| Publish dry runs (npm pack, PyPI build, Docker) | `scripts/publish-check.ts` | decided: D853 |
| `@types/bun` (resolves 1.4.4) | root | keep: matches the runtime |

### Shipped packages

| Package | Choices | Verdict |
|---|---|---|
| protocol | Hand-written validators returning `{ok,error}` (no zod on the wire); `bodyShapeUnder` byte scan before `JSON.parse` (D100); ids and `scopeKey` | keep: a schema library would add a dependency to the hot path |
| primitives | Fused tokenizer with interning into `Uint32Array`; FNV-1a, murmur3, native xxHash32; Aho–Corasick DFA; typed-array top-k heap; S3-FIFO cache; GCRA; breaker; AIMD; log-linear histograms; packed CSR BM25F index; SimHash/MinHash/LSH; xoshiro128; Thompson bandit; Bun `WorkerPool` | decided: D20, D22, D25. Each has a benchmark, and `bench/compare/*` ran head-to-heads against npm libraries |
| redact | Gitleaks rules vendored byte for byte; the seven backtracking rules on `re2js` (D24); structural JSON redaction | decided: D24. `re2js` bump is a candidate |
| sources | `McpSource` on Eden's own MCP client (D1704; read-only check, D7); arguments from JSON schema; Thompson-sampled query planner; per-(user, source) breaker, AIMD, GCRA and singleflight; `StaticSource` inverted index | switched: D1704 (was the MCP SDK's client) |
| graph | Source map on `bun:sqlite`, WAL, `synchronous=NORMAL`, busy timeout | decided: D4, D8, D15; a specialised store measured and rejected (D1720) |
| llm | `fetch` to OpenRouter (ZDR, `data_collection: deny`, D12) with `sort` routing (D66); `Budget` and `TenantSpend`; lab-only `AnthropicModel` (D97); `Pacer` | keep. The direct route is a candidate |
| engine | Per-user BM25F `ItemCache` on primitives; item text deflated (`packed-text.ts`); frozen users as zstd-3 JSON blobs, warm form "EDF2" (D325, D860, D862; a binary layout rejected, D1715); `EncryptedFrozenDisk`: AES-256-GCM, HKDF-derived keys, HMAC file names, atomic temp-file rename (D425, D991); `SharedFrozenDisk` to S3 (D992); turn gate as a `.bin` hashed n-gram table (D1014), gloss as a `.bin` of sorted UTF-8 string tables searched in place (D1153, D1710); redaction in Bun workers (D25, D26); spans and traces content-free | decided by the decisions named. GCM's write bound is under Findings |
| server | `Bun.serve`; GCRA per tenant; multi-process router over `Bun.spawn` children with jump-hash placement (D113, D163, D178); cluster router with rendezvous placement and epoch fencing (D992-D995); `/metrics` as hand-written Prometheus text (D994); Bun's built-in `S3Client` (D992, no dependency); MCP `ask_context` on a hand-written JSON-RPC handler and stdio transport (D1704; was the SDK's `McpServer` with zod); config validated at startup with exit 2 (D365) | switched: D1704 for MCP (zod went with the SDK) |
| client (TS) | `fetch`, fail open, 800 ms default (D14); `pack.ts` bundles one ESM file plus declarations | keep |
| client-python | Standard library only (`urllib`), no redirects (D278, D313); setuptools ≥ 77 build backend | keep: zero dependencies is the right floor |
| proxy | `fetch` passthrough with byte-preserving body edits (`withMessages`); OpenAI chat, Anthropic Messages and Responses routes (D280, D653, D656); `speculate` (D1273) | keep |

### Image and deploy

| Choice | Where | Verdict |
|---|---|---|
| Base image `oven/bun:1.4.4` | Dockerfile | **switched in #333**: distroless runtime stage |
| Image contents | `.dockerignore` | **switched in #335**: no lab, tests or benches |
| `bun -e fetch(...)` health check (no curl in either image) | Dockerfile, compose | keep: no binary to add on distroless |
| Build CA as a BuildKit secret, never baked in | Dockerfile | keep |
| Caddy 2.10.2: TLS from Let's Encrypt, `encode zstd gzip`, `/metrics` and `/internal/*` refused, `lb_try_duration` across restarts | `deploy/compose/single/Caddyfile` | keep |
| Compose: json-file logs at 20 MB × 5, `stop_grace_period` 40 s, loopback publish | `deploy/compose/*` | keep. `local` driver is a non-candidate (above) |
| SeaweedFS 3.97 as the local cluster's S3 (MinIO's images not pullable) | `deploy/compose/local-cluster` | keep |
| Cloud-init: Ubuntu's `docker.io` and `docker-compose-v2`, unattended-upgrades, journald limits, systemd units for compose and backup | `deploy/cloud-init` | keep |
| ufw | `deploy/cloud-init` | keep; see Findings (Docker bypasses it for published ports) |
| OpenTofu ≥ 1.8 with `hcloud ~> 1.52`, and `aws ~> 5.80` for one bucket; OCI | `deploy/tofu` | keep; the aws provider is a candidate |
| Backups: `sqlite3 .backup` (WAL-safe), tar.gz, 7-day retention (D428), optional rclone | `deploy/scripts/backup.sh` | keep: frozen files are encrypted, so zstd would gain nothing |
| Grafana Alloy (unix exporter, Eden scrape, json-file log tail) to Grafana Cloud; Prometheus alert rules | `deploy/monitoring` | keep: validated with alloy 1.11.3 and promtool 3.5.0 (DEPLOY.md §12) |
| Static checks for tofu and monitoring with no tools (python-hcl2) | `deploy/scripts/check-*.py` | decided: D997 |

### Lab, eval, examples, native, bench

| Area | Choices | Verdict |
|---|---|---|
| eval | JSON scenarios, no-model `StubReader` and `OracleReader`, own clock per scenario (D435), acting suite (D810), `--live` needs a dollar cap (D128) | keep |
| sim/src | Seeded worlds (`rng.ts`), simulated sessions and sources, perf and quality CLIs, the real server under simulated agents | keep: lab only, out of the image since D1700 |
| sim/src/lab | Pi harness (`@earendil-works/pi-ai`, `pi-agent-core` 1.3.0, devDependencies), funnel, replay caches, spend ledger, Anthropic transport (D97), lab guard (D818) | keep: standard agent per CLAUDE.md |
| sim/lab | 251 Python scripts (torch, numpy, `tokenizers`), connector-lab Dockerfiles (Radicale, CalDAV, Meilisearch, Chroma, IMAP, Gitea, mcpvault), result files | keep: research instruments; the trained models that ship are `.bin` tables read in TypeScript |
| sim/modal | Modal 1.6.3 (`requirements.txt`) for GPU training and serving | keep: lab only |
| examples | AI SDK adapter (`ai` 7.0.154, `@ai-sdk/anthropic`, devDependencies), personal agent, OAuth directory, onboarding smoke tests (D365), Hermes plugin | keep |
| native | Rust crates (`eden-native` FFI, `eden-napi`), benchmarks against TS | decided: D22; nothing imports it |
| bench | Recorded benchmark runs (`bench/runs`) | keep: data |

## Appendix: every file

One line per file, from the second pass (method above). Columns:

- **What it is**: the file's own header comment, cut to 100 characters.
- **Choices seen**: the libraries it imports from outside the workspace, and the scanned patterns it uses.
- **Verdict**: "keep" with the decisions named for it, or this audit's own finding.

### Shipped packages (`packages/*/src`, the client's `pack.ts`, the Python client) (162 files)

| File | Lines | What it is | Choices seen | Verdict |
|---|---|---|---|---|
| `packages/client-python/eden_client/__init__.py` | 565 | Eden's Python client: the same calls and the same fail-open contract as ''@eden/client'' (TypeScript | asyncio, eden_client, hashlib, inspect, urllib | keep (D14, D282, D365, D376, D420, D850) |
| `packages/client-python/eden_client/hermes.py` | 268 | Eden as a Hermes Agent plugin (D422), built on the ''hermes-eden'' arm the lab measured: Eden's ''as | , threading | keep (D14, D70, D385, D422) |
| `packages/client-python/eden_client/py.typed` | 1 | - | - | keep |
| `packages/client-python/package.json` | 9 | - | - | keep |
| `packages/client-python/pyproject.toml` | 26 | description = "Python client for the Eden context partner: report agent events, collect injections,  | - | keep |
| `packages/client/pack.ts` | 113 | 'bun run pack:client [outDir]': writes '@eden/client' as a standalone npm package (default 'dist/ede | typescript; sync fs | keep (D365); uses TypeScript 5's JS API, which blocks TypeScript 7 stable |
| `packages/client/package.json` | 10 | - | - | keep |
| `packages/client/src/client.ts` | 534 | The SDK an agent builder adds to their agent loop. Three calls cover the integration: | node:crypto; typed arrays | keep (D210, D277, D347, D421) |
| `packages/client/src/guard.ts` | 89 | Check before acting, in one line (D376, D420): wrap the agent's acting tools so each call goes throu | - | keep (D14, D376, D420) |
| `packages/client/src/index.ts` | 26 | type EdenClientOptions, | - | keep |
| `packages/client/src/messages.ts` | 42 | Placing injections in an OpenAI-style message list. Context goes in a system message right before th | - | keep (D69, D336) |
| `packages/client/src/on-error.ts` | 100 | The 'onError' a client uses when the integrator sets none (D850). | - | keep (D4, D14, D850) |
| `packages/engine/package.json` | 19 | - | - | keep |
| `packages/engine/src/cache.ts` | 2537 | The per-user item cache: what sources returned recently, redacted, indexed for the fast path. It liv | node:crypto; typed arrays; compression; timers | keep (D57, D188, D325, D425, D862, D998) |
| `packages/engine/src/cards.ts` | 1861 | Implication cards ('cards', off by default; docs/research/moon-cards.md): the semantic bridge betwee | node:crypto; timers | keep (D56, D63, D87, D322) |
| `packages/engine/src/config-check.ts` | 407 | 'checkEngineConfig': a JSON object of 'EngineConfig' keys, checked before an engine runs on it. One  | - | keep (D103, D104, D112, D276, D1132, D1252) |
| `packages/engine/src/config.ts` | 1027 | Every threshold the engine uses, in one place. Tuned by the eval harness (packages/eval), not by han | - | keep (D6, D49, D112, D264, D603, D1252) |
| `packages/engine/src/conflict.ts` | 1017 | The conflict test: would this item change what the request is about to do? With no model's say, word | the allergy results | keep (D49, D75); patterns hoisted to module level except one built per call (~80 ns each, not material) |
| `packages/engine/src/consequence.ts` | 401 | Consequence probes: the constraint an action runs into is often written in words the request never u | - | keep (D44, D46, D48, D49, D50, D54) |
| `packages/engine/src/days.ts` | 201 | 'pushDaySeats' (G1, D1400, trial): reading days with no model, past what 'timeWindow' and 'namesDay' | - | keep (D1400, D1402) |
| `packages/engine/src/decide.ts` | 111 | What the engine knows about each candidate of a no-model decision (docs/research/econ-decide.md): th | - | keep (D67) |
| `packages/engine/src/economy.ts` | 377 | The probe economy: what each user's probes have been bringing back, learned per user with no model,  | - | keep (D44, D46, D48, D49, D50, D54) |
| `packages/engine/src/fold.ts` | 172 | Folding echoes out of a packet ('densePacket'): one occurrence, one line. | - | keep (D11, D19, D47, D52, D68) |
| `packages/engine/src/fuzz-world.ts` | 936 | } from "@eden/protocol"; | timers | keep (D56, D126, D237, D276, D277, D282) |
| `packages/engine/src/gate.ts` | 64 | Gating source items off the event loop (D25). Redacting a lookup's items is the engine's largest syn | - | keep (D25, D26) |
| `packages/engine/src/gloss.bin` | - | The packed glossary (version 2, D1710): a header with two CRC-32s, the prefix (codes, English words, function words, keys' Bloom filters), then each language's sorted keys and glosses | - | keep (D1153, D1710) |
| `packages/engine/src/gloss.ts` | 675 | The request glossary ('requestGloss', in the default since D1153, part 'gloss'; F1, | typed arrays; sync fs | keep (D1153, D1710): answered from the file's bytes (binary search over sorted UTF-8 keys, every offset and both CRCs checked), the lexicons read only when a request could be read as another language |
| `packages/engine/src/grounding.ts` | 290 | Grounding: whether a cached item is about the people and the time a request names, read from the ite | - | keep (D44, D46, D48, D49, D50, D54) |
| `packages/engine/src/index.ts` | 147 | export { FACT_NAMES, vectorOf, type Facts } from "./decide"; | - | keep |
| `packages/engine/src/intent.ts` | 277 | The intent index ('intent', off by default; docs/research/edge-intent.md): for each cached item, the | typed arrays | keep (D56, D63, D87, D322) |
| `packages/engine/src/judge.ts` | 81 | The judge's model call: given the recent turns and up to N candidate items the cheap path could not  | - | keep (D19, D221) |
| `packages/engine/src/ledger.ts` | 144 | What a session has already been given. The partner never repeats itself: an item delivered in a sess | - | keep (D13, D18, D65, D342) |
| `packages/engine/src/line.ts` | 50 | The one line sanitiser (D221). Source text and event text are untrusted (D11, D19): put on a line of | - | keep (D11, D19, D221) |
| `packages/engine/src/packed-text.ts` | 160 | Compact item text for the cache ('CacheLimits.packText', on by default; D188 reopened D111's compres | node:buffer; typed arrays; compression | keep (D111, D188, D860, D998) |
| `packages/engine/src/parties.ts` | 166 | 'partyCheck' (D375, on in the default since D376; docs/research/a25-action-guard.md): the parties a  | node:crypto | keep (D305, D375, D376, D815) |
| `packages/engine/src/partner.ts` | 7208 | The context partner. It runs beside an agent and does two things: | node:crypto; typed arrays; timers | keep (D17, D44, D57, D127, D301, D430) |
| `packages/engine/src/parts.ts` | 205 | The default's parts (D112). 'DEFAULT_CONFIG' is one configuration, the best measured; each part name | - | keep (D6, D48, D52, D54, D112, D828) |
| `packages/engine/src/persist-shared.ts` | 411 | Frozen users in a store every machine reaches (D992): the hand-off between machines, and what a mach | typed arrays; timers | keep (D992) |
| `packages/engine/src/persist.ts` | 518 | Frozen users on disk, encrypted (D425, opt-in; off by default, where D8 stands unchanged). A user fr | node:crypto; typed arrays; sync fs | keep (D425, D991, D1071): AES-256-GCM, HKDF keys, HMAC names, AAD; random nonces sound to ~2^32 writes a key; sync writes, no fsync (re-syncable state) |
| `packages/engine/src/probes.ts` | 773 | Probes: the checks a request implies but does not ask for (docs/research/probes.md). A request to ac | - | keep (D46-D48, D702); six date patterns built per call (~80 ns each against ~115 ns hoisted, measured; not material) |
| `packages/engine/src/push-check.ts` | 497 | The push check (I3, D500; in the default since D828, part 'check'; docs/research/i3-push-check.md, | node:crypto | keep (D490, D493, D500, D501, D527, D828) |
| `packages/engine/src/rare-terms.ts` | 241 | 'sourceYieldEarn' (D600): which few of a user's sources hold a word. One table a user, sized by the  | typed arrays | keep (D425, D600, D603) |
| `packages/engine/src/reader.ts` | 823 | The ask-time model reader ('askReader', off by default; D95). | node:crypto | keep (D19, D45, D95, D96, D155, D240) |
| `packages/engine/src/render.ts` | 514 | The packet the agent sees. Short, cited, and labelled as background so the agent treats it as inform | typed arrays | keep (D11, D19, D47, D52, D68) |
| `packages/engine/src/settle.ts` | 166 | 'askNudge' (D316, D317; docs/research/a12-quality.md): whether the push's candidates settle what the | - | keep (D237, D257, D316, D317, D400, D404) |
| `packages/engine/src/situation.ts` | 24 | A coarse label for what the agent is doing, so the source map can learn "calendar helps when schedul | - | keep |
| `packages/engine/src/sketch.ts` | 141 | A source's vocabulary sketch ('routeSketch', D322): a Bloom filter of the terms in what the sync rea | typed arrays | keep (D56, D63, D87, D322) |
| `packages/engine/src/source-yield.ts` | 150 | 'sourceYield' (D505, on in the default since D509; the earn rule since D603): what each of a user's  | - | keep (D390, D505, D509, D600, D603) |
| `packages/engine/src/spans.ts` | 206 | Engine-wide span tracing: where each event's time goes, phase by phase, in wall and CPU time. | - | keep (D19, D56, D277, D293) |
| `packages/engine/src/sync.ts` | 2079 | Background connector sync, "Eden Atlas" (D57, behind 'sync', on in the default, D112): each active u | timers | keep (D56, D63, D87, D322) |
| `packages/engine/src/text.ts` | 194 | Deterministic text analysis: the cue the partner builds from a session without a model. Everything h | typed arrays | keep (D6, D8, D37) |
| `packages/engine/src/trace.ts` | 216 | One record per decision the engine makes: what evals score and what the operator's logs show. No con | - | keep (D19, D56, D237, D277, D293, D500) |
| `packages/engine/src/turn-gate.bin` | 30319 | EDG1\{"v": 1, "arch": "bag", "bits": 16, "dim": 24, "hidden": 128, "quant": "int8", "groups": "chewp | - | keep (D3, D4, D5, D7, D9, D1014) |
| `packages/engine/src/turn-gate.ts` | 316 | M13's turn gate (D1010-D1019, docs/research/m13-gate.md): a tiny learned model that reads one user t | typed arrays; sync fs | keep (D1014): int8 n-gram bag, 1.59 MB of weights read once |
| `packages/engine/src/usage.ts` | 52 | Did the agent use what it was given? Inferred, without a model, from what it does next: an injection | typed arrays | keep (D13, D18) |
| `packages/graph/package.json` | 15 | - | - | keep |
| `packages/graph/src/index.ts` | 2 | export { SourceMap, normalizeEntity, type RankedSource, type RouteRequest, type UserRows } from "./s | - | keep |
| `packages/graph/src/source-map.ts` | 344 | The source map: the first layer of the knowledge graph. It records, per user, which sources have men | bun:sqlite; SQLite; timers | keep (D4, D8, D15): bun:sqlite, WAL, synchronous=NORMAL; a specialised store (resident map, append log) measured and rejected (D1720) |
| `packages/llm/package.json` | 9 | - | - | keep |
| `packages/llm/src/anthropic.ts` | 341 | Anthropic's Messages API over plain 'fetch' (no SDK: the repo keeps dependencies few). LAB ONLY for  | typed arrays | keep (D12, D95, D97, D240, D470, D1197) |
| `packages/llm/src/budget.ts` | 170 | The model is the expensive, slow part, so it is rationed. A budget caps calls and spend per session  | - | keep (D112) |
| `packages/llm/src/fake.ts` | 28 | A scripted model for tests and offline evals: 'reply' sees each request and returns the text, or the | - | keep |
| `packages/llm/src/index.ts` | 22 | export type { ChatMessage, ChatRequest, ChatResponse, Model, Usage } from "./types"; | - | keep |
| `packages/llm/src/openrouter.ts` | 187 | OpenRouter's OpenAI-compatible chat endpoint. | - | keep (D12, D66); a direct Anthropic route is a candidate (paid A/B) |
| `packages/llm/src/pacing.ts` | 204 | Pacing for runs against rate-limited endpoints (OpenRouter's free models: about 20 requests a minute | timers | keep |
| `packages/llm/src/pricing.ts` | 43 | USD per million tokens. | - | keep (D112) |
| `packages/llm/src/tokens.ts` | 5 | A cheap token estimate (about four characters a token) for budgeting before a call. Never for billin | - | keep |
| `packages/llm/src/types.ts` | 80 | export interface ChatMessage { | - | keep (D45, D240, D1197) |
| `packages/primitives/package.json` | 12 | - | - | keep |
| `packages/primitives/src/bandit.ts` | 226 | Source selection as a Beta–Bernoulli semi-bandit: one arm per source, k arms queried per decision, a | typed arrays | keep (D3, D9) |
| `packages/primitives/src/breaker.ts` | 147 | A circuit breaker for one upstream (or one user × upstream). Failure rate is measured over a sliding | typed arrays | keep |
| `packages/primitives/src/cache.ts` | 433 | A bounded cache with S3-FIFO eviction (Yang et al., SOSP 2023), a byte budget and two TTLs. | typed arrays | keep (D20): S3-FIFO with a byte budget |
| `packages/primitives/src/calibrate.ts` | 549 | Calibration and thresholds for the inject-or-stay-silent gate: turn raw confidence features into pro | typed arrays | keep (D3) |
| `packages/primitives/src/charclass.ts` | 117 | Per-code-unit tables for the tokenizer, indexed by UTF-16 code unit: branch-light table lookups inst | typed arrays | keep |
| `packages/primitives/src/deadline.ts` | 80 | An absolute deadline shared by every stage of one operation (route → fan out → merge → maybe a model | - | keep |
| `packages/primitives/src/dedup.reference.ts` | 339 | 'TextSketcher' as it was before D998, unchanged but for its name: per vocabulary id it kept the term | typed arrays | keep (D998) |
| `packages/primitives/src/dedup.ts` | 503 | Duplicate and near-duplicate detection over text: an exact fingerprint, MinHash with an LSH index, a | typed arrays | keep (D998) |
| `packages/primitives/src/gcra.ts` | 77 | Rate limiting with GCRA (the generic cell rate algorithm): per key, one number, the theoretical arri | - | keep |
| `packages/primitives/src/hash.ts` | 76 | 32-bit hashes for hash tables, sketches and dedup. Not cryptographic. | typed arrays | keep (D20): native xxHash32 for strings, FNV-1a in place, murmur3 for bytes |
| `packages/primitives/src/histogram.ts` | 164 | A latency histogram for rolling percentiles (adaptive hedging delays, slow-call thresholds, metrics) | typed arrays | keep (D261) |
| `packages/primitives/src/idset.ts` | 330 | 'IdSet': an insertion-ordered set of strings held in typed arrays, for long-lived sets of ids (D371) | typed arrays | keep (D325, D371, D752) |
| `packages/primitives/src/index.ts` | 74 | export { fnv1a, hashString, mix32, murmur3 } from "./hash"; | - | keep |
| `packages/primitives/src/limiter.ts` | 83 | An adaptive concurrency limit (AIMD), as Netflix's concurrency-limits recommends for clients: the li | - | keep |
| `packages/primitives/src/matcher.ts` | 252 | Multi-pattern literal matching (Aho–Corasick), folded: case-insensitive and accent-insensitive, the  | typed arrays | keep |
| `packages/primitives/src/pack.ts` | 283 | Budgeted context packing: choose which candidate items go into a size-limited packet so it holds the | typed arrays | keep |
| `packages/primitives/src/placement.ts` | 103 | Placement of keys across processes and machines (D992). Three pieces, each stable across restarts an | typed arrays | keep (D992) |
| `packages/primitives/src/pool-worker.ts` | 55 | The worker side of 'WorkerPool' (pool.ts). The first message names the task module, and optionally a | - | keep |
| `packages/primitives/src/pool.fixture.ts` | 49 | Tasks for pool.test.ts: run in the pool's workers and, for inline runs, on the calling thread. | node:worker_threads; timers | keep |
| `packages/primitives/src/pool.ts` | 329 | A small pool of Bun workers for CPU-bound, synchronous, pure functions (redacting and tokenizing a l | timers | keep (D25, D26) |
| `packages/primitives/src/random.ts` | 150 | A deterministic, seedable random source for decisions that must be replayable (bandit draws, explora | typed arrays | keep |
| `packages/primitives/src/reply.ts` | 594 | Email reply structure for dedup: which lines of a message are the sender's own words, and which are  | typed arrays | keep |
| `packages/primitives/src/singleflight.ts` | 89 | Request coalescing: concurrent calls with the same key share one underlying call (Go's x/sync/single | - | keep |
| `packages/primitives/src/sketch.ts` | 136 | Compact membership and counting structures over 64-bit keys given as two 32-bit lanes (a fingerprint | typed arrays | keep |
| `packages/primitives/src/sparse-index.reference.ts` | 457 | The reference: 'SparseIndex' as it was before the packed layout (2026-11-03), kept unchanged as the  | typed arrays | keep (D111) |
| `packages/primitives/src/sparse-index.ts` | 1331 | An in-memory inverted index with BM25 scoring over term ids (from 'Vocab'/'tokenizeInto'), for one u | typed arrays | keep (D20, D111): packed CSR tier plus delta, BM25F |
| `packages/primitives/src/stats.ts` | 162 | The few special functions the decision primitives need (calibrate.ts, bandit.ts, pack.ts): log-gamma | - | keep |
| `packages/primitives/src/tokenize.ts` | 111 | The shared tokenizer: one definition of a "term" for indexes, queries, gazetteers and usage tracking | typed arrays | keep (D20, D22): fused scan, fold, hash and intern into a Uint32Array |
| `packages/primitives/src/topk.ts` | 120 | Top-k selection by score: a bounded binary min-heap over parallel typed arrays (no object per candid | typed arrays | keep |
| `packages/primitives/src/utf8.ts` | 40 | UTF-8 sizes of JS strings without encoding them, for byte budgets (injection packets, cache costs, m | - | keep |
| `packages/primitives/src/vocab.ts` | 432 | A string interner: term ↔ dense integer id, so indexes, sets and counters work on Uint32Arrays inste | node:buffer; typed arrays | keep (D860, D998) |
| `packages/protocol/package.json` | 9 | - | - | keep |
| `packages/protocol/src/describe.ts` | 12 | How Eden describes its 'ask_context' tool to an agent: the MCP server gives it, the client SDK expor | - | keep (D88, D112) |
| `packages/protocol/src/home.ts` | 11 | Eden's data directory: '$EDEN_HOME', else '~/.eden'. Created '0700' on first use. | sync fs | keep |
| `packages/protocol/src/ids.ts` | 39 | A sortable, unique id: '<prefix>_<time base36><random hex>'. | node:crypto | keep (D992) |
| `packages/protocol/src/index.ts` | 20 | export * from "./types"; | - | keep |
| `packages/protocol/src/types.ts` | 179 | The wire types every package shares. The partner sits beside a personal or proactive agent: it obser | - | keep (D60, D63, D127, D212, D430, D505) |
| `packages/protocol/src/validate.ts` | 298 | Runtime checks for what arrives over the wire. Hand-written rather than schema-library based: the sh | typed arrays | keep (D100, D347) |
| `packages/proxy/package.json` | 11 | - | - | keep |
| `packages/proxy/src/ask.ts` | 307 | 'ask_context' through the proxy (D851; the opt-in flag 'askTool', D857). D70 measured the SDK arm wi | - | keep (D3, D14, D70, D851, D857) |
| `packages/proxy/src/index.ts` | 2 | export { createProxy, eventsOf, textOf, type ProxyOptions } from "./proxy"; | - | keep |
| `packages/proxy/src/main.ts` | 104 | 'bun run proxy': Eden as a proxy in front of the agent's model: OpenAI-compatible chat completions ( | - | keep (D9, D280, D336, D365, D653, D1273) |
| `packages/proxy/src/proxy.ts` | 975 | Eden in front of the agent's model, as an OpenAI-compatible proxy (D280). | node:crypto; timers | keep (D14, D336, D653, D656, D851, D1273) |
| `packages/proxy/src/with-messages.ts` | 61 | 'raw' (a JSON object's text) with its top-level 'messages' value replaced (or 'key''s: the Responses | - | keep |
| `packages/redact/package.json` | 15 | - | - | keep |
| `packages/redact/src/index.ts` | 3 | export { redact, redactString, containsSecret, REDACTED } from "./redact"; | - | keep |
| `packages/redact/src/redact.ts` | 594 | Credential nouns, written down once. | typed arrays | keep (D13) |
| `packages/redact/src/redos-sweep.ts` | 68 | Test support, not part of the gate: the crafted-input sweep of redos.test.ts and redos-{1,2,3}.test. | - | keep |
| `packages/redact/src/secrets.ts` | 782 | D13's secret gate, as A6 §2.2 details it: which rules a text hits ('secretHits'; 'eden eval build-ne | re2js; typed arrays | keep (D10, D24, D86): re2js for the backtracking rules; bump to 2.10.0 is a candidate |
| `packages/redact/src/vendor/gitleaks/gitleaks.toml` | 3210 | This file has been auto-generated. Do not edit manually. | - | keep |
| `packages/redact/src/vendor/gitleaks/LICENSE` | 22 | Copyright (c) 2019 Zachary Rice | - | keep |
| `packages/server/package.json` | 28 | - | - | keep |
| `packages/server/src/auth.ts` | 14 | The API key a request carries, or "" for none. "Key-less" is decided on this, never on the header's  | - | keep (D351) |
| `packages/server/src/blob-store.ts` | 102 | The object store behind 'SharedFrozenDisk' (D992), on Bun's built-in S3 client: no new dependency. A | bun; typed arrays | keep (D992): Bun's S3 client, no dependency |
| `packages/server/src/build.ts` | 250 | } from "@eden/engine"; | - | keep (D26, D33, D112, D163, D828) |
| `packages/server/src/cli.ts` | 24 | 'eden <command>' (D852): one entry point for the server's operator commands, so the Docker image and | subprocess | keep (D852) |
| `packages/server/src/cluster.ts` | 546 | The cluster router (D992): the tier above the machines, as router.ts is the tier above a machine's p | typed arrays; sync fs; timers | keep (D163, D992, D993, D994) |
| `packages/server/src/config.ts` | 479 | Server configuration, from the environment. Validated at startup: a bad value stops the server with  | node:crypto; typed arrays; sync fs | keep (D100, D163, D178, D425, D991, D992) |
| `packages/server/src/connector-presets.ts` | 158 | Connector presets (D294): one-line entries for common MCP servers in a user's source spec, so an int | - | keep (D294, D356, D415, D842) |
| `packages/server/src/connectors.ts` | 91 | Which sources each user has. This is the integration point with a tenant's connector setup: in produ | sync fs | keep (D7, D108) |
| `packages/server/src/digest.ts` | 422 | 'bun run digest [log ...] [--baseline LOG] [--json]' (D293): "Eden caught this", a content-light rep | - | keep (D13, D18, D56, D277, D293, D405) |
| `packages/server/src/doctor.ts` | 473 | 'eden doctor' ('bun run doctor', D852): checks a tenant's integration against each obligation in doc | sync fs | keep (D56, D98, D99, D293, D704, D852) |
| `packages/server/src/engine-config.ts` | 54 | EDEN_ENGINE_CONFIG (D103): the path of a JSON file of 'EngineConfig' keys, merged over the default f | sync fs | keep (D103, D104, D108, D112) |
| `packages/server/src/fixtures/fake-s3.ts` | 87 | A minimal S3-compatible server for tests (D992): path-style PUT, GET, HEAD and DELETE of objects and | typed arrays | keep (D992) |
| `packages/server/src/fixtures/google-tool-descriptions.json` | 20 | - | - | keep |
| `packages/server/src/fixtures/google-tools.json` | 90 | - | - | keep (D294, D356, D415, D842) |
| `packages/server/src/http.ts` | 328 | The HTTP API an agent integration calls. All routes take and return JSON. | typed arrays | keep (D100, D108, D125, D126, D277, D282) |
| `packages/server/src/index.ts` | 30 | export { createHandler } from "./http"; | - | keep |
| `packages/server/src/integration-stats.ts` | 206 | How a tenant's integration calls Eden (D852), for 'eden doctor': content-free counts, per tenant, of | - | keep (D98, D99, D347, D420, D421, D852) |
| `packages/server/src/main.ts` | 348 | Starts the partner's HTTP API. 'bun run dev' from the repo root. With EDEN_PROCESSES above 1 this pr | typed arrays; node:crypto; timers | keep (D113, D163, D172, D293, D326, D365) |
| `packages/server/src/mcp-stdio.ts` | 46 | Serves 'ask_context' over stdio for one user, for MCP clients that launch servers as processes: | ./stdio-transport | keep (D14); switched to Eden's stdio transport (D1704) |
| `packages/server/src/mcp.ts` | 87 | The partner as an MCP server, so any MCP-capable agent can ask it questions with one tool, 'ask_cont | @eden/sources (MCP types) | keep (D14, D281); hand-written handler since D1704 |
| `packages/server/src/models.ts` | 100 | The model roles the shipped servers wire (D112): the card and intent calls in the background and the | - | keep (D12, D66, D98, D99, D112, D1196) |
| `packages/server/src/ops.ts` | 329 | What an operator and a router need from one server process beyond the API (D992): | node:crypto; typed arrays | keep (D56, D862, D992, D994) |
| `packages/server/src/persist.ts` | 37 | The server's side of persisting frozen users (D425; on by default since D991). Since D992 every proc | sync fs | keep (D425, D991, D992) |
| `packages/server/src/router.ts` | 666 | The multi-process router (D113 stage 1, D163): one Bun.serve front and N child server processes ('ma | bun:sqlite; typed arrays; SQLite; subprocess; sync fs; timers | keep (D113, D163, D172, D326) |
| `packages/server/src/trace-report.ts` | 207 | 'bun run trace-report [log ...]' (D279): an integrator's self-check on their own traffic. Reads a se | - | keep (D56, D59, D87, D279, D430) |
| `packages/server/src/user-sources.ts` | 611 | Per-user sources (D108): each (tenant, user) gets their own sources, built from their own configurat | @eden/sources (`StreamableHttpTransport`, D1704), node:crypto; sync fs; timers | keep (D7, D57, D108, D294, D1133) |
| `packages/sources/package.json` | 17 | - | - | keep |
| `packages/sources/src/abort.ts` | 22 | 'p', or a rejection with the signal's reason once it aborts: a source that does not watch its signal | - | keep |
| `packages/sources/src/cache-heap.scenario.ts` | 71 | The results cache's heap bound, run in a process of its own by 'regressions.test.ts' ("50,000 empty  | bun:jsc | keep |
| `packages/sources/src/fanout.ts` | 55 | export interface SourceOutcome { | - | keep |
| `packages/sources/src/fixtures/lab-preset-tools.json` | 875 | - | - | keep |
| `packages/sources/src/fixtures/mcp-results.json` | 267 | - | - | keep |
| `packages/sources/src/fixtures/mcp-tools.json` | 722 | - | - | keep |
| `packages/sources/src/guarded.ts` | 906 | Fan-out to a user's sources with the resilience layer from '@eden/primitives' around every call. Sou | - | keep (D48, D126, D211, D298, D328, D754) |
| `packages/sources/src/index.ts` | 50 | export { FetchErrorResult, type ListPage, type SearchQuery, type Source, type SourceResolver } from  | - | keep |
| `packages/sources/src/mcp-source.ts` | 649 | A source backed by an MCP server's read tools: the way the partner reaches every connector the custo | ./mcp (D1704), node:crypto | keep (D7, D35); the MCP SDK was replaced by D1704 |
| `packages/sources/src/planner.ts` | 555 | The query planner: for each lookup and each connector, which query shape to send (docs/plans/query-p | typed arrays | keep (D28, D33, D38, D39) |
| `packages/sources/src/schema-args.ts` | 326 | Schema-driven arguments: how a lookup becomes a call to a search tool, read from the tool's own JSON | - | keep (D44, D57) |
| `packages/sources/src/shapes.ts` | 111 | Query shapes: the ways a lookup can phrase one cue for a connector (docs/plans/query-planner.md). Th | - | keep |
| `packages/sources/src/source.ts` | 92 | A source is anything the partner can read context from: an MCP server's read tools, a connector, a s | - | keep (D35, D44, D57, D125, D126, D356) |
| `packages/sources/src/static-source.ts` | 165 | export interface StaticDoc { | typed arrays | keep (D175) |

### Tooling (`scripts/`) (13 files)

| File | Lines | What it is | Choices seen | Verdict |
|---|---|---|---|---|
| `scripts/check-line-length.ts` | 92 | Fails when a line is longer than Prettier's printWidth (.prettierrc.json). | typescript; sync fs | keep; uses TypeScript 5's JS API, which blocks TypeScript 7 stable |
| `scripts/check.sh` | 41 | The gate ('bun run check'; 'CHECK_COLD=1 bun run check' before every merge, D657): format:check, typ | - | keep (D811) |
| `scripts/decision-index.ts` | 643 | Generates docs/DECISION-INDEX.md (one line per decision, with a status) and docs/DEAD-ENDS.md (every | sync fs | keep (D89, D112, D500, D704, D708, D812) |
| `scripts/format.sh` | 165 | Formats the code, or checks it with --check (CI step 1). | - | keep (D819) |
| `scripts/lab-guard.ts` | 32 | A preload for every 'bun' started from the repository (bunfig.toml): a lab script refuses to start w | - | keep (D1101) |
| `scripts/publish-check.ts` | 149 | 'bun run publish:check' (D853): builds every artifact Eden would publish and runs each registry's dr | typed arrays; node:crypto; subprocess; sync fs | keep (D853, D991) |
| `scripts/test-cache-audit.ts` | 144 | Checks the test cache's keys (scripts/test-cache.ts, D650) against what each test really reads: runs | node:child_process; subprocess; sync fs | keep (D650, D658) |
| `scripts/test-cache.ts` | 500 | A result cache for test files (D650): a test file is skipped when it last passed on exactly the inpu | bun, node:child_process; subprocess; sync fs | keep (D650, D657, D658) |
| `scripts/test-preload.ts` | 42 | Preloaded by bunfig.toml before any test module loads: no 'bun test' run may touch the real ~/.eden. | sync fs; timers | keep |
| `scripts/test-report.ts` | 80 | The end of a test run (scripts/test.sh, D811): the ten slowest files and every test over 'SLOW_MS',  | sync fs | keep (D811) |
| `scripts/test-select.ts` | 217 | Runs the tests of some workspace packages through scripts/test.sh (same preload, temp HOME and paral | node:child_process; subprocess; sync fs | keep (D104, D161) |
| `scripts/test.sh` | 121 | Runs every test in the workspace (CI step 3), or those under the directories given ('scripts/test.sh | sync fs | keep (D650, D657, D811) |
| `scripts/typecheck.sh` | 147 | Typechecks every TypeScript program in the workspace (CI step 2). | - | keep (D816); TypeScript 7 stable is a candidate |

### Deploy kit (`deploy/`) (34 files)

| File | Lines | What it is | Choices seen | Verdict |
|---|---|---|---|---|
| `deploy/cloud-init/eden.yaml.tftpl` | 109 | One Eden machine on Ubuntu 24.04 (docs/DEPLOY.md §2, §9): Docker from Ubuntu's archive, a firewall,  | - | switched in #338 (D1702): DOCKER-USER drops 8790 from outside the private range |
| `deploy/compose/cluster-router/.env.example` | 8 | The cluster router (docs/DEPLOY.md §9). Copy to .env (chmod 600); never commit. | - | keep |
| `deploy/compose/cluster-router/compose.yaml` | 65 | The cluster router (D992) and TLS in front of it (docs/DEPLOY.md §9). It holds no user state: run tw | - | keep |
| `deploy/compose/cluster-router/nodes.example` | 6 | id=url, one per line. Ids are stable names (re-addressing a machine moves nobody); urls are private  | - | keep |
| `deploy/compose/local-cluster/compose.yaml` | 92 | A whole cluster on one machine, for trying the kit and for the deploy check (docs/DEPLOY.md §12): th | - | keep |
| `deploy/compose/local-cluster/nodes` | 4 | - | - | keep |
| `deploy/compose/local-cluster/s3.json` | 10 | - | - | keep |
| `deploy/compose/local-cluster/sources.json` | 10 | - | - | keep |
| `deploy/compose/node/.env.example` | 14 | A cluster node (docs/DEPLOY.md §9). Copy to .env (chmod 600); never commit. Same keys on every node. | - | keep |
| `deploy/compose/node/compose.yaml` | 45 | One machine of a cluster (D992, docs/DEPLOY.md §9): Eden only, listening on the private network addr | - | keep |
| `deploy/compose/single/.env.example` | 19 | Copy to .env (chmod 600), fill in, never commit. Every value here is a secret or names one (docs/DEP | - | keep |
| `deploy/compose/single/Caddyfile` | 34 | TLS for Eden (docs/DEPLOY.md §3). Caddy gets and renews the certificate from Let's Encrypt for EDEN_ | - | keep |
| `deploy/compose/single/Caddyfile.router` | 34 | TLS for Eden (docs/DEPLOY.md §3). Caddy gets and renews the certificate from Let's Encrypt for EDEN_ | - | keep |
| `deploy/compose/single/compose.yaml` | 71 | One box: Eden behind Caddy (TLS from Let's Encrypt), docs/DEPLOY.md §2. | - | keep |
| `deploy/monitoring/alerts.yaml` | 90 | Prometheus alerting rules for Eden (docs/DEPLOY.md §8, §10). Import into Grafana Cloud (Alerting, da | - | keep (validated with promtool 3.5.0; D994, D1690) |
| `deploy/monitoring/config.alloy` | 77 | Grafana Alloy on each Eden machine (docs/DEPLOY.md §8): scrapes Eden's /metrics (D994) on loopback a | - | keep (validated with alloy 1.11.3) |
| `deploy/scripts/backup.sh` | 44 | Daily backup of a machine's Eden state (docs/DEPLOY.md §7), run by eden-backup.timer: | - | keep: sqlite3 .backup is WAL-safe; frozen files are already encrypted, so zstd would gain nothing |
| `deploy/scripts/bootstrap-dedicated.sh` | 98 | Bootstraps a machine that was not created with user data (a Hetzner dedicated server after 'installi | - | keep |
| `deploy/scripts/check-monitoring.py` | 88 | A static check of deploy/monitoring without Alloy or promtool (D997): | yaml | keep |
| `deploy/scripts/check-tf.py` | 92 | A static check of deploy/tofu/* without OpenTofu (D997): parses every .tf file (python-hcl2) and che | hcl2 | keep |
| `deploy/scripts/cluster-smoke.ts` | 62 | A deploy check against a running Eden (one box or the cluster router; docs/DEPLOY.md §12): readiness | - | keep |
| `deploy/scripts/push-secrets.sh` | 19 | Copies a role's .env to a machine over SSH (mode 600, root only) and starts Eden there (docs/DEPLOY. | - | keep |
| `deploy/scripts/render-cloud-init.py` | 65 | Renders deploy/cloud-init/eden.yaml.tftpl outside OpenTofu (docs/DEPLOY.md §2): for a Hetzner dedica | - | keep |
| `deploy/scripts/rolling-upgrade.sh` | 39 | Upgrades every node of a cluster with no user unserved for longer than a rebalance (docs/DEPLOY.md § | - | keep |
| `deploy/scripts/sizing.py` | 67 | Users per box from measured RSS per user (docs/DEPLOY.md §6). Arithmetic, not a measurement: the inp | - | keep |
| `deploy/scripts/upgrade.sh` | 26 | Upgrades one machine to a git ref with the least downtime one box allows (docs/DEPLOY.md §11): | - | keep |
| `deploy/tofu/hetzner/main.tf` | 195 | Eden on Hetzner Cloud (docs/DEPLOY.md §9): a private network, NODE_COUNT Eden machines that listen o | - | keep; the bucket on hashicorp/aws is a candidate (above) |
| `deploy/tofu/hetzner/outputs.tf` | 25 | output "public_ips" { | - | keep |
| `deploy/tofu/hetzner/terraform.tfvars.example` | 22 | Copy to terraform.tfvars (gitignored). Secrets go in the environment, never here: | - | keep |
| `deploy/tofu/hetzner/variables.tf` | 96 | variable "hcloud_token" { | - | keep |
| `deploy/tofu/hetzner/versions.tf` | 33 | required_version = ">= 1.8" | - | keep; a small S3 provider in place of hashicorp/aws is a candidate (needs a Hetzner account) |
| `deploy/tofu/oci/main.tf` | 195 | Eden on Oracle Cloud A1.Flex (ARM64), the fallback host (docs/DEPLOY.md §2.1, §2.2): a VCN, one subn | - | keep |
| `deploy/tofu/oci/terraform.tfvars.example` | 14 | Copy to terraform.tfvars (gitignored). OCI credentials come from ~/.oci/config, never from here. | - | keep |
| `deploy/tofu/oci/variables.tf` | 60 | description = "e.g. eu-frankfurt-1, us-ashburn-1 (check A1 capacity in the region first)." | - | keep |

### Examples (11 files)

| File | Lines | What it is | Choices seen | Verdict |
|---|---|---|---|---|
| `examples/ai-sdk/agent.ts` | 92 | A Vercel AI SDK agent with Eden beside it, through 'eden-ai-sdk.ts' (D854): 'generateText' with the  | @ai-sdk/anthropic, ai, ai/test | keep: example (D365 smoke tests) |
| `examples/ai-sdk/eden-ai-sdk.ts` | 312 | Eden in a Vercel AI SDK agent (D854): every integration obligation in docs/INTEGRATION.md from three | ai, node:crypto | keep: example (D365 smoke tests) |
| `examples/ai-sdk/package.json` | 17 | - | - | keep: example (D365 smoke tests) |
| `examples/hermes/eden/__init__.py` | 6 | Hermes loads ''register(ctx)'' from here; the plugin itself is ''eden_client.hermes'' (pip install t | eden_client | keep: example (D365 smoke tests) |
| `examples/hermes/eden/plugin.yaml` | 6 | Eden context partner: ask_context in place of the source tools, its packet each turn, | - | keep: example (D365 smoke tests) |
| `examples/oauth-directory/directory.ts` | 110 | A 'SourceDirectory' for per-user OAuth tokens (D108, D294): the shape an embedding uses when its use | - | keep: example (D365 smoke tests) |
| `examples/oauth-directory/package.json` | 8 | - | - | keep: example (D365 smoke tests) |
| `examples/onboarding/package.json` | 14 | - | - | keep: example (D365 smoke tests) |
| `examples/personal-agent/agent.ts` | 137 | A minimal personal-agent loop with Eden beside it. The agent is any OpenAI-compatible chat model; Ed | - | keep: example (D365 smoke tests) |
| `examples/personal-agent/package.json` | 8 | - | - | keep: example (D365 smoke tests) |
| `examples/personal-agent/sources.json` | 18 | - | - | keep: example (D365 smoke tests) |

### Benchmarks (57 files)

| File | Lines | What it is | Choices seen | Verdict |
|---|---|---|---|---|
| `packages/engine/bench/churn.bench.ts` | 212 | A heavy user's cache under churn: what a vocabulary that never frees a term costs, and what 'release | typed arrays; subprocess | keep: benchmark (D57) |
| `packages/engine/bench/concurrent.bench.ts` | 139 | Concurrent load through the real ContextPartner: many users, each with cold caches, sending events o | timers | keep: benchmark (D25) |
| `packages/engine/bench/gloss-corpus.ts` | 116 | Requests for the glossary's differential test and benchmark (D1710): a sweep of every word, and seeded fuzzed requests | - | keep: benchmark (D1710) |
| `packages/engine/bench/gloss.bench.ts` | 159 | The request glossary's cost a process (D1153, D1710): RSS and heap, load time, 'glossOf' latency | bun:jsc; subprocess; sync fs | keep: benchmark (D1710) |
| `packages/engine/bench/index-memory.bench.ts` | 240 | The per-user search index's memory and speed: the packed 'SparseIndex' (frozen CSR + scanned delta)  | typed arrays; subprocess | keep: benchmark (D120) |
| `packages/engine/bench/ingest.bench.ts` | 310 | The background sync's ingest at scale (D57): memory held per synced user, and CPU per item on the tw | subprocess | keep: benchmark (D57, D111, D112, D169, D188, D216) |
| `packages/engine/bench/live-heap.bench.ts` | 359 | Where a live heavy user's memory goes: 'users.bench.ts''s setup (the shipped wiring, '--prose' items | bun:jsc; typed arrays; sync fs | keep: benchmark |
| `packages/engine/bench/many-sources.bench.ts` | 273 | One user with many connected sources (A1 scale audit, docs/research/a1-scale.md): what a lookup, an  | - | keep: benchmark (D263) |
| `packages/engine/bench/pipeline.bench.ts` | 114 | End to end: a realistic event stream through the real ContextPartner (fast path, slow path, source s | timers | keep: benchmark (D25, D188) |
| `packages/engine/bench/put.bench.ts` | 57 | Per-item cost of storing a source result: redaction, tokenizing, indexing, entity extraction (one us | typed arrays | keep: benchmark |
| `packages/engine/bench/release.bench.ts` | 140 | A rebalance at full size (D992): what it costs a node to release users to another machine, and the n | typed arrays; sync fs | keep: benchmark (D862, D992) |
| `packages/engine/bench/restart.bench.ts` | 231 | A restart with and without persisted frozen users (D425, docs/research/c3-persist-frozen.md). What i | typed arrays; sync fs | keep: benchmark (D8, D425, D862) |
| `packages/engine/bench/segment-screen.bench.ts` | 724 | O4's screen for O2's segment redesign (docs/research/o4-segment-screens.md): would a user's postings | typed arrays; compression; subprocess; sync fs | keep: benchmark |
| `packages/engine/bench/source-days.bench.ts` | 279 | One user with many connected sources over whole simulated days (A13, docs/research/a13-scale.md): wh | - | keep: benchmark (D126, D356) |
| `packages/engine/bench/storm.bench.ts` | 204 | A cold-start storm (A14): many users connect at once (a deploy, a restart, a morning) while users al | timers | keep: benchmark (D325, D328, D751, D753, D755) |
| `packages/engine/bench/stub-cards.ts` | 28 | A card enricher whose maker answers every batch at once at no cost: a deadline card and two requests | - | keep: benchmark (D998) |
| `packages/engine/bench/thread-cpu.ts` | 22 | CPU time of the process's main thread alone (Linux: '/proc/self/task/<pid>/stat', utime + stime), fo | sync fs | keep: benchmark (D216) |
| `packages/engine/bench/users.bench.ts` | 397 | Many users in one process (A14): what a synced user costs in memory, what an idle one costs frozen ( | typed arrays; sync fs; timers | keep: benchmark (D325, D372, D425, D860, D862, D998) |
| `packages/engine/bench/workload.ts` | 163 | A realistic synthetic workload for the engine, for end-to-end measurement (pipeline.bench.ts): one u | - | keep: benchmark (D750) |
| `packages/primitives/bench/bandit.bench.ts` | 187 | Source selection: cost per decision, then what the choice is worth: cumulative regret and how well e | typed arrays | keep: benchmark |
| `packages/primitives/bench/baseline.bench.ts` | 27 | Where per-item CPU went before the primitives: the engine's regex tokenizer and entity extractor, th | - | keep: benchmark |
| `packages/primitives/bench/calibrate.bench.ts` | 236 | Calibration and thresholds: fit and predict cost, calibration quality by training-set size, and whet | typed arrays | keep: benchmark |
| `packages/primitives/bench/compare/cache.compare.ts` | 121 | Hit ratio and throughput of S3FifoCache against LRU (a Map, and the lru-cache package). lru-cache is | lru-cache; typed arrays | keep: benchmark |
| `packages/primitives/bench/compare/decision.compare.ts` | 242 | The decision primitives (stats.ts, random.ts, calibrate.ts, bandit.ts, pack.ts) against the npm libr | @langchain/core/utils/math, @stdlib/random-base-beta, @stdlib/stats-base-dists-beta-quantile, jstat, ml-logistic-regression; typed arrays | keep: benchmark |
| `packages/primitives/bench/compare/dedup.compare.ts` | 207 | Our reply stripper and sketches against the npm libraries for the same jobs, on the same corpus and  | node:module; typed arrays | keep: benchmark |
| `packages/primitives/bench/compare/pool.compare.ts` | 118 | WorkerPool against the npm worker pools on Bun: tinypool, piscina, workerpool. None is a repo depend | - | keep: benchmark |
| `packages/primitives/bench/compare/reply-fixtures.compare.ts` | 103 | The reply stripper on real emails from other projects' test suites, not on our generator's output: | node:module; typed arrays; sync fs | keep: benchmark |
| `packages/primitives/bench/compare/sketch.compare.ts` | 83 | npm Bloom filter and count-min packages on the workloads of bench/sketch.bench.ts, for the record of | node:module | keep: benchmark |
| `packages/primitives/bench/compare/workerpool.worker.ts` | 9 | The workerpool package's worker for pool.compare.ts: the same gate task, registered the way workerpo | - | keep: benchmark |
| `packages/primitives/bench/dedup-corpus.ts` | 901 | A synthetic but realistic mailbox for dedup benchmarks: email threads in five languages with replies | - | keep: benchmark |
| `packages/primitives/bench/dedup-eval.ts` | 153 | Scoring for the dedup benchmarks: line-level scores for quote strippers, pair-level precision and re | typed arrays | keep: benchmark |
| `packages/primitives/bench/dedup.bench.ts` | 474 | Quality and cost of reply stripping (reply.ts) and duplicate detection (dedup.ts) on the synthetic m | typed arrays | keep: benchmark |
| `packages/primitives/bench/gate-engine.bench.ts` | 106 | The secret gate three ways, end to end through 'sanitizeForStore': every gitleaks regex on JavaScrip | - | keep: benchmark (D24) |
| `packages/primitives/bench/gate-memory.bench.ts` | 64 | Heap kept by the secret gate after realistic and crafted input, per engine choice: re2js keeps a laz | - | keep: benchmark |
| `packages/primitives/bench/gate.bench.ts` | 24 | The secret gate (packages/redact) before and after the Aho–Corasick keyword prefilter, on the same r | - | keep: benchmark |
| `packages/primitives/bench/harness.ts` | 79 | A minimal benchmark harness: warmup, then timed batches; reports mean and p50/p99 of per-op time acr | - | keep: benchmark |
| `packages/primitives/bench/hash.bench.ts` | 21 | const enc = new TextEncoder(); | - | keep: benchmark |
| `packages/primitives/bench/histogram.bench.ts` | 59 | 'Histogram' / 'RollingHistogram' (histogram.ts): record and quantile time, and heap per rolling hist | - | keep: benchmark (D261) |
| `packages/primitives/bench/idset.bench.ts` | 111 | 'IdSet' against 'Set<string>' at the sync's scale (D371): a source's synced ids, 1,000 to 3,000 a so | - | keep: benchmark (D371, D752) |
| `packages/primitives/bench/jsc.bench.ts` | 43 | JavaScriptCore behaviours that shaped the primitives, each isolated on a 2 KB string. | - | keep: benchmark |
| `packages/primitives/bench/load.ts` | 179 | A mixed server load for judging CPU offload by what users feel, not ns/op: many small events plus bu | typed arrays; timers | keep: benchmark |
| `packages/primitives/bench/matcher.bench.ts` | 46 | const keywords = [...new Set(secretRules().flatMap((r) => r.keywords))]; | typed arrays | keep: benchmark |
| `packages/primitives/bench/message.bench.ts` | 191 | What it costs to hand text to a worker and get it back, by transport: structured clone of a string a | node:worker_threads; typed arrays | keep: benchmark |
| `packages/primitives/bench/offload.bench.ts` | 57 | CPU off the event loop: the mixed load of bench/load.ts with each lookup's gate run inline, or in a  | - | keep: benchmark |
| `packages/primitives/bench/pack.bench.ts` | 237 | Packing: cost per packet, how close the Lin–Bilmes greedy gets to the exact optimum, and how often e | typed arrays | keep: benchmark |
| `packages/primitives/bench/redos.scan.ts` | 104 | Searches the secret gate for inputs that cost more than linear time: every rule as 'spans' runs it ( | - | keep: benchmark (D24) |
| `packages/primitives/bench/runtime.bench.ts` | 99 | The same primitives under whichever runtime runs this file (see runtime.sh). No Bun-only APIs. | typed arrays | keep: benchmark |
| `packages/primitives/bench/runtime.sh` | 13 | Runs bench/runtime.bench.ts on Bun and on Node (bundled for Node by 'bun build'), to compare JavaScr | - | keep: benchmark |
| `packages/primitives/bench/sketch.bench.ts` | 342 | Does a compact structure beat the plain Set/Map at Eden's scale? Two workloads, each with its obviou | bun:jsc; typed arrays | keep: benchmark |
| `packages/primitives/bench/sparse-index-ab.bench.ts` | 93 | The packed 'SparseIndex' against the layout it replaced ('ReferenceSparseIndex'), interleaved in one | typed arrays | keep: benchmark |
| `packages/primitives/bench/sparse-index.bench.ts` | 149 | SparseIndex against the obvious alternative: BM25 over a Map of term → Map(doc → tf), scored per que | typed arrays | keep: benchmark |
| `packages/primitives/bench/tokenize.bench.ts` | 44 | const WORD = /[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu; | typed arrays | keep: benchmark |
| `packages/primitives/bench/topk.bench.ts` | 33 | const scores = Float64Array.from({ length: 10_000 }, (_, i) => Math.sin(i) * 1000); | typed arrays | keep: benchmark |
| `packages/primitives/bench/vocab.bench.ts` | 211 | Interner designs on the same scan: identity by comparing against string objects, against a character | bun:jsc; typed arrays | keep: benchmark |
| `packages/primitives/bench/workers/echo.worker.ts` | 68 | The worker side of bench/message.bench.ts: returns its input by each transport, so the bench times o | node:worker_threads; typed arrays | keep: benchmark |
| `packages/primitives/bench/workers/gate.task.ts` | 16 | Task module for bench/offload.bench.ts: the secret gate, which the engine runs on every item it cach | - | keep: benchmark |
| `packages/server/bench/cluster.bench.ts` | 183 | The cluster router (D992) on one host: three machines ('main.ts', one process each, persistence to a | subprocess; sync fs | keep: benchmark (D992, D993) |
| `packages/server/bench/router.bench.ts` | 277 | The multi-process router's gate (D163): events per second the whole server sustains with observe p99 | typed arrays; subprocess; sync fs | keep: benchmark (D113, D163, D172, D326) |
| `packages/sources/bench/static-source.bench.ts` | 182 | StaticSource search cost at 400 / 4,000 / 40,000 documents (D175): the old search (every document re | bun:jsc; subprocess | keep: benchmark (D175) |

### Native (D22) (27 files)

| File | Lines | What it is | Choices seen | Verdict |
|---|---|---|---|---|
| `native/bench/builtins.ts` | 40 | Kernel 5 (Bun only): Bun's native hashes on the same strings, against murmur3 in TS and in Rust, for | - | keep: D22's measured experiment; nothing imports it |
| `native/bench/ffi.ts` | 81 | Kernels 1 and 2 (Bun only): bun:ffi per-call overhead, and the cost of getting a JS string into memo | bun:ffi; typed arrays | keep: D22's measured experiment; nothing imports it |
| `native/bench/lib/corpus.ts` | 75 | Secret-shaped strings for the scanner benchmark and cross-check, assembled from parts and a fixed-se | - | keep: D22's measured experiment; nothing imports it |
| `native/bench/lib/gen.ts` | 83 | Deterministic email-like text for the benchmarks: sentences mixing common words, names, ticket ids,  | - | keep: D22's measured experiment; nothing imports it |
| `native/bench/lib/harness.ts` | 84 | A small timing harness that runs on Bun and Node. Each benchmark warms up, then takes 'samples' time | typed arrays | keep: D22's measured experiment; nothing imports it |
| `native/bench/lib/native.ts` | 82 | Loads the eden-native cdylib through 'bun:ffi'. 'NATIVE_LIB' picks another build (the target-cpu=nat | bun:ffi; typed arrays | keep: D22's measured experiment; nothing imports it |
| `native/bench/lib/tokenize.ts` | 155 | The experiment's tokenizer in TypeScript; it must match 'native/eden-native/src/tokenize.rs' exactly | typed arrays | keep: D22's measured experiment; nothing imports it |
| `native/bench/lib/ts-secrets.ts` | 22 | The TypeScript gate from packages/redact, imported by relative path (the bench is outside the worksp | - | keep: D22's measured experiment; nothing imports it |
| `native/bench/lib/wasm.ts` | 78 | Loads the eden-native crate built for wasm32-unknown-unknown, on Bun or Node. Input and output buffe | typed arrays; sync fs | keep: D22's measured experiment; nothing imports it |
| `native/bench/napi.ts` | 73 | napi-rs (Node-API) on Bun and Node: call overhead and tokenize + murmur3 with napi's own string mars | typed arrays | keep: D22's measured experiment; nothing imports it |
| `native/bench/secrets-profile.ts` | 94 | Where the TS gate's time goes: which rules pass the keyword gate on benign email and what each one's | - | keep: D22's measured experiment; nothing imports it |
| `native/bench/secrets.ts` | 69 | Kernel 4 (Bun only): "which rules fire" over the vendored gitleaks rules, TS (packages/redact) again | typed arrays | keep: D22's measured experiment; nothing imports it |
| `native/bench/summarize.ts` | 50 | Summarises several 'run-all.sh <dir>' runs: for every row of one benchmark's tables, the mean and p5 | sync fs | keep: D22's measured experiment; nothing imports it |
| `native/bench/tokenize.ts` | 48 | Kernel 3: tokenize + murmur3, end to end from a JS string to a filled Uint32Array, at 256 B, 2 KiB a | typed arrays | keep: D22's measured experiment; nothing imports it |
| `native/bench/tsconfig.bench.json` | 5 | - | - | keep: D22's measured experiment; nothing imports it |
| `native/bench/verify.ts` | 139 | Correctness cross-checks (run with Bun): every tokenizer implementation yields identical hash arrays | typed arrays | keep: D22's measured experiment; nothing imports it |
| `native/eden-napi/.gitignore` | 2 | - | - | keep: D22's measured experiment; nothing imports it |
| `native/eden-napi/build.rs` | 4 | - | - | keep: D22's measured experiment; nothing imports it |
| `native/eden-napi/Cargo.toml` | 24 | description = "Language-choice experiment: the eden-native tokenizer behind Node-API (napi-rs), load | - | keep: D22's measured experiment; nothing imports it |
| `native/eden-napi/src/lib.rs` | 36 | ! The eden-native tokenizer behind Node-API via napi-rs, to compare Node-API call and string-marshal | typed arrays | keep: D22's measured experiment; nothing imports it |
| `native/eden-native/.gitignore` | 3 | - | - | keep: D22's measured experiment; nothing imports it |
| `native/eden-native/Cargo.toml` | 22 | description = "Language-choice experiment: Eden's per-event kernels in Rust behind a C ABI (bun:ffi) | - | keep: D22's measured experiment; nothing imports it |
| `native/eden-native/src/lib.rs` | 206 | ! Eden's per-event CPU kernels in Rust, for the language-choice experiment (docs/research/language-c | - | keep: D22's measured experiment; nothing imports it |
| `native/eden-native/src/secrets.rs` | 495 | ! The gitleaks half of 'packages/redact/src/secrets.ts' (rules (a) only; Eden's own 'eden-*' rules a | - | keep: D22's measured experiment; nothing imports it |
| `native/eden-native/src/tokenize.rs` | 216 | ! The experiment's tokenizer, which must match 'native/bench/lib/tokenize.ts' exactly: | - | keep: D22's measured experiment; nothing imports it |
| `native/run-all.sh` | 46 | Builds every variant of the language-choice experiment and runs the cross-checks and benchmarks in s | - | keep: D22's measured experiment; nothing imports it |
| `native/rustfmt.toml` | 2 | - | - | keep: D22's measured experiment; nothing imports it |

### Lab and eval (`packages/sim`, `packages/eval`) (821 files)

| File | Lines | What it is | Choices seen | Verdict |
|---|---|---|---|---|
| `packages/eval/package.json` | 17 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-family-1.json` | 88 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-family-2.json` | 87 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-family-3.json` | 80 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-family-4.json` | 80 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-family-5.json` | 80 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-family-6.json` | 80 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-family-7.json` | 80 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-family-8.json` | 80 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-home-admin-1.json` | 92 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-home-admin-2.json` | 92 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-home-admin-3.json` | 85 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-home-admin-4.json` | 85 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-home-admin-5.json` | 85 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-home-admin-6.json` | 85 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-home-admin-7.json` | 85 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-home-admin-8.json` | 85 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-social-1.json` | 82 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-social-2.json` | 82 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-social-3.json` | 75 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-social-4.json` | 75 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-social-5.json` | 75 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-social-6.json` | 75 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-social-7.json` | 75 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-travel-1.json` | 82 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-travel-2.json` | 82 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-travel-3.json` | 75 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-travel-4.json` | 75 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-travel-5.json` | 75 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-travel-6.json` | 75 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-travel-7.json` | 75 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-work-ops-1.json` | 92 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-work-ops-2.json` | 92 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-work-ops-3.json` | 85 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-work-ops-4.json` | 85 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-work-ops-5.json` | 85 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-work-ops-6.json` | 85 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-work-ops-7.json` | 85 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/acting/acting-work-ops-8.json` | 85 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/agent-already-fetched.json` | 62 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/agent-mentions-only.json` | 52 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/anniversary.json` | 68 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/birthday-gift.json` | 73 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/calendar-clash.json` | 62 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/dentist-reschedule.json` | 94 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/family-logistics.json` | 65 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/flight-change.json` | 104 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/hotel-checkin.json` | 60 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/injection-in-mail.json` | 77 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/invoice-triage.json` | 85 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/large-flight-lookalikes.json` | 362 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/large-people-lookalikes.json` | 357 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/large-subscription-lookalikes.json` | 344 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/large-vendor-freeze.json` | 373 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/lookalike-names.json` | 72 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/meeting-prep.json` | 96 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/newsletter-arrives.json` | 64 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/order-tracking.json` | 65 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/people-and-days.json` | 143 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/personal-assistant.json` | 142 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/promised-follow-up.json` | 76 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/quiet-inbox.json` | 82 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/refund-request.json` | 66 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/reply-drafting.json` | 80 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/secrets-in-docs.json` | 83 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/subscription-renewal.json` | 61 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/ticket-follow-up.json` | 61 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/two-sessions.json` | 89 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/unanswered-thread.json` | 62 | - | - | keep: lab or eval data |
| `packages/eval/scenarios/unrelated-request.json` | 57 | - | - | keep: lab or eval data |
| `packages/eval/src/cli.ts` | 148 | bun run eval [--live --usd-cap <usd> [--judge]] [--wait <ms>] [--no-planner] [--config '{"probes":tr | sync fs | keep: lab (D33, D112, D128, D810); not in the image since D1700 |
| `packages/eval/src/index.ts` | 11 | export type { Scenario, Turn } from "./scenario"; | - | keep: lab; not in the image since D1700 |
| `packages/eval/src/reader-stub.ts` | 55 | Readers with no model for 'bun run eval --reader stub/oracle': the eval's own copy of the lab's sema | - | keep: lab; not in the image since D1700 |
| `packages/eval/src/run.ts` | 579 | Plays scenarios through a real 'ContextPartner' and scores what it delivered. Deterministic with no  | - | keep: lab (D12, D128, D276, D435, D810, D828); not in the image since D1700 |
| `packages/eval/src/scenario.ts` | 50 | An eval scenario: a user's sources, and scripted sessions whose turns say what the partner should de | - | keep: lab (D44, D810); not in the image since D1700 |
| `packages/sim/lab/a12/hidden.py` | 136 | A12 (docs/research/a12-quality.md): hidden facts raised, Haiku-graded and Sonnet-corrected, per arm  | - | keep: lab research script (D317); not shipped |
| `packages/sim/lab/a12/nudge-screen.py` | 29 | A12 (docs/research/a12-quality.md): where askNudge (D316) fires in a funnel run, by kind. | - | keep: lab research script (D316); not shipped |
| `packages/sim/lab/a12/regrade.sh` | 7 | A12: Sonnet 5.5 regrades of a pi-ab run (docs/research/a12-quality.md). STEM NAME then regrade.ts fi | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/a12/run.sh` | 17 | A12 on Pi (docs/research/a12-quality.md): LABEL PUSH CONDITIONS then pi-ab flags. A2's run.sh with A | - | keep: lab (D237, D316, D317); not in the image since D1700 |
| `packages/sim/lab/a15/embed.py` | 23 | Encodes each world's items and requests (hidden-funnel --corpus-dump) with a small local model, for  | numpy, sentence_transformers | keep: lab research script; not shipped |
| `packages/sim/lab/a15/run_screen.py` | 185 | Drives screen.py's retrievers (docs/research/a15-retrieval.md section 2). Each adds up to k items th | numpy, screen | keep: lab research script; not shipped |
| `packages/sim/lab/a15/run.sh` | 12 | A15 on Pi (docs/research/a15-retrieval.md): LABEL PUSH CONDITIONS then pi-ab flags. A2's run.sh with | - | keep: lab (D330); not in the image since D1700 |
| `packages/sim/lab/a15/score.py` | 25 | Funnel JSON score and task diff (docs/research/a15-retrieval.md): hidden and decoys surfaced (delive | - | keep: lab research script; not shipped |
| `packages/sim/lab/a15/screen.py` | 158 | A15 $0 screen (docs/research/a15-retrieval.md): offline retrievers over each world's items (hidden-f | - | keep: lab research script; not shipped |
| `packages/sim/lab/a16/earlier.py` | 35 | A16 (D336): for each arm's hidden tasks over a user's days, where the planted item reached the agent | - | keep: lab research script (D336); not shipped |
| `packages/sim/lab/a16/run.sh` | 13 | A16 loop moonshots on Pi (docs/research/a16-loop.md): LABEL PUSH CONDITIONS then pi-ab flags. A6's r | - | keep: lab (D271); not in the image since D1700 |
| `packages/sim/lab/a16/turns.py` | 36 | A16 (docs/research/a16-loop.md): where an arm's agent tokens go, by turn type, from pi-ab timelines | - | keep: lab research script; not shipped |
| `packages/sim/lab/a17/days.py` | 150 | A17 (docs/research/a17-long-quality.md): pi-ab '--days' runs by position in the day. | - | keep: lab research script; not shipped |
| `packages/sim/lab/a17/reshown.py` | 27 | A17: hidden tasks whose planted item reached the agent in this request's packet, split by whether a  | - | keep: lab research script; not shipped |
| `packages/sim/lab/a17/run.sh` | 12 | A17 (docs/research/a17-long-quality.md): LABEL PUSH CONDITIONS then pi-ab flags. A3's run.sh with it | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/a2/embscreen.py` | 41 | A2 $0 screen (docs/research/a2-quality.md section 4): a local embedding model ranks every world item | numpy, sentence_transformers | keep: lab research script; not shipped |
| `packages/sim/lab/a2/feat.py` | 97 | A2 (docs/research/a2-quality.md), $0: re-rank rules simulated on the push's pool dump (hidden-funnel | - | keep: lab research script (D1, D2); not shipped |
| `packages/sim/lab/a2/keepdiff.py` | 27 | A2: per hidden task, the share of the detail words the planted item's candidate line keeps, run A ag | - | keep: lab research script; not shipped |
| `packages/sim/lab/a2/run.sh` | 15 | A2 on Pi (docs/research/a2-quality.md): LABEL PUSH CONDITIONS then pi-ab flags. CL8's run.sh with A2 | - | keep: lab (D266, D267, D268); not in the image since D1700 |
| `packages/sim/lab/a2/sim.py` | 48 | A2 (docs/research/a2-quality.md), $0: re-rank rules simulated on the push's pool dump (hidden-funnel | - | keep: lab research script; not shipped |
| `packages/sim/lab/a2/uptake.py` | 23 | A2: per arm, hidden tasks by where the planted item reached the agent (packet, ask only, neither) an | - | keep: lab research script; not shipped |
| `packages/sim/lab/a21/run.sh` | 12 | A21 live Pi check of the 1,000-source default (docs/research/a21-scale.md): LABEL CONDITIONS then pi | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/a22/hidden.py` | 30 | A22 (D360): hidden raised with Sonnet's regrade of every Haiku miss ('regrade.sh STEM miss-STEM --on | - | keep: lab research script (D360); not shipped |
| `packages/sim/lab/a22/linkscreen.py` | 32 | A22 (D360; the switch is in commit 3a3e51b9 only, check it out to rerun): how often the planted item | - | keep: lab research script (D360); not shipped |
| `packages/sim/lab/a22/regrade.sh` | 7 | A22: Sonnet 5.5 regrades of a pi-ab run (A12's regrade.sh on A22's ledger). STEM NAME then regrade.t | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/a22/run.sh` | 12 | A22 on Pi (docs/research/a22-quality.md): LABEL PUSH CONDITIONS then pi-ab flags. A15's run.sh with  | - | keep: lab (D271, D360); not in the image since D1700 |
| `packages/sim/lab/a26/concerns.py` | 10 | A26: concerns per arm before and after the Sonnet regrade (regrade.ts --only-concerns output; rule ( | - | keep: lab research script; not shipped |
| `packages/sim/lab/a26/pool.py` | 11 | A26 (docs/research/a26-reshow.md §0): the pre-registered pooling of D340's hidden difference. A17's  | - | keep: lab research script (D340); not shipped |
| `packages/sim/lab/a26/run.sh` | 12 | A26 (docs/research/a26-reshow.md): LABEL PUSH then pi-ab flags. A17's run.sh with its own ledger and | - | keep: lab (D340); not in the image since D1700 |
| `packages/sim/lab/a27/pull_consts.py` | 21 | A27: reads (never executes) named top-level string constants from hermes-agent source files with ast | ast | keep: lab research script; not shipped |
| `packages/sim/lab/a28/run.sh` | 15 | A28 live Pi check of the cut-copy budget (D390, docs/research/a28-scale.md): LABEL CONDITIONS then p | - | keep: lab (D390); not in the image since D1700 |
| `packages/sim/lab/a29/cold-user.json` | 96 | - | - | keep: lab or eval data |
| `packages/sim/lab/a29/hermes/run.sh` | 14 | Hermes on the blind heldout17 (A29's end-of-day confirmation, Hermes half): three arms, seeds 41-42  | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/a29/run.sh` | 13 | A29 (docs/research/a29-heldout17.md): the end-of-day blind check on heldout17. LABEL PUSH CONDITIONS | - | keep: lab (D271, D316); not in the image since D1700 |
| `packages/sim/lab/a3/run.sh` | 13 | A3 on Pi (docs/research/a3-cost-speed.md): LABEL PUSH CONDITIONS then pi-ab flags. CL8's run.sh with | - | keep: lab (D271, D274); not in the image since D1700 |
| `packages/sim/lab/a30/gap.py` | 74 | A30 (docs/research/a30-token-gap.md): where the eden arm's agent bill differs from the tools arm's,  | - | keep: lab research script; not shipped |
| `packages/sim/lab/a30/run.sh` | 12 | A30 (docs/research/a30-token-gap.md): LABEL PUSH CONDITIONS then pi-ab flags. A3's run.sh (train, ho | - | keep: lab (D271, D400); not in the image since D1700 |
| `packages/sim/lab/a6/asks-absent.ts` | 51 | A6 (docs/research/a6-moonshots.md): of a Pi run's 'ask_context' questions, how many name an entity n | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/lab/a6/census.ts` | 48 | A6 (docs/research/a6-moonshots.md): how many of a request's named entities no item of its world name | - | keep: lab (D287); not in the image since D1700 |
| `packages/sim/lab/a6/connector-price.py` | 20 | A6: token $ plus connector $ per 1,000 tasks on the 1:1:8 mix, per connector plan (market.py's CONNE | - | keep: lab research script; not shipped |
| `packages/sim/lab/a6/dress-pairs.py` | 61 | A6 (D287): dressed − undressed worlds per arm, paired by task id across runs (same seeds, tasks and  | - | keep: lab research script (D287); not shipped |
| `packages/sim/lab/a6/pilot.py` | 23 | A6 (docs/research/a6-moonshots.md §1): the pilot's figures from a pi-ab timeline (eden arm). | - | keep: lab research script; not shipped |
| `packages/sim/lab/a6/run.sh` | 13 | A6 moonshots on Pi (docs/research/a6-moonshots.md): LABEL PUSH CONDITIONS then pi-ab flags. CL8's ru | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/a6/tags.py` | 37 | A6 (docs/research/a6-moonshots.md): the card tags in funnel packets ('--packets'), D286's $0 screen. | - | keep: lab research script (D286); not shipped |
| `packages/sim/lab/a7/connector-calls.json` | 261 | - | - | keep: lab or eval data |
| `packages/sim/lab/a7/connector-calls.ts` | 86 | A7 (D291): Eden's connector calls outside the tasks of the no-key Pi run, at $0. pi-ab's timelines c | - | keep: lab (D291); not in the image since D1700 |
| `packages/sim/lab/a7/connectors.py` | 59 | A7 (D291): connector calls and their price per plan for the no-key Pi run, beside the model cost. | - | keep: lab research script (D291); not shipped |
| `packages/sim/lab/a7/demo-sweep.ts` | 27 | A7 (D292): how often 'bun run demo''s path (no key, sync backfilled, the shipped wiring through HTTP | - | keep: lab (D292); not in the image since D1700 |
| `packages/sim/lab/a7/run.sh` | 12 | A7 on Pi (docs/research/a7-adoption.md): LABEL then pi-ab flags. D276's owed live check: the default | - | keep: lab (D276, D291); not in the image since D1700 |
| `packages/sim/lab/a8/pair.py` | 103 | A8 (docs/research/a8-connector-calls.md): two pi-ab runs of the same users compared arm by arm, pair | - | keep: lab research script; not shipped |
| `packages/sim/lab/a8/price.py` | 12 | A8: $ per 1,000 tasks per connector plan (market.py's CONNECTORS, $ per 1,000 calls): token $/1k plu | - | keep: lab research script; not shipped |
| `packages/sim/lab/a8/run.sh` | 12 | A8 connector calls on Pi (docs/research/a8-connector-calls.md): LABEL PUSH CONDITIONS then pi-ab fla | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/a8/spend.py` | 11 | A8: spend per run label and in total from the spend ledger. python3 -I spend.py LEDGER""" | - | keep: lab research script; not shipped |
| `packages/sim/lab/a9/ahead-screen.py` | 44 | A9 $0 screen of 'pushAhead' (docs/research/a9-ahead.md): the funnel's '--packets' files of the defau | - | keep: lab research script; not shipped |
| `packages/sim/lab/a9/arrivals.ts` | 140 | A9 (docs/research/a9-ahead.md): a $0 screen of 'planConflict' under ordinary new-item traffic, which | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/a9/asks.py` | 80 | A9 (docs/research/a9-ahead.md): per arm and kind from pi-ab timelines (STEM.tl/tasks.jsonl): tasks,  | - | keep: lab research script; not shipped |
| `packages/sim/lab/a9/late.py` | 72 | A9 plan-conflict test ('pi-ab --day K --late', docs/research/a9-ahead.md): per arm and kind, the pla | - | keep: lab research script; not shipped |
| `packages/sim/lab/a9/reach.py` | 23 | A9: hidden raised (and control/neutral concerns as graded) for ARM and BASE on the tasks ARM's ahead | - | keep: lab research script; not shipped |
| `packages/sim/lab/a9/run.sh` | 13 | A9 answer-ahead and plan-conflict on Pi (docs/research/a9-ahead.md): LABEL PUSH CONDITIONS then pi-a | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/a9/spend.py` | 12 | A9: the ledger's spend by run label (python3 -I spend.py .local/a9/ledger.jsonl).""" | - | keep: lab research script; not shipped |
| `packages/sim/lab/audit-1107/hermes/run.sh` | 12 | cd "$(git rev-parse --show-toplevel)" | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/audit-1107/hermes/run3.sh` | 12 | cd "$(git rev-parse --show-toplevel)" | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/b1/path-pair.py` | 41 | B1 (docs/research/b1-scale-path.md): Eden's time on the agent's path per task (Eden's spans on the " | - | keep: lab research script; not shipped |
| `packages/sim/lab/b1/run.sh` | 14 | B1 live Pi check of 'pushCutBehind' (D405, docs/research/b1-scale-path.md): LABEL CONDITIONS then pi | - | keep: lab (D405); not in the image since D1700 |
| `packages/sim/lab/b18/all.sh` | 22 | B18: every run of the pre-registration, each once, at most two Anthropic processes at a time. For ea | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/b18/analyze.sh` | 73 | B18: merge the three arms of each seed, then every report of the pre-registered readout into package | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/b18/levels.py` | 138 | B18 (docs/research/b18-heldout18.md): each arm's level on hidden facts and its concerns, on Haiku's  | - | keep: lab research script (D466); not shipped |
| `packages/sim/lab/b18/merge.py` | 60 | B18 (docs/research/b18-heldout18.md): the three arms of one seed, each run by its own pi-ab process, | - | keep: lab research script; not shipped |
| `packages/sim/lab/b18/run.sh` | 30 | B18 (docs/research/b18-heldout18.md): one pi-ab process of the blind confirmation on heldout18. ARM  | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/b18/tasks-hash.ts` | 36 | B18 (docs/research/b18-heldout18.md): a sha256 of everything an arm's agent and grader are given on  | node:crypto | keep: lab; not in the image since D1700 |
| `packages/sim/lab/b19/analyze.sh` | 26 | B19: the final run's four reports (Hermes short and days, Pi short and days) from go.sh's results, o | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/b19/arm-tree.sh` | 32 | B19 (D1040): a tree that runs the lab harness (packages/sim: suites, worlds, grader and prompts) at  | - | keep: lab (D1040); not in the image since D1700 |
| `packages/sim/lab/b19/compat.py` | 39 | B19 (D1047): makes the harnesses load against an Eden tree that predates an engine export they name. | - | keep: lab research script (D1047, D1060, D1063); not shipped |
| `packages/sim/lab/b19/concerns.py` | 28 | B19 (D1043): every control and neutral answer the run's grader called a concern, for the pre-registe | - | keep: lab research script (D1043); not shipped |
| `packages/sim/lab/b19/go.sh` | 142 | B19's final run (pre-registered in docs/research/b19-final-bench.md §2, D1043, amended by D1045): he | - | keep: lab (D1043, D1044, D1045, D1046, D1047, D1060); not in the image since D1700 |
| `packages/sim/lab/b19/report.py` | 314 | B19 (D1040–D1043, docs/research/b19-final-bench.md): the three-arm report. Each arm is one results f | - | keep: lab research script (D1040, D1043); not shipped |
| `packages/sim/lab/b19/run.sh` | 66 | B19 (D1040–D1042, docs/research/b19-final-bench.md): one harness process for one arm. Everything but | - | keep: lab (D97, D878, D1040, D1042); not in the image since D1700 |
| `packages/sim/lab/b19/tasks-hash.ts` | 42 | B19 (D1040, docs/research/b19-final-bench.md): B18's tasks-hash for any suite. A sha256 of every tas | node:crypto | keep: lab (D1040); not in the image since D1700 |
| `packages/sim/lab/basic-memory/Dockerfile` | 10 | Basic Memory over a folder of Markdown notes: HOME is /state, so its default project is /state/basic | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/before-after/analyze.py` | 166 | The before/after tables of docs/research/final-before-after.md, from pi-ab.ts / hermes-ab.ts results | - | keep: lab research script; not shipped |
| `packages/sim/lab/before-after/ingest-patch.py` | 43 | Adapts this repo's packages/engine/bench/ingest.bench.ts to the 18366d039 sync, in the BEFORE tree o | - | keep: lab research script; not shipped |
| `packages/sim/lab/before-after/make-before-tree.sh` | 94 | Builds the BEFORE tree of docs/research/final-before-after.md: the product packages of 18366d039 (PR | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/before-after/market-profiles/direct.json` | 8 | - | - | keep: lab or eval data |
| `packages/sim/lab/before-after/market-profiles/hosted.json` | 8 | - | - | keep: lab or eval data |
| `packages/sim/lab/before-after/market.py` | 212 | Eden's effect on an agent's cost, speed and quality with market connector latency and prices. | - | keep: lab research script; not shipped |
| `packages/sim/lab/c4/ask-pair.py` | 59 | C4 (D430): two funnel JSONs task by task, for the ask. | - | keep: lab research script (D430); not shipped |
| `packages/sim/lab/c4/ask-uptake.py` | 35 | C4 (D430): per arm and kind over pi-ab timelines, the 'ask_context' calls a task (Eden's path lane), | - | keep: lab research script (D430); not shipped |
| `packages/sim/lab/c4/clock.ts` | 16 | C4 (D432): 'bun --preload packages/sim/lab/c4/clock.ts packages/eval/src/cli.ts' runs the eval on 20 | - | keep: lab (D432); not in the image since D1700 |
| `packages/sim/lab/c4/route.py` | 28 | C4 (D430): hidden tasks by how the planted item reached the agent (in a packet, in an ask answer onl | - | keep: lab research script (D430); not shipped |
| `packages/sim/lab/c4/run.sh` | 14 | C4 live Pi check of 'askBehind' (D430, docs/research/c4-ask-path.md): LABEL CONDITIONS then pi-ab fl | - | keep: lab (D430); not in the image since D1700 |
| `packages/sim/lab/caldav/Dockerfile` | 9 | A CalDAV MCP server; the backend is Radicale (../radicale), reached as CALDAV_URL. Its 'mcp>=…' depe | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/chroma/Dockerfile` | 14 | The official Chroma MCP server over an embedded (persistent) Chroma store mounted at /data. The defa | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/chroma/seed.py` | 18 | Loads lab items (JSON lines: id, document, kind) into a persistent Chroma collection named "items"." | chromadb | keep: lab research script; not shipped |
| `packages/sim/lab/cl2/arms.py` | 72 | CL2's per-arm figures and paired intervals from pi-ab result JSONs and timelines (RealUse-2's arms.p | - | keep: lab research script; not shipped |
| `packages/sim/lab/cl2/run.sh` | 15 | CL2's Pi runs (docs/research/cl-cl2.md). Needs the train cards merged once: | - | keep: lab (D240); not in the image since D1700 |
| `packages/sim/lab/cl2/run8.sh` | 11 | CL2 on CL5's long horizon (--days 8): the default (stop on, D240) against the default with the stop  | - | keep: lab (D240); not in the image since D1700 |
| `packages/sim/lab/cl3/arms.py` | 88 | Per-arm figures and paired bootstrap 95% intervals for CL3's Pi runs (RealUse-2's arms.py and pairs. | - | keep: lab research script; not shipped |
| `packages/sim/lab/cl3/cold/cold-base.json` | 114 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl3/cold/cold-bulk-train1-41.json` | 58 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl3/cold/cold-bulk-train3-42.json` | 58 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl3/cold/cold-bulk-train5-43.json` | 58 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl3/cold/cold-l7.json` | 116 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl3/cold/cold-l7r2.json` | 117 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl3/funnel-pairs.py` | 22 | Paired bootstrap 95% intervals between funnel runs (surfaced = delivered or cited by the ask), per v | - | keep: lab research script; not shipped |
| `packages/sim/lab/cl3/run.sh` | 13 | CL3's Pi runs (docs/research/cl-cl3.md): pi-ab on the direct market profile, Haiku 5.5 in every role | - | keep: lab (D97); not in the image since D1700 |
| `packages/sim/lab/cl4/arms.py` | 139 | CL4 (docs/research/cl-cl4.md): per-arm figures and paired differences from pi-ab result JSONs and ti | - | keep: lab research script; not shipped |
| `packages/sim/lab/cl4/asks.py` | 31 | for f in sys.argv[1:]: | - | keep: lab research script; not shipped |
| `packages/sim/lab/cl4/pooled.py` | 24 | CL4 (docs/research/cl-cl4.md): one arm against another, paired by task and pooled over several pi-ab | - | keep: lab research script; not shipped |
| `packages/sim/lab/cl4/run.sh` | 13 | usage: run.sh LABEL SUITE SEED VARIANTS CONDS [extra args...] | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/cl5/cold-user.json` | 94 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl5/run.sh` | 10 | CL5 baseline on Pi: LABEL then pi-ab flags. | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/cl6/pair.py` | 25 | Paired bootstrap of arm A - arm B over pi-ab results files: rate (any must fact true), wall s, $/1k  | - | keep: lab research script; not shipped |
| `packages/sim/lab/cl6/regrade/cl6-long-pay-41.regrade.json` | 51 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl6/regrade/cl6-long-pay-42.regrade.json` | 108 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl6/regrade/cl6-long-sig-41.regrade.json` | 144 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl6/regrade/cl6-long-sig-42.regrade.json` | 75 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl6/regrade/cl6-m-long-pay-41.regrade.json` | 112 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl6/regrade/cl6-m-long-pay-42.regrade.json` | 29 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl6/regrade/cl6-m-short-pay-41.regrade.json` | 85 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl6/regrade/cl6-m-short-pay-42.regrade.json` | 121 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl6/regrade/cl6-scr41.regrade.json` | 132 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl6/regrade/cl6-short-pay-41.regrade.json` | 132 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl6/regrade/cl6-short-pay-42.regrade.json` | 84 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl6/regrade/cl6-short-sig-41.regrade.json` | 108 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl6/regrade/cl6-short-sig-42.regrade.json` | 84 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl6/run.sh` | 11 | CL6 (H19, the agent is the reader) on Pi: LABEL CONDITIONS PUSH then pi-ab flags. The CL5 baseline's | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/cl7/arms.py` | 143 | CL7 (docs/research/cl-cl7.md; CL4's arms.py with a per-stem arm filter): per-arm figures and paired  | - | keep: lab research script; not shipped |
| `packages/sim/lab/cl7/cold-user.json` | 99 | - | - | keep: lab or eval data |
| `packages/sim/lab/cl7/notes.py` | 22 | Hidden tasks: was the note handed out (an injection with 0 items), and the paired raised outcomes. | - | keep: lab research script; not shipped |
| `packages/sim/lab/cl7/regr.py` | 12 | Concerns (control, neutral) per arm: the run's Haiku grader, and how many Sonnet's regrade kept. | - | keep: lab research script; not shipped |
| `packages/sim/lab/cl7/run.sh` | 10 | CL7 on Pi: LABEL PUSH CONDITIONS then pi-ab flags (CL5's run.sh with the push mode and arms as argum | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/cl8/asks.py` | 24 | CL8 (docs/research/cl-cl8.md): per Eden arm and kind, packet characters a task (the packets the agen | - | keep: lab research script; not shipped |
| `packages/sim/lab/cl8/cache.py` | 60 | CL8 (docs/research/cl-cl8.md): the agent's billed cost per arm and kind split by Anthropic token cla | - | keep: lab research script; not shipped |
| `packages/sim/lab/cl8/concerns.py` | 20 | CL8: control and neutral concerns per horizon and arm: what the run's Haiku grader flagged, and how  | - | keep: lab research script; not shipped |
| `packages/sim/lab/cl8/pooled.py` | 53 | CL8 (docs/research/cl-cl8.md): ARM against BASE, paired by task and pooled over pi-ab runs: hidden r | - | keep: lab research script; not shipped |
| `packages/sim/lab/cl8/run.sh` | 14 | CL8 on Pi (docs/research/cl-cl8.md): LABEL PUSH CONDITIONS then pi-ab flags. CL7's run.sh with CL8's | - | keep: lab (D258, D259); not in the image since D1700 |
| `packages/sim/lab/cl8/screen/bytes.py` | 18 | CL8 $0 screen: packet and ask bytes, items, planted delivered and ask-cited per variant, from a funn | - | keep: lab research script; not shipped |
| `packages/sim/lab/cl8/screen/dups.py` | 22 | CL8 $0 screen: tasks with an item in two packets of the same request, from hidden-funnel --packets. | - | keep: lab research script; not shipped |
| `packages/sim/lab/cl8/screen/keep.py` | 23 | CL8 $0 screen: in each hidden task's candidates packet (hidden-funnel --packets), the share of the t | - | keep: lab research script; not shipped |
| `packages/sim/lab/distilled/run.sh` | 79 | The distilled-reader experiment (docs/research/distilled-reader.md), end to end. Lab only, simulated | - | keep: lab (D87); not in the image since D1700 |
| `packages/sim/lab/f1/combo_score.py` | 82 | F1 x F2 combined check-pool pilot scorer (subagent-simulated; docs/research/f1-intent-bridge.md sect | - | keep: lab research script; not shipped |
| `packages/sim/lab/f1/credit.sh` | 46 | F1, once Anthropic credit is back (docs/research/f1-intent-bridge.md §3, §6). Runs in order, each st | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/f1/days.py` | 22 | F1: source-days.bench.ts JSONs, connector calls a user a day over days 2-8. | - | keep: lab research script; not shipped |
| `packages/sim/lab/f1/enc_items.py` | 28 | Encode items (title + head, "passage: ") and task requests ("query: ") of an m11 export with an e5 m | tokenizers | keep: lab research script; not shipped |
| `packages/sim/lab/f1/enc_requests.py` | 22 | name,prefix=sys.argv[1],sys.argv[2] if len(sys.argv)>2 else '' | tokenizers | keep: lab research script; not shipped |
| `packages/sim/lab/f1/extras.py` | 12 | Per task: the encoder's top-k item hashes (item text) for the request; written for the pilot's promp | - | keep: lab research script; not shipped |
| `packages/sim/lab/f1/fresh.py` | 28 | F1 (D475-D478): one line per quality-cli JSON: stale and deleted deliveries, re-reads and sync calls | - | keep: lab research script (D475, D478); not shipped |
| `packages/sim/lab/f1/gain_items.py` | 26 | Encoder (item text) top-k added to the push check's view: facts and look-alikes newly in view, items | - | keep: lab research script; not shipped |
| `packages/sim/lab/f1/gain_requests.py` | 34 | Encoder top-k (with tau) reach on tasks whose planted item is NOT in the push pool's first 15 (what  | - | keep: lab research script; not shipped |
| `packages/sim/lab/f1/gloss_score.py` | 45 | F1: the requestGloss pair through the subagent queue (rule in 67a019b6). Usage: gloss_score.py BASE. | - | keep: lab research script; not shipped |
| `packages/sim/lab/f1/go.sh` | 16 | Record only: '--connector-mix' was deleted with the local-copy trials (D495); run at commit 225625db | - | keep: lab (D495); not in the image since D1700 |
| `packages/sim/lab/f1/manifest-a.json` | 25 | - | - | keep: lab or eval data |
| `packages/sim/lab/f1/manifest-b.json` | 25 | - | - | keep: lab or eval data |
| `packages/sim/lab/f1/manifest-c.json` | 25 | - | - | keep: lab or eval data |
| `packages/sim/lab/f1/manifest-d.json` | 25 | - | - | keep: lab or eval data |
| `packages/sim/lab/f1/manifest-e.json` | 25 | - | - | keep: lab or eval data |
| `packages/sim/lab/f1/path.py` | 63 | F1: Eden's time on the agent's path and the task's wall time, one arm against another, paired by tas | - | keep: lab research script; not shipped |
| `packages/sim/lab/f1/pilot_score.py` | 29 | P={p['id']:p for p in json.load(open('.local/f1/pilot/prompts.json'))['prompts']} | - | keep: lab research script; not shipped |
| `packages/sim/lab/f1/prep.py` | 20 | Build .local/f1/screen.json: per world, items with shipped requests (f3 preferred) and card kind; ta | - | keep: lab research script; not shipped |
| `packages/sim/lab/f1/qrun.sh` | 8 | Record only: '--connector-mix' was deleted with the local-copy trials (D495); run at commit 225625db | - | keep: lab (D495); not in the image since D1700 |
| `packages/sim/lab/f1/run.sh` | 30 | F1's pre-registered Pi pair (docs/research/f1-intent-bridge.md §4): reworded's non-English templates | - | keep: lab (D97); not in the image since D1700 |
| `packages/sim/lab/f11/concerns.py` | 67 | F11: the control and neutral answers a run's grader marked as raising a concern, for a second, caref | - | keep: lab research script (D1101); not shipped |
| `packages/sim/lab/f11/report.py` | 305 | F11 (D1250–D1252): per-arm turns, connector calls, cost and wait of a multi-turn pi-ab run answered  | - | keep: lab research script (D1101, D1190, D1250, D1252); not shipped |
| `packages/sim/lab/f13/anticipate.ts` | 152 | LAB ONLY (F13, D1301: rejected; the engine's store, CPU match and their tests are in commit fd458ac8 | - | keep: lab (D10, D11, D221, D1301); not in the image since D1700 |
| `packages/sim/lab/f13/match.ts` | 157 | F13: the CPU match of each task's request against its world's anticipations ($0; LAB ONLY, sim data) | typed arrays; sync fs | keep: lab (D1270); not in the image since D1700 |
| `packages/sim/lab/f13/missed.ts` | 103 | F13 (retrieval): why hidden facts never reach the agent ($0; LAB ONLY, sim data). | node:zlib; compression; sync fs | keep: lab (D872, D1102); not in the image since D1700 |
| `packages/sim/lab/f13/pass.ts` | 131 | F13: the anticipation pass over each world's sheet, through the queue transport (D1101). LAB ONLY, s | node:crypto; sync fs | keep: lab (D1101); not in the image since D1700 |
| `packages/sim/lab/f13/precursor.py` | 57 | F13: would a plan-driven anticipation pass have predicted the request? A $0 proxy from a funnel --co | - | keep: lab research script; not shipped |
| `packages/sim/lab/f13/score.py` | 85 | F13: screen 1's scorer (pre-registered in 04d69058). Reads match.ts rows. | - | keep: lab research script; not shipped |
| `packages/sim/lab/f13/sheet.py` | 83 | F13: per-world constraint sheets from a funnel --corpus-dump and the shipped card replay ($0). | gzip | keep: lab research script (D1062); not shipped |
| `packages/sim/lab/f2-decoy/cleared.py` | 39 | F2-decoy: which rule took the planted fact (hidden) or the decoy (control) out of the push's pool, w | - | keep: lab research script; not shipped |
| `packages/sim/lab/f2-decoy/labels.py` | 37 | F2-decoy: each template's labelled decoy kind, read from the suite sources' own comments (no model). | - | keep: lab research script; not shipped |
| `packages/sim/lab/f2-decoy/score.py` | 70 | F2-decoy: planted facts (hidden) and decoys (control) surfaced and handed, by path and by labelled d | labels | keep: lab research script; not shipped |
| `packages/sim/lab/f2-decoy/screen.py` | 66 | F2-decoy: candidate rules over what the filter read ('cardReads', a 'pushDecoyFilter' 8 run's pool d | labels | keep: lab research script; not shipped |
| `packages/sim/lab/f2-recall/arms.ts` | 38 | F2's screened instructions (docs/research/f2-push-recall.md): the shipped 'CHECK_SYSTEM' with its ac | - | keep: lab (D1141); not in the image since D1700 |
| `packages/sim/lab/f2-recall/base.sh` | 10 | F2: one funnel process with the live check and its dump.   SUITE SEED | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/f2-recall/drops.py` | 48 | F2 (docs/research/f2-push-recall.md): why the push check left out a planted fact it read. | - | keep: lab research script; not shipped |
| `packages/sim/lab/f2-recall/offline.py` | 57 | F2 (docs/research/f2-push-recall.md): another reading of recorded compare-first replies, at $0. | - | keep: lab research script; not shipped |
| `packages/sim/lab/f2-recall/pi.sh` | 19 | F2 (docs/research/f2-push-recall.md §4): one pi-ab process for the pair 'eden' against 'eden~R' ('pu | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/f2-recall/pilot-build.ts` | 73 | F2's subagent-simulated pilot (docs/research/f2-push-recall.md §5): the push check's exact prompts f | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/lab/f2-recall/pilot-score.py` | 99 | F2's subagent-simulated pilot (docs/research/f2-push-recall.md §5): each arm's replies read by the s | - | keep: lab research script; not shipped |
| `packages/sim/lab/f2-recall/screen.ts` | 121 | F2 (docs/research/f2-push-recall.md): the push check's instructions, screened on recorded pools. Re- | sync fs | keep: lab (D97, D931); not in the image since D1700 |
| `packages/sim/lab/f2-state/build.py` | 71 | F2-state: per-item state labelling batches for Haiku subagents (lab; no model call here). | gzip | keep: lab research script; not shipped |
| `packages/sim/lab/f2/arms.py` | 25 | F2 (C): each pi-ab shard's hidden-raised and control-concern rates per arm, and the agent's $ per 1, | - | keep: lab research script; not shipped |
| `packages/sim/lab/f2/look.py` | 39 | F2 (A): the intent requests of planted items, decoys and other items, with word-overlap statistics a | gzip | keep: lab research script; not shipped |
| `packages/sim/lab/f2/table.py` | 19 | F2: one line per screen on both intent draws: hidden and decoys surfaced, and tasks gained and lost  | - | keep: lab research script; not shipped |
| `packages/sim/lab/f3/askmulti.json` | 670 | -0.028014616321559074, | - | keep: lab or eval data |
| `packages/sim/lab/f3/bench.json` | 1330 | - | - | keep: lab or eval data |
| `packages/sim/lab/f3/go.sh` | 30 | F3 (D1120): the pre-registered Pi pair for 'packetWhy'. Lab-provider (D97): Anthropic direct, no Ope | - | keep: lab (D97, D1120); not in the image since D1700 |
| `packages/sim/lab/f3/manifest-a-long.json` | 41 | - | - | keep: lab or eval data |
| `packages/sim/lab/f3/manifest-b-41.json` | 41 | - | - | keep: lab or eval data |
| `packages/sim/lab/f3/manifest-b-45.json` | 41 | - | - | keep: lab or eval data |
| `packages/sim/lab/f3/manifest-b-49.json` | 169 | - | - | keep: lab or eval data |
| `packages/sim/lab/f3/pilot-build.ts` | 61 | F3 (D1125): the subagent-simulated pilot's prompts, at $0. Each task's single-shot agent turn, as pi | node:crypto; sync fs | keep: lab (D1125); not in the image since D1700 |
| `packages/sim/lab/f3/pilot-grade.ts` | 85 | F3 (D1125): the pilot's grading prompts (the harness's own 'gradeMessages') from the subagents' answ | node:crypto; sync fs | keep: lab (D1125); not in the image since D1700 |
| `packages/sim/lab/f3/pilot-report.py` | 68 | F3 (D1125): the subagent-simulated pilot's readout. Lab tooling; sim data only. | - | keep: lab research script (D1125, D1128); not shipped |
| `packages/sim/lab/f3/report.py` | 111 | F3 (D1120): the pre-registered readout of the 'packetWhy' Pi pair. Lab tooling; sim data only. | - | keep: lab research script (D1120); not shipped |
| `packages/sim/lab/f3/run.sh` | 33 | F3 (docs/research/f3-asks-bench-pilot.md): the paid runs, as they were made. Needs the Modal client | - | keep: lab (D485); not in the image since D1700 |
| `packages/sim/lab/f3/sets.json` | 292 | - | - | keep: lab or eval data |
| `packages/sim/lab/f3/stale-count.ts` | 58 | F3 (D1127): how each handed silent fact went out, current or stale, from a funnel '--packets' dump o | sync fs | keep: lab (D1127); not in the image since D1700 |
| `packages/sim/lab/f3/totals.json` | 120 | - | - | keep: lab or eval data |
| `packages/sim/lab/f4/record-coverage.sh` | 29 | heldout20's shipped coverage (D1080, as D872 made heldout19's): the cards and intent requests the sh | - | keep: lab (D97, D872, D1080); not in the image since D1700 |
| `packages/sim/lab/f5/clock-check.ts` | 63 | F5 (docs/research/f5-rule-sheet.md §4): what the shipped enricher reads for one world on the wall cl | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/f5/pi.sh` | 19 | F5 (docs/research/f5-rule-sheet.md §1b): one pi-ab process for the pair 'eden' against 'eden~F' (the | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/f5/pilot.ts` | 268 | F5's subagent-simulated pilot (docs/research/f5-rule-sheet.md §5). The Anthropic API has no credit,  | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/lab/f6/pilot-report.py` | 95 | F6 pilot report ("subagent-simulated, single-shot"; docs/research/f6-uptake.md). | - | keep: lab research script; not shipped |
| `packages/sim/lab/f6/single-shot.ts` | 88 | F6 pilot (docs/research/f6-uptake.md), "subagent-simulated, single-shot": no model API. Builds, at $ | sync fs | keep: lab (D1160); not in the image since D1700 |
| `packages/sim/lab/f6/tasks-seed41.json` | 2450 | - | - | keep: lab or eval data |
| `packages/sim/lab/f7/cache-probe.ts` | 62 | D1196's probe: does the shipped OpenRouter route cache the push check's stable prefix? | timers | keep: lab (D1196); not in the image since D1700 |
| `packages/sim/lab/f7/holdabort.py` | 76 | F7 §9: hold-and-abort priced on a measured final arm ([EST]; served by subagents, D1101, or the API) | - | keep: lab research script (D1101); not shipped |
| `packages/sim/lab/f7/levers.py` | 95 | F7: what each cost and latency lever saves, priced from what the lab recorded ($0, every figure [EST | - | keep: lab research script (D241, D1191); not shipped |
| `packages/sim/lab/f7/mt.py` | 100 | F7: a multi-turn pi-ab run served by subagents (D1101), read per arm for target 3+4 ([EST] wall). | - | keep: lab research script (D1101); not shipped |
| `packages/sim/lab/f7/price-queue.py` | 98 | F7: cost and latency per role for runs served by subagents (D1101), from the queue's own records ([E | - | keep: lab research script (D1101); not shipped |
| `packages/sim/lab/f7/price.py` | 64 | F7: two arms' model spend and the push check's wait, priced per role from token counts ([EST]). | - | keep: lab research script; not shipped |
| `packages/sim/lab/f7/sheet-cache.py` | 93 | F7: the rule sheet's prompt-cache hit rate and its price a check (D1180), from a user's request spac | - | keep: lab research script (D1180); not shipped |
| `packages/sim/lab/f7/simstop.py` | 60 | F7: the lean stop simulated on recorded shipped replies ($0). Per recorded compare-first reply (a '- | - | keep: lab research script; not shipped |
| `packages/sim/lab/f7/wall.py` | 72 | F7: wall p50 a task on the 1:1:8 mix, an arm against the base, with a template-clustered bootstrap. | - | keep: lab research script; not shipped |
| `packages/sim/lab/final/check-order.py` | 31 | Assert that each task's push check ended before its first agent request started (F7's warning via th | - | keep: lab research script; not shipped |
| `packages/sim/lab/final/cost.py` | 238 | The final benchmark's cost and speed, side by side with quality, per arm [EST; served by subagents ( | - | keep: lab research script (D1101, D1180, D1273); not shipped |
| `packages/sim/lab/final/go.sh` | 249 | The final benchmark (served by subagents, D1101; single-shot agent): Eden before the F wave against  | - | keep: lab (D1101, D1103); not in the image since D1700 |
| `packages/sim/lab/final/report.py` | 234 | The final benchmark's report (served by subagents, D1101; single-shot agent). Read-only over a go.sh | - | keep: lab research script (D1101); not shipped |
| `packages/sim/lab/final/report.sh` | 27 | The final benchmark's report: quality (report.py) and cost and wait [EST] (F7's price-queue.py), fro | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/final/results/heldout20-go.log` | 18 | 2026-11-12T13:01:32Z go: suite=heldout20 seeds=41,42,43,44 before=006b505c3 final=fd895e10b harness= | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/final/wall.py` | 262 | Target 4's wall time, task by task, from a multi-turn run's timelines [EST; served by subagents (D11 | - | keep: lab research script (D1101, D1252, D1273, D1550, D1551); not shipped |
| `packages/sim/lab/fix-s1/pi-run1-summary.json` | 1025 | - | - | keep: lab or eval data |
| `packages/sim/lab/fix-s1/pi-run2-summary.json` | 751 | - | - | keep: lab or eval data |
| `packages/sim/lab/fix-s1/s1.py` | 53 | Fix S1 (docs/research/fix-s1-reader.md): each reader trial arm against 'eden' on the same Pi runs. | importlib | keep: lab research script; not shipped |
| `packages/sim/lab/fix-s2/analyze.py` | 99 | S2's live Pi analysis (docs/research/fix-s2-rules.md): each arm against 'eden', paired by task. | - | keep: lab research script; not shipped |
| `packages/sim/lab/fix-s2/live.json` | 286 | - | - | keep: lab or eval data |
| `packages/sim/lab/fix-s2/nofb.json` | 406 | - | - | keep: lab or eval data |
| `packages/sim/lab/fix-s3b/cold-start.json` | 107 | - | - | keep: lab or eval data |
| `packages/sim/lab/fix-s3b/day-vs-single.py` | 22 | for t in d['tasks']: K[t['id']]=t['kind'] | - | keep: lab research script; not shipped |
| `packages/sim/lab/fix-s3b/days.json` | 2453 | - | - | keep: lab or eval data |
| `packages/sim/lab/fix-s3b/pair.py` | 18 | a,b=sys.argv[1],sys.argv[2]; files=sys.argv[3:] | - | keep: lab research script; not shipped |
| `packages/sim/lab/fix-s3b/perf-memory-synced.json` | 448 | - | - | keep: lab or eval data |
| `packages/sim/lab/fix-s3b/perf-memory-unsynced.json` | 540 | - | - | keep: lab or eval data |
| `packages/sim/lab/fix-s3b/regrade-41.json` | 56 | - | - | keep: lab or eval data |
| `packages/sim/lab/fix-s3b/regrade-by-condition.py` | 16 | Sonnet's verdict against the run's Haiku verdict per condition and kind (any fact true), from regrad | - | keep: lab research script; not shipped |
| `packages/sim/lab/fix-s4/analyze.py` | 40 | sys.path.insert(0, 'packages/sim/lab/before-after') | market | keep: lab research script; not shipped |
| `packages/sim/lab/fix-s4/honesty-branch.json` | 175 | - | - | keep: lab or eval data |
| `packages/sim/lab/fix-s4/honesty-main.json` | 169 | - | - | keep: lab or eval data |
| `packages/sim/lab/fix-s4/pi-summary.json` | 173 | - | - | keep: lab or eval data |
| `packages/sim/lab/fix-s4/quality-summary.json` | 403 | - | - | keep: lab or eval data |
| `packages/sim/lab/fix-s4/run.sh` | 12 | The variants name the deleted D213/D214 switches: run it on commit a0ed239f (claude/fix-s4-connector | - | keep: lab (D213, D214); not in the image since D1700 |
| `packages/sim/lab/fix-s7/day-pairs.py` | 62 | fix-s7: revisionNotice off vs on in 'pi-ab --day', paired by day (recap measures) and by task (grade | - | keep: lab research script; not shipped |
| `packages/sim/lab/fix-s7/days.json` | 3458 | - | - | keep: lab or eval data |
| `packages/sim/lab/fix-w2a/parts-replay.json` | 461 | - | - | keep: lab or eval data |
| `packages/sim/lab/fix-w2a/pi-summary.json` | 477 | - | - | keep: lab or eval data |
| `packages/sim/lab/fix-w2b/analyze.py` | 101 | fix-w2b's live Pi analysis (docs/research/fix-w2b-false-concerns.md): each arm against 'eden', paire | - | keep: lab research script; not shipped |
| `packages/sim/lab/fix-w2b/attribute.py` | 145 | fix-w2b: attribute every false (control) and neutral concern of pi-ab runs to the way the agent got  | - | keep: lab research script (D230); not shipped |
| `packages/sim/lab/fix-w2b/attribution.json` | 510 | - | - | keep: lab or eval data |
| `packages/sim/lab/fix-w2b/live-unflagged.json` | 304 | - | - | keep: lab or eval data |
| `packages/sim/lab/fix-w2b/live-unread.json` | 304 | - | - | keep: lab or eval data |
| `packages/sim/lab/fix-w2b/run.sh` | 16 | usage: run.sh PHASE SUITE SEED VARIANTS CONDITIONS [VARIANT_CONFIG] | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/g1/dated-bench.ts` | 45 | G1 (D1400): what 'ItemCache.dated' costs a request that names a day. One dev20 world's items (a corp | sync fs | keep: lab (D1400); not in the image since D1700 |
| `packages/sim/lab/g1/go.sh` | 57 | G1 (D1400): the pre-registered pair for 'pushDaySeats', F6's single-shot recipe (packages/sim/lab/fi | - | keep: lab (D1101, D1102, D1400); not in the image since D1700 |
| `packages/sim/lab/g1/labels.ts` | 30 | G1 ($0): dev20 pool misses by the suites' own labels. bun packages/sim/lab/g1/labels.ts POOL.jsonl | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/lab/g1/report.py` | 130 | G1 (D1400, D1401): the pair's report. Read-only over a g1/go.sh run directory. | - | keep: lab research script (D1400, D1401); not shipped |
| `packages/sim/lab/g1/start.ts` | 29 | G1 ($0): which dev20 requests start the push (the rule, the turn gate's verdict and score), by varia | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/lab/g3/pool-like.py` | 35 | G3: how many of the push pool's items are constraint-like, and whether the planted item is, at $0. | - | keep: lab research script; not shipped |
| `packages/sim/lab/g3/pool-rank.py` | 43 | G3: where the planted fact sits in the push check's pool, and how much of the pool repeats, at $0. | - | keep: lab research script; not shipped |
| `packages/sim/lab/g3/report.py` | 342 | G3 (target 3): agent + Eden against the agent alone, per arm of 'g3/run.sh' [EST; served by subagent | - | keep: lab research script (D1101, D1180, D1190); not shipped |
| `packages/sim/lab/g3/run.sh` | 55 | G3 (target 3: agent + Eden net cheaper than the agent alone): F6's multi-turn step (final/go.sh 2b)  | - | keep: lab (D828, D1101, D1102, D1252); not in the image since D1700 |
| `packages/sim/lab/g4/run.sh` | 81 | G4 (target 4): the multi-turn comparison of go.sh's step 2b with more arms, on this checkout (served | - | keep: lab (D1101, D1552); not in the image since D1700 |
| `packages/sim/lab/gitea/Dockerfile` | 13 | The official Gitea MCP server; the backend is the official Gitea image. Its go.mod asks for Go 1.27. | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/h19-diag/go.sh` | 44 | Diagnosis of the final default on heldout19 (Pi, the agent alone vs Eden), B19's settings. Lab-provi | - | keep: lab (D97); not in the image since D1700 |
| `packages/sim/lab/h19-diag/live.py` | 44 | T={t['id']:t for t in json.load(open('templates.json'))} | - | keep: lab research script; not shipped |
| `packages/sim/lab/h19-diag/stage.py` | 43 | T={t['id']:t for t in json.load(open('templates.json'))} | - | keep: lab research script; not shipped |
| `packages/sim/lab/h2/skip.py` | 64 | H2 (D1050-D1059): the pre-registered no-model skip rule for the push check, read on '--check-dump' r | - | keep: lab research script (D1050, D1059); not shipped |
| `packages/sim/lab/h2/w2.py` | 75 | H2 (D1050-D1059): the card-call screen's read ('h2-cards-screen.ts' output), $0. | - | keep: lab research script (D1050, D1059); not shipped |
| `packages/sim/lab/h3/checks.py` | 56 | H3 (docs/research/h3-pushcheck-lean.md): the push check's calls by arm from pi-ab timelines. | - | keep: lab research script; not shipped |
| `packages/sim/lab/h3/pi.sh` | 20 | H3 (docs/research/h3-pushcheck-lean.md §1b): one pi-ab process for the pair 'eden' against 'eden~D'  | - | keep: lab (D1073, D1074); not in the image since D1700 |
| `packages/sim/lab/h3/split-screen.ts` | 169 | H3 (docs/research/h3-pushcheck-lean.md, D1072, D1073): what the push check reads and how it is calle | sync fs | keep: lab (D10, D97, D1072, D1073); not in the image since D1700 |
| `packages/sim/lab/haiku/queue.sh` | 14 | runs jobs from a list, N at a time: each line "pi/hermes SUITES SEED LABEL" | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/haiku/run-w.sh` | 9 | usage: run-w.sh SUITES SEED LABEL : Pi, NEW with a 1 s first-observe wait, paired with NEW at 3 s | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/haiku/run.sh` | 16 | usage: run.sh pi/hermes SUITES SEED LABEL | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/hermes/eden/__init__.py` | 79 | Eden as a Hermes plugin, the way a tenant would integrate it (lab: hermes-ab.ts). | urllib | keep: lab research script; not shipped |
| `packages/sim/lab/hermes/eden/plugin.yaml` | 4 | description: Eden context partner for the lab A/B (packets before the turn and after tool results) | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/hermes/worker.py` | 145 | One Hermes Agent per stream of hermes-ab.ts: reads tasks as JSON lines on stdin, answers one JSON li | datetime, hermes_time, run_agent, tools, traceback | keep: lab research script (D1044); not shipped |
| `packages/sim/lab/i1/compare.py` | 104 | I1's funnel screen, task by task (D473, docs/research/i1-checker.md §1's bar). Lab only. | hashlib | keep: lab research script (D257, D473, D493); not shipped |
| `packages/sim/lab/i1/evaluate.py` | 68 | I1: a trained checker on this machine's CPU (D472, docs/research/i1-checker.md). Lab only. | i1_data, onnxruntime, sidecar | keep: lab research script (D472); not shipped |
| `packages/sim/lab/i1/sidecar.py` | 148 | I1's checker as a CPU sidecar the lab calls (D471, docs/research/i1-checker.md). Lab only, not produ | hashlib, http, numpy, onnxruntime, tokenizers | keep: lab research script (D471, D492); not shipped |
| `packages/sim/lab/imap/Dockerfile` | 11 | An IMAP MCP server; the backend is the official Dovecot image. Credentials come from IMAP_MCP_ACCOUN | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/m1-student/compare.py` | 79 | M1 (D895, docs/research/m1-student.md §2b): the funnel screen of 'pushCheckLocal', task by task, on  | compare, m1_data | keep: lab research script (D493, D895); not shipped |
| `packages/sim/lab/m1-student/cpu_bench.py` | 57 | M1 (D893): one push's check on CPU, the student's architecture with int8 dynamic quantization of its | m1_data, torch, transformers | keep: lab research script (D893); not shipped |
| `packages/sim/lab/m1-student/fixtures.py` | 75 | M1 micro track, gate G1: the short real-constraint fixtures as (request, item) pairs a pair model ca | - | keep: lab research script (D908, D930); not shipped |
| `packages/sim/lab/m1-student/g0.py` | 108 | M1 micro track, gate G0 ($0): does a scorer agree with Haiku's push check as closely as Haiku agrees | - | keep: lab research script; not shipped |
| `packages/sim/lab/m1-student/micro.py` | 549 | M1 micro track (D980-D989): micro CPU checkers distilled from the 8B teacher's scores. Lab only; CPU | datetime, torch, zlib | keep: lab research script (D980, D981, D989); not shipped |
| `packages/sim/lab/m1-student/round_table.py` | 36 | M1 micro track: a round's table from micro.py's logs (one line an epoch) or result files. | - | keep: lab research script; not shipped |
| `packages/sim/lab/m1/manifest-long.json` | 73 | - | - | keep: lab or eval data |
| `packages/sim/lab/m1/manifest-scale.json` | 201 | - | - | keep: lab or eval data |
| `packages/sim/lab/m1/manifest-short-a.json` | 41 | - | - | keep: lab or eval data |
| `packages/sim/lab/m1/manifest-short-b.json` | 41 | - | - | keep: lab or eval data |
| `packages/sim/lab/m1/parts.py` | 183 | M1 (docs/research/m1-lab-scale.md): each arm against 'eden' and 'tools', paired by task and pooled o | numpy | keep: lab research script; not shipped |
| `packages/sim/lab/m1/scale.py` | 87 | M1 (docs/research/m1-lab-scale.md): the default at 995 noise sources against the same tasks at 5 sou | numpy | keep: lab research script; not shipped |
| `packages/sim/lab/m10/arm.sh` | 14 | M10: one funnel arm, its score line and neutral line. Usage: arm.sh SUITES SEEDS NAME [funnel args.. | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/m10/build_set.py` | 37 | M10: one training file of strict items with Haiku labels, splits and aligned targets (lab only). | data | keep: lab research script; not shipped |
| `packages/sim/lab/m10/data.py` | 102 | M10 data: exported items joined with Haiku card labels, family splits, and labels aligned to the rea | hashlib | keep: lab research script (D882); not shipped |
| `packages/sim/lab/m10/evalset.py` | 153 | M10 shared evaluation (lab only): decode a tagger's outputs into cards and score them against Haiku' | data, score | keep: lab research script; not shipped |
| `packages/sim/lab/m10/export_h1.py` | 93 | M10: export a trained sparse tagger (h1_sparse.py's 'model.pt') to the tagger's weights file (lab on | evalset, h1_sparse, torch | keep: lab research script (D960); not shipped |
| `packages/sim/lab/m10/h1_sparse.py` | 218 | M10 H1: hashed sparse linear heads (lab only). The baseline every other hypothesis is measured again | data, datetime, evalset, torch | keep: lab research script; not shipped |
| `packages/sim/lab/m10/make_replay.py` | 63 | M10: a cards-and-requests replay file (cards-disk '{h, c, r}' lines) with the cards swapped (lab onl | - | keep: lab research script; not shipped |
| `packages/sim/lab/m10/score.py` | 82 | M10 field agreement between two card sets on the same items (lab only). | - | keep: lab research script; not shipped |
| `packages/sim/lab/m10/to_cards.py` | 31 | M10: a tagger's raw outputs ('{h, out}') decoded to cards ('{h, c}') with evalset.decode's rules (la | evalset | keep: lab research script; not shipped |
| `packages/sim/lab/m11/bridges.py` | 36 | M11: where the generation head ranks the bridge terms each validation fact needs (Haiku's request te | data, torch | keep: lab research script; not shipped |
| `packages/sim/lab/m11/copygen.py` | 420 | M11 (D970-D979): CopyGen and its variants (H3-H10 of docs/research/m11-intent.md §2), lab only, CPU. | data, screen, torch | keep: lab research script (D970, D979); not shipped |
| `packages/sim/lab/m11/data.py` | 123 | M11 (D970-D979): the training and screening data for the intent micro-expansion model. | - | keep: lab research script (D970, D979); not shipped |
| `packages/sim/lab/m11/decode.py` | 29 | M11: re-decode a saved CopyGen with other decode settings (no training). python3 -I decode.py NET.pt | data, torch | keep: lab research script; not shipped |
| `packages/sim/lab/m11/export.py` | 175 | M11: export a trained CopyGen (copygen.py --save) to the engine's model file, with a numpy reference | copygen, data, numpy, torch | keep: lab research script; not shipped |
| `packages/sim/lab/m11/funnel_arms.py` | 40 | M11: compare funnel JSONs (base first) by suite: hidden surfaced, decoys surfaced, pushHanded, neutr | - | keep: lab research script; not shipped |
| `packages/sim/lab/m11/prefilter.ts` | 16 | M11: the card keys of export items the card prefilter ('worthCarding') passes. | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/lab/m11/screen.py` | 178 | M11's offline screen (lab only): how an expansion changes which items a request reaches, on the scre | data | keep: lab research script; not shipped |
| `packages/sim/lab/m11/stem.ts` | 20 | M11: adds 'target' (each request stemmed as the engine's 'intentTerms') to m11-enrich.ts's lines; dr | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/lab/m11/train.py` | 520 | M11 (D970-D979): intent micro-expansion models. Item in (hashed n-grams), weighted request terms out | data, screen, torch | keep: lab research script (D970, D979); not shipped |
| `packages/sim/lab/m12/ceiling.py` | 83 | M12: the ceiling of candidate channels over the funnel's own pools (sim fit suites, $0). | data, numpy, torch | keep: lab research script; not shipped |
| `packages/sim/lab/m12/data.py` | 120 | M12 (D1000-D1009, docs/research/m12-pool.md): data for the pool models. | gzip, numpy, scipy | keep: lab research script (D1000, D1009); not shipped |
| `packages/sim/lab/m12/export_pair.py` | 140 | M12: a binary pairnet (pairnet.py, without --float) as the engine's EP12 file (pool-pair.ts), with p | data, numpy, struct, torch, zlib | keep: lab research script; not shipped |
| `packages/sim/lab/m12/export_table.py` | 52 | M12: a lowrank expansion model (train.py --model lowrank) as the engine's EM12 table (pool-expand.ts | struct, torch | keep: lab research script; not shipped |
| `packages/sim/lab/m12/pair-parity.ts` | 57 | M12: the engine's EP12 forward ('loadPoolPair') against export_pair.py's PyTorch-path cases: every r | typed arrays; sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/lab/m12/pairnet.py` | 514 | M12 H8 (D1000-D1009): a request x item scorer distilled from M1's 8B teacher, as the pool's tail-sea | data, numpy, torch, unicodedata, zlib | keep: lab research script (D1000, D1009); not shipped |
| `packages/sim/lab/m12/pool-expand.ts` | 115 | M12 (lab only; D1001 rejected the trial 'poolExpand' and deleted its engine wiring; docs/research/m1 | typed arrays | keep: lab (D1001); not in the image since D1700 |
| `packages/sim/lab/m12/pool-pair.ts` | 233 | M12 (lab only; D1002 rejected the trial 'poolScan' and deleted its engine wiring; docs/research/m12- | typed arrays | keep: lab (D1002); not in the image since D1700 |
| `packages/sim/lab/m12/poolscore.py` | 64 | M12: hidden and decoys in the push's pool (pushPoolAt >= 0) and neutral packets, from funnel --json  | - | keep: lab research script; not shipped |
| `packages/sim/lab/m12/prf.py` | 76 | M12 H4 screen: pseudo-relevance feedback from the push pool's own head, on the funnel's sim worlds ( | data, numpy | keep: lab research script; not shipped |
| `packages/sim/lab/m12/rerank.py` | 192 | M12 H3 (D1000-D1009): the pool's tail seats re-ranked over the engine's wide candidates ('pushWide'  | numpy, torch, unicodedata | keep: lab research script (D1000, D1009); not shipped |
| `packages/sim/lab/m12/train.py` | 414 | M12 (D1000-D1009): query-side expansion distilled from M1's 8B teacher, with an offline pool screen. | data, numpy, torch, zlib | keep: lab research script (D1000, D1009); not shipped |
| `packages/sim/lab/m13/bench.ts` | 32 | M13: the TypeScript gate's time a turn (mean and p99 over the dev turns, after a warm-up) and its lo | typed arrays; sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/lab/m13/build.py` | 109 | M13: assemble the gate's training, dev and held-out files from every source, each row | - | keep: lab research script (D920); not shipped |
| `packages/sim/lab/m13/dump_suites.ts` | 30 | M13: the train suites' request texts (hidden variant; control and neutral share them) as JSONL '{tex | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/lab/m13/export.py` | 81 | M13: export a trained bag or mil gate (gate.py) to the engine's flat file ('turn-gate.bin'), with th | gate, numpy, score, torch | keep: lab research script; not shipped |
| `packages/sim/lab/m13/feats.py` | 118 | M13 gate features: hashed character and word n-grams of one user turn, with no tokenizer and no pret | unicodedata | keep: lab research script; not shipped |
| `packages/sim/lab/m13/fixtures-2.json` | 230 | - | - | keep: lab or eval data |
| `packages/sim/lab/m13/fixtures.json` | 314 | - | - | keep: lab or eval data |
| `packages/sim/lab/m13/fixtures.ts` | 26 | M13: the hard-gate fixtures (fixtures.json, fixtures-2.json) through the engine's shipped gate with  | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/lab/m13/fpair.py` | 47 | M13: the funnel's push with and without 'pushGate', task by task: planted facts handed by the push ( | - | keep: lab research script; not shipped |
| `packages/sim/lab/m13/gate.py` | 390 | M13 gate harness: train one architecture on .local/m13/sets/train.jsonl, select its threshold on dev | feats, gzip, torch | keep: lab research script (D907); not shipped |
| `packages/sim/lab/m13/gen_blind4.py` | 96 | M13 blind set 4: user messages to a personal assistant in nine languages, written by Haiku from this | concurrent, haiku | keep: lab research script; not shipped |
| `packages/sim/lab/m13/gen_blind5.py` | 105 | M13 blind set 5 (addendum B): set 4's brief with stricter definitions, new seeds, and an English par | concurrent, haiku | keep: lab research script; not shipped |
| `packages/sim/lab/m13/gen_extra.py` | 66 | M13 round 3 training additions (addendum B): the turn types round 2 missed, in the nine bar language | concurrent, gen_train, haiku | keep: lab research script (D1014); not shipped |
| `packages/sim/lab/m13/gen_logs.py` | 38 | M13 training set, pasted text: log lines, errors, CI and shell output, alerts and notifications a us | concurrent, haiku | keep: lab research script; not shipped |
| `packages/sim/lab/m13/gen_train.py` | 129 | M13 training set: contrastive sets of user turns written by Haiku. Each set holds eight messages abo | concurrent, haiku | keep: lab research script; not shipped |
| `packages/sim/lab/m13/haiku.py` | 45 | M13: one Haiku call through the Anthropic API (HAIKU_API_KEY, never printed), with a spend ledger an | haiku | keep: lab research script; not shipped |
| `packages/sim/lab/m13/parity.ts` | 27 | M13: the TypeScript gate against PyTorch's own logits on export.py's 64 parity rows: the same decisi | typed arrays; sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/lab/m13/pi.sh` | 19 | M13 (docs/research/m13-gate.md §0, bar 5): one pi-ab process for the pair 'eden' against 'eden~G' (' | - | keep: lab (D878); not in the image since D1700 |
| `packages/sim/lab/m13/probe.ts` | 46 | M13 (addendum C): the short throwaway turns the review found the round-3 gate starting a push on, re | typed arrays; sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/lab/m13/rules.ts` | 21 | M13: the shipped push gate ('pushStart' with the default's switches) over a JSONL of '{text, ...}' r | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/lab/m13/score.py` | 135 | M13: score a FROZEN gate on the held-out sets against the shipped rule, and apply the pre-registered | feats, gate, subprocess, torch | keep: lab research script (D1011); not shipped |
| `packages/sim/lab/m14/hashnet.py` | 237 | The LOGO screen's reference model (M14, D1022): a small hashed-n-gram network of the micro models' s | logo_core, torch, zlib | keep: lab research script (D908, D909, D1022); not shipped |
| `packages/sim/lab/m14/lengthcue.py` | 38 | A length-only model for the LOGO screen (M14): scores an item by its character length and nothing el | logo_core | keep: lab research script (D908); not shipped |
| `packages/sim/lab/m14/logo_core.py` | 264 | LOGO core (M14, D1021): the leave-one-generator-out screen's data, splits, metrics and text transfor | hashlib | keep: lab research script (D488, D908, D909, D1021); not shipped |
| `packages/sim/lab/m14/logo.py` | 242 | Leave-one-generator-out screen (M14, D1021): does a micro model hold up on text written differently  | importlib, logo_core | keep: lab research script (D908, D1021); not shipped |
| `packages/sim/lab/m14/padcue.py` | 38 | A boilerplate-only model for the length-debiased M2 (M14, D1024): scores an item by the characters o | lengthcue | keep: lab research script (D1024); not shipped |
| `packages/sim/lab/m14/run_grid.sh` | 20 | The M14 recipe grid (D1023): each recipe a LOGO run over the four sources, four runs side by side, o | - | keep: lab (D1023); not in the image since D1700 |
| `packages/sim/lab/m3r/binnet.py` | 934 | M3 binarised networks (D907): small local test runs on CPU, one architecture per Eden spot, each wit | numpy, torch | keep: lab research script (D907, D908); not shipped |
| `packages/sim/lab/m3r/cpu_bench.py` | 94 | M3 retriever (D900): CPU cost of a trained model, one thread (the request path's share of a core). | numpy, onnxruntime, torch, transformers | keep: lab research script (D900); not shipped |
| `packages/sim/lab/m3r/daysstat.py` | 31 | M3 retriever: where each days request's planted item (hidden) or decoy (control) ranks in the push's | - | keep: lab research script (D900); not shipped |
| `packages/sim/lab/m3r/export_groups.py` | 96 | M3 TwinXor (D907): training and eval groups for the neural scorer, from frames.py's symbolic candida | framerank, frames, multiprocessing | keep: lab research script (D907); not shipped |
| `packages/sim/lab/m3r/export_net.py` | 88 | M3 (D907): export a trained binnet 'supersede' or 'tags' network (binnet.py --save) to flat files a  | binnet, numpy, torch | keep: lab research script (D907); not shipped |
| `packages/sim/lab/m3r/framerank.py` | 224 | M3 FrameRank (D906): train and evaluate the no-embedding ranker over frames.py's candidates. | frames, lightgbm, numpy, qexpand | keep: lab research script (D906); not shipped |
| `packages/sim/lab/m3r/frames.py` | 235 | M3 FrameRank (D906, docs/research/m3-arch.md §5): no embeddings anywhere. Each item becomes a frame  | - | keep: lab research script (D906); not shipped |
| `packages/sim/lab/m3r/h10_pool_pairs.py` | 37 | M3b (D914): H10's engine-drawn pairs. The 'pushSupersede' trial scores, for each handed candidate, e | - | keep: lab research script (D914); not shipped |
| `packages/sim/lab/m3r/h10-forward.ts` | 324 | M3b (D907 follow-on): H10's compressed supersession network in plain TypeScript, from 'h10.py export | typed arrays; sync fs | keep: lab (D907, D914); not in the image since D1700 |
| `packages/sim/lab/m3r/h10.py` | 537 | M3b (D907 follow-on): make H10, the supersession pair network, small and fast without losing the flo | binnet, numpy, torch | keep: lab research script (D907, D914); not shipped |
| `packages/sim/lab/m3r/m2_worlds.py` | 68 | M3 (D900): M2's synthetic worlds ('eden-synth' v0, split by family) as M3's training worlds and as a | qexpand | keep: lab research script (D900); not shipped |
| `packages/sim/lab/m3r/ort-bench.ts` | 26 | const model = process.argv[2]!; | onnxruntime-node | keep: lab; not in the image since D1700 |
| `packages/sim/lab/m3r/poolstat.py` | 29 | M3 retriever: recall of the push's lexical pool from a funnel '--pool-dump' (last pass a task), by v | - | keep: lab research script; not shipped |
| `packages/sim/lab/m3r/prep.py` | 63 | M3 retriever (D900): the eval set, joined from $0 dumps (simulated worlds only). | - | keep: lab research script (D900); not shipped |
| `packages/sim/lab/m3r/qexpand.py` | 132 | M3 (D902): query-side term expansion learned as a lookup table, no model anywhere: from training wor | - | keep: lab research script (D902); not shipped |
| `packages/sim/lab/m3r/score.py` | 99 | M3 retriever (D900): recall of the planted item (hidden) and the decoy (control) at 5 and 15, for Ed | - | keep: lab research script (D900); not shipped |
| `packages/sim/lab/m3r/short_fixture.py` | 67 | M3 (D908): the tagger's length-invariance gate fixture, short real constraints built deterministical | - | keep: lab research script (D908); not shipped |
| `packages/sim/lab/m3r/synth_worlds.py` | 93 | M3 retriever (D900): 'm3-synth.ts''s generated templates as training worlds, in m3-export.ts's forma | sklearn | keep: lab research script (D900); not shipped |
| `packages/sim/lab/m3r/ts-layer-bench.ts` | 111 | One BERT layer (bge-small shape: d 384, 12 heads, FFN 1536) at T tokens, plain TypeScript loops: fp3 | typed arrays | keep: lab; not in the image since D1700 |
| `packages/sim/lab/m3r/twin-forward.ts` | 163 | M3 (D907): the binnet 'supersede' (H10) and 'tags' (H13) networks in plain TypeScript, from export_n | typed arrays; sync fs | keep: lab (D907); not in the image since D1700 |
| `packages/sim/lab/m3r/widen_table.py` | 45 | M3 retriever (D901): cross-fitted rank tables for the 'pushRetrieve' trial. Each request gets the ra | - | keep: lab research script (D901); not shipped |
| `packages/sim/lab/m3r/xnor-bench.ts` | 142 | M3 (D907): the binarised scorer's CPU kernels in plain TypeScript, timed. Shapes are TwinXor's local | typed arrays | keep: lab (D907); not in the image since D1700 |
| `packages/sim/lab/m4/nudge.py` | 172 | M4 (docs/research/m4-nudge.md): the ask nudge's paired effect, 'eden − eden~minus-nudge', Haiku-grad | numpy | keep: lab research script; not shipped |
| `packages/sim/lab/m5/go.sh` | 16 | M5 (docs/research/m5-nudge-narrow.md): lab_fanout pi-ab on train, Haiku 5.5 in every role, arms eden | - | keep: lab (D440, D460); not in the image since D1700 |
| `packages/sim/lab/m5/m5_match.py` | 347 | M5 (D910-D912, docs/research/m5-ledger.md): the standing-constraint ledger matched against a request | datetime | keep: lab research script (D526, D910, D912); not shipped |
| `packages/sim/lab/m5/manifest-long-a.json` | 25 | - | - | keep: lab or eval data |
| `packages/sim/lab/m5/manifest-long-b.json` | 25 | - | - | keep: lab or eval data |
| `packages/sim/lab/m5/manifest-short-a.json` | 25 | - | - | keep: lab or eval data |
| `packages/sim/lab/m5/manifest-short-b.json` | 25 | - | - | keep: lab or eval data |
| `packages/sim/lab/m5/narrow.py` | 188 | M5 (docs/research/m5-nudge-narrow.md): the narrower nudge's paired effect, 'eden~deep − eden' (askNu | numpy | keep: lab research script (D460); not shipped |
| `packages/sim/lab/m5/screen.py` | 38 | M5 (docs/research/m5-nudge-narrow.md): the $0 trigger screen. Per task of a funnel --pool-dump (hidd | - | keep: lab research script; not shipped |
| `packages/sim/lab/m6/baselines.py` | 26 | M6: the no-model baselines on the offline screen (B0 shipped, B1 pick at smaller budgets, title only | m6lib | keep: lab research script; not shipped |
| `packages/sim/lab/m6/cands.py` | 718 | M6 (D920-D921): the trimmer candidates H1-H9 (docs/research/m6-trimmer.md §3), one trainer, CPU torc | base64, copy, lightgbm, m6lib, numpy | keep: lab research script (D920, D921); not shipped |
| `packages/sim/lab/m6/m6lib.py` | 163 | M6 (D920-D921): shared pieces for the trimmer's trainers and screen. Pure Python + numpy; no pretrai | zlib | keep: lab research script (D920, D921); not shipped |
| `packages/sim/lab/m6/prep.py` | 105 | M6 (D920-D921): the trimmer's part dataset from '--packets --packet-parts' dumps and label.ts's labe | hashlib | keep: lab research script (D920, D921); not shipped |
| `packages/sim/lab/m6/screen_funnel.py` | 101 | M6 (D920-D921): the pre-registered offline screen on real funnel packets (the engine's trimmer in th | m6lib, prep | keep: lab research script (D920, D921); not shipped |
| `packages/sim/lab/m7/.gitignore` | 4 | M3 tagger copy (from claude/m3-retriever) until it is on main | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/m7/fixtures.json` | 29 | - | - | keep: lab or eval data |
| `packages/sim/lab/m7/fixtures.py` | 25 | M7 (D930, D932): fixtures.json -> check-dump rows (one pool a case), for m7.py --fixtures. | - | keep: lab research script (D930, D932); not shipped |
| `packages/sim/lab/m7/m7.py` | 569 | M7 (D930, D931; rejected): the push check's pre-screen, trained and screened offline (docs/research/ | lightgbm, numpy, scipy, sklearn, zlib | keep: lab research script (D930, D931); not shipped |
| `packages/sim/lab/m7/nets.py` | 348 | M7 (D930): the pre-screen's neural candidates (round 1/2), on m7.py's rows, thresholds and settle ru | m7, numpy, sklearn, torch, zlib | keep: lab research script (D930); not shipped |
| `packages/sim/lab/m7/self-agree.ts` | 78 | M7 (D930): the check's agreement with itself. Re-asks a sample of recorded check calls ('--check-dum | sync fs | keep: lab (D97, D930); not in the image since D1700 |
| `packages/sim/lab/m7/tag-dump.ts` | 34 | M7 (D930): the constraint tagger's nine logits for every item of a '--check-dump' file, as the engin | sync fs | keep: lab (D908, D930); not in the image since D1700 |
| `packages/sim/lab/m8/harness.py` | 324 | M8 router harness (D940-D949; docs/research/m8-router.md): offline examples, online per-user replay, | numpy | keep: lab research script (D940, D949); not shipped |
| `packages/sim/lab/m8/routers.py` | 603 | M8 router candidates (round 1). Each is trained on M2 v2 train worlds and scored by harness.main_eva | harness, numpy | keep: lab research script (D265); not shipped |
| `packages/sim/lab/m8/train_router.py` | 520 | M8: trains the engine's connector router (packages/engine/src/router.ts) and writes its weights file | numpy, struct | keep: lab research script; not shipped |
| `packages/sim/lab/m9/ceiling.py` | 38 | M9: how many missed facts have per-user evidence at all? For a missed fact F and request Q: a 2-hop  | data | keep: lab research script; not shipped |
| `packages/sim/lab/m9/data.py` | 40 | M9 (D950-D959, docs/research/m9-alias.md): shared loaders for the alias resolver's offline screen. | - | keep: lab research script (D950, D959); not shipped |
| `packages/sim/lab/m9/links.py` | 241 | M9 (D950-D959, docs/research/m9-alias.md): per-user link structures learned from one user's own item | unicodedata | keep: lab research script (D950, D959); not shipped |
| `packages/sim/lab/m9/oracle_shared.py` | 57 | M9: ceiling of SHARED bridges (not per-user): a term-pair table learned on fit templates only (reque | data | keep: lab research script; not shipped |
| `packages/sim/lab/m9/oracle.py` | 32 | M9: the ceiling of a candidate generator. Of the facts outside the shipped pool's first five, how ma | data | keep: lab research script; not shipped |
| `packages/sim/lab/m9/screen.py` | 210 | M9 hypotheses screen ($0, no model): each hypothesis is a per-user link structure (links.py) that tu | data, links | keep: lab research script; not shipped |
| `packages/sim/lab/mcpvault/Dockerfile` | 10 | mcpvault over an Obsidian-style vault (a folder of Markdown), mounted at /vault, started read-only. | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/meilisearch/Dockerfile` | 8 | The official Meilisearch MCP server; the backend is the official Meilisearch image (MEILI_HTTP_ADDR) | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/memory/Dockerfile` | 12 | The reference knowledge-graph memory server. Its store is one JSONL file, mounted at /data. | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/n1/go.sh` | 16 | go.sh RUN SEEDS CAP CONDITIONS VARIANT_CONFIG [EXTRA...]: lab_fanout pi-ab at 1,000 sources (995 noi | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/n1/manifest-long-first.json` | 57 | - | - | keep: lab or eval data |
| `packages/sim/lab/n1/manifest-long-fix.json` | 57 | - | - | keep: lab or eval data |
| `packages/sim/lab/n1/manifest-short-first.json` | 41 | - | - | keep: lab or eval data |
| `packages/sim/lab/n1/manifest-short-fix.json` | 41 | - | - | keep: lab or eval data |
| `packages/sim/lab/n1/pair.sh` | 18 | pair.sh RUN [RUN...]: the paired connector-call and hidden effects of eden~yield against eden over t | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/n1/qrun.sh` | 12 | qrun.sh NAME LOST CONFIG [extra flags]: quality-cli (stale and deleted deliveries), 16 users x 20 se | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/n1/user-day.py` | 19 | N1: source-days.bench.ts JSONs, connector calls a user a day over days 2-8. | - | keep: lab research script; not shipped |
| `packages/sim/lab/n1b/bench.json` | 855 | -0.007515657620041753, | - | keep: lab or eval data |
| `packages/sim/lab/n1b/manifest-long-47-48.json` | 25 | - | - | keep: lab or eval data |
| `packages/sim/lab/n1b/manifest-long.json` | 57 | - | - | keep: lab or eval data |
| `packages/sim/lab/n1b/manifest-short-41.json` | 41 | - | - | keep: lab or eval data |
| `packages/sim/lab/n1b/manifest-short-45.json` | 41 | - | - | keep: lab or eval data |
| `packages/sim/lab/n1b/manifest-short-49.json` | 169 | - | - | keep: lab or eval data |
| `packages/sim/lab/n1b/manifest-smoke.json` | 17 | - | - | keep: lab or eval data |
| `packages/sim/lab/n1b/report.sh` | 47 | N1b: the reports over the fan-outs' shards (.local/modal/n1b-*). 'report.sh regrade' first (Sonnet o | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/n1b/run.sh` | 19 | N1b (docs/research/n1b-yield-bench.md): the paid runs, as registered. Needs the Modal client in .loc | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/n2/compare.py` | 133 | N2's funnel comparisons (D510-D513, docs/research/n2-recall.md §1), lab only. | hashlib | keep: lab research script (D510, D513); not shipped |
| `packages/sim/lab/n3/day-cluster.py` | 52 | N3 (D519): paired differences over 'pi-ab --days' runs with whole days resampled (a day's requests s | - | keep: lab research script (D519); not shipped |
| `packages/sim/lab/n3/late-copy.py` | 15 | N3 (H2): a copy of a '--late' results file for regrade.ts, each late-planted request's 'answer' set  | - | keep: lab research script; not shipped |
| `packages/sim/lab/n3/late.py` | 112 | N3 (docs/research/n3-long.md, H2): 'pi-ab --day K --late' over many seeds. Per arm and kind: the pla | - | keep: lab research script; not shipped |
| `packages/sim/lab/n3/settle.py` | 43 | N3 (H1, docs/research/n3-long.md): 'takeSettleMs' on Pi. Per arm: tasks, asks, the waits before a re | - | keep: lab research script; not shipped |
| `packages/sim/lab/n3/stems.sh` | 12 | N3: a Modal fan-out's shards (.local/modal/RUN/<shard>/out.json, out.timeline/) as the STEM.json and | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/n3/tokens.py` | 50 | N3 (docs/research/n3-long.md): each arm's agent bill by Anthropic token class over 'pi-ab --days' ru | - | keep: lab research script; not shipped |
| `packages/sim/lab/n4/new-user.sh` | 13 | N4 (docs/research/n4-agents.md) part B: a new user's first card calls, one lane against two and four | - | keep: lab (D521); not in the image since D1700 |
| `packages/sim/lab/n4/run.sh` | 14 | N4 (docs/research/n4-agents.md) part A: a stronger model as the Pi AGENT. AGENT LABEL CONDITIONS the | - | keep: lab (D271); not in the image since D1700 |
| `packages/sim/lab/n4/tokens.py` | 34 | N4 (docs/research/n4-agents.md): the agent's bill per 1,000 tasks by Anthropic token class (plain in | - | keep: lab research script; not shipped |
| `packages/sim/lab/n5/days_hidden.py` | 61 | N5: hidden facts raised over a '--days' run, an arm against 'eden', with whole users resampled (D519 | - | keep: lab research script (D519); not shipped |
| `packages/sim/lab/n5/mix.py` | 93 | N5 (docs/research/n5-widen-check.md): an arm against 'eden', paired task by task, for cost and wall. | - | keep: lab research script (D519); not shipped |
| `packages/sim/lab/o1/earn/bench.json` | 855 | -0.00303951367781155, | - | keep: lab or eval data |
| `packages/sim/lab/o1/earn/manifest-long.json` | 73 | - | - | keep: lab or eval data |
| `packages/sim/lab/o1/earn/manifest-short-41.json` | 41 | - | - | keep: lab or eval data |
| `packages/sim/lab/o1/earn/manifest-short-45-64.json` | 169 | - | - | keep: lab or eval data |
| `packages/sim/lab/o1/earn2/bench.json` | 855 | -0.005319148936170213, | - | keep: lab or eval data |
| `packages/sim/lab/o1/earn2/manifest-long.json` | 73 | - | - | keep: lab or eval data |
| `packages/sim/lab/o1/earn2/manifest-short-41.json` | 41 | - | - | keep: lab or eval data |
| `packages/sim/lab/o1/earn2/manifest-short-45-64.json` | 169 | - | - | keep: lab or eval data |
| `packages/sim/lab/o1/earn2d/bench.json` | 230 | -0.008522727272727272, | - | keep: lab or eval data |
| `packages/sim/lab/o1/earn2d/manifest-49-54.json` | 57 | - | - | keep: lab or eval data |
| `packages/sim/lab/o1/earn2d/manifest-55-60.json` | 57 | - | - | keep: lab or eval data |
| `packages/sim/lab/o1/earn2d/manifest-61-66.json` | 57 | - | - | keep: lab or eval data |
| `packages/sim/lab/o1/earn2d/manifest-67-72.json` | 57 | - | - | keep: lab or eval data |
| `packages/sim/lab/o1/earn2t/bench.json` | 855 | -0.017331721080209594, | - | keep: lab or eval data |
| `packages/sim/lab/o1/earn2t/manifest-long.json` | 73 | - | - | keep: lab or eval data |
| `packages/sim/lab/o1/earn2t/manifest-short-41.json` | 41 | - | - | keep: lab or eval data |
| `packages/sim/lab/o1/earn2t/manifest-short-45-64.json` | 169 | - | - | keep: lab or eval data |
| `packages/sim/lab/o1/report.sh` | 52 | O1: the reports over a preset's fan-out shards (.local/modal/o1-PRESET-*). 'report.sh PRESET ARM reg | - | keep: lab (D603); not in the image since D1700 |
| `packages/sim/lab/o1/run.sh` | 28 | O1 (docs/research/o1-earn.md): the paid runs, as registered. Needs the Modal client in .local/venv-m | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/o4/new-user.py` | 25 | O4 (docs/research/o4-new-user.md): a new user's hidden facts by seconds since connect. | - | keep: lab research script; not shipped |
| `packages/sim/lab/o5/all.sh` | 9 | O5: every train suite of one seed through run.sh, one process each, skipping those whose results exi | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/o5/mutate-park.py` | 39 | Mutation check of park.test.ts (D754): each mutation of SourceFanout.park must make the file fail. | subprocess | keep: lab research script (D754); not shipped |
| `packages/sim/lab/o5/mutate-sync-kick.py` | 62 | Mutation check of sync-kick.test.ts: each mutation of the engine must make the file fail. | subprocess | keep: lab research script; not shipped |
| `packages/sim/lab/o5/new-user-pi.py` | 106 | O5 (docs/research/o4-new-user.md 6a): the paid check of syncKick on new users, from pi-ab --connect- | - | keep: lab research script; not shipped |
| `packages/sim/lab/o5/run.sh` | 20 | O5 (docs/research/o4-new-user.md §6a): the paid check of 'syncKick' on new users. SEED LABEL LIMIT S | - | keep: lab (D97); not in the image since D1700 |
| `packages/sim/lab/p2/blind-gate-1.json` | 308 | - | - | keep: lab or eval data |
| `packages/sim/lab/p2/blind-gate-2.json` | 263 | - | - | keep: lab or eval data |
| `packages/sim/lab/p2/blind-gate-3.json` | 253 | - | - | keep: lab or eval data |
| `packages/sim/lab/p2/calls.py` | 62 | P2: the push check's calls by run label from a spend ledger, and a stop sequence simulated on record | - | keep: lab research script; not shipped |
| `packages/sim/lab/p2/compare_rw.py` | 66 | P2's funnel comparison across the reworded train (D820, docs/research/p2-push-check.md), lab only. | - | keep: lab research script (D820); not shipped |
| `packages/sim/lab/p2/packet_reread.py` | 89 | P2 (weak point C1): how many packet characters the agent reads again over a day, per arm, from pi-ab | - | keep: lab research script (D336); not shipped |
| `packages/sim/lab/p3/a2-core-grade.json` | 764 | - | - | keep: lab or eval data |
| `packages/sim/lab/p3/ab.sh` | 26 | P3 baselines (a) and (b) (docs/research/p3-baselines.md §1): every run of the pre-registration, each | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/p3/b2.sh` | 17 | P3 (b2) (docs/research/p3-baselines.md §7): the hits arm again with its own prompt and Eden's compac | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/p3/b3.sh` | 13 | P3 (b3) (docs/research/p3-baselines.md §9): eden against hits over days on 32 more fresh users, two  | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/p3/b4.sh` | 12 | P3 (b4) (docs/research/p3-baselines.md §10): eden against hits one request a session on fresh seeds  | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/p3/pointer.sh` | 16 | P3 (c) (docs/research/p3-baselines.md §2): the pointer's days run, users w73-w104, two processes at  | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/p3/pool.py` | 52 | P3 weak point 2: where each hidden (or control) request's planted item was in the push's pool over a | - | keep: lab research script; not shipped |
| `packages/sim/lab/p3/report.py` | 185 | P3 (docs/research/p3-baselines.md): the readout of baselines (a), (b) and (c) from pi-ab runs. | - | keep: lab research script; not shipped |
| `packages/sim/lab/p3/run.sh` | 21 | P3 (docs/research/p3-baselines.md): one pi-ab process. AGENT LABEL then pi-ab flags. N4's run.sh (pa | - | keep: lab (D271); not in the image since D1700 |
| `packages/sim/lab/radicale/Dockerfile` | 8 | Radicale, a small open-source CalDAV server, as the calendar backend. No auth: it only listens on th | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/realuse-1/A/funnel-heldout14.json` | 94 | - | - | keep: lab or eval data |
| `packages/sim/lab/realuse-1/A/t1-summary.json` | 948 | - | - | keep: lab or eval data |
| `packages/sim/lab/realuse-1/A/t1.py` | 402 | RealUse-1 part A: the T1 metrics of docs/research/benchmark-realuse-1.md from pi-ab.ts results files | - | keep: lab research script; not shipped |
| `packages/sim/lab/realuse-1/B/ablate-variants.json` | 2 | - | - | keep: lab or eval data |
| `packages/sim/lab/realuse-1/B/analysis.json` | 1 | - | - | keep: lab or eval data |
| `packages/sim/lab/realuse-1/B/analyze.py` | 192 | RealUse-1 part B: the T1 metrics per arm, per suite and pooled, with paired bootstrap 95% intervals. | - | keep: lab research script; not shipped |
| `packages/sim/lab/realuse-1/B/run.sh` | 15 | usage: run.sh LABEL SUITE SEED PROFILE CONDITIONS [extra args...] | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/realuse-1/B/runs.json` | 830 | - | - | keep: lab or eval data |
| `packages/sim/lab/realuse-1/B/tables.py` | 25 | d=json.load(open(sys.argv[1])) | - | keep: lab research script; not shipped |
| `packages/sim/lab/realuse-1/C/summary.json` | 84 | - | - | keep: lab or eval data |
| `packages/sim/lab/realuse-1/D/probes/ask-honesty-probe.ts` | 137 | RealUse-1 part D, T5: does an ask say "could not reach" honestly when connectors fail (D127)? No mod | - | keep: lab (D127, D212); not in the image since D1700 |
| `packages/sim/lab/realuse-1/D/probes/injection-probe.ts` | 127 | RealUse-1 part D, T6: injection inertness, end to end, no model. Source items whose title or text ca | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/realuse-1/D/probes/privacy-probe.ts` | 207 | RealUse-1 part D, T6: a ReDoS probe and a secret-shape probe over the secret gate, no model. | - | keep: lab (D220); not in the image since D1700 |
| `packages/sim/lab/realuse-1/D/t2-decisions.json` | 996 | - | - | keep: lab or eval data |
| `packages/sim/lab/realuse-1/D/t3-freshness.json` | 215 | - | - | keep: lab or eval data |
| `packages/sim/lab/realuse-1/D/t5-robustness.json` | 2243 | - | - | keep: lab or eval data |
| `packages/sim/lab/realuse-1/D/t6-privacy.json` | 572 | - | - | keep: lab or eval data |
| `packages/sim/lab/realuse-1/D/t7-eval-live.json` | 155 | - | - | keep: lab or eval data |
| `packages/sim/lab/realuse-1/E/results.json` | 5073 | - | - | keep: lab or eval data |
| `packages/sim/lab/realuse-2/hermes/run.sh` | 13 | cd "$(git rev-parse --show-toplevel)" | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/realuse-2/pi/arms.py` | 75 | Per-arm figures for RealUse-2's Pi heldout15 run, from pi-ab's result JSONs and timelines (A-heldout | - | keep: lab research script; not shipped |
| `packages/sim/lab/realuse-2/pi/funnel-h15.summary.json` | 4216 | - | - | keep: lab or eval data |
| `packages/sim/lab/realuse-2/pi/pairs.py` | 37 | Paired bootstrap 95% intervals over tasks for RealUse-2's Pi heldout15 run (fix-s3b/pair.py's method | - | keep: lab research script; not shipped |
| `packages/sim/lab/realuse-2/pi/r2-pi-41.summary.json` | 1 | - | - | keep: lab or eval data |
| `packages/sim/lab/realuse-2/pi/r2-pi-42.summary.json` | 1 | - | - | keep: lab or eval data |
| `packages/sim/lab/realuse-2/pi/r2-pi-43.summary.json` | 1 | - | - | keep: lab or eval data |
| `packages/sim/lab/realuse-2/pi/r2-pi-44.summary.json` | 1 | - | - | keep: lab or eval data |
| `packages/sim/lab/realuse-3/hermes/h16-41.summary.json` | 1 | - | - | keep: lab or eval data |
| `packages/sim/lab/realuse-3/hermes/h16-42.summary.json` | 1 | - | - | keep: lab or eval data |
| `packages/sim/lab/realuse-3/hermes/run.sh` | 14 | cd "$(git rev-parse --show-toplevel)" | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/realuse-3/pi/cold-user.json` | 162 | - | - | keep: lab or eval data |
| `packages/sim/lab/realuse-3/pi/concerns.py` | 52 | RealUse-3 (docs/research/realuse-3/pi-heldout16.md): control and neutral concerns per arm, as the ru | - | keep: lab research script; not shipped |
| `packages/sim/lab/realuse-3/pi/run.sh` | 12 | RealUse-3 on Pi, heldout16 blind (docs/research/realuse-3/pi-heldout16.md): LABEL PUSH CONDITIONS th | - | keep: lab; not in the image since D1700 |
| `packages/sim/lab/retrieval-screen.json` | 213 | - | - | keep: lab or eval data |
| `packages/sim/lab/scripts/funnel-score.py` | 23 | d=json.load(open(f)); pt=d['perTask'] | - | keep: lab research script; not shipped |
| `packages/sim/lab/scripts/haiku-bench.py` | 159 | The Haiku benchmark's tables, from pi-ab / hermes-ab results files, their timelines and the spend le | - | keep: lab research script; not shipped |
| `packages/sim/lab/scripts/reader-score.py` | 51 | Reader metrics on a funnel JSON, against a baseline funnel JSON on the same tasks. | - | keep: lab research script; not shipped |
| `packages/sim/lab/servers.json` | 36 | - | - | keep: lab or eval data |
| `packages/sim/lab/subagent/batch.ts` | 303 | The queue transport's batcher (F9, D1101; README.md here, ../../src/lab/queue-transport.ts). LAB ONL | sync fs | keep: lab (D1101, D1180); not in the image since D1700 |
| `packages/sim/lab/subagent/fidelity/cards-fidelity.py` | 23 | F9 (D1101): cards-distill score of subagent answers against Haiku's recorded cards, on their rows on | - | keep: lab research script (D1101); not shipped |
| `packages/sim/lab/subagent/fidelity/check-agree.py` | 22 | F9 (D1101): the push check served twice by subagents, first answers in Q/done and second in R*.answe | - | keep: lab research script (D1101); not shipped |
| `packages/sim/lab/subagent/fidelity/check-fidelity.py` | 133 | F9 (D1101): how far subagent-served push checks agree with the recorded API check, on F2's pilot row | - | keep: lab research script (D1101); not shipped |
| `packages/sim/lab/subagent/fidelity/make-examples.ts` | 35 | F9 (D1104): the 12 calibration examples of recipe L2 (recorded API replies from the tune half, outsi | sync fs | keep: lab (D1104); not in the image since D1700 |
| `packages/sim/lab/subagent/fidelity/paired-delta.py` | 105 | F9 (D1104): the paired-delta check replay, validated against the API's own answers under changed che | importlib | keep: lab research script (D1104); not shipped |
| `packages/sim/lab/subagent/fidelity/random-rows.ts` | 43 | F9 (D1101, D1104): a seeded random sample of recorded API check rows ('--check-dump' lines, e.g. F2' | sync fs | keep: lab (D1101, D1104); not in the image since D1700 |
| `packages/sim/modal/bench_report.py` | 360 | The powered bench's report (F3, D487): paired effects between arms of pi-ab fan-out runs, with tasks | - | keep: lab research script (D487); not shipped |
| `packages/sim/modal/cards_distill.py` | 194 | The background card model distilled into a small open model on Modal (M0, lab tooling): LoRA on Haik | datasets, distill_data, modal, peft, subprocess | keep: lab research script (D235); not shipped |
| `packages/sim/modal/distill_data.py` | 111 | The card distillation's data handling and arithmetic, with no Modal and no ML library in it (M0): ro | - | keep: lab research script; not shipped |
| `packages/sim/modal/embed_score.py` | 213 | The embedding retrieval screen's scoring, with no Modal and no numpy in it (M0): which planted items | - | keep: lab research script; not shipped |
| `packages/sim/modal/embed_screen.py` | 114 | An embedding retrieval screen on Modal (M0, lab tooling): the train suites' corpus dump embedded wit | embed_score, modal, numpy, sentence_transformers | keep: lab research script (D331); not shipped |
| `packages/sim/modal/endpoint_bench.py` | 93 | The distilled card endpoint's latency and throughput (M2, lab tooling, no Modal library): the held-o | concurrent, distill_data, urllib | keep: lab research script; not shipped |
| `packages/sim/modal/fanout_plan.py` | 717 | The lab fan-out's arithmetic, with no Modal in it (M0): shards, the spend cap's split, each shard's  | hashlib, shlex | keep: lab research script (D487, D540, D601, D603, D813, D877); not shipped |
| `packages/sim/modal/i1_checker.py` | 131 | I1 (D470-D474, docs/research/i1-checker.md): a small cross-encoder fine-tuned on Opus-labelled near- | i1_data, inspect, modal, numpy, torch | keep: lab research script (D470, D474); not shipped |
| `packages/sim/modal/i1_data.py` | 79 | I1's data checks and scoring (no Modal, no torch): pairs joined to the teacher's labels, training ta | - | keep: lab research script; not shipped |
| `packages/sim/modal/lab_fanout.py` | 239 | The lab at scale on Modal (M0, lab tooling): pi-ab seeds or funnel shards fanned out over containers | fanout_plan, fcntl, modal, shlex, subprocess | keep: lab research script (D440, D487, D813); not shipped |
| `packages/sim/modal/m1_build.py` | 47 | M1: the student's rows file (no Modal). Train-suite pairs ('i1-label.ts pairs', train only) and, opt | m1_data | keep: lab research script; not shipped |
| `packages/sim/modal/m1_data.py` | 234 | M1 (D890-D899, docs/research/m1-student.md): the distilled "changes the action" student's data and s | hashlib | keep: lab research script (D501, D890, D899); not shipped |
| `packages/sim/modal/m1_serve.py` | 300 | M1 (D893, D894): the student as a lab endpoint, and its latency on each GPU. Lab tooling, not produc | fastapi, gzip, hmac, m1_data, modal | keep: lab research script (D893, D894, D899); not shipped |
| `packages/sim/modal/m1_student.py` | 266 | M1 (D890-D899, docs/research/m1-student.md): an open decoder model (Qwen3, 0.6B-8B, Apache-2.0) fine | m1_data, modal, numpy, peft, torch | keep: lab research script (D490, D890, D899); not shipped |
| `packages/sim/modal/m12_train.py` | 63 | M12 (D1000-D1009): full trainings of the pool models (packages/sim/lab/m12/) on Modal CPU containers | modal, shlex, subprocess | keep: lab research script (D1000, D1009); not shipped |
| `packages/sim/modal/m3_binnet.py` | 63 | M3 (D907): full trainings of the binarised network family (packages/sim/lab/m3r/binnet.py) on Modal  | modal, shlex, subprocess | keep: lab research script (D907); not shipped |
| `packages/sim/modal/m3_retriever.py` | 676 | M3 (D900-D909, docs/research/m3-retriever.md): a small retriever trained on Eden's own question, "wh | gzip, huggingface_hub, modal, numpy, sklearn | keep: lab research script (D712, D900, D903, D909); not shipped |
| `packages/sim/modal/m3_twinslot.py` | 424 | M3-arch (D904, docs/research/m3-arch.md): TwinSlot, a retrieval network built for "which held item b | gzip, modal, numpy, torch, transformers | keep: lab research script (D904); not shipped |
| `packages/sim/modal/m3_twinxor.py` | 259 | M3 TwinXor (D907, docs/research/m3-arch.md §6): a binarised cross-scoring network, trained end to en | gzip, modal, numpy, torch, zlib | keep: lab research script (D907); not shipped |
| `packages/sim/modal/m3b_h10.py` | 61 | M3b (D914): full trainings of H10's compressed students (packages/sim/lab/m3r/h10.py) on Modal CPU c | modal, shlex, subprocess | keep: lab research script (D914); not shipped |
| `packages/sim/modal/m6_trim.py` | 55 | M6 (D920-D921, docs/research/m6-trimmer.md): the packet trimmer's candidates trained on Modal CPU co | gzip, modal, shlex, shutil, subprocess | keep: lab research script (D920, D921); not shipped |
| `packages/sim/modal/m8_router.py` | 73 | M8 (D940-D949, docs/research/m8-router.md): the connector router's full training on Modal, CPU only. | modal, subprocess, tarfile | keep: lab research script (D940, D949); not shipped |
| `packages/sim/modal/synth_data.py` | 235 | M2's synthetic worlds (D880-D884): loading, checks and labelled pairs, for M1 (the changes-what-to-d | datetime, hashlib, synth_data | keep: lab research script (D880, D882, D884); not shipped |
| `packages/sim/modal/synth_store.py` | 108 | M2 (D880-D884): the synthetic-world dataset on the Modal Volume 'eden-synth': upload, validate in a  | hashlib, modal, synth_data | keep: lab research script (D880, D884); not shipped |
| `packages/sim/package.json` | 29 | - | - | keep: lab or eval data |
| `packages/sim/src/demo.ts` | 333 | 'bun run demo': Eden in five minutes, no key, $0 (D292). | - | keep: lab (D11, D18, D258, D292); not in the image since D1700 |
| `packages/sim/src/drafts.ts` | 28 | The "user is typing" lead-in the lab gives a request (hidden-funnel.ts '--lead-in'). Neither the hid | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/index.ts` | 16 | export { buildWorld, NOW, type Arc, type Fact, type Person, type World, type WorldItem } from "./wor | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/judge.ts` | 135 | A stand-in for the model, for when a live one is unavailable or too costly to run at scale: it reads | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/ab-common.ts` | 684 | What every live agent A/B runner shares, so their results are comparable and 'agent-ab-report.ts' re | node:crypto | keep: lab (D59, D271, D287, D291, D914, D1123); not in the image since D1700 |
| `packages/sim/src/lab/act-report.ts` | 137 | The report of 'pi-ab.ts --act' runs (docs/research/econ-lab.md): what the agent did, not only what i | sync fs | keep: lab (D815); not in the image since D1700 |
| `packages/sim/src/lab/act.ts` | 215 | Action tools for the live agent A/B's '--act' mode (docs/research/econ-lab.md): stub tools an agent  | @earendil-works/pi-ai | keep: lab (D305, D375, D376, D815); not in the image since D1700 |
| `packages/sim/src/lab/agent-ab-report.ts` | 334 | The tables of docs/research/agent-ab.md from an agent-ab.ts results file: per condition and task kin | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/agent-ab.ts` | 344 | Does Eden help an agent finish tasks, against the same agent given plain search tools? (docs/researc | sync fs | keep: lab (D48); not in the image since D1700 |
| `packages/sim/src/lab/ask-coverage.ts` | 370 | '--ask-diag''s coverage facts (hidden-funnel.ts; audit 2026-11-06, quality-o7-remaining-gap-not-cand | - | keep: lab (D162, D165, D173, D200); not in the image since D1700 |
| `packages/sim/src/lab/bench-compare.ts` | 68 | Compares benchmark runs in the ledger (bench/README.md). | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/bench.ts` | 246 | Runs the free tiers of the benchmark (bench/README.md) on the current tree and records each in the l | subprocess | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/build.ts` | 66 | Builds the lab's images: each open-source MCP server from its repository at the pinned commit in | subprocess; sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/cache-probe.ts` | 136 | A3 (docs/research/a3-cost-speed.md): does Anthropic cache the Pi agent's fixed prefix (tools + syste | @earendil-works/pi-ai | keep: lab (D260, D271); not in the image since D1700 |
| `packages/sim/src/lab/capture-preset-tools.ts` | 119 | C1 follow-up (D415): from the lab servers behind the 'caldav' and 'obsidian' connector presets, capt | @modelcontextprotocol/sdk/client/index.js; sync fs | keep: lab (D415); not in the image since D1700 |
| `packages/sim/src/lab/capture.ts` | 51 | Captures, from each lab server, one real search result (the fixture 'toItems' is tested against) and | @modelcontextprotocol/sdk/client/index.js; sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/card-queue-cli.ts` | 144 | The subagent card transport's files (F8, D1102; 'card-queue.ts'): | sync fs | keep: lab (D1102); not in the image since D1700 |
| `packages/sim/src/lab/card-queue.ts` | 117 | The subagent card transport (F8, D1102): stands in for the card model when no API credit is availabl | node:crypto; sync fs | keep: lab (D1102); not in the image since D1700 |
| `packages/sim/src/lab/cards-census.ts` | 142 | A census of what card enrichment reads (docs/research/econ-background.md): for each simulated user o | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/cards-disk.ts` | 531 | Implication cards from a disk cache (lab only; docs/research/moon-cards.md): each card the model mad | node:zlib; compression; sync fs | keep: lab (D87, D117, D158, D878, D1060, D1063); not in the image since D1700 |
| `packages/sim/src/lab/cards-distill.ts` | 499 | The card model's distillation set and its scorer (M0, lab only; 'packages/sim/modal/cards_distill.py | node:crypto, node:zlib; compression; sync fs | keep: lab (D408, D871); not in the image since D1700 |
| `packages/sim/src/lab/cards-endpoint.ts` | 115 | A lab card transport (M0; lab only, like D97's Anthropic provider): the card model behind any OpenAI | - | keep: lab (D97, D408); not in the image since D1700 |
| `packages/sim/src/lab/cards-enrich.ts` | 274 | Precomputes implication cards ('cards.ts') for the simulated worlds' items, once, into a disk cache  | sync fs | keep: lab (D87, D117, D713, D1193); not in the image since D1700 |
| `packages/sim/src/lab/check-api-replay.ts` | 106 | The push check's recorded API replies, seeded into the queue transport's replay store (F9, D1104). L | node:crypto, node:zlib; compression; sync fs | keep: lab (D1104); not in the image since D1700 |
| `packages/sim/src/lab/check-dump.ts` | 87 | M7 (D932): the push check's calls as rows, recorded from the funnel ('--check-dump F', with '--check | sync fs | keep: lab (D828, D932); not in the image since D1700 |
| `packages/sim/src/lab/cold-start.ts` | 220 | Cold-start enrichment cost per user, measured (fix-s3b, docs/research/realuse-1-weak-points.md issue | sync fs | keep: lab (D12, D71, D97, D815, D872, D1103); not in the image since D1700 |
| `packages/sim/src/lab/connector-options.ts` | 195 | The connector options the live A/B harnesses share ('pi-ab.ts', 'hermes-ab.ts'): | sync fs | keep: lab (D272, D347); not in the image since D1700 |
| `packages/sim/src/lab/connectors.ts` | 621 | The lab's connectors: an open-source MCP server (built by build.ts from a pinned commit) and the bac | @modelcontextprotocol/sdk/client/stdio.js, node:net; subprocess; sync fs; timers | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/core-grade.ts` | 142 | P3 (a2) (docs/research/p3-baselines.md §4): a second grade of "in hand, not raised". For every 'eden | sync fs; timers | keep: lab (D1, D2, D97, D834); not in the image since D1700 |
| `packages/sim/src/lab/cost-screen.ts` | 93 | H18's cost screen (CL5, docs/research/cl-cl5.md; docs/LAB.md recipe 2b): from a funnel run with the  | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/days-calls.ts` | 897 | 'days-calls.ts' (A8, docs/research/a8-connector-calls.md): Eden's connector calls over a user's days | sync fs | keep: lab (D272, D813, D828, D875, D900, D911); not in the image since D1700 |
| `packages/sim/src/lab/decide-fit.ts` | 307 | Fits a no-model decision model over the engine's per-candidate facts ('decide.ts', docs/research/eco | sync fs | keep: lab (D36, D67); not in the image since D1700 |
| `packages/sim/src/lab/distilled-fit.ts` | 359 | Fits the distilled reader (distilled-reader.ts; docs/research/distilled-reader.md) on recorded reade | typed arrays; sync fs | keep: lab (D110); not in the image since D1700 |
| `packages/sim/src/lab/distilled-reader.ts` | 341 | The distilled reader (lab only; docs/research/distilled-reader.md): a no-model scorer for the ask-ti | sync fs | keep: lab (D95, D96, D110); not in the image since D1700 |
| `packages/sim/src/lab/dress-entities.ts` | 104 | A6 (docs/research/a6-moonshots.md, D287; lab only): "dressed" worlds. A request often names a person | - | keep: lab (D287); not in the image since D1700 |
| `packages/sim/src/lab/eval-live.ts` | 158 | 'bun run eval --live' on Anthropic's API (claude-haiku-5-5, HAIKU_API_KEY), metered by the lab's spe | sync fs | keep: lab (D12, D95, D97, D128, D144); not in the image since D1700 |
| `packages/sim/src/lab/f1-check-pilot.ts` | 142 | F1's subagent-simulated pilot of encoder candidates in the push check (lab only; docs/research/f1-in | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/f1-combo-pilot.ts` | 145 | F1 × F2's combined check-pool pilot (lab only; docs/research/f1-intent-bridge.md §9). The push check | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/fake-openrouter.ts` | 68 | A $0 stand-in for OpenRouter, loaded with 'bun --preload' before a lab harness (pi-ab-resume.test.ts | sync fs | keep: lab (D813); not in the image since D1700 |
| `packages/sim/src/lab/flags.ts` | 119 | Strict flags for the lab's $0 CLIs (funnel.ts, hidden-funnel.ts, quality-cli.ts). A misspelled flag  | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/free-smoke.ts` | 52 | The free-model smoke test (docs/research/edge-freelab.md): one tiny JSON-mode request to each model  | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/free.ts` | 285 | The lab's access to OpenRouter, for paid and free models alike (docs/research/edge-freelab.md). LAB  | @earendil-works/pi-ai, @earendil-works/pi-ai/api/anthropic-messages.lazy, @earendil-works/pi-ai/api/openai-completions.lazy | keep: lab (D12, D97, D1101); not in the image since D1700 |
| `packages/sim/src/lab/funnel-merge.ts` | 347 | funnel.ts's arithmetic, apart from the script so it is tested in-process (funnel-merge.test.ts): how | - | keep: lab (D139); not in the image since D1700 |
| `packages/sim/src/lab/funnel.ts` | 756 | The common no-model screen in one command ('bun run funnel'; docs/LAB.md): hidden-funnel.ts with a n | node:child_process, node:zlib; compression; subprocess; sync fs; timers | keep: lab (D112, D139, D158, D714, D872, D877); not in the image since D1700 |
| `packages/sim/src/lab/gate-negatives.ts` | 45 | P2 (Q6): user messages that ask Eden's push for nothing: pasted log lines, chatter, remarks, stateme | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/gate-score.ts` | 42 | P2 (D820): how many messages of a gate set start the push, with 'pushIndirect' off and on, by kind. | sync fs | keep: lab (D820); not in the image since D1700 |
| `packages/sim/src/lab/gate-traffic.ts` | 478 | The reader gate on simulated realistic sessions, at no cost ('bun run gate-traffic'; docs/COST-MODEL | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/gloss-make.ts` | 206 | F1 (docs/research/f1-intent-bridge.md): the request glossary's words, written and glossed into Engli | sync fs; timers | keep: lab (D97); not in the image since D1700 |
| `packages/sim/src/lab/gloss-pack.ts` | 78 | F1: packs 'gloss-make.ts''s output into the engine's 'gloss.bin' (the packed layout, version 2, D1710: 'packGlossary') | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/h2-cards-screen.ts` | 251 | H2 (D1050-D1059, lab only; docs/research/h2-haiku-lean.md §1b): the card-and-intent call's cost per  | sync fs | keep: lab (D149, D1050, D1059); not in the image since D1700 |
| `packages/sim/src/lab/hermes-ab.ts` | 1355 | The live A/B on Hermes Agent (NousResearch/hermes-agent): Hermes alone against the same Hermes with  | @modelcontextprotocol/sdk/server/mcp.js, node:child_process, zod; node:crypto; subprocess; sync fs; timers | keep: lab (D813, D1040, D1042, D1044); not in the image since D1700 |
| `packages/sim/src/lab/hermes-anthropic.ts` | 293 | Hermes speaks OpenAI chat completions; a 'claude-*' agent model is Anthropic's Messages API. This mo | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hermes-cache-probe.ts` | 198 | A27 (docs/research/a27-hermes-cost.md): where Hermes' prompt cache breaks in hermes-ab, with and wit | sync fs | keep: lab (D385); not in the image since D1700 |
| `packages/sim/src/lab/hermes-conditions.ts` | 55 | The conditions of 'hermes-ab.ts': Hermes Agent alone, and the same Hermes with Eden integrated as a  | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hermes-host.ts` | 142 | The localhost surface 'hermes-ab.ts' gives each Hermes worker: one stream (a world under one conditi | @modelcontextprotocol/sdk/server/mcp.js, @modelcontextprotocol/sdk/server/webStandardStreamableHttp.js | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hermes-proxy.ts` | 413 | Hermes' model endpoint in 'hermes-ab.ts' ('/s/<stream>/v1/…'), on its own so it can be tested withou | typed arrays | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hermes-worker.ts` | 94 | One Hermes worker of 'hermes-ab.ts': a process (packages/sim/lab/hermes/worker.py on Hermes' venv) r | node:child_process, node:readline; sync fs; timers | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-context.ts` | 385 | Tasks whose answer depends on context the request does not ask for (docs/research/agent-hidden.md):  | - | keep: lab (D871, D908, D1123); not in the image since D1700 |
| `packages/sim/src/lab/hidden-dev20a.ts` | 1842 | Tuning suite dev20a (F8, a dev20 tuning set; not held out: tune on it), written by an isolated autho | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-dev20b.ts` | 1730 | Tuning suite dev20b (F8, a dev20 tuning set; not held out: tune on it), written by an isolated autho | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-dev20c.ts` | 1736 | Tuning suite dev20c (F8, a dev20 tuning set; not held out: tune on it), written by an isolated autho |  +           | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-dev20d.ts` | 1933 | Tuning suite dev20d (F8, a dev20 tuning set; not held out: tune on it), written by an isolated autho | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-dev6a.ts` | 1021 | Development suite dev6a: thirty hidden-context templates across work and personal life, written afte | - | keep: lab (D72); not in the image since D1700 |
| `packages/sim/src/lab/hidden-dev6b.ts` | 981 | Development suite dev6b: thirty hidden-context templates across work and personal life, written afte | - | keep: lab (D72); not in the image since D1700 |
| `packages/sim/src/lab/hidden-funnel.ts` | 2187 | The free tier of the hidden-context benchmark (docs/research/probes.md): each task's request is play | sync fs; timers | keep: lab (D95, D173, D430, D500, D914, D1060); not in the image since D1700 |
| `packages/sim/src/lab/hidden-heldout.ts` | 444 | A held-out set of hidden-context tasks, written blind to the engine and to 'hidden-context.ts': each | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-heldout10.ts` | 1230 | heldout10: a blind hidden-context suite, written after D79 by an author who had read only the world  | - | keep: lab (D79); not in the image since D1700 |
| `packages/sim/src/lab/hidden-heldout11.ts` | 779 | Held-out suite 11: 32 hidden-context tasks, written blind after D80 (the author read only the world  | - | keep: lab (D80); not in the image since D1700 |
| `packages/sim/src/lab/hidden-heldout12.ts` | 944 | Held-out hidden-context suite 12: blind, written after D85 by an author who read only the world gene | - | keep: lab (D85); not in the image since D1700 |
| `packages/sim/src/lab/hidden-heldout13.ts` | 1274 | Held-out hidden-context suite 13: blind, written by an author who read only the world generator, the | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-heldout14.ts` | 1205 | Held-out hidden-context suite 14 (RealUse-1, docs/research/benchmark-realuse-1.md): blind, written b |  +           | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-heldout15.ts` | 1166 | Held-out hidden-context suite 15: blind, written for the S3b weak-points work | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-heldout16.ts` | 1175 | Held-out hidden-context suite 16: written blind for the CL wave's final check, by an author who saw  | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-heldout17.ts` | 1199 | Held-out hidden-context suite 17: written blind for the end-of-day confirmation (heldout17), by an a | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-heldout18.ts` | 1309 | Held-out hidden-context suite 18: written blind for the askNudge confirmation (heldout18), by an aut | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-heldout19.ts` | 1370 | Held-out hidden-context suite 19 (P7, the end-of-wave confirmation), written blind: the author read  | - | keep: lab (D870, D873); not in the image since D1700 |
| `packages/sim/src/lab/hidden-heldout2.ts` | 549 | Held-out hidden-context suite 2: fifteen work requests (sales, account management, product, engineer | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-heldout20.ts` | 1951 | Held-out hidden-context suite 20 (F4, the one fresh test of the F1–F3 fixes), written blind: the aut |  +         | keep: lab (D870, D873); not in the image since D1700 |
| `packages/sim/src/lab/hidden-heldout3.ts` | 558 | Held-out hidden-context tasks, personal-life domain (third set). | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-heldout4.ts` | 544 | Held-out suite 4: operations, legal, IT/security, HR and compliance. Each template is a request from | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-heldout5.ts` | 493 | Held-out set 5 for the hidden-context suite: fifteen requests, each with one item in the user's sour | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-heldout6.ts` | 525 | Held-out suite 6 (blind): requests whose decisive context shares few or no words with the request. E | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-heldout7.ts` | 627 | Held-out hidden-context suite 7: twenty requests an assistant would act on, across work and personal | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-heldout8.ts` | 946 | Held-out suite 8: 24 blind hidden-context templates across work and personal life, written without r | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-heldout9.ts` | 1069 | Held-out hidden-context suite 9: 28 templates across work and personal life, written blind to the en | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-longtail.ts` | 630 | The long-tail suite (P7, D873; B5 in docs/research/weak-points-1111.md): every fact sits in a rarely | - | keep: lab (D356, D602, D870, D873); not in the image since D1700 |
| `packages/sim/src/lab/hidden-train1.ts` | 1226 | Training suite 1: personal finance and admin (banking, savings, tax, bills, insurance, subscriptions | - | keep: lab (D1); not in the image since D1700 |
| `packages/sim/src/lab/hidden-train2.ts` | 1212 | type Variant = "hidden" / "control"; |  +             | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-train3.ts` | 978 | type Variant = "hidden" / "control"; | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-train4.ts` | 994 | Training suite 4: sales, customers, legal and procurement. Each task is a commercial request (a quot | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-train5.ts` | 1013 | Blind suite train5: travel, events and social life. Each template is a request the user makes of the | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hidden-train6.ts` | 1059 | type Variant = "hidden" / "control"; | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/hits-screen.ts` | 59 | P3's $0 screen of the 'hits' arm (lexical-hits.ts): of each train task's planted item (the hidden fa | sync fs | keep: lab (D831); not in the image since D1700 |
| `packages/sim/src/lab/i1-label.ts` | 342 | I1 (D470–D474, docs/research/i1-checker.md): the checker's labelled pairs, lab only. Nothing in a pr | node:crypto; sync fs; timers | keep: lab (D470, D474); not in the image since D1700 |
| `packages/sim/src/lab/i2-label.ts` | 74 | I2 (D490–D494, docs/research/i2-changes-action.md): I1's labeller with the product's question, lab o | sync fs | keep: lab (D470, D490, D494); not in the image since D1700 |
| `packages/sim/src/lab/i3-regrade.ts` | 173 | I3 (D500–D504, docs/research/i3-push-check.md): 'regrade.ts''s Anthropic regrade sent as Message Bat | sync fs; timers | keep: lab (D500, D504); not in the image since D1700 |
| `packages/sim/src/lab/injection-ab.ts` | 545 | A10's live injection suite on the Pi harness (docs/research/a10-injection.md, D305). LAB ONLY, simul | @earendil-works/pi-agent-core, @earendil-works/pi-ai; sync fs | keep: lab (D305, D375, D376, D815); not in the image since D1700 |
| `packages/sim/src/lab/injection-suite.ts` | 382 | A10's injection suite (docs/research/a10-injection.md): prompt-injection attempts planted in a simul | - | keep: lab (D305, D375, D376, D815); not in the image since D1700 |
| `packages/sim/src/lab/injection-world.ts` | 97 | One injection case's world and Eden, up to the push (A10, D305): the hidden-context task's world wit | - | keep: lab (D305, D375, D376, D815); not in the image since D1700 |
| `packages/sim/src/lab/lab-cli.ts` | 47 | Runs the connector lab: seeds a world into each connector's backend, plays every case through every  | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/lab.ts` | 350 | The connector lab: real open-source MCP servers over real backends, seeded with a simulated world, s | @modelcontextprotocol/sdk/shared/transport.js, @modelcontextprotocol/sdk/types.js | keep: lab (D7); not in the image since D1700 |
| `packages/sim/src/lab/latency-report.ts` | 196 | Eden's time on the agent's path, piece by piece (A18), from a '--timeline' file (hidden-funnel's, 't | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/ledger.ts` | 72 | The benchmark ledger (bench/README.md): every benchmark run appends one summary line to 'bench/ledge | compression; subprocess; sync fs | keep: lab (D877); not in the image since D1700 |
| `packages/sim/src/lab/lexical-hits.ts` | 68 | P3's 'hits' arm (weak-points-1111 §3 B10): the plain retrieval baseline Eden's selection is measured | - | keep: lab (D831); not in the image since D1700 |
| `packages/sim/src/lab/m10/export.ts` | 105 | M10 (lab only): the card tagger's item-level set. Every item a sync of the train and longtail worlds | node:zlib; compression; sync fs | keep: lab (D960, D963); not in the image since D1700 |
| `packages/sim/src/lab/m10/fixtures.ts` | 81 | M10 (lab only): M3's 52 short constraints ('packages/sim/lab/m3r/short-constraints.jsonl') and M10's | sync fs | keep: lab (D960, D963); not in the image since D1700 |
| `packages/sim/src/lab/m10/gates.ts` | 52 | M10 (lab only): the hard gates on the engine's own micro tagger (the shipped weights, 'microCardOf') | sync fs | keep: lab (D960, D963); not in the image since D1700 |
| `packages/sim/src/lab/m10/gen.ts` | 182 | M10 (lab only): generated item families for the card tagger's training split, on Anthropic through t | sync fs | keep: lab (D880, D884, D960, D963); not in the image since D1700 |
| `packages/sim/src/lab/m10/label.ts` | 139 | M10 (lab only): cards for exported items, made by the shipped card call ('ModelCardMaker', 'cardMess | sync fs | keep: lab (D97, D960, D963); not in the image since D1700 |
| `packages/sim/src/lab/m10/reader.ts` | 652 | M10's micro card tagger (lab only; docs/research/m10-cards.md, D960–D963). The trial 'cardsMicro' th | typed arrays; sync fs | keep: lab (D960, D963); not in the image since D1700 |
| `packages/sim/src/lab/m11-enrich.ts` | 86 | M11 (D970-D979, lab only): Haiku's intent requests for M2 synthetic items, once, as training targets | sync fs | keep: lab (D884, D970, D979); not in the image since D1700 |
| `packages/sim/src/lab/m11-export.ts` | 110 | M11's training and screening export (lab only; docs/research/m11-intent.md). For each suite × seed × | sync fs | keep: lab (D970, D972, D1080); not in the image since D1700 |
| `packages/sim/src/lab/m11-synth.ts` | 47 | M11 (D970-D979): M2 v2 synthetic worlds as CopyGen training rows (lab only). Each task's fact, as th | sync fs | keep: lab (D884, D970, D979); not in the image since D1700 |
| `packages/sim/src/lab/m12-export.ts` | 71 | M12's training export (lab only; docs/research/m12-pool.md): texts as the engine's index and query s | node:readline | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/m14/debias.ts` | 110 | A length-debiased M2 (M14, D1024). LAB ONLY. M2's facts are longer than their twins in 94% of tasks, | sync fs | keep: lab (D1022, D1024); not in the image since D1700 |
| `packages/sim/src/lab/m14/g2.ts` | 438 | G2 (M14, D1020): a second synthetic-world generator, written to differ from M2's on purpose. LAB ONL | sync fs | keep: lab (D908, D1020); not in the image since D1700 |
| `packages/sim/src/lab/m14/g3.ts` | 616 | G3 (M14, D1020): a third world generator, programmatic and template-driven, with no model call. LAB  | sync fs | keep: lab (D908, D1020); not in the image since D1700 |
| `packages/sim/src/lab/m14/logo-export.ts` | 132 | LOGO rows (M14, D1021): one line per task, in one shape for every generator, so the leave-one-genera | sync fs | keep: lab (D1021); not in the image since D1700 |
| `packages/sim/src/lab/m14/paraphrase.ts` | 94 | Style randomisation and paraphrase augmentation for the LOGO recipes (M14, D1023). LAB ONLY. Haiku r | sync fs | keep: lab (D1023); not in the image since D1700 |
| `packages/sim/src/lab/m14/teacher-join.ts` | 48 | M1's 8B teacher scores over M2 v2's pair groups, joined to the texts M14's LOGO rows carry (M14, D10 | sync fs | keep: lab (D1023); not in the image since D1700 |
| `packages/sim/src/lab/m3-export.ts` | 89 | 'm3-export.ts' (M3, D900): training and screening data for a retriever trained on Eden's own questio | a-b; sync fs | keep: lab (D712, D900); not in the image since D1700 |
| `packages/sim/src/lab/m3-synth.ts` | 128 | 'm3-synth.ts' (M3, D900): new hidden-context template families written by a model, for training a re | sync fs | keep: lab (D491, D900); not in the image since D1700 |
| `packages/sim/src/lab/m5-ledger.ts` | 287 | M5 (D910–D911, docs/research/m5-ledger.md): a per-user standing-constraint ledger. A cheap model rea | node:crypto; sync fs | keep: lab (D97, D910, D911); not in the image since D1700 |
| `packages/sim/src/lab/m6/label.ts` | 183 | M6 (D920–D921, docs/research/m6-trimmer.md), LAB ONLY: labels which parts of a delivered planted ite | node:crypto; sync fs | keep: lab (D10, D97, D920, D921, D960, D963); not in the image since D1700 |
| `packages/sim/src/lab/neutral.ts` | 180 | The 'neutral' variant (RealUse-1, docs/research/benchmark-realuse-1.md): the same request as a suite | - | keep: lab (D884, D1070); not in the image since D1700 |
| `packages/sim/src/lab/new-user-trace.ts` | 132 | O5 (docs/research/o4-new-user.md §3, the review's finding 5): one new user's backfill, alone in the  | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/noise-sources.ts` | 75 | Noise connectors (A1 scale audit, D262–D264): a user with hundreds of connected sources that have no | - | keep: lab (D262, D264, D600); not in the image since D1700 |
| `packages/sim/src/lab/o1-rare-bytes.ts` | 65 | O1 (docs/research/o1-earn.md §2c): what 'sourceYieldEarn''s table of rare words ('RareTerms') weighs | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/observe-tool.ts` | 26 | A tool result reported to Eden by a lab harness (pi-ab, hermes-ab): the observe can hand out a packe | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/packet-layout.ts` | 49 | A16 (D336): how an integration keeps Eden's packets across a session's requests, as the Pi harness ( | - | keep: lab (D336); not in the image since D1700 |
| `packages/sim/src/lab/pi-ab-report.ts` | 725 | The report of a 'pi-ab.ts' run: its results file with the timelines beside it ('<timeline>/tasks.jso | sync fs | keep: lab (D112, D165, D171, D291, D336, D813); not in the image since D1700 |
| `packages/sim/src/lab/pi-ab-weighted.ts` | 252 | Traffic-weighted rows for the A/B reports (audit 2026-11-03b, R3-21): a deployment's traffic is most | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/pi-ab.ts` | 2259 | The live agent A/B on the Pi harness (CLAUDE.md's standard agent), with a timeline of every task. | @earendil-works/pi-agent-core, @earendil-works/pi-ai; sync fs; timers | keep: lab (D272, D291, D336, D500, D813, D1101); not in the image since D1700 |
| `packages/sim/src/lab/pi-conditions.ts` | 190 | The conditions of 'pi-ab.ts', one grammar for every A/B the econ tracks ran (docs/research/econ-lab. | - | keep: lab (D291, D336, D815); not in the image since D1700 |
| `packages/sim/src/lab/pi-cost-report.ts` | 191 | The cost and latency split of pi-ab runs (H16, CL5; pi-cost.ts has the rules): per condition the age | sync fs | keep: lab (D813); not in the image since D1700 |
| `packages/sim/src/lab/pi-cost.ts` | 330 | The cost split of a pi-ab run (H16, CL5, docs/research/cl-cl5.md), for the short horizon (one reques | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/pi-day.ts` | 310 | 'pi-ab --day K' (fix-s3b, docs/research/realuse-1-weak-points.md issue 12): one agent session across | - | keep: lab (D291, D336); not in the image since D1700 |
| `packages/sim/src/lab/pi-late.ts` | 50 | 'pi-ab --day K --late' (A9, docs/research/a9-ahead.md): plan-conflict proactivity's test. The plante | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/pi-timeline.ts` | 247 | Per-task timelines for the live agent benchmark ('pi-ab.ts', 'pi-ab-report.ts'): what happened when, | - | keep: lab (D56, D291, D336); not in the image since D1700 |
| `packages/sim/src/lab/pi-user.ts` | 302 | 'pi-ab --days D' (H16, CL5, docs/research/cl-cl5.md): a long horizon as one user lives it. One world | - | keep: lab (D871, D874, D884, D1080); not in the image since D1700 |
| `packages/sim/src/lab/presets.ts` | 25 | The lab's named engine configurations ('--preset', '--config NAME'), shared by funnel.ts, pi-ab.ts a | - | keep: lab (D112); not in the image since D1700 |
| `packages/sim/src/lab/queue-transport.ts` | 370 | The "queue" lab transport (F9, D1101; packages/sim/lab/subagent/README.md): every lab model call is  | node:crypto; sync fs; timers | keep: lab (D1101); not in the image since D1700 |
| `packages/sim/src/lab/reader-disk.ts` | 455 | A disk replay cache for the ask-time reader's model calls (lab only; D95, 'reader.ts'). Each call is | node:crypto; sync fs; timers | keep: lab (D8, D95, D117, D144, D240); not in the image since D1700 |
| `packages/sim/src/lab/reader-latency-fit.ts` | 275 | How the reader's latency splits into a fixed floor, input and output (no model call; docs/COST-MODEL | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/reader-stub.ts` | 289 | Readers with no model, for $0 screens of the NEW family (lab only; docs/LAB.md "No-model readers"). | node:crypto | keep: lab (D95); not in the image since D1700 |
| `packages/sim/src/lab/reader-time.ts` | 311 | Times the shipped reader's call ('ModelReaderMaker', D95/D96) on real reader pools, two arms interle | sync fs | keep: lab (D95, D96, D97, D144, D145, D155); not in the image since D1700 |
| `packages/sim/src/lab/regrade-kinds.ts` | 62 | regrade.ts's split by task kind (fix-s3b): how often a second grader agrees with the run's own grade | - | keep: lab (D71, D815); not in the image since D1700 |
| `packages/sim/src/lab/regrade.ts` | 179 | Grades a finished A/B run's answers again with other graders, to choose a grader that grades reliabl | sync fs | keep: lab (D71, D97, D815); not in the image since D1700 |
| `packages/sim/src/lab/reprice.ts` | 138 | Agent cost re-priced at one fixed endpoint, beside the billed cost (econ-research's R3; its 'normcos | - | keep: lab (D71, D159, D171, D815); not in the image since D1700 |
| `packages/sim/src/lab/retrieval-screen.ts` | 296 | The retrieval screen (audit 2026-11-06 F25): the inner loop for changes to what reaches the reader ( | node:child_process; subprocess; sync fs | keep: lab (D877); not in the image since D1700 |
| `packages/sim/src/lab/revision.ts` | 174 | M3b (D914): '+revision' for the hand-written suites. A hidden task's planted fact stays as it is, th | - | keep: lab (D914); not in the image since D1700 |
| `packages/sim/src/lab/reword.ts` | 56 | P2 (weak point Q6, docs/research/weak-points-1111.md; docs/research/p2-push-check.md): the train req | node:crypto | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/reworded.ts` | 837 | The train suites' requests reworded (P7, D871; B4 and Q6 in docs/research/weak-points-1111.md): ever | - | keep: lab (D870, D871, D873); not in the image since D1700 |
| `packages/sim/src/lab/router-sim.bench.ts` | 367 | The router gate (D163, D172) on simulated connectors (audit 2026-11-06 F23). 'packages/server/bench/ | subprocess; sync fs; timers | keep: lab (D112, D163, D172, D991); not in the image since D1700 |
| `packages/sim/src/lab/router-sim.ts` | 110 | The helpers behind 'router-sim.bench.ts' (audit 2026-11-06 F23): the router gate on simulated connec | sync fs | keep: lab (D163, D172); not in the image since D1700 |
| `packages/sim/src/lab/run-journal.ts` | 334 | Resumable lab runs (R4, D813; lab only): a paid run appends each finished unit of work (pi-ab: a tas | node:child_process, node:crypto; subprocess; sync fs | keep: lab (D813); not in the image since D1700 |
| `packages/sim/src/lab/secret-scan.ts` | 127 | What the secret gate lets through in the sim worlds (docs/research/edge-secret.md): every item of th | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/session-cache-probe.ts` | 178 | A16 (docs/research/a16-loop.md, D336): what Anthropic's prompt cache does over one session of severa | @earendil-works/pi-ai | keep: lab (D271, D336); not in the image since D1700 |
| `packages/sim/src/lab/silent.ts` | 131 | F3 (D1123): silent edits in the harnesses. A hidden task may carry its planted item's earlier versio | - | keep: lab (D1123, D1125); not in the image since D1700 |
| `packages/sim/src/lab/soak.ts` | 582 | R1c's capacity soak (docs/research/r1-release.md, round 3): heavy users (20 connectors, 3,000 prose  | typed arrays; subprocess; sync fs; timers | keep: lab (D753, D998, D1133); not in the image since D1700 |
| `packages/sim/src/lab/source-heap.ts` | 107 | O4 (docs/research/o4-per-source.md): where a many-source user's heap is, by taking parts away one at | - | keep: lab (D754); not in the image since D1700 |
| `packages/sim/src/lab/spend.ts` | 135 | The lab's hard cap on Anthropic spend, shared by every process of a campaign through one append-only | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/suites.ts` | 430 | The hidden-context suites by name, so every lab tool (agent-ab.ts, hidden-funnel.ts, bench.ts) can r | - | keep: lab (D350, D399, D802, D884, D1080, D1100); not in the image since D1700 |
| `packages/sim/src/lab/sync-cost.ts` | 44 | What holding a synced index costs (D57, docs/research/moon-sync.md): twelve simulated users' sources | - | keep: lab (D57); not in the image since D1700 |
| `packages/sim/src/lab/sync-econ.ts` | 229 | What keeping a synced index current costs (docs/research/econ-background.md): one simulated user who | sync fs | keep: lab (D57, D121, D1133); not in the image since D1700 |
| `packages/sim/src/lab/synth/critic.ts` | 221 | The synth factory's critic pass (D883), LAB ONLY: a model reads a sample of generated tasks blind (o | sync fs | keep: lab (D880, D883, D884); not in the image since D1700 |
| `packages/sim/src/lab/synth/gen.ts` | 922 | M2's synthetic-world factory (D880–D884), LAB ONLY. Nothing in a product package imports this file. | sync fs | keep: lab (D880, D884, D960, D963); not in the image since D1700 |
| `packages/sim/src/lab/synth/jobs.ts` | 344 | Haiku calls for the synth factory (D880), LAB ONLY: a job is one prompt whose reply is stored under  | sync fs; timers | keep: lab (D880); not in the image since D1700 |
| `packages/sim/src/lab/synth/labels.ts` | 50 | Ground truth from construction (D881). LAB ONLY. For every (request, item) pair of a world: 'changes | - | keep: lab (D880, D881, D884); not in the image since D1700 |
| `packages/sim/src/lab/synth/prompts.ts` | 269 | The synth factory's prompts (D880), LAB ONLY. Three stages: families (abstract scenarios, no names), | - | keep: lab (D880, D883); not in the image since D1700 |
| `packages/sim/src/lab/synth/qc.ts` | 178 | Quality control for the synth factory (D882), LAB ONLY: near-duplicate detection (families against e | node:crypto | keep: lab (D880, D882, D884); not in the image since D1700 |
| `packages/sim/src/lab/synth/schema.ts` | 202 | The synth world format (D880) and its checks. LAB ONLY. A world is one synthetic user's items and ta | zod | keep: lab (D880, D884); not in the image since D1700 |
| `packages/sim/src/lab/synth/suite.ts` | 143 | The 'synth' suite family (D884), LAB ONLY: generated worlds run as hidden-context suites, the way tr | sync fs | keep: lab (D880, D884, D908); not in the image since D1700 |
| `packages/sim/src/lab/synth/taxonomy.ts` | 114 | M2's synthetic-world factory (D880): the axes a generated world varies along. LAB ONLY. Every family | - | keep: lab (D880); not in the image since D1700 |
| `packages/sim/src/lab/timeline-report.ts` | 393 | Where a run's time went, from a timeline ('timeline.ts', '--timeline out.jsonl' on hidden-funnel or  | sync fs | keep: lab; not in the image since D1700 |
| `packages/sim/src/lab/timeline.ts` | 149 | A run's timeline: every engine span ('@eden/engine' 'spans.ts'), each task's start and end, the engi | sync fs; timers | keep: lab (D19); not in the image since D1700 |
| `packages/sim/src/lab/uptake.ts` | 118 | Delivery against uptake on hidden-context tasks (docs/research/econ-lab.md): what reached the agent  | - | keep: lab (D71, D815); not in the image since D1700 |
| `packages/sim/src/load.ts` | 312 | Load from simulated agents, over HTTP, through the real client SDK. Each user runs generated session | timers | keep: lab; not in the image since D1700 |
| `packages/sim/src/names.ts` | 127 | Name and vocabulary banks for the simulated world. Chosen to stress what real address books do to en | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/narrow.ts` | 101 | The narrowed question the ask experiments give an agent (docs/research/smart-askctx.md). An agent's  | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/perf-cli.ts` | 365 | Performance scenarios against the real server in its own process (server.ts), driven by simulated ag | subprocess; timers | keep: lab (D1, D57); not in the image since D1700 |
| `packages/sim/src/pilot/annotate.ts` | 63 | The pilot's annotation (F3, D489): the owner marks each answer without knowing which arm gave it. Fo | node:crypto | keep: lab (D489); not in the image since D1700 |
| `packages/sim/src/pilot/import.ts` | 142 | The pilot's import (F3, D489): what a user's read-only sources hold, read once through the same 'Sou | - | keep: lab (D7, D10, D489); not in the image since D1700 |
| `packages/sim/src/pilot/pilot.ts` | 290 | The real-data pilot kit (F3, D489; docs/PILOT.md): one consenting account's own data and requests, o | node:child_process, node:readline/promises; subprocess; sync fs | keep: lab (D10, D12, D489); not in the image since D1700 |
| `packages/sim/src/pilot/report.ts` | 190 | The pilot's report (F3, D489): the agent alone against the agent with Eden on the owner's own tasks, | - | keep: lab (D489); not in the image since D1700 |
| `packages/sim/src/pilot/store.ts` | 252 | The pilot kit's files (F3, D489): one directory on the owner's own machine, outside any git work tre | sync fs | keep: lab (D8, D425, D489); not in the image since D1700 |
| `packages/sim/src/pilot/world.ts` | 73 | The pilot's import as a lab world (F3, D489): the same '{world, tasks}' the Pi harness runs for a ge | - | keep: lab (D489); not in the image since D1700 |
| `packages/sim/src/quality-cli.ts` | 324 | bun packages/sim/src/quality-cli.ts [--users 6] [--sessions 15] [--seed 1] [--profile realistic/idea | subprocess; sync fs | keep: lab (D356); not in the image since D1700 |
| `packages/sim/src/quality.ts` | 1316 | Plays generated sessions through a real 'ContextPartner' over simulated sources and scores what reac | - | keep: lab (D28, D40, D57, D126, D347, D356); not in the image since D1700 |
| `packages/sim/src/rare-sources.ts` | 163 | Rarely used connectors (P7, B5 in docs/research/weak-points-1111.md): a user's long tail of sources  | - | keep: lab (D602, D873); not in the image since D1700 |
| `packages/sim/src/realism.ts` | 335 | A heavy real user's sources (F8, D1103; the lab's '--realism heavy'): the sim's worlds hold a few hu | - | keep: lab (D1103); not in the image since D1700 |
| `packages/sim/src/rng.ts` | 56 | A seeded random stream with the helpers a world generator needs. Same seed, same world. | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/server.ts` | 302 | The real Eden server (createHandler + ContextPartner, wired as in production: file-backed source map | timers | keep: lab (D57); not in the image since D1700 |
| `packages/sim/src/sessions.ts` | 811 | Sessions with ground truth, generated from a world. A session is a run of tasks as a personal agent  | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/sources.ts` | 631 | Simulated sources that behave like the connectors Eden will actually read through, rather than like  | timers | keep: lab (D44, D57, D126, D345, D356, D1133); not in the image since D1700 |
| `packages/sim/src/text.ts` | 194 | Rendering of simulated items into text shaped like the real thing: emails with greetings, sign-offs, | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/updates.ts` | 149 | Items that change at the source after Eden may have cached them: a meeting moved, an appointment res | - | keep: lab; not in the image since D1700 |
| `packages/sim/src/world.ts` | 1189 | A simulated user's world: the people and organisations in their life, and what their sources hold ab | - | keep: lab (D44, D489, D842); not in the image since D1700 |

### Tests (295 files)

| File | Lines | What it is | Choices seen | Verdict |
|---|---|---|---|---|
| `examples/ai-sdk/adapter.test.ts` | 228 | The doctor's judgement on what this adapter sent (D852): every obligation it can see should read ok. | ai, ai/test; subprocess | keep: test |
| `examples/oauth-directory/directory.test.ts` | 91 | The per-user OAuth directory (D294): refresh tokens stay in the app, Eden gets short-lived access to | - | keep: test |
| `examples/onboarding/client-package.test.ts` | 100 | Path (a) of the onboarding smoke tests (D365): an agent outside this monorepo installs the packed cl | subprocess; sync fs | keep: test |
| `examples/onboarding/integration-defaults.test.ts` | 190 | The shortest integration path's three defaults (D420–D422), end to end against the real handler with | subprocess | keep: test |
| `examples/onboarding/production-server.test.ts` | 181 | Path (c) of the onboarding smoke tests (D365): the server as the Dockerfile runs it (NODE_ENV=produc | typed arrays; subprocess; sync fs | keep: test |
| `examples/onboarding/python-proxy.test.ts` | 156 | Path (b) of the onboarding smoke tests (D365): a Python agent with only the standard library calls i | typed arrays; subprocess | keep: test |
| `examples/personal-agent/agent.test.ts` | 82 | The example must run with no paid key: a dev server on a free port with the example's sources, then  | subprocess | keep: test |
| `packages/client-python/src/python.test.ts` | 132 | The Python client (eden_client/, D278): its unit tests, then the same calls end to end against the r | subprocess | keep: test |
| `packages/client-python/test_eden_client.py` | 550 | Unit tests for the Python client: every call fails open on every failure shape (D14). Run from this  | asyncio, contextlib, datetime, eden_client, http | keep: test |
| `packages/client-python/test_hermes.py` | 202 | Unit tests for the Hermes plugin (''eden_client.hermes''): a fake Hermes ''ctx'' and a fake client.  | eden_client, unittest | keep: test |
| `packages/client/src/client.test.ts` | 717 | const inj = (text: string) => ({ id: "inj_1", text }) as Injection; | - | keep: test |
| `packages/client/src/guard.test.ts` | 118 | const finding: ActionCheck = { | - | keep: test |
| `packages/client/src/on-error.test.ts` | 147 | afterEach(() => resetDefaultOnError()); | - | keep: test |
| `packages/engine/src/active-poll.test.ts` | 222 | F3 ('syncActivePollMs', trial; D1131): a quiet source is trusted for up to 'syncMaxStaleMs' (6 h) by | - | keep: test |
| `packages/engine/src/ask-behind.test.ts` | 328 | 'askBehind' (D430, trial; docs/research/c4-ask-path.md): an explicit ask's lookup runs behind as the | - | keep: test |
| `packages/engine/src/ask-cut-pending.test.ts` | 108 | Repro: an ask drops a queued candidates packet whose every item it CITES, though the answer's 4,000- | - | keep: test |
| `packages/engine/src/ask-deadline-held.test.ts` | 127 | D140 with a held page: an ask whose on-demand poll uses up the lookup's deadline has no time left to | - | keep: test |
| `packages/engine/src/ask-deadline.test.ts` | 147 | D140: an explicit ask has one deadline for its whole lookup. The on-demand sync poll, the live searc | - | keep: test |
| `packages/engine/src/ask-nudge.test.ts` | 370 | A12 (docs/research/a12-quality.md, D316): 'askNudge'. When no candidate the push hands holds every k | - | keep: test |
| `packages/engine/src/ask-verify.test.ts` | 251 | D211: an ask's citations a change signal put in doubt are re-read ('verifyItems', as deliveries are) | - | keep: test |
| `packages/engine/src/cache-freeze.test.ts` | 809 | Idle users frozen (D325): a frozen user thaws into the state they were frozen in, so every read answ | timers | keep: test |
| `packages/engine/src/cache.test.ts` | 746 | const alice = { tenantId: "t", userId: "alice" }; | - | keep: test |
| `packages/engine/src/card-state.test.ts` | 258 | type CardMakeOptions, | - | keep: test |
| `packages/engine/src/cards-lanes.test.ts` | 313 | 'cardsLanes' (N4, D521, promoted by D522): one user's card calls run in up to N lanes while full bat | timers | keep: test |
| `packages/engine/src/cards-lean-recurring.test.ts` | 63 | Audit A5, fixed (D244 'cardsLeanDays', D125 'cardsLean'): the lean decision depends on an item's DAT | - | keep: test |
| `packages/engine/src/cards-order.test.ts` | 183 | 'cardsOrder' (D482, promoted by D483): a user's waiting items are read best first. Constraint wordin | - | keep: test |
| `packages/engine/src/cards-requests-fix.test.ts` | 237 | type CardMakeOptions, | - | keep: test |
| `packages/engine/src/cards.test.ts` | 521 | A bound on work, not on waiting: process CPU time, so a loaded machine (four test files at once) doe | - | keep: test |
| `packages/engine/src/closed-ask-budget.test.ts` | 74 | Audit A5 (long-running leak, fixed): an ask waiting on the push's verdict ('reusePush') when its ses | timers | keep: test |
| `packages/engine/src/config-check.test.ts` | 134 | const ALL_DEPS = { cards: true, reader: true }; | - | keep: test |
| `packages/engine/src/conflict-vocab.test.ts` | 263 | Tuesday 27 October 2026, 09:00 UTC. | - | keep: test |
| `packages/engine/src/conflict.test.ts` | 431 | A bound on work, not on waiting: process CPU time, so a loaded machine (four test files at once) doe | - | keep: test |
| `packages/engine/src/consequence.test.ts` | 300 | A bound on work, not on waiting: process CPU time, so a loaded machine (four test files at once) doe | - | keep: test |
| `packages/engine/src/days.test.ts` | 117 | Tuesday 27 October 2026, 09:00 UTC. | - | keep: test |
| `packages/engine/src/decide.test.ts` | 117 | Tuesday 27 October 2026, 09:00 UTC. | - | keep: test |
| `packages/engine/src/default.test.ts` | 317 | Every setting where the default and the core differ, with its value in the default (D112). | timers | keep: test |
| `packages/engine/src/dense.test.ts` | 272 | A bound on work, not on waiting: process CPU time, so a loaded machine (four test files at once) doe | - | keep: test |
| `packages/engine/src/econ-judge.test.ts` | 517 | docs/research/econ-judge.md: a lookup that does not wait for the sync's on-demand poll ('syncPollBeh | - | keep: test |
| `packages/engine/src/econ-review.test.ts` | 99 | Regressions from the review of the background economy (D66): sentence reuse's key, retention and ove | - | keep: test |
| `packages/engine/src/econ.test.ts` | 365 | The background economy (docs/research/econ-background.md): the cards' strict prefilter and sentence  | - | keep: test |
| `packages/engine/src/economy.test.ts` | 264 | const alice = { tenantId: "t", userId: "alice" }; | - | keep: test |
| `packages/engine/src/explain.test.ts` | 138 | D277: 'explain' keeps a session's last decisions (its traces), content-free, for "why this packet /  | - | keep: test |
| `packages/engine/src/fold.test.ts` | 62 | const x = (id: string, title: string, text: string): { item: ContextItem } => ({ | - | keep: test |
| `packages/engine/src/freshen-deadline.test.ts` | 74 | const HOUR = 3_600_000; | timers | keep: test |
| `packages/engine/src/freshness-push.test.ts` | 313 | D126 on the reader's push, with 'readerVerifyAfter' off (these tests build on CORE_CONFIG): the read | timers | keep: test |
| `packages/engine/src/freshness.test.ts` | 605 | const T0 = Date.UTC(2026, 10, 2, 9); | timers | keep: test |
| `packages/engine/src/fuzz.test.ts` | 101 | A seeded fuzz of the engine's state machine ('fuzz-world.ts'): random orders of events, asks, takes, | - | keep: test |
| `packages/engine/src/gate.test.ts` | 78 | const KEY = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2"; | - | keep: test |
| `packages/engine/src/gloss-partner.test.ts` | 54 | Tuesday 27 October 2026, 09:00 UTC. | - | keep: test |
| `packages/engine/src/gloss.test.ts` | 110 | fn: ["voglio", "dai", "al", "il", "di"], | sync fs | keep: test |
| `packages/engine/src/gloss-packed.test.ts` | 483 | The packed glossary (D1710) against the version 1 reader it replaced; corrupt, truncated and crafted files | node:crypto; sync fs | keep: test (D1710) |
| `packages/engine/src/grounding.test.ts` | 137 | Thursday 29 October 2026, noon UTC. | - | keep: test |
| `packages/engine/src/held.test.ts` | 108 | What an open session costs in memory once its agent has fetched large tool results: each tool result | bun:jsc; typed arrays | keep: test |
| `packages/engine/src/ingest-reuse.test.ts` | 335 | Secret-shaped values are assembled from parts so no literal in the repo is one (packages/redact/CLAU | - | keep: test |
| `packages/engine/src/injection.test.ts` | 145 | Injection inertness, end to end, no model (D221): RealUse-1 part D's probe | - | keep: test |
| `packages/engine/src/intent-bykind.test.ts` | 202 | 'intentByKind' (D200, on in the default; docs/research/fix-s3a-intent.md): constraint-carded intent  | - | keep: test |
| `packages/engine/src/intent.test.ts` | 574 | Tuesday 27 October 2026, 09:00 UTC. | - | keep: test |
| `packages/engine/src/joined-flight.test.ts` | 185 | D133 through the fan-out's shared calls: a lookup that starts after a change signal must not join a  | timers | keep: test |
| `packages/engine/src/ledger.test.ts` | 83 | describe("Ledger", () => { | - | keep: test |
| `packages/engine/src/line.test.ts` | 93 | The shared line sanitiser (D221): text from a source or an event, put on one line of a packet, an an | - | keep: test |
| `packages/engine/src/moon-review.test.ts` | 356 | Regressions for the review of the combined moonshot tree ('moon/combined'): each test reproduced a f | - | keep: test |
| `packages/engine/src/moon-review2.test.ts` | 167 | const HOUR = 3_600_000; | - | keep: test |
| `packages/engine/src/name-only.test.ts` | 145 | A bound on work, not on waiting: process CPU time, so a loaded machine (four test files at once) doe | - | keep: test |
| `packages/engine/src/packed-text.test.ts` | 131 | const scope = { tenantId: "t", userId: "u" }; | - | keep: test |
| `packages/engine/src/parties.test.ts` | 336 | A bound on work, not on waiting: process CPU time, so a loaded machine (four test files at once) doe | - | keep: test |
| `packages/engine/src/partner.test.ts` | 1248 | A partner's sessions as JSON, each session's vocabulary as its terms: since D998 a 'Vocab' holds its | timers | keep: test |
| `packages/engine/src/persist-shared.test.ts` | 470 | Frozen users in a shared store (D992): what one machine writes another fetches and serves with the s | typed arrays; sync fs | keep: test |
| `packages/engine/src/persist.test.ts` | 649 | Frozen users on disk, encrypted (D425, opt-in): a user frozen by one process thaws in the next exact | typed arrays; sync fs | keep: test |
| `packages/engine/src/plan-conflict.test.ts` | 306 | A9 (docs/research/a9-ahead.md): plan-conflict proactivity. With 'planConflict', a new item that woul | - | keep: test |
| `packages/engine/src/prefix-stable.test.ts` | 45 | D1196's trial ('EDEN_MODEL_CACHE'): a provider caches only an identical prefix. The push check's and | - | keep: test |
| `packages/engine/src/probes.test.ts` | 765 | A bound on work, not on waiting: process CPU time, so a loaded machine (four test files at once) doe | - | keep: test |
| `packages/engine/src/push-behind-gap.test.ts` | 153 | Repro: 'readerPushBehind''s second pass (pushCandidates) withdraws the untaken first packet BEFORE i | timers | keep: test |
| `packages/engine/src/push-behind.test.ts` | 522 | 'readerPushBehind' (audit 2026-11-03b, lat-push-read-waits-poll): under 'syncPollBehind' the push's  | timers | keep: test |
| `packages/engine/src/push-candidates-behind.test.ts` | 169 | 'pushCandidates' (D236) under 'readerPushBehind': the poll's second pass re-picks the candidates; it | timers | keep: test |
| `packages/engine/src/push-candidates.test.ts` | 317 | CL6 (docs/research/cl-cl6.md, D236, D237): "the agent is the reader". The push makes no reader call; | - | keep: test |
| `packages/engine/src/push-check-sheet.test.ts` | 413 | 'pushCheckSheet' (F5, trial; docs/research/f5-rule-sheet.md): the push check also reads the user's a | - | keep: test |
| `packages/engine/src/push-check.test.ts` | 482 | The push check (I3, D500; in the default since D828). One model call over the push's pool names the  | timers | keep: test |
| `packages/engine/src/push-cut-behind.test.ts` | 174 | 'pushCutBehind' (D405, D406: on in the default; docs/research/b1-scale-path.md): on the push, a sync | - | keep: test |
| `packages/engine/src/push-day-seats.test.ts` | 288 | 'pushDaySeats' (G1, D1400, in the default since D1402): a plan with a day is an action on that day.  | - | keep: test |
| `packages/engine/src/push-indirect.test.ts` | 261 | P2 (D820): 'pushIndirect' reads a need, plan, wish or question about acting as its imperative, and t | - | keep: test |
| `packages/engine/src/push-lookup.test.ts` | 178 | 'pushLookup' (F11, D1252; rejected, kept off): a push the check left silent hands the pool's records | - | keep: test |
| `packages/engine/src/push-open.test.ts` | 187 | A bound on work, not on waiting: process CPU time, so a loaded machine (four test files at once) doe | - | keep: test |
| `packages/engine/src/push-trace-turn.test.ts` | 63 | Audit A11: a push's trace names the turn of the request it read, not whatever turn the session reach | - | keep: test |
| `packages/engine/src/rare-terms.test.ts` | 168 | 'RareTerms' ('sourceYieldEarn', D600): one table a user of which few sources hold a word, in place o | - | keep: test |
| `packages/engine/src/reader-failure.test.ts` | 159 | A reader whose model fails must stay invisible to the agent (fail open, D41) but visible to the oper | - | keep: test |
| `packages/engine/src/reader-s1.test.ts` | 203 | The S1 reader trials (docs/research/fix-s1-reader.md): the ask reusing the push's reading (D193); re | timers | keep: test |
| `packages/engine/src/reader-stop-native.test.ts` | 31 | Audit A5, fixed (D240, unverified provider behaviour): OpenRouter's 'native_finish_reason' is the up | - | keep: test |
| `packages/engine/src/reader.test.ts` | 1184 | Tuesday 27 October 2026, 09:00 UTC. | waited the 3 s it was allowed; timers | keep: test |
| `packages/engine/src/regressions.test.ts` | 311 | Regressions from the 2026-10-29 audit of the engine: each test failed before its fix. | - | keep: test |
| `packages/engine/src/render.test.ts` | 191 | A bound on work, not on waiting: process CPU time, so a loaded machine (four test files at once) doe | - | keep: test |
| `packages/engine/src/review-regressions.test.ts` | 655 | Regression tests for the scaffold's first independent review (2026-10-27). Each names the finding it | - | keep: test |
| `packages/engine/src/revision-diff.test.ts` | 199 | A17 (docs/research/a17-long-quality.md, D342): 'revisionDiff'. Over a day an "updated:" packet (D205 | - | keep: test |
| `packages/engine/src/revision-notice.test.ts` | 633 | 'revisionNotice' (D205, on in the default): an item a session was handed that changes at its source  | typed arrays; timers | keep: test |
| `packages/engine/src/scale2.test.ts` | 434 | A13's scale switches (docs/research/a13-scale.md): a user with many sources. 'cardsSourceAware' (D32 | - | keep: test |
| `packages/engine/src/source-calls.test.ts` | 178 | Trace 'sourceCalls' are the calls a connector received (audit 2026-11-03, finding 18). With 'readerP | - | keep: test |
| `packages/engine/src/source-refs.test.ts` | 363 | D347 (A18): a change notice that names the refs it changed (no content). Those refs are re-read in t | - | keep: test |
| `packages/engine/src/source-yield-partner.test.ts` | 399 | 'sourceYield' at the partner (D505, N1; docs/research/n1-calls.md): a source whose live reads go unu | - | keep: test |
| `packages/engine/src/source-yield.test.ts` | 75 | 'SourceYield' ('sourceYield', D505): each source's run of live reads with nothing used, and whether  | - | keep: test |
| `packages/engine/src/spans.test.ts` | 246 | let clock = 1_700_000_000_000; | - | keep: test |
| `packages/engine/src/sync-calls.test.ts` | 353 | Audit A5, connector calls (priced per call): the sync's listings counted against what a lookup, a ba | timers | keep: test |
| `packages/engine/src/sync-kick.test.ts` | 665 | 'syncKick' (D751, D753, in the default since D755; docs/research/o4-new-user.md): a user the sync ha | - | keep: test |
| `packages/engine/src/sync-mcp-page.test.ts` | 129 | const HOUR = 3_600_000; | timers | keep: test |
| `packages/engine/src/sync-scale.test.ts` | 348 | The A1 scale switches on the background sync (docs/research/a1-scale.md): a user with many sources. | - | keep: test |
| `packages/engine/src/sync-turns.test.ts` | 148 | 'syncIngestTurns' (D328, on in the default since D370): a background sync page is redacted and store | - | keep: test |
| `packages/engine/src/sync.test.ts` | 710 | const HOUR = 3_600_000; | timers | keep: test |
| `packages/engine/src/text.test.ts` | 95 | describe("extractEntities", () => { | - | keep: test |
| `packages/engine/src/tied.test.ts` | 74 | 'judgeTied': the judge is asked only when a candidate is tied to the request (a probe's find, a day  | - | keep: test |
| `packages/engine/src/timed-zone.test.ts` | 142 | The day an event is on is the user's day (candidate 'timed-utc-start-day'). A connector can write an | - | keep: test |
| `packages/engine/src/tokens.test.ts` | 221 | The tokens track (D76–D78; docs/research/gen-tokens.md): 'compactAsk' cuts an ask's answer as packet | - | keep: test |
| `packages/engine/src/turn-gate.test.ts` | 173 | M13 (D1010, D1011; docs/research/m13-gate.md): the turn gate decides whether a user turn starts the  | sync fs | keep: test |
| `packages/engine/src/tz.test.ts` | 120 | Dates read the same on every host: a zone-less date (a sim mail's 'Date:' header, a local calendar s | subprocess | keep: test |
| `packages/engine/src/unused-sweep.test.ts` | 328 | Trial 'syncUnusedSweepMs' (D356, A21, docs/research/a21-scale.md): a source the user does not use is | - | keep: test |
| `packages/engine/src/unverifiable-reread.test.ts` | 226 | A8 (A5's lead): a re-read whose null proves nothing (an MCP source, 'fetchReportsGone' false) is "un | - | keep: test |
| `packages/engine/src/usage-record.test.ts` | 89 | D293: 'onUsage' reports, content-free, whether the agent used each injection (inferred, D18; or expl | - | keep: test |
| `packages/engine/src/verify-removed.test.ts` | 133 | Audit A5 (fixed): an ask's strict re-read (D211) of item A says "changed" (and stores the new copy); | timers | keep: test |
| `packages/eval/src/run.test.ts` | 480 | const scenario = JSON.parse( | sync fs | keep: test |
| `packages/graph/src/source-map-move.test.ts` | 39 | const alice = { tenantId: "acme", userId: "alice" }; | - | keep: test |
| `packages/graph/src/source-map.test.ts` | 205 | const alice = { tenantId: "t", userId: "alice" }; | subprocess | keep: test |
| `packages/llm/src/anthropic.test.ts` | 289 | type AnthropicCallRecord, | typed arrays | keep: test |
| `packages/llm/src/llm.test.ts` | 448 | describe("pricing", () => { | - | keep: test |
| `packages/llm/src/pacing.test.ts` | 223 | A clock that only moves when the pacer sleeps, so the tests run in no real time. | sync fs | keep: test |
| `packages/primitives/src/bandit.test.ts` | 233 | const prior = (arms: number, mean: number) => new Float64Array(arms).fill(mean); | typed arrays | keep: test |
| `packages/primitives/src/cache.test.ts` | 234 | describe("S3FifoCache", () => { | typed arrays | keep: test |
| `packages/primitives/src/calibrate.test.ts` | 297 | expectedCalibrationError, | typed arrays | keep: test |
| `packages/primitives/src/dedup.test.ts` | 443 | lshCandidateProbability, | band:values; typed arrays | keep: test |
| `packages/primitives/src/histogram.test.ts` | 87 | The histogram before D261, kept as the oracle: 1,024 counters from the first sample, one scan per qu | typed arrays | keep: test |
| `packages/primitives/src/idset.test.ts` | 175 | Ids that cover the encoding: plain ASCII, Latin-1, the escape byte itself (ÿ), wider code units, the | - | keep: test |
| `packages/primitives/src/matcher.test.ts` | 71 | const all = (m: MultiMatcher, text: string) => { | typed arrays | keep: test |
| `packages/primitives/src/pack.test.ts` | 190 | f(S) written out directly, for checking. | typed arrays | keep: test |
| `packages/primitives/src/placement.test.ts` | 67 | describe("placement (D992)", () => { | - | keep: test |
| `packages/primitives/src/pool.test.ts` | 157 | const MODULE = new URL("./pool.fixture.ts", import.meta.url).href; | - | keep: test |
| `packages/primitives/src/random.test.ts` | 141 | Kolmogorov–Smirnov statistic of the sorted sample against a CDF. | typed arrays | keep: test |
| `packages/primitives/src/regressions.test.ts` | 166 | Regressions from the 2026-10-29 audit of the primitives: each test failed before its fix. | typed arrays | keep: test |
| `packages/primitives/src/reply.test.ts` | 373 | A bound on work, not on waiting: process CPU time, so a loaded machine (four test files at once) doe | - | keep: test |
| `packages/primitives/src/resilience.test.ts` | 253 | describe("Deadline", () => { | timers | keep: test |
| `packages/primitives/src/sketch.test.ts` | 107 | describe("ExpiringSet", () => { | - | keep: test |
| `packages/primitives/src/sparse-index-packed.test.ts` | 264 | The packed index against the reference layout it replaced: the same operations on both must give the | typed arrays | keep: test |
| `packages/primitives/src/sparse-index-snapshot.test.ts` | 171 | 'compact' and 'snapshot'/'restore' (D860). Three indexes take the same operations: 'plain' is never  | typed arrays | keep: test |
| `packages/primitives/src/sparse-index.test.ts` | 248 | The obvious BM25: every doc, every query term, Maps. The reference SparseIndex must agree with. | typed arrays | keep: test |
| `packages/primitives/src/stats.test.ts` | 175 | Reference values printed by scipy 1.18.1 (special.betainc, special.betaincinv, special.gammaln, stat | - | keep: test |
| `packages/primitives/src/tokenize.test.ts` | 117 | describe("tokenize", () => { | typed arrays | keep: test |
| `packages/primitives/src/utf8.test.ts` | 34 | const enc = new TextEncoder(); | - | keep: test |
| `packages/primitives/src/vocab.test.ts` | 234 | 'foldString' as it was before it built a flat string (one '+=' per code unit): the output it must st | bun:jsc; typed arrays | keep: test |
| `packages/protocol/src/ids.test.ts` | 18 | test("bucketOf (D992) is stable, 16 bits, separates tenant from user, and spreads users evenly", ()  | typed arrays | keep: test |
| `packages/protocol/src/validate.test.ts` | 244 | A bound on work, not on waiting: process CPU time, so a loaded machine (four test files at once) doe | - | keep: test |
| `packages/proxy/src/proxy-a11.test.ts` | 129 | Audit A11 on the proxy (D280): each test failed before its fix. | - | keep: test |
| `packages/proxy/src/proxy-a16.test.ts` | 250 | A16 (D336, 'keepPackets', on by default): a packet the agent saw stays where it was on every later r | - | keep: test |
| `packages/proxy/src/proxy-a5.test.ts` | 184 | Audit A5 on A4's proxy (D280): each test states what D280 and packages/proxy/CLAUDE.md promise; each | - | keep: test |
| `packages/proxy/src/proxy-anthropic.test.ts` | 317 | D653: the proxy in front of Anthropic's Messages API ('POST …/v1/messages'). A fake upstream records | - | keep: test |
| `packages/proxy/src/proxy-ask.test.ts` | 415 | D851 (trial 'askTool'): the proxy offers Eden's ask_context to the model and answers its calls itsel | - | keep: test |
| `packages/proxy/src/proxy-responses.test.ts` | 207 | D656: the proxy in front of OpenAI's Responses API ('POST …/v1/responses'). A fake upstream records  | - | keep: test |
| `packages/proxy/src/proxy-speculate.test.ts` | 215 | 'speculate' (F10, D1273, on by default; docs/research/f10-rule-index.md §9): the turn goes upstream  | - | keep: test |
| `packages/proxy/src/proxy.test.ts` | 367 | D280: Eden as an OpenAI-compatible proxy. A fake upstream records what reached the model; Eden is th | node:crypto | keep: test |
| `packages/proxy/src/with-messages.test.ts` | 39 | Audit A5: injecting re-serialised the whole body; now only 'messages' is replaced, every other byte  | - | keep: test |
| `packages/redact/src/aws-secret.test.ts` | 84 | 'eden-aws-secret': an AWS secret access key (40 characters of base64's alphabet) beside its key id,  | - | keep: test |
| `packages/redact/src/keyword-quoted.test.ts` | 46 | Audit A5 (fixed). A multi-word password in quotes under 'password' (and, after another credential fi | - | keep: test |
| `packages/redact/src/linear.test.ts` | 129 | D24: the gitleaks rules run on RE2 (re2js), linear in the text, with results identical to JavaScript | - | keep: test |
| `packages/redact/src/pem.test.ts` | 46 | A bound on work, not on waiting: process CPU time, so a loaded machine (four test files at once) doe | - | keep: test |
| `packages/redact/src/prefilter.test.ts` | 77 | The keyword prefilter (one Aho–Corasick pass) must not change what the gate finds: for every text, e | - | keep: test |
| `packages/redact/src/redact.test.ts` | 140 | A bound on work, not on waiting: process CPU time, so a loaded machine (four test files at once) doe | - | keep: test |
| `packages/redact/src/redos-1.test.ts` | 9 | D24 and D86: shard 1 of the crafted-input sweep (redos-sweep.ts; shard 0 and the rest are in redos.t | - | keep: test |
| `packages/redact/src/redos-2.test.ts` | 9 | D24 and D86: shard 2 of the crafted-input sweep (redos-sweep.ts; shard 0 and the rest are in redos.t | - | keep: test |
| `packages/redact/src/redos-3.test.ts` | 9 | D24 and D86: shard 3 of the crafted-input sweep (redos-sweep.ts; shard 0 and the rest are in redos.t | - | keep: test |
| `packages/redact/src/redos.test.ts` | 84 | D24 and D86: no input makes the gate super-linear. The timing half of linear.test.ts, in files of it | - | keep: test |
| `packages/redact/src/secrets.test.ts` | 246 | D13's secret gate (A6 §2.2): the vendored gitleaks rules, the keyword rule, URL userinfo and the | node:crypto; sync fs | keep: test |
| `packages/redact/src/warm.test.ts` | 130 | Secret-shaped values are assembled from parts so no literal in the repo is one (packages/redact/CLAU | - | keep: test |
| `packages/server/src/blob-store.test.ts` | 53 | const s3 = fakeS3("eden-test"); | typed arrays | keep: test |
| `packages/server/src/browser-origin.test.ts` | 56 | Audit A20 (security). Dev mode (EDEN_DEV=1, the README's quickstart, with real sources) serves reque | - | keep: test |
| `packages/server/src/cluster.test.ts` | 319 | The cluster router over real machines (D992), end to end on one host: three nodes ('main.ts' process | subprocess; sync fs | keep: test |
| `packages/server/src/concurrent-session.test.ts` | 49 | Probe (concurrency at the HTTP layer): many asks, events, pendings, session_ends and forgets in the  | - | keep: test |
| `packages/server/src/connector-presets.test.ts` | 350 | } from "../../sources/src/schema-args"; | @modelcontextprotocol/sdk/inMemory.js, @modelcontextprotocol/sdk/server/index.js, @modelcontextprotocol/sdk/types.js | keep: test |
| `packages/server/src/connectors.test.ts` | 135 | const dir = mkdtempSync(join(tmpdir(), "eden-conn-")); | subprocess; sync fs | keep: test |
| `packages/server/src/digest.test.ts` | 190 | D293: "Eden caught this", over an EDEN_TRACE=1 log: traces and usage records, counts and connector i | - | keep: test |
| `packages/server/src/doctor.test.ts` | 196 | D852: 'eden doctor' names each integration obligation that is not met, from the server's content-fre | sync fs | keep: test |
| `packages/server/src/engine-config.test.ts` | 311 | const dir = mkdtempSync(join(edenHome(), "engine-config-")); | sync fs | keep: test |
| `packages/server/src/gate-pool.test.ts` | 30 | describe("startGatePool (D25)", () => { | - | keep: test |
| `packages/server/src/http-review.test.ts` | 127 | A24's review of A14 (D325, D326). Routes that read a frozen user's items thaw them through 'partner. | - | keep: test |
| `packages/server/src/http.test.ts` | 631 | const key = "k_acme_0123456789abcdef"; | - | keep: test |
| `packages/server/src/main-signal.test.ts` | 57 | const dir = mkdtempSync(join(tmpdir(), "eden-main-signal-")); | subprocess; sync fs; timers | keep: test |
| `packages/server/src/mcp.test.ts` | 168 | test("an MCP agent can ask the partner through ask_context", async () => { | @modelcontextprotocol/sdk/client/index.js, @modelcontextprotocol/sdk/inMemory.js; timers | keep: test |
| `packages/server/src/ops.test.ts` | 153 | const KEY = "cluster-key-0123456789abcdef"; | - | keep: test |
| `packages/server/src/persist.test.ts` | 264 | Persisting frozen users from the server (D425, opt-in): the settings (both or neither, a key that is | subprocess; sync fs; timers | keep: test |
| `packages/server/src/push-check-wiring.test.ts` | 93 | The push check is in the default (D828): a server with a model key wires it on the reader's model, w | - | keep: test |
| `packages/server/src/reader-log.test.ts` | 118 | The shipped reader fails open (D41), so a reader whose every call fails (seen live: OpenRouter's 403 | - | keep: test |
| `packages/server/src/router-processes.test.ts` | 551 | The router tests that start routers of their own (D163, D172), split from router.test.ts so 'scripts | bun:sqlite; SQLite; sync fs; timers | keep: test |
| `packages/server/src/router.test.ts` | 417 | const KEY = "k_acme_0123456789abcdef"; | bun:sqlite; SQLite; sync fs | keep: test |
| `packages/server/src/trace-report.test.ts` | 131 | D279: the integrator's self-check over an EDEN_TRACE=1 log. | - | keep: test |
| `packages/server/src/user-sources.test.ts` | 488 | const alice: Scope = { tenantId: "acme", userId: "alice" }; | @modelcontextprotocol/sdk/inMemory.js, @modelcontextprotocol/sdk/server/mcp.js, zod; sync fs; timers | keep: test |
| `packages/sim/lab/hermes/test_plugin.py` | 94 | The Eden plugin's contract with Hermes (stdlib only): it never raises into the agent's turn. | http, importlib, threading, unittest | keep: test |
| `packages/sim/lab/m12/pool-pair.test.ts` | 71 | A tiny EP12 file (version 2) with the given weights: B = 32 bits, W = 32, NB buckets. | typed arrays | keep: test |
| `packages/sim/modal/tests/__init__.py` | 2 | The Modal lab apps' unit tests: 'cd packages/sim/modal && python3 -I -m unittest' (no Modal, no toke | - | keep: test |
| `packages/sim/modal/tests/test_bench_report.py` | 164 | bench_report.py: template clusters, the clustered bootstrap, McNemar, the MDE and the variance split | bench_report, tempfile, unittest | keep: test |
| `packages/sim/modal/tests/test_distill_data.py` | 87 | distill_data.py: split checks, records, estimates (python3 -I -m unittest discover -s packages/sim/m | distill_data, unittest | keep: test |
| `packages/sim/modal/tests/test_embed_score.py` | 105 | embed_score.py: packing, ranks and the screen's groups (python3 -I -m unittest discover -s packages/ | embed_score, unittest | keep: test |
| `packages/sim/modal/tests/test_fanout_plan.py` | 401 | fanout_plan.py: shards, the cap split, commands and merging (python3 -I -m unittest discover -s pack | fanout_plan, shutil, tempfile, unittest, zlib | keep: test |
| `packages/sim/modal/tests/test_i1_data.py` | 59 | i1_data.py: pairs joined to labels, targets, AUCs (python3 -I -m unittest discover -s packages/sim/m | i1_data, unittest | keep: test |
| `packages/sim/modal/tests/test_logo_core.py` | 102 | logo_core.py (M14, D1021): the LOGO screen's splits, metrics and text transforms (stdlib only).""" | logo_core, tempfile, unittest | keep: test |
| `packages/sim/modal/tests/test_m1_data.py` | 137 | m1_data.py: rows, splits, targets, the prompt and the held-out figures (python3 -I -m unittest).""" | m1_data, unittest | keep: test |
| `packages/sim/modal/tests/test_synth_data.py` | 81 | synth_data.py: M2's worlds, checks and labelled pairs (python3 -I -m unittest discover -s packages/s | synth_data, unittest | keep: test |
| `packages/sim/src/deletes.test.ts` | 43 | describe("source-side deletions (--deletes)", () => { | - | keep: test |
| `packages/sim/src/demo.test.ts` | 53 | 'bun run demo' (D292): the newcomer's first run. It must work with no key, spend nothing, and say pl | - | keep: test |
| `packages/sim/src/drafts.test.ts` | 38 | A bound on work, not on waiting: process CPU time, so a loaded machine (four test files at once) doe | - | keep: test |
| `packages/sim/src/lab/ab-replay.test.ts` | 379 | 'pi-ab --replay' and '--reuse-arms' (lab only): the reader and the grader behind 'ReplayModel' as pi | subprocess; sync fs; timers | keep: test |
| `packages/sim/src/lab/act.test.ts` | 73 | const spec = (name: string) => ACTIONS.find((a) => a.name === name)!; | - | keep: test |
| `packages/sim/src/lab/ask-coverage.test.ts` | 291 | } from "./ask-coverage"; | - | keep: test |
| `packages/sim/src/lab/card-queue.test.ts` | 67 | const item = (id: string, title: string, text: string): ContextItem => | subprocess; sync fs | keep: test |
| `packages/sim/src/lab/cards-disk-form.test.ts` | 124 | D1060: a replay file may hold the shipped prompt's lines (keyed by 'cardKey') and 'cardsRequestsFix' | sync fs | keep: test |
| `packages/sim/src/lab/cards-disk.test.ts` | 442 | } from "./cards-disk"; | node:zlib; compression; sync fs | keep: test |
| `packages/sim/src/lab/cards-distill.test.ts` | 221 | } from "./cards-distill"; | - | keep: test |
| `packages/sim/src/lab/cards-endpoint.test.ts` | 121 | A stub OpenAI-compatible server: a freeze card for item 0 of every batch and one request per item. | sync fs | keep: test |
| `packages/sim/src/lab/check-api-replay.test.ts` | 53 | afterEach(() => uninstallQueue()); | sync fs | keep: test |
| `packages/sim/src/lab/check-dump.test.ts` | 65 | '--check-dump' (M7, D932): one row a check call, with the pool as read, the answer, the reply and th | sync fs | keep: test |
| `packages/sim/src/lab/connector-options.test.ts` | 119 | const opts = (given: Record<string, string>) => (name: string, fallback: string) => given[name] ?? f | - | keep: test |
| `packages/sim/src/lab/cost-screen.test.ts` | 41 | describe("costScreen (H18)", () => { | - | keep: test |
| `packages/sim/src/lab/days-calls-resume.test.ts` | 101 | R4 (D813): with '--json F', each user lands in F.partial.jsonl as it finishes; a restart with '--res | sync fs | keep: test |
| `packages/sim/src/lab/days-calls.test.ts` | 182 | const MIX = { hidden: 1, control: 1, neutral: 8 }; | - | keep: test |
| `packages/sim/src/lab/distilled-reader.test.ts` | 134 | DistilledReaderMaker, | sync fs | keep: test |
| `packages/sim/src/lab/dress-entities.test.ts` | 80 | A6 (D287): dressed worlds give each person or firm a request names (that no item names) one ordinary | - | keep: test |
| `packages/sim/src/lab/flags.test.ts` | 79 | const KNOWN: FlagSpec = { preset: "value", seeds: "value", set: "value", record: "bool", blind: "boo | subprocess | keep: test |
| `packages/sim/src/lab/free.test.ts` | 214 | anthropicThinkingOff, | @earendil-works/pi-ai | keep: test |
| `packages/sim/src/lab/funnel-flags.test.ts` | 512 | } from "./reader-stub"; | node:child_process; subprocess; sync fs | keep: test |
| `packages/sim/src/lab/funnel-merge.test.ts` | 302 | } from "./funnel-merge"; | - | keep: test |
| `packages/sim/src/lab/gate-traffic.test.ts` | 158 | } from "./gate-traffic"; | node:child_process; subprocess; sync fs | keep: test |
| `packages/sim/src/lab/hermes-anthropic.test.ts` | 106 | describe("toAnthropicBody", () => { | - | keep: test |
| `packages/sim/src/lab/hermes-conditions.test.ts` | 59 | const ALL = { sync: true, cards: true }; | - | keep: test |
| `packages/sim/src/lab/hermes-host.test.ts` | 153 | A stream whose task records what its Eden routes received. | @modelcontextprotocol/sdk/server/mcp.js, node:child_process; subprocess; sync fs | keep: test |
| `packages/sim/src/lab/hermes-proxy.test.ts` | 266 | const KEY = "sk-or-test-SECRET-123"; | typed arrays | keep: test |
| `packages/sim/src/lab/hermes-worker.test.ts` | 69 | A stub worker speaking worker.py's protocol: "crash" exits mid-task, "hang" never answers, anything  | sync fs | keep: test |
| `packages/sim/src/lab/i1-label.test.ts` | 72 | I1 (D470): the checker's labelled pairs. Groups join a template's hidden, control and neutral pools  | - | keep: test |
| `packages/sim/src/lab/i2-label.test.ts` | 52 | I2 (D490): the teacher's question and its scoring against the sim's truth. | - | keep: test |
| `packages/sim/src/lab/injection-suite.test.ts` | 142 | A10's injection suite as a standing $0 test (D305): the suite's attacks, planted in train worlds, re | - | keep: test |
| `packages/sim/src/lab/lab.test.ts` | 170 | The lab itself needs Docker (lab-cli.ts); these cover the parts that decide its numbers. | @modelcontextprotocol/sdk/inMemory.js, @modelcontextprotocol/sdk/server/mcp.js, @modelcontextprotocol/sdk/shared/transport.js, @modelcontextprotocol/sdk/types.js, zod | keep: test |
| `packages/sim/src/lab/lexical-hits.test.ts` | 47 | describe("the hits arm (P3, D831)", () => { | - | keep: test |
| `packages/sim/src/lab/m10/reader.test.ts` | 47 | M10's reader (D962): the dates and amounts an item mentions, resolved to values, as the lab's tagger | - | keep: test |
| `packages/sim/src/lab/m5-ledger.test.ts` | 42 | describe("m5-ledger (D910, D911)", () => { | - | keep: test |
| `packages/sim/src/lab/m6/label.test.ts` | 41 | detail: "Dean's inbox was hacked; ring him on 07700 900481 before paying", | - | keep: test |
| `packages/sim/src/lab/modal-python.test.ts` | 35 | The Modal lab apps' Python unit tests ('packages/sim/modal/tests': the fan-out's sharding and cap sp | node:child_process; subprocess | keep: test |
| `packages/sim/src/lab/neutral.test.ts` | 234 | const s = (wallS: number, usd = 0, edenUsd = 0, tools = 0): WeightedSample => ({ usd, edenUsd, tools | subprocess; sync fs | keep: test |
| `packages/sim/src/lab/observe-tool.test.ts` | 44 | const scope = { tenantId: "t", userId: "u", sessionId: "s" }; | - | keep: test |
| `packages/sim/src/lab/packet-layout.test.ts` | 61 | const bp = { type: "ephemeral" }; | - | keep: test |
| `packages/sim/src/lab/pi-ab-resume.test.ts` | 158 | 'pi-ab --resume' (R4, D813), end to end at $0: pi-ab runs in its own process with 'fake-openrouter.t | subprocess; sync fs | keep: test |
| `packages/sim/src/lab/pi-ab-weighted.test.ts` | 92 | } from "./pi-ab-weighted"; | sync fs | keep: test |
| `packages/sim/src/lab/pi-conditions.test.ts` | 167 | const ALL = { sync: true, cards: true, densePacket: true }; | - | keep: test |
| `packages/sim/src/lab/pi-cost.test.ts` | 208 | const t = (o: Partial<CostTask>): CostTask => ({ | - | keep: test |
| `packages/sim/src/lab/pi-day.test.ts` | 130 | const task = (id: string, planted?: string): Task => ({ | - | keep: test |
| `packages/sim/src/lab/pi-late.test.ts` | 40 | const item = (id: string): WorldItem => | - | keep: test |
| `packages/sim/src/lab/pi-timeline.test.ts` | 148 | } from "./pi-timeline"; | - | keep: test |
| `packages/sim/src/lab/pi-user.test.ts` | 134 | const MIX = { hidden: 1, control: 1, neutral: 8 }; | - | keep: test |
| `packages/sim/src/lab/presets.test.ts` | 25 | describe("lab presets (D112: only the default and the default minus a part)", () => { | - | keep: test |
| `packages/sim/src/lab/queue-transport.test.ts` | 96 | const BATCH = join(import.meta.dir, "../../lab/subagent/batch.ts"); | node:child_process; subprocess; sync fs; timers | keep: test |
| `packages/sim/src/lab/reader-disk.test.ts` | 237 | } from "./reader-disk"; | sync fs | keep: test |
| `packages/sim/src/lab/reader-latency-fit.test.ts` | 84 | const phase3 = join(import.meta.dir, "..", "..", "..", "..", "docs", "research", "haiku-phase3.md"); | sync fs | keep: test |
| `packages/sim/src/lab/reader-stub.test.ts` | 260 | } from "./reader-stub"; | node:child_process; subprocess; sync fs | keep: test |
| `packages/sim/src/lab/reader-time.test.ts` | 96 | const item = (i: number, extra: Partial<ReaderInput["items"][number]> = {}) => ({ | - | keep: test |
| `packages/sim/src/lab/regrade-kinds.test.ts` | 38 | describe("regrade by kind", () => { | - | keep: test |
| `packages/sim/src/lab/reprice.test.ts` | 135 | const GLM = "z-ai/glm-5.3-flash"; | - | keep: test |
| `packages/sim/src/lab/retrieval-screen.test.ts` | 124 | const row = (over: Partial<Row>): Row => ({ | - | keep: test |
| `packages/sim/src/lab/revision.test.ts` | 67 | M3b (D914): '+revision' plants a stale earlier version beside each hidden fact of train5-6 and 5r-6r | - | keep: test |
| `packages/sim/src/lab/reword.test.ts` | 63 | P2 (D820): the reworded train keeps every world, fact and decoy; only the request's words change. | - | keep: test |
| `packages/sim/src/lab/router-sim.test.ts` | 89 | } from "./router-sim"; | - | keep: test |
| `packages/sim/src/lab/run-journal.test.ts` | 107 | 'run-journal.ts' (R4, D813): the code part of the key read from any directory of the repository, unt | node:child_process; subprocess; sync fs | keep: test |
| `packages/sim/src/lab/silent.test.ts` | 101 | F3 (D1123): silent edits. A hidden task's planted item starts at its source as 'before'; the edit la | - | keep: test |
| `packages/sim/src/lab/spend.test.ts` | 44 | const record = (costUsd: number) => ({ | sync fs | keep: test |
| `packages/sim/src/lab/suites.test.ts` | 588 | HELDOUT19_NON_ENGLISH, | - | keep: test |
| `packages/sim/src/lab/synth/synth.test.ts` | 196 | const sample = () => readWorlds(SAMPLE_PATH); | - | keep: test |
| `packages/sim/src/lab/tenant-prompt.test.ts` | 30 | '--tenant-prompt' (A3, D271): the tenant's house rules in every arm's system prompt, so every arm's  | - | keep: test |
| `packages/sim/src/lab/timeline.test.ts` | 92 | const dir = mkdtempSync(join(tmpdir(), "eden-timeline-")); | sync fs | keep: test |
| `packages/sim/src/lab/uptake.test.ts` | 74 | const cites = (...ids: string[]) => ids.map((itemId) => ({ itemId })); | - | keep: test |
| `packages/sim/src/narrow.test.ts` | 28 | describe("narrowQuestion", () => { | - | keep: test |
| `packages/sim/src/perf-sync.test.ts` | 48 | describe("sim:perf synced mode (fix-s3b)", () => { | - | keep: test |
| `packages/sim/src/pilot/pilot-review.test.ts` | 329 | Each test is a defect the F3 review found in the first version of the kit (D489). Sim data only. | node:child_process; subprocess; sync fs | keep: test |
| `packages/sim/src/pilot/pilot.test.ts` | 306 | Sim data only: a generated world stands in for the consenting account (its items carry planted secre | node:child_process; subprocess; sync fs | keep: test |
| `packages/sim/src/rare-sources.test.ts` | 39 | describe("rare sources (P7)", () => { | - | keep: test |
| `packages/sim/src/realism.test.ts` | 52 | describe("realism (F8, D1103): a heavy real user's sources", () => { | - | keep: test |
| `packages/sim/src/sim.test.ts` | 331 | const scope = { tenantId: "t", userId: "u" }; | - | keep: test |
| `packages/sim/src/sources-overrides.test.ts` | 16 | describe("withOverrides", () => { | - | keep: test |
| `packages/sources/src/deadline-unwatched.test.ts` | 77 | const scope: Scope = { tenantId: "t", userId: "u" }; | timers | keep: test |
| `packages/sources/src/guarded.test.ts` | 615 | const scope = { tenantId: "t", userId: "u" }; | - | keep: test |
| `packages/sources/src/joined-flight.test.ts` | 172 | A lookup that joins a call already in flight gets that call's items. A call that began before 'dropR | timers | keep: test |
| `packages/sources/src/list.test.ts` | 199 | const scope = { tenantId: "t", userId: "u" }; | @modelcontextprotocol/sdk/inMemory.js, @modelcontextprotocol/sdk/server/mcp.js, zod | keep: test |
| `packages/sources/src/mcp-source.test.ts` | 490 | A connector-like MCP server: one read tool, one write tool. | @modelcontextprotocol/sdk/inMemory.js, @modelcontextprotocol/sdk/server/mcp.js, zod | keep: test |
| `packages/sources/src/park.test.ts` | 265 | D754: a (user, source) pair's guards are parked once no call has taken them for twenty minutes and t | - | keep: test |
| `packages/sources/src/planner.test.ts` | 590 | const signal = new AbortController().signal; | - | keep: test |
| `packages/sources/src/regressions.test.ts` | 544 | Regressions from the 2026-10-29 audit of the sources: each test failed before its fix. | @modelcontextprotocol/sdk/inMemory.js, @modelcontextprotocol/sdk/server/index.js, @modelcontextprotocol/sdk/server/mcp.js, @modelcontextprotocol/sdk/types.js, zod; subprocess | keep: test |
| `packages/sources/src/schema-args.test.ts` | 238 | } from "./schema-args"; | - | keep: test |
| `packages/sources/src/shapes.test.ts` | 65 | const plain: ShapeOptions = { quotes: false }; | - | keep: test |
| `packages/sources/src/sources.test.ts` | 247 | const scope = { tenantId: "t", userId: "u" }; | timers | keep: test |
| `packages/sources/src/static-source.test.ts` | 172 | StaticSource's index (D175) against the algorithm it replaced, kept here unchanged as the oracle. | - | keep: test |
| `scripts/decision-index.test.ts` | 310 | } from "./decision-index"; | - | keep: test |
| `scripts/deploy-kit.test.ts` | 194 | deploy/scripts/bootstrap-dedicated.sh against stand-ins for ssh, ssh-keygen and ssh-keyscan: no mach | subprocess; sync fs | switched in #338: renders every role's cloud-init and checks the DOCKER-USER block |
| `scripts/dockerfile.test.ts` | 125 | The image copies files one by one, so a file every 'bun' needs at startup can be left out with nothi | sync fs | switched in #333, #335: checks the distroless final stage and the image's exclusions |
| `scripts/format-key.test.ts` | 76 | The known-formatted set's key (scripts/format.sh, D819): the cold gate trusts the set, so the key mu | subprocess; sync fs | keep: test |
| `scripts/lab-guard.test.ts` | 34 | describe("lab-guard (bunfig.toml's preload)", () => { | subprocess | keep: test |
| `scripts/test-cache.test.ts` | 310 | A small repository of its own: the cache under test reads it through EDEN_TEST_CACHE_ROOT. | bun, node:child_process; subprocess; sync fs | keep: test |
| `scripts/test-report.test.ts` | 87 | const root = join(import.meta.dir, ".."); | subprocess; sync fs | keep: test |
| `scripts/test-select.test.ts` | 172 | This repo's own workspace packages with their @eden/* dependencies, read as test-select.ts reads the | node:child_process; subprocess; sync fs | keep: test |
