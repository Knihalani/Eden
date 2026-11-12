# Tech audit (2026-11-12)

This audit reviewed every technical choice in the repository against one bar: switch only where an alternative is at
most medium effort and gives a clear, measurable gain in speed, cost, security, reliability, maintenance or the number
of dependencies. Each choice was checked against docs/DECISIONS.md and docs/DEAD-ENDS.md first, and nothing measured and
decided was reopened without new evidence. Every number below comes from a command run in this session, or is labelled
with the decision it comes from. Decisions: D1600, D1700 (switches), D1701 (this audit's findings).

**Method and its limits.** The audit is per module, not line by line. For each package and directory it read the
package's `CLAUDE.md` file table and the README (the files, and the choices each one makes, with the decisions that
measured them), and the imports, `package.json` and lockfile. Code was read where a choice could be switched: the
Dockerfile, `.dockerignore`, the compose files, cloud-init, OpenTofu, the backup script, Alloy, `blob-store.ts`,
`persist.ts`, the type-check, format and test scripts, and `tsconfig`. The repository holds about 250,000 lines
outside `archived/`: engine 57.6k, sim/src 90.8k, sim/lab 33.2k (251 Python files), primitives 17.3k. Most of
those lines are lab or engine logic whose choices are behavioural and have their own decisions. For them this audit
records the technical substrate (data structures, formats, concurrency), not each heuristic. The registry versions
were read from registry.npmjs.org on 2026-11-12. `archived/` is history and was not reviewed (CLAUDE.md).

## Switches made

| PR | Decision | Change | Measured benefit |
|---|---|---|---|
| #333 | D1600 | The server image runs on `oven/bun:1.4.4-distroless`, with a two-stage build. It runs as uid 1000, so old volumes stay writable. HEALTHCHECK and CMD are in exec form | 430 → 260 MB on disk, 118 → 72.3 MB compressed. Debian packages 80 → 14 status entries. No shell, so `/bin` has no entries (was 261) |
| #335 | D1700 | `.dockerignore` leaves out `packages/sim` (except its package.json), `*.test.ts` and `packages/*/bench`. A test walks the servers' imports | 260 → 230 MB on disk, 72.3 → 65.5 MB compressed. No lab or paid-run script in the production image |

Together: **430 → 230 MB (−47%) on disk, 118 → 65.5 MB (−44%) to pull**. The attack surface also shrinks: no shell, no
apt, no coreutils, no lab code. Both images were checked as follows:

- Docker's health check reads `healthy`.
- `/readyz` reports 2 of 2 children up under `EDEN_PROCESSES=2`.
- `eden doctor` runs.
- A volume written by the old image is read and written by the new one.

## Candidates not switched

| Candidate | Gain | Why not now |
|---|---|---|
| Replace `@modelcontextprotocol/sdk` with a minimal MCP client and stdio server of our own | The production install drops from 93 packages (31 MB `node_modules`) to about 3: express, hono, cors, jose, ajv and ~85 more go. None of them is reached by Eden's imports (`client/index`, `client/streamableHttp`, `server/mcp`, `server/stdio`) | Not medium effort. Streamable HTTP with SSE, session ids, protocol-version negotiation and pagination must match every connector the lab captured. The SDK also tracks the spec. Needs: a design note and the connector lab (`packages/sim/src/lab/capture.ts`) re-run against the replacement |
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

## Owed checks

- **arm64 image, D1600.** The distroless tag publishes linux/arm64 (`docker buildx imagetools inspect`), but this host
  has no QEMU binfmt, and installing it was not permitted here. D990's check under QEMU needs re-running on the new
  Dockerfile.

## Findings (no switch)

- **ufw does not filter Docker's published ports** (D1701). Docker forwards published ports through its own iptables
  chains, which ufw's INPUT rules never see. On a node, `ufw allow from <private cidr> to any port 8790` is therefore
  not what limits access. The limit is the bind address in compose (`${PRIVATE_IP}:8790`). Any host on the private
  network reaches 8790, and Hetzner's cloud firewall (`hcloud_firewall.node`) covers only the public interface
  (Hetzner's documentation; not tested here). API keys and `EDEN_CLUSTER_KEY` still guard every route. This follows
  Docker's documented behaviour and was not tested on a real machine. If the owner wants the private allowlist enforced,
  the fix is a `DOCKER-USER` chain rule.
- **AES-256-GCM with random 96-bit nonces under one derived key** (`persist.ts`). This is sound up to about 2^32 writes
  per key (NIST SP 800-38D). At 1,000 frozen-user writes a minute, one key reaches that in about 8 years. Rotating
  `EDEN_PERSIST_KEY` resets the count. Recorded so a much busier deployment knows the bound. The header and scope are
  bound as AAD, and file names are a keyed HMAC.

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
| sources | `McpSource` on the MCP SDK client (read-only check, D7); arguments from JSON schema; Thompson-sampled query planner; per-(user, source) breaker, AIMD, GCRA and singleflight; `StaticSource` inverted index | keep. The SDK is a candidate (above) |
| graph | Source map on `bun:sqlite`, WAL, `synchronous=NORMAL`, busy timeout | decided: D4, D8, D15 |
| llm | `fetch` to OpenRouter (ZDR, `data_collection: deny`, D12) with `sort` routing (D66); `Budget` and `TenantSpend`; lab-only `AnthropicModel` (D97); `Pacer` | keep. The direct route is a candidate |
| engine | Per-user BM25F `ItemCache` on primitives; item text deflated (`packed-text.ts`); frozen users as zstd-3 JSON blobs, warm form "EDF2" (D325, D860, D862); `EncryptedFrozenDisk`: AES-256-GCM, HKDF-derived keys, HMAC file names, atomic temp-file rename (D425, D991); `SharedFrozenDisk` to S3 (D992); turn gate and gloss as `.bin` hashed n-gram tables (D1014, D1153); redaction in Bun workers (D25, D26); spans and traces content-free | decided by the decisions named. GCM's write bound is under Findings |
| server | `Bun.serve`; GCRA per tenant; multi-process router over `Bun.spawn` children with jump-hash placement (D113, D163, D178); cluster router with rendezvous placement and epoch fencing (D992-D995); `/metrics` as hand-written Prometheus text (D994); Bun's built-in `S3Client` (D992, no dependency); MCP `ask_context` on the SDK's `McpServer` and stdio transport, with zod for its input schema; config validated at startup with exit 2 (D365) | keep. Zod is required by the SDK's `registerTool`, so it goes only with the SDK |
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
