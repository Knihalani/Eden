# Eden — Full Audit & Execution Plan

*Date: 2026-08-24. Basis: 898 passing tests, clean typecheck, all gated benchmarks WIN,
plus a multi-front audit (runtime/compiler correctness, CLI/packaging, security surface,
product readiness). Findings verified against source; file:line references included.*

---

## Part 1 — Audit findings

### 🔴 CRITICAL — correctness (breaks shipped functionality)

| # | Finding | Where | Impact |
|---|---|---|---|
| **C1** | Fork programs place `envelope` as a top-level key instead of inside `contract`. `inDistribution()` reads only `contract.envelope`, so with it absent every input is out-of-distribution. | `packages/compile/src/fork.ts:286-287` | Every fork-mined program deopts on *every* input once live. G2 (conditional workflow compilation) can never ship until fixed. |
| **C2** | Fork `returns` references `lastThenStep ?? lastElseStep ?? branchId`. When the guard selects the else arm, the then step never ran; `evalBinding` throws a plain `Error` (not a DeoptError), so replay classification fails and the error propagates raw. | `fork.ts:273-285`, `runtime/src/bind.ts:77` | Compiled fork runs crash to the agent instead of falling back. |
| **C3** | Parallel sibling calls are suppressed (`{eden:"steered"}`) *before* the compiled run finishes. If that run then fails, the catch only deletes the arming — already-suppressed siblings were executed by nobody. For mutating tails, work the agent believes happened never did. | `wrap/src/wrap-tools.ts:750-787` | Lost side effects — the one failure class worse than blocking. Violates the spirit of the prime directive. |
| **C4** | Setup copy tells users `OPENAI_BASE_URL=http://127.0.0.1:8787/v1`, but `eden wrap` defaults to **8788** (8787 is the dashboard). Following our own instructions points LLM traffic at a UI server. | `apps/site/src/server.ts:269`, `cli.ts` help vs `wrap-cmd.ts:16` | First-run integration silently broken for every OpenAI-compatible user. |

### 🟠 HIGH

| # | Finding | Where |
|---|---|---|
| **H1** | Anthropic steering zips replacements positionally while `steerToolCalls` drops sibling calls → wrong name/input attached to subsequent tool_use blocks. Also: no `res.ok` check, error bodies fed to `.json()`, streaming clients break, bare `fetch` without timeout, and CommonJS `require()` inside an ESM package. Handler is currently unwired — dormant landmine. | `wrap/src/anthropic.ts:81-151` |
| **H2** | Failure-cluster mining builds sequences from undecorated shell names (`Bash`) while everything else uses decorated names (`Bash:kubectl.get.pods`). Alignment finds nothing; groups silently skipped while advertising steps that don't exist → live programs that arm suppression for tail steps the compiled run never performs. | `compile/src/mine.ts:222-241`, `compile.ts:394-400` |
| **H3** | Templates are verified under two different renderers (`interpolateSlots` for inputs, `interpolate` for prior-result/shell recovery) while runtime always renders with `interpolateSlots`. A template containing `${VAR}` or a literal `{token}` is witnessed under one renderer and executed under another → compiled tool runs commands never observed. | `compile/src/bind.ts:186,200`, `steer.ts:215`, `runtime/bind.ts:86` |
| **H4** | npm publish is impossible today: `bin` points at `.ts`, cli.ts has no shebang, deps use `workspace:*` (only pnpm rewrites those), code needs Bun APIs + top-level await. | `packages/cli/package.json`, `cli.ts` |

### 🟡 MEDIUM — engine

| # | Finding | Where |
|---|---|---|
| M1 | Branch executor double-counts `toolCallsIssued` (~2× stepsRun near branches) → skews replay-safety boundaries and receipts. | `runtime/execute.ts:183,227-230` |
| M2 | Compose ignores `SubProgramEntry.registry`, doesn't forward parent abort signal, hard 30s default truncates legitimate sub-programs. | `runtime/compose.ts:19-57` |
| M3 | `pauseLiveFor` fires on any 2-consecutive failures regardless of enforcement mode — pauses live programs and POSTs control-plane state **in observe mode**, contradicting "guards observe". | `wrap-tools.ts:561-575` |
| M4 | `compiledDef` (proxy-get path) rethrows non-deopt errors straight to the agent — different failure philosophy from the prefix-steer path we just hardened. | `wrap-tools.ts:590-601` |
| M5 | Tool-name collision precedence inverted: local wrap prefers raw, proxy injection prefers compiled. Same agent, divergent behavior, no warning. | `wrap-tools.ts:941`, `steer.ts:351-357` |
| M6 | Control-plane posts, pullLive, and upstream chat have no fetch timeouts / injected-fetch consistency; hung upstream hangs client requests. Non-numeric `EDEN_ISLAND_MS` throws synchronously via `AbortSignal.timeout(NaN)`. | `wrap-tools.ts:196-280`, `proxy.ts:65-97`, `island.ts:81` |
| M7 | Bash jail is regex-advisory: `python3 -c 'import os; os.system(...)'` bypasses token scanning entirely. Fine as defense-in-depth; dangerous if treated as a boundary. | `wrap/coding.ts:20-96` |
| M8 | Failure-cluster alignment indexes ok-events by count but cuts at firstWarningAt over all events → wrong-occurrence arg binding on interleaved failures. | `compile.ts:394-396` |
| M9 | Stale-DB boot crash: `CREATE INDEX … (tool_id, created_at)` in `SQLITE_STATEMENTS` runs before `migrate()` adds the column → any pre-migration DB bricks startup. (Reproduced.) | `apps/site/src/db.ts:39,123-125` |

### 🟡 MEDIUM — product / SDK / ops

| # | Finding | Where |
|---|---|---|
| P1 | sdk-js ingests raw args with **no redaction** (hook path redacts; SDK doesn't) — secrets flow to `/v1/ingest`. Imported traces also unredacted. | `sdk-js/index.ts:39-56`, `cli/import.ts:54-63` |
| P2 | No retention: `~/.eden/runs/*.jsonl` grows forever if plane is down; empty shells + cursor sidecars accumulate permanently. | `drain.ts`, `hook.ts` |
| P3 | SDK contract skew: sdk-js defaults to port **8787** (site) not 8788 (wrap); no fetch timeout in sdk-js (py has one); **no version negotiation anywhere** in the protocol; `sdk-python/` duplicates `sdk-py/`. | `sdk-js/index.ts:9`, `client.py:63` |
| P4 | Trace import: one malformed LangSmith line rejects the entire export as "Unrecognized format"; whole file read into memory (no size cap); imported traces fabricate llmCalls/duration/cost → corrupts savings metrics. | `cli/ingest.ts:355`, `import.ts:25,68` |
| P5 | hookd: timed-out request handler keeps running holding its file lock → recording silently lost under load; no graceful shutdown. | `hookd.ts:71-79` |
| P6 | Dev-mode auth fallback is default-on for non-managed deployments (`EDEN_DEV !== "0"`). Anyone running the site publicly without DATABASE_URL/VERCEL serves an open workspace. Footgun. | `db.ts:407-420` |
| P7 | 97 modified files uncommitted; last commits are prior audit passes — current fail-safe + UX work is at risk. | git status |

### ⚪ LOW
Assert tokenizer partial-parse errors (L1), alias fallback mis-slotting (L2), fork duplicate step ids + quote-embedding interpolation (L3), compiledCache eviction gap (L4), island abort-sniffing by message text (L5), shadow token scaling treated as measured outside island case (L6), placebo pairing assumption (L7).

### ✅ Verified well-engineered (do NOT redo)
Concurrency-safe trace attribution (invocation tagging + partitioned flush); disciplined memory bounding everywhere (no unbounded growth found); replay-safety contract (`stepsRun` stamped pre-call); loop/wave parallel safety with allowlist + per-iteration boxes; compiler honesty gates (witness intersection, trap92, redacted-secret refusal); deterministic versioning/hashing; honest savings ledger; SSRF defenses (redirect-following, IPv6-mapped, hex encodings — tested); monotonic clocks in all decision paths; timing-insensitive sha256 key lookup; config perms 0600/0700.

---

## Part 2 — The plan

### Phase 0 — Housekeeping (today, ~30 min)
1. Commit the uncommitted fail-safe + UX work (P7).
2. Fix C4 port mismatch in onboarding page + CLI help (one string each).
3. Fix M9 migration order: add `created_at` ALTER before index creation, or wrap index DDL in try/catch like migrate() does.

### Phase 1 — Prime-directive completion ✅ DONE (this session)
The fail-safe pass covered prefix steering; three paths still violated or undermined it. All fixed, each pinned by tests in `packages/wrap/src/failsafe.test.ts` ("phase 1" describe blocks):
1. **C3 sibling-loss** — FIXED. Arming entries now carry a settle deferred (`settled`/`resolveSettled`/`headErr`). Parallel siblings wait (bounded by wrap timeout) for the head's compiled run to finish before claiming their share. On success they claim as before. On failure: `DeoptError` now carries `toolCalls` (steps that COMPLETED), so a sibling whose step already ran claims it without repeating it; a step nobody completed re-runs raw if read-named; a mutating step under any ambiguity returns an honest structured deopt — never a silent loss, never a duplicate write.
2. **M3 observe-leak** — FIXED. `pauseLiveFor` is enforcement-only now; observe mode never mutates live programs or POSTs control-plane state.
3. **M4 inconsistent fallback** — FIXED. `compiledDef` follows the same touched/replayable policy as prefix steering; pure-compiled names never propagate thrown errors to the agent.
4. **M6 unbounded network paths** — FIXED. Control-plane posts/pulls bounded by `EDEN_CONTROL_TIMEOUT_MS` (default 10s), proxy upstream by `EDEN_UPSTREAM_TIMEOUT_MS` (default 300s), island timeout NaN-guarded.

Additional defects found and fixed during execution:
- **Guard-steer could never fall back**: the pre-existing catch returned "halted" unconditionally even for provably-replay-safe failures; and in enforcement mode a failed steer must NOT fall back to the very call being refused. Policy now: prefix steering falls back when replay is safe; guard steering halts unless the stretch is all-reads and untouched.
- **Runtime error semantics**: all mid-run failures now surface as stamped `DeoptError`s (`stepsRun`, `toolCalls`, original preserved as `cause`) so every fallback decision has exact completion information; shadow's `UnrecordedCall` classification walks the cause chain and still works.
- **armTail crash-safety**: corrupt programs can no longer defeat arming and crash the call — arming failures degrade to raw execution.

### Phase 2 — Fork/G2 completion ✅ DONE (this session)
1. **C1 envelope placement** — FIXED. `contract.envelope` now carries the witnessed inputs; `inDistribution()` gates fork programs correctly. A zero-input (fully literal) fork sets `allowExact: true` instead — nothing variable exists to be out-of-distribution.
2. **C2 branch-aware returns** — FIXED. `returns` binds to the BRANCH step, which the runtime stamps with whichever arm's last value executed. Both arms return their own result; regression-tested by executing the else arm through `runProgram`.
3. **Stable identity** — FIXED. Fork programs derive id from `hashStretch` and version from `withVersion`, exactly like linear programs; recompiles update in place instead of minting `fork_0/fork_1/…`.
4. **Honesty gates** — FIXED. Fork assembly routes through the same pipeline as linear: `assertValid`, min-3-steps, under-determined inputs, constant/empty outputs — each refusal carries the actionable message. Also moved fork mining BEFORE the MAX_PROGRAMS cap so it can no longer silently overflow the program budget.
5. **Tests rewritten to execute** — the old suite asserted inside `if (prog)` and never ran anything. The new tests validate assembly, prove envelope gating both ways, EXECUTE both arms through `runProgram`, verify stable identity across compiles, and drive branched programs end-to-end through `wrapTools` (then-arm, else-arm, out-of-envelope raw fallback) in `failsafe.test.ts`.

Additional defect found and fixed during execution:
- **Input binding could never bind varying inputs** (`fork.ts` buildArmOrPrefix): the matcher held ONE witness's input value constant across the whole cohort, so only all-literal forks could ever assemble — varying inputs (the entire point of compilation) refused. Now each witness's arg is compared against its own input value at that path.

### Phase 3 — Steering & compile soundness ✅ DONE (this session)
1. **H1 Anthropic handler rebuilt** on proxy.ts's pipeline: id-keyed steering (absorbed siblings removed from the response instead of positionally shifted), static import replacing CJS `require()`, ok-check + text-then-parse verbatim passthrough for error/non-JSON bodies, kill-switch degrades to unsteered passthrough (no more 409), `opts.fetch` injection + bounded upstream timeout, and a full Anthropic SSE re-framer (`message_start` → block deltas → `message_stop`) so streaming clients with tools work. Provider usage now recorded onto the run. Found & fixed the same gap in proxy.ts: **response steering is gated on steerable** — an unsteered passthrough returns the model's own tool calls untouched. Also fixed both handlers' opt-in predicate: an empty tools array HAS opted into function calling (documented contract of injectTools); a missing tools field has not.
2. **H2 failure-cluster name decoration** — `namesBefore` now uses `effectiveEventName`, so warned prefixes containing shell events mine as alignable decorated names instead of bare "Bash" clusters that silently vanished while advertising phantom steps.
3. **H3 single-renderer templates** — prior-result template verification and `recoverShellInput` now use `interpolateSlots` (the only renderer the runtime executes). Verified == executed by construction; commands containing literal `${VAR}` or unusual braces can no longer verify under one renderer and execute under another.
4. **M8 cut-aware alignment** — failure clusters carry per-trace `cutAt`; `aligned()` never looks past a trace's own warning boundary, so post-warning occurrences can no longer bind arguments from the wrong event.
5. **M1 branch accounting** — arm tools are counted once (execStep already counts); stepsRun near branches no longer reads ~2×.
6. **M2 composition** — `sub.registry` is honored (was dead code); parent cancellation forwards into sub-programs via `RunOpts.signal`; sub-program timeout defaults to `EDEN_SUB_TIMEOUT_MS`/120s instead of a hard 30s truncation.
7. **M5 collision precedence** — in-process name resolution now matches the HTTP proxy: approved compiled tools take precedence over same-named host functions, with a one-time warning naming the conflict and the remedy.

Tests: 12 new (Anthropic handler suite rewritten end-to-end, H2 shell-decoration regression, M1 accounting, M2 registry/cancellation/timeout, M5 collision+warning-once) — total suite now 926 tests.

### Phase 4 — Distribution ✅ DONE (this session)
1. **H4 npm packaging fixed and verified**:
   - CLI bundles to a single dependency-free `dist/eden.js` (79 modules inlined, ~360 KB) via `scripts/build-cli.sh` — `bun build --target=bun` emits the shebang itself; the literal-`workspace:*` problem is gone because nothing external remains.
   - `packages/cli/package.json`: `bin → dist/eden.js`, `files: [dist, README]`, no runtime deps, `prepublishOnly` rebuilds.
   - Build script gates on typecheck + tests, smoke-runs the bundle (`--help`), and dry-run-packs the tarball (94.5 kB, 2 files).
   - CI now runs `scripts/build-cli.sh` so bundling breakage fails CI instead of a user's install.
2. **Version negotiation shipped**: `EDEN_PROTOCOL_VERSION` + `protocolCheck()` in @eden/ir. Both servers refuse mismatched `/v1/*` clients with **426 + actionable message** (naming both versions) while absent/malformed headers pass — legacy clients never brick. `/health` reports `protocol`. Clients sending the header: wrap proxy (sendPost/pullLive), CLI hook flush / drain / import, sdk-js, sdk-py.
3. **Managed-deployment assertion** — already covered by tenancy tests (`DATABASE_URL` deployment refuses `/v1/setup` with 401); verified present rather than re-written.
4. **SDK consolidation**: stale `packages/sdk-python` (single-file, dead endpoint) deleted; `packages/sdk-py` is canonical. sdk-js default port corrected 8787→8788 (the dashboard port was intercepting SDK traffic); both SDKs send the protocol header; sdk-js/sdK-py package metadata made publish-ready.

P4 schema note: `/v1/traces` POST already accepts single-trace and `{traces:[…]}` bodies server-side; the protocol header now records which wire version a client speaks so any future shape change is enforceable.

### Phase 5 — Data hygiene & measurement honesty ✅ DONE (this session)
1. **P1 redaction at every boundary**: the site's `/v1/ingest` and the control plane's `/v1/traces` POST now run `redact()` over event args/results/commands before persistence — previously NO server-side redaction existed anywhere, so non-redacting clients persisted secrets verbatim. sdk-js scrubs args client-side with a dependency-free scrubber (secrets don't even transit; server remains the guarantee). Trace import redacts before posting.
2. **P2 retention** (`~/.eden/runs`): swept on every `ensureHome` — empty `.jsonl` shells older than 1h removed with sidecars, logs past `EDEN_RETAIN_DAYS` (default 14) swept even when non-empty, orphaned `.lock`/`.cursor` garbage-collected. Best-effort by construction; drain being down is exactly when files accumulate, so sweeping lives outside drain.
3. **P4 import honesty**: LangSmith parsing skips malformed lines and COUNTS them (one bad line no longer rejects a whole export as "Unrecognized format"); 64MB size cap prevents OOM on huge exports; reconstructed llmCalls/duration/cost are flagged `metrics_estimated: true` on the trace so no gate mistakes a guess for a measurement.
4. **P5 hookd**: `/hook` requests are serialized through a bounded queue instead of raced-then-abandoned — the losing handler no longer keeps running holding the session lock while later hooks fail open. SIGTERM/SIGINT now stop accepting connections, drain the queue (bounded), and exit 0.
5. **M9 permanent test**: booting a legacy pre-`created_at` database succeeds and migrate() backfills the column (was the bricked-upgrade crash).
6. **L5/L6 polish**: island retry-stop matches `AbortError` by name, not just message text; shadow token extrapolation keys off compiled LLM use itself, so composed sub-program calls can no longer masquerade as a *measured zero*.

Tests: +16 across protocol/redaction/retention/migration/import-tolerance/L6.

### Phase 6 — Validation & launch
1. ~~Landing page copy~~ ✅ `/onboarding` serves as the public front door (unauthenticated `/` redirects there); upside / trade-offs / never-do panels cover positioning.
2. **Deployed to production** ✅ https://eden-murex-nine.vercel.app — Vercel project `eden`, root `apps/site`, Neon Postgres (`broad-mountain-93797752`/eden-prod), protocol gate verified live, GitHub repo linked for auto-deploy (verify the Vercel GitHub App is installed on Knihalani/Eden after first webhook).
3. **Live A/B benchmark** — pending budget (~$1.1K) per §7 methodology. The only remaining item gating *citable* production numbers.
4. Load test of hookd + proxy under concurrent sessions — recommended before scale-out; single-workspace use is fine today.

**Sequencing rationale:** Phase 0 protects existing work. Phase 1 completes the promise we just made to users before anything ships publicly. Phase 2 unlocks the biggest remaining capability (G2). Phases 3–4 make the thing installable and trustworthy for strangers. Phase 5 closes data-honesty gaps that would poison the metrics the pitch depends on. Phase 6 is launch.

**Explicit non-goals:** rewriting trace attribution, memory bounding, wave execution, ledger honesty, or SSRF defense — audited and solid.
