# Eden Memory — builder waves

**Canonical execution spec.** Product locks: `docs/MEMORY-PLAN.md`. Autopsy: `benchmarks/memoryagentbench/SOTA-GAP-REPORT.md` (cited as **Report §**). Company method: `docs/ROADMAP.md` §0 / §4.9 (rotation, hold-outs, red-team). UI rebuild is **not** this work (`apps/web/REBUILD.md`). Locked whatever harness: do not touch.

**Orchestrator prompt:** `docs/MEMORY-WAVE-PROMPT.md`.  
**Run next wave:** slash command **`/memory-wave`**. Next pending wave until **CLOSED**, **every finding fixed**. After **M50**: Plan §7 is true, the inject scoreboard is filed, **and** a help ledger shows memory aiding real wrap/hook sessions — then **deletes** that command. **Competitor autopsy:** `docs/MEMORY-COMPETITORS.md`. Do not install `memorable-cli`. Do not add `memory_search`.

**50 waves × 4 parts = 200 parts.** M1–M15 closed (spine + how-to + official exams). **M16–M37** are SOTA mechanisms + first official re-bench. **M38–M49** are the product that **actually helps** (silence when useless, continuity, pin/forget, first-session, live coding). **M50** ships and deletes `/memory-wave`. Inside a wave, all four parts run **in parallel**. Zero inter-part dependencies. Disjoint files (or an explicit line-range split). If two fixes need the same lines, they are one part, not two. Cross-wave only: a wave does not start until the previous gate holds.

**Help bar (M38–M50):** a wave does not close on a MAB cell alone. “Helps” means: the next turn is more correct *or cheaper* because of inject, **or** inject was correctly omitted; a stranger feels continuity after sleep; harmed packets are gone next time. Always-on junk is a product failure even if Table 3 moved. Measure on wrap+hook traces (M47 HELP.md), not only MemoryAgentBench.

M16–M20 as originally written (four competencies in one debug wave, then optimize/verify/ship) are **superseded**. Do not execute the old M16 “four competency deltas” as one wave. M37 does **not** delete the command.

**Close honesty:** “LOSS OK” means the artifact names the LOSS **and** the no-memory control — not “file exists.” “Green ×3” names the test file in Evidence. “Reject in writing” is allowed only for optional Dense / PreToolUse / MCP. Unit fixtures do not close official Table 3 / LME / TB cells (M8 unit ≠ FC-MH 262k).

**Phase types** (same as `docs/ROADMAP.md` §4):

| Type | Produces | Closes when |
|---|---|---|
| **B** · Benchmarking / checking | Harness, fixture, or official run | Verdict recorded (WIN / LOSS / FAIL-as-baseline). No silent retune. |
| **T** · Testing | Pass/fail tests the D/O owner does **not** write | Red→green; green on 3 consecutive suite runs |
| **O** · Optimization | Measured improvement on a named hot path | Gate WIN or documented parity; **no** LoCoMo retrieve@5 |
| **D** · Debugging | Root cause + fix for a named anomaly | Anomaly unreproducible; pin test (owned by T) green |

**How to pick up a part**

1. Read this row + the cited **Report §§** + `docs/MEMORY-PLAN.md` locks (§0).
2. Implement in Owner files / line ranges so the four parts stay parallel. After merge, the orchestrator **fixes every extra memory finding** — nothing is left for a later wave.
3. T owners write tests; D/O owners write product code. Merge on the test file is T’s.
4. Wave closes when **all four** Done-whens hold **and leftovers are none**.
5. Fail-open: `inject` catch stays pass-through. Add a metric; do not throw.
6. If a B part in the same wave needs that wave’s D, the B owner **waits on merge then measures** — the only allowed intra-wave wait. Do not start M{N}+1. Coupled work that cannot even start in parallel is one part, not two.

**Do not:** score `BrainMemory` / `cortex: false` as the product; quote retrieve@40 as MCC; EventQA-64k as Table 3; LoCoMo 92; k=40; `label:` strip; GraphRAG EventQA; Mem0 extract on ICL; gated UI phases; Memorable MCP / `memorable recall` as the default loop; cloud extract; 60ms CLI recall in front of inject; fail-closed writes that 403 the host.

---

## Cross-wave DAG

```
M1 Instrument (check)
    ├── M2 Encode          ⎤
    ├── M3 Cue + order     ⎥  parallel after M1
    ├── M4 Ranker hygiene  ⎥
    └── M5 Persist         ⎦
              │
              ▼
         M6 Holdout check
              │
              ▼
         M7 Sleep / replay          ← CLOSED
              │
              ▼
         M8 Assembly + fuse         ← CLOSED
              │
              ▼
         M9  Structured experience  ← CLOSED
         M10 Sleep how-to           ← CLOSED
         M11 How-to integrity       ← CLOSED
         M12 Cue-complete how-to    ← CLOSED (`[procedure]` on existing inject; no tools)
         M13 Honest off switch      ← CLOSED
         M14 One brain              ← CLOSED
              │
              ▼
         M15 Official exams (check)          ← CLOSED
              │
              ▼
         M16 Evidence lock (no retune)       ← NEXT
              │
              ▼
         M16 Evidence lock (no retune)
              │
              ▼
         M17 Encode lanes (stop extract tax)
              │
              ▼
         M18 Narrative chunks ∥ M19 ICL atoms
              │
              ▼
         M20 SF candidates → M21 code-pick → M22 CAR hops
              │
              ▼
         M23 Experience files → M24 retrieve → M25 sleep → M26 LME re-exam
              │
              ▼
         M27 AR SH → M28 AR MH
         M29 LRU gists → M30 DetQA + route stub
         M31 Recsys / TTL remainder
              │
              ▼
         M32 Terminal-Bench 2.1 Δ (measure; silence gate is M38)
         M33 Competency router (no memory_search)
         M34 Packet + persist quality
              │
              ▼
         M35 Negative + savings (bench annex)
         M36 Adversarial + walkthrough
              │
              ▼
         M37 SOTA re-bench (checkpoint; do not delete command)
              │
              ▼
         M38 Remain-silent (omit junk; Start briefing exempt)
         M39 Dedup + diverse packet
         M40 Provenance / ages (does not reintroduce losers)
         M41 Host artifacts → pathCues (M3 cue stays)
         M42 Incremental sleep (no mid-task tombstone)
         M43 Pin / forget in language
         M44 Project identity proof (layout is M5/M14)
         M45 Subagent / worktree share
         M46 Import history (day-1; silence still wins)
         M47 Help ledger on wrap+hook traces
         M48 Live coding holdout (flake/ADR/file)
         M49 First-session + setup polish
              │
              ▼
         M50 Ship: §7 + scoreboard + HELP.md; delete /memory-wave
```

`src/index.ts` is a god file. M2–M5 are parallel only because of the **line-range split** below. Do not expand a part into a neighbor’s range.

| After M1, owner | `src/index.ts` range (today) | Also owns |
|---|---|---|
| **M2** | `extractDurable` ~255–280, `CHAT`/`ACK_PREFIX` ~226–229, salience tags on write | hook tool observe |
| **M3** | `convBlob` ~206, `inject`/`injectBody`/`notesFor` ~739–769 | wrap Anthropic order |
| **M4** | `queryHay` ~171–184, `noteBonus` ~40–58, `pinEnvFact` ~98, `pathCues` ~355, `subjectKey` ~548, `relevant` extras ~668–719 | — |
| **M5** | `persist`/`load`/`flush` ~538–655, `openMemory`/`processMemory` ~779–786, `CUES` WeakMap ~410 | hook session dir |

M3 must not change `relevant()` scoring internals. M4 must not change `inject()` signature or causal order. M5 must not change retrieve ranking.

---

## Wave M1 — Instrument *(check; no ranking change)*

**Goal:** freeze the object under test and pin today’s bugs as tests/baselines. Product behavior stays put. Report **§0, §2, §5.4, Gate 0, §11.1**.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M1.1** Freeze API-under-test | T | `benchmarks/memoryagentbench/INJECT-API.md` (new); test that product scores import `openMemory` / hook inject, **not** `BrainMemory` | One paragraph: wrap OpenAI `injectBody`, Anthropic `withKnowFactsAnthropic`, hook `memoryHookResponse`. Ban `cortex: false` as a published column. | §2, §5.4 | Doc + test exist. CI fails if a new bench file imports `BrainMemory` without `// not-product` |
| **M1.2** Official protocol sheet | B | `benchmarks/memoryagentbench/PROTOCOL.md` (new) | Copy Table 3 lengths: EventQA **534k**, FC **262k**, SH **197k**, MH **421k**, k=**10**, 4o-mini reader, no `label:` strip. Forbidden-comparison list from Report §0. | §0, §3, §11.1 | Sheet matches Report. A later runner that uses 64k / k=40 fails a protocol test |
| **M1.3** Characterization suite (red is OK) | T | `src/memory-char.test.ts` (new) | Assert **current** behavior so later waves cannot silently regress or “fix” without flipping the test: (1) `please` / `fix the` dropped; (2) `auth.ts` not a cue; (3) “Auth is failing” deletes Clerk; (4) Anthropic observes before rank; (5) `sal=0.6` unpinned; (6) fuse 1.000 vs 1.219 if CLS on. Mark each `// WAVE-FIX: M2.1` etc. | §5.1–5.3, §6.1 | File merged. Tests document today. Do **not** make them pass in M1 |
| **M1.4** Baselines | B | `benchmarks/memoryagentbench/BASELINE.md` (new); swallow counter log only (no ranker change) | inject p50/p95, persist bytes, JSONL n, swallow count (`inject` catch). Fail-open stays. | §5.2 | Numbers dated. M11 compares against this file |

**Parallelism:** four new files. No `src/index.ts` edits except an optional swallow `console`/`metric` behind a flag in M1.4 — if that touches `inject` catch, M1.4 owns **only** the `catch` block (~761), not cue logic.

**Rotation:** characterization cases come from Report §5, not bakeoff rec5.

**Wave close:** M1.1–M1.4 Done-whens. Product holdout still unmeasured (that is M6).

---

## Wave M2 — Encode experience *(debug)*

**Goal:** hippocampus stores the turn. No `please` drop. Tools are experience when the host has them. Report **§5 write failures, §4.12 LME-V2, §11.2 AMA-Bench**. Plan §1.2 / §6.5 extract/tools.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M2.1** Stop dropping agent language | D | `src/index.ts` `extractDurable` ~255–280 and the allow-list/`CHAT` gates that feed it | Store ordinary language: `please`, `fix the`, `we need to`, fences, `git `, `bun `. Still redact secrets. | §5 write failures | M1.3 items tagged `M2.1` flip green. “Please fix the flake in auth.test.ts” is stored |
| **M2.2** Observe tools on the hook | D | `packages/cli/src/memory-hook.ts` (`MEMORY_EVENTS` ~5, `memoryHookResponse`); `packages/cli/src/hook.ts` PostToolUse ~280 **add observe without breaking stretch recording** | `PostToolUse` + `SubagentStop` observe tool name + result. Plugin `hooks.json` already lists SubagentStop; hook must honor it. Stretch/transparent path stays. | §5.3, §11.2 | Tool failure text is in JSONL after a PostToolUse fixture. Existing `hook.test.ts` PostToolUse stretch tests still green |
| **M2.3** Observe tools on wrap | D | `packages/wrap/src/proxy.ts` ~176,193; `packages/wrap/src/anthropic.ts` ~258; tool-result messages already in `body` | `observe` assistant tool_calls + tool-role results. Do **not** change retrieve-then-observe order (M3). | §5.3, §4.12 | Wrap fixture with a tool result writes an episode. `know-inject.test.ts` still pass |
| **M2.4** Tool-trace holdout (check) | B | `benchmarks/memory-holdout/tools.md` + fixture JSON (new) | AMA-shaped cases: test exit, git sha, flake log. Run on **hook inject**. Record FAIL until M2.2 lands; this part still **merges the fixture**. | §11.2 AMA-Bench [arxiv:2602.22769] | Fixture exists; M6 re-runs it. Do not tune ranker |

**Parallelism:** M2.1 `src/index.ts` extract only; M2.2 CLI hook; M2.3 wrap; M2.4 `benchmarks/`. T for M2.1 lives in `src/memory-char.test.ts` flips — **T owner is M1.3 file; M2.1 D only flips expected assertions by coordinating with a dedicated test patch in `src/memory-encode.test.ts` (M2.1 may add that file).** Simpler rule: **M2.1 adds `src/memory-encode.test.ts`**; does not edit M1.3 (M1.3 stays as historical red snapshot **or** M2.1 updates the `WAVE-FIX: M2.1` cases only — that’s a known two-file touch; M2.1 owns those tagged tests).

**Wave close:** encode tests green; tool traces stored on hook **and** wrap; holdout fixture filed.

---

## Wave M3 — Cue and causal order *(debug)*

**Goal:** retrieve from **this-turn cue**, then encode. One order on OpenAI, Anthropic, hook. Report **§5.3 three pipelines**. Plan §0 causal order.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M3.1** `cueFor(this turn)` | D | `src/index.ts` `convBlob` ~206, `inject` ~747–762, `notesFor` ~739–745 | Rank blob = latest user text + short WM (not full window, not last-8 novel, not transcript-40). `notesFor(convBlob)` dies. Signature of `relevant()` unchanged. | §5.3 | Unit: 40-line transcript + new user line → cue is the new line. M1.3 Anthropic item stays until M3.2 |
| **M3.2** Anthropic retrieve-then-observe | D | `packages/wrap/src/know-inject.ts` `withKnowFactsAnthropic` ~60+; do not swap OpenAI the wrong way | Same order as `inject`: notesFor **then** observe. Skip-if-mark still observes (match OpenAI). | §5.3 table | Anthropic no longer echoes this-turn extract as “memory.” `know-inject.test.ts` updated by **M3.4** |
| **M3.3** Hook cue = prompt, not transcript-40 | D | `packages/cli/src/memory-hook.ts` `memoryHookResponse` ~58–74 | Submit/PreCompact: `notesFor(prompt)` (plus short WM if session_id already exists — session persist is M5; here pass prompt as cue). Transcript still observed. SessionStart still eviction until M7 — **do not** invent gists. | §5.3 | Hook test: ranking query is the prompt string |
| **M3.4** Packet-identity tests | T | `packages/wrap/src/know-inject.test.ts`; `packages/cli/src/memory-hook.test.ts`; new `src/memory-order.test.ts` | Same `observe`/`inject` contract documented in M1.1. Wrap OpenAI vs Anthropic vs hook: order matches Plan §0. | §5.3 | 3 consecutive green. D owners do not write these files except import types |

**Parallelism:** M3.1 `inject`/`notesFor`/`convBlob`; M3.2 wrap know-inject; M3.3 memory-hook ranking call; M3.4 tests only.

**Wave close:** one causal order; cue is this turn.

---

## Wave M4 — Ranker hygiene *(debug)*

**Goal:** any-agent core. Delete LoCoMo hay and bakeoff pins. Keep binary IDF for now (not a BM25 rewrite). Report **§5.1**. Plan §6.1 / §6.5 hay rows.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M4.1** Kill `queryHay` expansions | D | `src/index.ts` `queryHay` ~171–184 | Tokenize + skip list only. No diet / childhood / pets / stained glass / adoption / running-from-shoes. | §5.1 | `queryHay("best restaurant")` does not contain `diet` |
| **M4.2** Kill `noteBonus` + `pinEnvFact` | D | `src/index.ts` `noteBonus` ~40–58, `pinEnvFact` ~98–108, `relevant` call ~703 | No movie/book/favorite bonuses. No CircleCI / Buildkite / `staging.example` pins. `watch` file-watcher is not a movie. | §5.1 | `pinEnvFact` gone from default. CI query does not hard-pin CircleCI |
| **M4.3** Place cells + typed subject | D | `src/index.ts` `pathCues` ~355–363, `subjectKey` ~548 | Dotted filenames kept (`auth.ts`). `subjectKey` does not delete Clerk on “Auth is failing” (leave Clerk until M7 tombstone). | §5.1, §6.5 | M1.3 `auth.ts` and Clerk cases tagged M4.3 green |
| **M4.4** Hygiene tests + leftover IDF note | T | `src/memory-ranker.test.ts` (new) | Covers M4.1–M4.3. Documents remaining binary IDF (Report §5.1 formula) as **known**, not this wave’s rewrite. | §5.1 | Green. No QUERY_LIGHT / `-ship` (Report §6) |

**Parallelism:** M4.1 / M4.2 / M4.3 are different functions in `src/index.ts` — merge by function, not by rewriting `relevant`’s whole body in two parts. **M4.2 owns the `relevant()` lines that *call* `noteBonus`/`pinEnvFact` (~668–719).** M4.1 owns `queryHay` only. M4.3 owns `pathCues`+`subjectKey` only. M4.4 owns the new test file.

**Wave close:** hay gone; `auth.ts` is a key; failing-is does not delete Clerk.

---

## Wave M5 — Persist and session identity *(debug)*

**Goal:** lock, honest caps, `ep`/session survive hook spawn. Report **§5.2**. Plan §6.2.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M5.1** Lock + atomic write + store cap | D | `src/index.ts` `persist` ~652–654, `load` ~538 | File lock (hook `events.jsonl` already has `withFileLock` — reuse that helper, do not copy-paste a third). Atomic write. Store cap **≠** `EDEN_MEMORY_CAP` (k). New env `EDEN_MEMORY_STORE_CAP` if needed. | §5.2 | Two concurrent persists do not tear JSONL. `EDEN_MEMORY_CAP=6` still means k |
| **M5.2** Session directory / `session_id` | D | `packages/cli/src/memory-hook.ts` `hookMemory` ~48–52; `openMemory` opts in `src/index.ts` ~779 **opts only, not persist body** | `session_id` → `memory/<session>/memories.jsonl` (or equivalent). Hook process N+1 loads the same `ep`. Wrap keeps `processMemory()` singleton. | §5.2, §4.6 Letta take = persisted WM | Reinstatement can fire across two hook invocations in a test |
| **M5.3** Pin what the comment claims | D | `src/index.ts` pin predicate in `persist`; `SAL_WEAK` ~422 | `sal=0.6` pins **or** the comment dies. Cues: serialize or keep `deriveCues` on load; fix `notesFor` clone dropping WeakMap. | §5.2 | M1.3 sal item green. Clone still has cues |
| **M5.4** Ghost `/forget` | D | plugin README / any `EDEN_MEMORY_HOST` docs | Implement `GET /forget` **or** delete the README lie. No dead `:8787`. | §5.2 ghost APIs | Grep for `/forget` either has a handler or zero hits in user-facing docs |

**Parallelism:** M5.1 persist writer; M5.2 hook dir + `openMemory` options; M5.3 pin predicate + cuesOf; M5.4 docs only. If M5.1 and M5.3 conflict on the pin line inside `persist`, **M5.3 owns the pin lambda; M5.1 owns lock/atomic/cap around it.**

**Wave close:** lock + session identity + honest pin.

---

## Wave M6 — Product holdout *(check; no ranker features)*

**Goal:** measure the **inject/hook** path. Do not add hay. Do not start sleep. Report **§5 coding-holdout, Gate 1 acceptance, §11.1 item 4**.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M6.1** Hook holdout run | B | `benchmarks/memory-holdout/` runner + RESULTS.md | Flake, ADR, file rule, version, junk, plus M2.4 tool-trace. **inject path only.** | §5, §11.1 | Dated RESULTS. Dual-API forbidden |
| **M6.2** Dual-API CI gate | T | CI / `benchmarks/memoryagentbench/inject-only.test.ts` | Fail CI if MAB adapter uses `BrainMemory` without banner. | §2 | Green |
| **M6.3** Struggle: fail-open + torn JSONL | D | tests + tiny persist hardening **only if M5 missed a crash** | Inject throw → pass-through (metric). Kill -9 mid-write → load swallows, next write heals. No ranking change. | §5.2, Plan fail-open | Probe green. If persist needs a fix, it is a pin test + minimal patch, not M8 |
| **M6.4** Remeasure vs M1.4 | O | `BASELINE.md` append | Latency/bytes after M2–M5. **Parity or better.** If slower, document. No k-hacking. | §5.2 | Numbers in BASELINE.md |

**Parallelism:** runner vs CI test vs struggle tests vs baseline file.

**Wave close:** holdout RESULTS exist. Losses feed M10, not a silent M4 retune.

---

## Wave M7 — Sleep / replay *(debug; biology becomes real)*

**Goal:** `sleep()` writes schemas, tombstones, gists. Report **§4.9 assembly (tombstone so reader cannot see old), §8 Gate 3 product overwrite**. Plan §1.5–1.6, §2 sleep row.

**Interfaces (lock before coding, so parts do not wait):**

```ts
sleep(opts?: { session?: string }): Promise<void>
// SemanticStore: put(s,p,o,t); tombstone(s,p,t); get(s,p) -> latest non-tombstoned
// GistStore: put(text, session, t); latest(session, k)
```

New files; do not grow `extractDurable` into a copula compiler (Report §6.2).

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M7.1** `sleep()` + host triggers | D | `src/sleep.ts` (new); `packages/cli/src/memory-hook.ts` Stop/SessionEnd; wrap idle **optional** | Calls SemanticStore + GistStore. Does not block `inject`. | Plan §3 | Stop/SessionEnd runs sleep. Inject path unchanged if sleep throws (fail-open) |
| **M7.2** Semantic LWW + tombstone | D | `src/semantic-store.ts` (new) — **not** `src/cls/semantic.ts` copula compile as the product | `(s,p,o,valid_from)`. Last-write-wins. Old row **absent** from later inject (tombstone, not ×0.45). | §4.9, §6.2, §8 Gate 3 | “Auth is Clerk” then “Auth is failing” → Clerk remains; chairperson serial-newer wins and old name gone from packet |
| **M7.3** Gists + SessionStart | D | `src/gist-store.ts` (new); `memory-hook.ts` SessionStart briefing only | SessionStart briefs pinned intentions + latest gists, **not** eviction `slice(-k)`. | §5.3 empty query | After a long session fixture, a gist exists and Start injects it |
| **M7.4** Sleep tests | T | `src/sleep.test.ts` (new) | Cases for M7.2–M7.3. ICL exemplars **must not** go through SemanticStore. | §4.4 Mem0 TTL death, §8 Gate 2 ICL separate | Green. Copula-only compile not used on product inject |

**Parallelism:** M7.1 controller+hook; M7.2 semantic module; M7.3 gist module; M7.4 tests. M7.1 programs against the interface even if stores are stubs; stubs are replaced on merge.

**Wave close:** sleep rewrites the store; SessionStart is gists+pins.

---

## Wave M8 — Assembly and fuse *(debug)*

**Goal:** code picks `max(valid_from)`; hops are not rarest `#`; fuse is not a magnet. Report **§4.9, §6.1–6.3, §7, Gate 2–3**. Plan §4 architecture.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M8.1** Assembler | D | `src/assemble.ts` (new) | Retrieve candidates → extract `(s,p,o,t)` → **code** `max(t)` per `(s,p)`. Product inject uses this. Target protocol: FC-SH/MH **82/27** @262k is M15/M16, not this unit. | §4.9 [arxiv:2606.01435] | Unit: two serials → packet contains only the newer |
| **M8.2** Fuse rewrite | D | `src/cls/controller.ts` `scores()` ~104–142 | No independent max-norm that lets dead semantic beat BM25 (1.000 vs **1.219**). Cortex weight cannot bury TTL. Or CLS fuse **off** on product inject until this is proven. | §6.1 | Worked example: G beats B. ICL tests do **not** need `skipSemantic` to pass |
| **M8.3** Completion / CAR | D | `src/cls/complete.ts` (new; move off rarest-`#` in controller) | Walk current graph or Self-Ask + max **per hop**; return **last hop** first. Not 3 BM25 rounds on rarest `#`. | §6.3, Gate 3 FC-MH | 3-hop fixture top-1 is last hop on **inject** path |
| **M8.4** Labeled packet | T | `src/index.ts` `notesFor` **format only** (~739–745 map); tests in `src/memory-packet.test.ts` | `[rule]` / `[fact]` / `[episode]` / `[gist]`. No `retrieveText` stuffing `never`→numeral on rules. | Plan §4 packet | Snapshot test of packet. k default 6–10 |

**Parallelism:** new `assemble.ts` / `complete.ts` / controller fuse / notesFor format. M8.4 may only change the string formatter, not scores.

**Wave close:** **unit** last-hop + labeled packet + fuse. Official FC-MH 262k is **M22** (M15 draft evidence: 7). Do not treat this close as Table 3 SF.


---

## Wave M9 — Structured experience *(debug)*

**Goal:** tool traces we already observe keep **order, files, exit**. Hippocampus stays store-all prose; structure is for sleep. Chat-only hosts mint **zero** how-to. This finishes M2, it does not import a vendor trace format.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M9.1** Keep order/exit on wrap | D | `packages/wrap/src/tool-observe.ts`; do **not** flatten to one prose line as the only record | Persist `{name, args, files?, exit?, t, order}` beside the existing episode text. Fail-open if parse throws. | §5.3; COMPETITORS §0 | Wrap fixture with `pytest …` exit 0 touching `auth.ts` reconstructs those three fields |
| **M9.2** Keep order/exit on hook | D | `packages/cli/src/memory-hook.ts` PostToolUse / SubagentStop | Same structured record. Stretch/transparent path stays. | §5.3 | Hook PostToolUse fixture writes the same shape |
| **M9.3** `HowToStore` shell | D | `src/howto-store.ts` (new) — **stubs ok if M10 fills sleep** | `put` / `latest(cue, k)`; lock+atomic like SemanticStore. Same dir as gists/semantic. Not `src/cls/*`. | Plan §4 | File exists; concurrent puts do not tear |
| **M9.4** Trace tests | T | `src/memory-howto.test.ts` (new) | Ordered trace → fields; chat-only → **no** how-to; ICL never becomes how-to; inject unchanged if parse throws | COMPETITORS §0 | Green ×3. D owners do not write this file except types |

**Parallelism:** wrap observe vs hook observe vs new store vs tests.

**Wave close:** a successful fixture’s files / verify / exit survive Stop. Chat-only: zero how-to; facts still work.

---

## Wave M10 — Sleep how-to *(debug)*

**Goal:** the same `sleep()` that tombstones facts and writes gists also compresses a **successful** trace into how-to. A failing verify does **not** promote. Hippocampus keeps the mess.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M10.1** Sleep lane | D | `src/sleep.ts`; `src/howto-store.ts` | Success → `{cue, steps[], files[], verify?, exit, t}`. Read/search-only traces stay episodic (log, do not silently drop). | Plan §1.5–1.6 | After Stop/sleep on the flake fixture, store has verify + files + order |
| **M10.2** Revisions, not LWW-clobber | D | `src/howto-store.ts` | Identical steps refresh. A different approach is a **sibling**. Worse second attempt does not destroy a working first. Facts stay LWW. | COMPETITORS §0 | Unit: two successful different fixes; both exist; inject can prefer the winner |
| **M10.3** Stale prune | D | howto prune helper (sleep or idle, **not** inject hot path) | Drop how-to when a named file no longer exists. Failed rabbit holes decay. | Plan directed forgetting | Pin test: deleted `auth.ts` → how-to omitted from later packet |
| **M10.4** Sleep tests | T | `src/memory-howto.test.ts` | Dead-end strip; no promote on exit ≠ 0; ICL skip; sleep throw fail-open | — | Green ×3 |

**Parallelism:** sleep lane vs revision writer vs prune vs tests. Do not change `relevant()` scoring.

**Wave close:** sleep writes how-to; failing traces do not become skill; revisions exist.

---

## Wave M11 — How-to integrity *(debug)*

**Goal:** directed forgetting for skill. Do **not** ship a vendor procedure graph. If the cue needs a step we do not have, the packet **names the hole** (unknown), it does not invent a path. If a place cell moved, omit the stale step.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M11.1** No invented steps | D | howto retrieve used by M12; **not** a new graph product | Incomplete skill → gap line as data, not an instruction. Bounded (≤3 how-tos, token-capped). | Plan §1.6 | Unit: missing step → gap, not a hallucinated command |
| **M11.2** Shared-prefix compress at sleep | D | `src/sleep.ts` howto lane | If two successes share a prefix, sleep **may** merge into one how-to. Optional. Do not build `procedure-graph.ts` unless a unit cannot be met without it. | Plan sleep | Unit or skip-with-reason in tests: merge does not invent steps |
| **M11.3** Omit stale place | D | howto step omit | File gone / selector gone → omit that step, fall back to reasoning. | Plan place cells | Fixture: missing file → gap, not a fake path |
| **M11.4** Integrity tests | T | `src/memory-howto.test.ts` | Gap, bound, fail-open, no dashboard | — | Green ×3 |

**Parallelism:** gap formatter vs optional sleep merge vs omit vs tests. M12 owns putting this on inject.

**Wave close:** how-to never invents; stale place omitted; no vendor graph.

---

## Wave M12 — Cue-complete how-to *(debug)*

**Goal:** this-turn `cueFor` silently puts `[procedure]` in the **existing** labeled packet. Match on aboutness (files, verify-stem, task tokens, `pathCues`) — a tool JSON rename must not hide the skill. Empty cue does **not** dump how-to (Start stays pins+gists). No three-matcher CLI. No embedder required.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M12.1** Aboutness on the how-to lane | D | `src/index.ts` `relevant` **how-to lane only** (do not restore hay) | Exact then lexical. Optional local embed on miss; if absent, degrade. **No** network embed. Must not beat BM25 (M8.2). | Plan §4; M4 `pathCues` | Cross-tool fixture: rename `command`→`cmd`; inject still hits how-to |
| **M12.2** Packet `[procedure]` | D | `notesFor` format (M8.4 range) + cap ~300 tokens | Labeled how-to with files + verify. Treat as data, not orders. k still 6–10 total. | Plan §4 packet | Snapshot includes `[procedure]` on the flake cue; chat-only packet has none |
| **M12.3** No memory tools | D | wrap + hook callers; setup/doctor | `grep memory_search` / MCP memory tools on default path = 0. Empty cue may skip inject. | Plan §0 | Grep green |
| **M12.4** Inject tests | T | `src/memory-howto.test.ts`; wrap + hook | Schema-rename WIN; no MCP symbols; fail-open; Start does not dump last-k how-to | M12.1 schema-rename | Green ×3 on wrap OpenAI, Anthropic, hook |

**Parallelism:** ranker vs formatter vs grep/docs vs tests.

**Wave close:** how-to appears in inject without a tool call; schema rename still matches; chat-only unchanged.

---

## Wave M13 — Honest off switch *(debug)*

**Goal:** a human can freeze writes without killing the agent. Three states we already owe: **on** (default) / **read-only** / **off**. Off = inject identity. Identifiers never persist. No cloud extract.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M13.1** Three states | D | `openMemory` / hook / wrap env | `EDEN_MEMORY=0` → inject identity (fail-open). Read-only: recall existing, no new encode. Boolean check, not an LLM, not a network call. | Plan fail-open | Disable mid-session: agent continues; existing sqlite fact still injects in read-only |
| **M13.2** Scrub | D | observe/persist redact | `session_id`, email, cwd never in JSONL / semantic / gist / how-to. Secrets already redacted (keep). | §5.2 | Probe: those strings absent after a Stop fixture |
| **M13.3** Doctor tells the truth | D | `packages/cli/src/doctor.ts` / setup | Names half-wired memory hooks. No ghost `/forget`. Forget/prune is explicit, operator-driven. | §5.2 | Doctor lists memory events actually installed |
| **M13.4** Off-switch tests | T | hook + wrap + doctor tests | Off / read-only / on; scrub; fail-open | — | Green ×3 |

**Parallelism:** env gate vs redact vs doctor vs tests.

**Wave close:** disable cannot 500 the host. No cloud extract. Scrub holds.

---

## Wave M14 — One brain *(debug)*

**Goal:** wrap OpenAI, wrap Anthropic, and the Claude hook read/write the **same** HowToStore. Optional Codex/Cursor/OpenCode only if `eden setup` already installs those hosts. Chat-only still zero how-to.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M14.1** One dir | D | `openMemory` dir + howto path | How-to file lives on the memory root (like semantic/gists), not only `memory/<session>/`. | M5 | Wrap then hook Start: same how-to id |
| **M14.2** Already-wired hosts | D | `packages/cli/src/setup.ts` memory events only | If setup already writes Codex/OpenCode hooks, they observe tools into the same store. If not installed, skip and document. Silent-fail hooks → doctor warning, not a thrown agent. | M5 / doctor | Doctor warns; agent still runs |
| **M14.3** Cross-host read | D | HowToStore | A how-to one host recorded is injectable by another on the same dir. | Plan one object | Unit: wrap write, hook inject |
| **M14.4** Host tests | T | wrap + hook tests | Three hosts; chat-only zero how-to | — | Green ×3 |

**Parallelism:** path vs setup vs store vs tests. Do not edit gated UI.

**Wave close:** one how-to store; unequal harness capture is **named**, not silent.

---

## Wave M15 — Official exams *(check; ship no claims yet)*

**Goal:** run the 2026 scoreboard on **inject**. Report **§8 Gate 0, §9, §11.1, §11.7**. Plan §9. (Former M9.)

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M15.1** MAB Table 3 on inject | B | `benchmarks/memoryagentbench/` adapter → `openMemory` inject; PROTOCOL.md enforced | k=10, official lengths, 4o-mini reader, overall = mean of AR/TTL/LRU/SF. | §3, §11.1 [arxiv:2507.05257] | Four avgs + overall published. LOSS is OK. No k=40 |
| **M15.2** LME-V2 Small | B | new runner under `benchmarks/` | Acc + latency. Even a loss diagnoses missing files/tools/procedures. | §4.12, §11.1 [arxiv:2605.12493] | Small-tier number filed. Target later: beat RAG 42.8, then AgentRunbook-C **74.9** |
| **M15.3** Terminal-Bench 2.1 Δ | B | locked harness ± Eden inject, k=5 | Report **Δ accuracy, tokens, $**. Absolute % is the agent, not Eden. | §11.1 [arxiv:2607.08716] | Δ filed vs same model/harness |
| **M15.4** Protocol auditor | T | `benchmarks/memoryagentbench/protocol.test.ts` | Fails on 64k-as-534k, k=40-as-MCC, label-strip, `BrainMemory` column, Memorable 454/454 as Table 3 | §0 forbidden | Green on the M15.1 config |

**Parallelism:** three harnesses + auditor. Do not share a results JSON schema that blocks start — each writes its own RESULTS.

**Wave close:** four artifacts exist. Claims wait for **M37**. Do not retune `extractDurable` / ranker from a running leaf. The draft table below is **not** this close.

---

## M15 evidence lock *(source for M16.1 — STATUS M15 closed 2026-09-19)*

Copy **this run’s RESULTS** into `M15-EVIDENCE.md` in **M16.1**. Numbers are the 2026-09-19 inject run with NVIDIA NIM `google/gemma-4-31b-it` (disclosed; not 4o-mini). Do not invent 4o-mini cells. Do not treat this table as a product claim — claims wait for M37.

| Leaf / exam | n | Product score | What it means | Mechanism that must change |
|---|---:|---:|---|---|
| FC-SH 262k | 100 | **54** | Tied HippoRAG-v2 54. Single-hop overwrite works at k=10. Not SF SOTA (82). | Richer candidates + `max(serial)` that **drops** losers (M20–M21). M8 copula `max(t)` is not enough. |
| FC-MH 262k | 100 | **7** | Field floor (HippoRAG 5, Zep 3). Packet does not assemble hops. | Per-hop retrieve, last hop first (M22). `complete()` on `#entity` is not CAR. |
| EventQA 534k | 100 | **56** | Loss to BM25 74.6 on the same official length. | Store-all 512-token chunks. **Stop** `extractDurable` on novels (M17–M18). |
| ICL banking | 100 | **67** | Working k=10 TTL. HippoRAG MCC avg 61.4; BM25 75.4. | Atomic exemplars, no extract, no graph. Protect this lane (M19). |
| ICL clinic | 100 | **87** | Strong. Do not Mem0-extract labels. | Same ICL index. Regression if extract returns. |
| ICL nlu | 100 | **70** | Finished. TREC-F is the MCC graveyard. | Diversity at k=10, still no `label:` strip. |
| ICL TREC-C | 100 | **25** | Weak coarse labels at k=10. | M19 atomic exemplars. |
| ICL TREC-F | 100 | **7** | Graveyard. | M19. Do not strip `label:`. |
| SH 197k | 100 | **66** | Tied BM25 66; HippoRAG 76. | Store-all chunks (M18) + associative extras that must not touch ICL (M27). |
| MH 421k | 100 | **45** | Below HippoRAG. | Same as SH; do not k=40. |
| LME (Table 3) | 300 | **42.7** | NIM yes/no judge, not gpt-4o. Not LME-S* 500. | Files + silent slice (M23–M26). |
| Recsys | 200 | **13.7** | TTL drag vs MCC 51.2. | Test-time learning, not a bigger k. |
| DetQA | 71 | **0.0** | Honest exact_match floor. | Long-range understanding (M30–M31). |
| Summ | 100 | **9.0** | NIM yes/no, not gpt-4o HELMET. | Same LRU wave. |
| LME-V2 Small | 451 | **2.7%** | Cap 2000 + extract on truncated text; official ~25M haystack not ingested. RAG 42.8 / AgentRunbook-C 74.9 are not like-for-like. | Trajectory **files** + silent slice inject (M23–M26). Not a bigger BM25 k. |
| Table 3 SF | — | **30.5** | Complete competency. HippoRAG SF 29.5. | Hold while M21–M22 push toward 54+. |
| Table 3 AR | — | **52.4** | mean(SH 66, MH 45, LME 42.7, EventQA 56). | M18/M27 narrative; do not retune ICL. |
| Table 3 TTL | — | **32.4** | mean(MCC 51.2, Recsys 13.7). | M19 ICL protect; Recsys later. |
| Table 3 LRU | — | **4.5** | mean(Summ 9.0, DetQA 0.0). | M30–M31. |
| Table 3 overall | — | **30.0** | mean(AR, TTL, LRU, SF). LOSS vs HippoRAG-v2 41.6. Backbone is NIM Gemma 4 31B, **not** 4o-mini. | Claims wait for M37. |
| TB 2.1 Δ | 2 tasks × k=5 | **−20.0 pp** | Harbor mean on 10.0% vs off 30.0%. Locked subset, not 89-task board. On-arm 9/10 errored (tmux / BadGateway) — infrastructure, not a memory win. Token Δ is mostly zero-token failures. | M32. |

**Hard splits (violating these is how M8 “assembly” still scored FC-MH 7):**

1. ICL index is never called from AR hops or SF assembly.
2. Narrative chunks are never run through `extractDurable`.
3. Facts that overwrite are assembled in **code**, not by asking Gemma which sentence is newer.
4. Trajectories are files (plus notes/events). Chat JSONL cap 2000 is not the LME store.
5. Still **silent inject**. No `memory_search`. Fail-open. k=10 on Table 3. No label-strip. No BrainMemory column.

---

## Wave M16 — Evidence lock *(check; no product retune)*

**Goal:** freeze the inject scoreboard and the lane contract so later waves cannot “fix” EventQA by extracting ICL or “fix” LME by k=40. Report **§0, §7, Gate 0**. Starts when M15.1–.4 artifacts exist, **or** FC-SH, FC-MH, EventQA, and ICL banking+clinic RESULTS exist and every other leaf is `missing` in M15-EVIDENCE.md. Partial lock does **not** unlock M27–M31 retune of missing leaves.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M16.1** Scoreboard file | B | `benchmarks/memoryagentbench/M15-EVIDENCE.md` (new) | Copy the table above from **this run’s** RESULTS (backbone, k, API, n). Missing leaves = `missing`, not 0. | §0, §3 | File matches PROTOCOL.md. CI fails if a later RESULTS claims Table 3 overall without four avgs |
| **M16.2** Lane types | T | `src/memory-lanes.ts` (new) | Types only: `icl` \| `narrative` \| `fact` \| `trajectory` \| `chat`. No retrieve yet. Document: ICL index ⟂ AR hops ⟂ SF assemble ⟂ ExperienceStore. | §7 arithmetic | Test: importing lanes does not import `BrainMemory` as product |
| **M16.3** Extract tax pin | T | `src/memory-encode.test.ts` or new `src/memory-lanes.test.ts` | Pin **today**: ICL `label:` blobs and novel paragraphs still pass `extractDurable` (or are dropped). Mark `// WAVE-FIX: M17`. Do not make them pass here. | §5 write; §4.2 BM25 | Characterization exists. M17 flips it |
| **M16.4** Assembly miss pin | T | `src/assemble.test.ts` or `src/memory-packet.test.ts` | Fixture: two-hop “player → sport → country” with a later overwrite. **Today’s** inject packet fails (FC-MH class). `// WAVE-FIX: M22`. | §4.9 | Red snapshot. M22 flips it |

**Parallelism:** evidence md vs types vs two test files. No `relevant()` rewrite.

**Wave close:** M15-EVIDENCE.md dated; lanes named; two red pins. Product scores unchanged.

---

## Wave M17 — Encode lanes *(debug; stop the extract tax)*

**Goal:** hippocampus is store-all. `extractDurable` stays for **chat** only. ICL exemplars and narrative chunks skip the allow-list that drops `please` and AX trees. Report **§4.2, §5 write failures**. Evidence: EventQA 56 vs BM25 74.6; ICL clinic 87 must not fall.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M17.1** Kind on observe | D | `src/index.ts` observe/write path only (not `relevant`) | `observe` tags `kind` from text: ICL (`label:` / input-output shots), narrative (long prose, EventQA-class), chat (default). | §4.2 Mem0 disaster | ICL shot stored whole. Novel paragraph stored whole. Chat still extractDurable |
| **M17.2** Kind persist | D | JSONL record shape in persist/load (M5 range **record fields only**) | `kind` survives reload. Store cap counts records honestly. ICL/narrative **not** evicted in FIFO that keeps chat small-talk over shots. | §5.2 | Reload test: 5900-shot-class atoms still present after cap pressure on chat |
| **M17.3** Flip M16.3 | T | `src/memory-lanes.test.ts` | ICL + narrative bypass extract. Secrets still redacted. | M16.3 | Green ×3 |
| **M17.4** No SF regression pin | T | FC-SH fixture from M15 | After lane change, single-hop overwrite still retrieves the latest value in a unit fixture (not a 262k rerun). | Gate 3 | Pin green. Full FC-SH re-bench is M21 |

**Parallelism:** observe vs persist field vs two tests. Do not add `icl-index.ts` here (M19).

**Wave close:** extract tax is opt-in for chat. ICL/narrative store-all.

---

## Wave M18 — Narrative chunks *(debug; EventQA)*

**Goal:** EventQA 534k is BM25 on **512-token chunks**, not 4096 extracted packs. Target **≥ 74.6** lexical substring on inject k=10. If we lose to LangChain BM25 on **identical chunks**, file LOSS and stop adding structure. Report **§4.2, Gate 2**. Evidence: 56.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M18.1** Chunk store | D | `src/chunk-store.ts` (new) | Sentence-preserving chunks ~512 tokens. Used only when `kind=narrative`. | §4.2 | Unit: 2k-token story → >1 chunk; reconstructible |
| **M18.2** Narrative retrieve | D | `src/index.ts` `relevant` **narrative lane only** | BM25 over chunks, k=10. Must not call ICL index or `complete()`. | §4.1 vs GraphRAG 34.4 | Cue with a rare name returns the chunk that contains it |
| **M18.3** EventQA re-run | B | M15.1 runner, EventQA 534k only | Same protocol. Backbone disclosed. | §3 EventQA 534k | Score in RESULTS. Target ≥74.6. LOSS allowed if identical-chunk BM25 also loses |
| **M18.4** Anti-GraphRAG test | T | protocol + chunk tests | Graph-shaped retrieve on EventQA is banned. | §0 GraphRAG EventQA | Green |

**Parallelism:** store vs retrieve vs bench vs test.

**Wave close:** EventQA number updated. No GraphRAG.

---

## Wave M19 — ICL atoms *(debug; protect MCC)*

**Goal:** Table 7 MCC at k=10, **no** label-strip, **no** graph, **no** extract. Evidence: banking 67, clinic 87. Target first **≥ Qwen3 90/88/86/67/59**, then BM25 **89/89/84/62/53**. **TREC-F is the gate.** Report **§3 Table 7, Gate 2**.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M19.1** ICL index | D | `src/icl-index.ts` (new) | One record per exemplar. Diversity at k=10 (not 10 near-duplicates). | §4.2; Mem0 MCC 32.4 | Unit: 100 shots one class + 1 gold other class → gold in k=10 |
| **M19.2** Wire retrieve | D | `relevant` **ICL lane only** | Detect ICL cue; retrieve from index only. | Gate 2 | Chat fact cue does not pull ICL shots |
| **M19.3** MCC re-run | B | five ICL leaves k=10 official ~103k | banking/clinic must not collapse. TREC-F published. | Table 7 | Five scores + MCC avg. LOSS on TREC-F is honest if published |
| **M19.4** Label-strip auditor | T | `protocol.test.ts` | Fail if runner strips `label:` from stored shots. Output format normalize (`label: N` → `N`) is **not** strip. | M15.4 | Green |

**Parallelism:** index vs relevant lane vs bench vs auditor.

**Wave close:** MCC avg exists. Clinic 87 not sacrificed for EventQA.

---

## Wave M20 — SF candidates *(debug)*

**Goal:** assembly fails because extract is copula-only (`objectAsserted`). Pull **all** asserted (s,p,o,t) from retrieved fact-list episodes, including numbered serials. ICL/narrative kinds are not facts. Report **§4.9 v2**. Evidence: FC-SH 54 plateau.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M20.1** Candidate extract | D | `src/assemble.ts` `extractCandidates` | Numbered fact lists, “now/was/became”, not only is/uses. Skip `isIclExemplar`. | §4.9 | Fixture: 8. The chairperson is X → serial 8 |
| **M20.2** Prior-override fixture | T | `src/assemble.test.ts` | Finland → ice hockey then later sport overwrite. Generator is **not** asked which is newer. | §4.9 v2 serial-drift | Test specifies code must pick max(serial) — may still fail until M21 |
| **M20.3** Packet still labeled | D | `notesFor` format only | Candidates do not dump raw 262k. Packet stays small labeled `[fact]`. | M8.4 | Snapshot size bound |
| **M20.4** Kind firewall | T | assemble tests | `kind=icl` and `kind=narrative` yield zero triples. | M16.2 | Green ×3 |

**Parallelism:** extract vs tests vs formatter vs firewall.

**Wave close:** candidates exist. Picking the winner is M21.

---

## Wave M21 — SF code-pick *(debug; FC-SH SOTA path)*

**Goal:** **code** picks `max(valid_from)` / `max(serial)` per (s,p). Losers **absent** from the inject packet (not 0.45× muted). Target FC-SH **≥ 82** at 262k (assembly paper), same k=10 inject API. Backbone disclosed. Report **Gate 3**. Evidence: 54.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M21.1** Winner in assemble | D | `src/assemble.ts` pick + tombstone emit | Packet contains only the winning o. JSONL may still hold losers. | §4.9 | Unit: two serials → packet has one object |
| **M21.2** Sleep agrees | D | `src/sleep.ts` SemanticStore | Replay tombstones the loser so a later session cannot resurrect it. | M7 | After sleep, inject still one object |
| **M21.3** FC-SH re-run | B | Factconsolidation_sh_262k | Official 262k, k=10, inject. | §3 FC 262k | Score vs 54 baseline. Target 82. LOSS OK if published |
| **M21.4** Flip prior-override | T | `src/assemble.test.ts` | M20.2 green. | §4.9 v2 | Green ×3 |

**Parallelism:** assemble vs sleep vs bench vs test. Do not start FC-MH hops here.

**Wave close:** single-hop overwrite is code, not the reader.

---

## Wave M22 — SF multi-hop / CAR *(debug; FC-MH)*

**Goal:** FC-MH 7% is “knowledge pool does not contain the country of the sport of X”. Retrieve **per hop**, cap **per hop**, return **last hop’s value first**. Target FC-MH **≥ 27**. Report **§4.9, Gate 3**. Flip M16.4.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M22.1** Hop retrieve | D | `src/cls/complete.ts` | Real CAR: query → entity → next fact, max 3 hops, each hop `max(serial)`. Not rarest `#` tags. | §4.9 CAR | Unit two-hop overwrite wins |
| **M22.2** Inject order | D | `inject` assembly merge only | Last hop’s `[fact]` is first among facts. ICL/narrative lanes untouched. | M8.3 | Packet order test |
| **M22.3** FC-MH re-run | B | Factconsolidation_mh_262k | 262k k=10 inject. | §3 | Score vs 7. Target 27. LOSS OK |
| **M22.4** Flip M16.4 | T | hop fixture | Green ×3 | M16.4 | Green |

**Parallelism:** complete.ts vs inject merge vs bench vs test.

**Wave close:** SF avg toward **≥ 54**. Do not claim SF SOTA unless both 82 and 27 hold.

---

## Wave M23 — Experience files *(debug; LME store)*

**Goal:** LME ~3.5% because the haystack is not in the store. AgentRunbook-C keeps **trajectories as files**. Eden does that **without** `memory_search`: a new ExperienceStore on the memory root. Chat-only still works (empty experience). Report **§4.12**. Evidence: gold_in_packet mostly false; cap 2000.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M23.1** ExperienceStore | D | `src/experience-store.ts` (new) | Append-only files per traj/session: states, url, action, thought, tree (capped, **not** extractDurable). Honest disk cap env, **distinct** from JSONL `EDEN_MEMORY_STORE_CAP`. | §4.12 | Unit: 100 traj ids written; chat observe does not require it |
| **M23.2** Observe hook | D | wrap `tool-observe` + hook PostToolUse | Tool/browser-shaped payloads go to ExperienceStore **and** a short episodic note. | AMA; M9 traces | Fixture: AX tree text present on disk, absent from extractDurable chat JSONL |
| **M23.3** Fail-open | D | inject catch + experience read | Missing dir / ENOENT → no throw. | Plan fail-open | Struggle test |
| **M23.4** Store tests | T | `src/memory-experience.test.ts` (new) | Chat-only zero traj files. Coding/web host writes files. Identifiers scrubbed (M13). | M13 | Green ×3 |

**Parallelism:** store vs observe vs fail-open vs tests.

**Wave close:** trajectories exist as files. Retrieve is M24.

---

## Wave M24 — Experience retrieve *(debug; silent slices)*

**Goal:** this-turn cue **completes** a trajectory slice into the labeled packet (`[episode]` / `[procedure]`), still silent. Raise `gold_in_packet` on LME-class questions. Beat **RAG 42.8** on Small is M26; this wave is the mechanism. k for chat facts stays 6–10; extra **slice budget** is documented (not sneak k=40 MCC).

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M24.1** Cue → files | D | `src/experience-retrieve.ts` (new) | Lexical + place (url/path) over traj files. Return ≤N slices, token-capped. | §4.12 files+notes+events | Unit: question tokens hit the file that contains gold phrase |
| **M24.2** Packet merge | D | `notesFor` / inject format | Slices labeled. Empty cue does not dump files (Start stays gists+pins). | Plan §3 | Start snapshot has no traj dump |
| **M24.3** gold_in_packet fixture | T | LME-shaped unit (not full 451) | After retrieve, gold phrase in packet for the M16-style Change-request case. | M15.2 debug-sample q25 | Green |
| **M24.4** No memory_search | D | wrap + hook grep | Still 0. Experience retrieve is called from `inject`, not a tool. | Plan §0 | Grep green |

**Parallelism:** retrieve vs packet vs fixture vs grep.

**Wave close:** silent file slices on inject. Full LME number is M26.

---

## Wave M25 — Experience sleep *(debug)*

**Goal:** replay files into gists + how-to **without deleting** the files (hippocampus stays). Dead-end traces do not become `[procedure]`. Screenshots: skip with a named LOSS, or store alt-text if the host has it. Report **§4.12, Plan §1.5**.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M25.1** Replay files | D | `src/sleep.ts` experience pass | Gists from traj goals/outcomes. Files remain. | M7 gist | After sleep, file still readable; gist exists |
| **M25.2** Procedure from success | D | HowToStore + experience | Exit 0 + verify → how-to. Exit ≠0 stays episodic. Chat-only still zero how-to. | M10 | Pin tests |
| **M25.3** Screenshot policy | B | `benchmarks/lme-v2/RESULTS.md` note | 29 gotchas multimodal: **skipped** named, or captions ingested. Do not pretend text-only is 74.9. | §4.12 | Honest sentence in RESULTS |
| **M25.4** Sleep tests | T | sleep + experience tests | Fail-open if a file is corrupt. | M7.4 | Green ×3 |

**Parallelism:** sleep vs howto vs docs vs tests.

**Wave close:** rest extracts schemas; files still store-all.

---

## Wave M26 — LME-V2 re-exam *(check)*

**Goal:** re-run Small on **inject** after M23–M25. Target **≥ 42.8** (RAG). Path to AgentRunbook-C **74.9** is the SOTA claim; if short, file LOSS with gold_in_packet rate. Do not skip-all on one NIM 504. Report **§4.12, §11.1**.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M26.1** Runner honesty | B | `benchmarks/lme-v2/run.ts` | Full 451 writes RESULTS.md (smoke ≠ official). Per-question reader. Probe does not skip all. | M15.2 | n=451 or Blocked with named dataset miss |
| **M26.2** Acc + gold_in_packet | B | RESULTS.md | Acc, latency, gold_in_packet hit rate, empty packets. | §11.1 | Dated. Compare to ~3.5% @200 |
| **M26.3** Latency | O | same | inject p95 must not become a 60ms CLI in front of wrap. | Plan anti-goal | Number filed vs M6.4 |
| **M26.4** Verdict | B | RESULTS verdict table | vs RAG 42.8 and AgentRunbook-C 74.9. No invented 74.9. | Plan §9.2 | WIN/LOSS written |

**Parallelism:** runner vs RESULTS vs latency vs verdict (one harness; parts are artifact splits).

**Wave close:** official Small number on inject. SOTA sentence only if ≥74.9.

---

## Wave M27 — AR SH *(debug)*

**Goal:** RULER SH-QA **197k**, k=10 inject. HippoRAG **76**, BM25 **66**. Evidence: not run in M15 lock — run here on store-all chunks (M18) + associative extras that **must not** touch ICL. Report **§4.1 Gate 2**.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M27.1** Multi-hit fusion | D | `src/cls/controller.ts` / episodic score **AR lane** | Fuse multiple chunk hits. No skipSemantic bug. | M8.2 | Unit needle |
| **M27.2** SH re-run | B | Ruler_qa1_197k | Official length. | §3 SH 197k | Score filed |
| **M27.3** ICL isolation | T | lanes test | SH retrieve does not read `icl-index`. | M16.2 | Green |
| **M27.4** Compare BM25 | B | note in RESULTS | If lose to identical-chunk BM25, LOSS and stop structure. | §4.2 | Written |

**Wave close:** SH number exists.

---

## Wave M28 — AR MH *(debug)*

**Goal:** RULER MH-QA **421k**. HippoRAG **66**, BM25 **56**. Last hop on inject (M22 mechanism reused, not a second assembler). Report **§4.1**.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M28.1** MH hops on chunks | D | `complete.ts` narrative/AR path | Hops over chunks, not ICL. | M22 | Unit 2-hop needle |
| **M28.2** MH re-run | B | Ruler_qa2_421k | Official 421k. | §3 | Score filed |
| **M28.3** AR avg | B | TABLE3-RESULTS | AR = mean(SH, MH, MAB-LME, EventQA) only if all four exist. | §7 | Avg published or missing named |
| **M28.4** Tests | T | complete + lanes | Green ×3 | — | Green |

**Wave close:** AR avg if four leaves exist; else named missing.

---

## Wave M29 — LRU gists *(debug)*

**Goal:** Summ cannot stay BM25 **19**. Sleep already writes gists (M7); **retrieve** them for InfBench-sum class. Target Summ lift vs 19. Do not GraphRAG EventQA. Report **§4.10 Gate 4**.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M29.1** Gist retrieve | D | `src/gist-store.ts` + `relevant` gist lane | Hierarchical / latest-session gists on summary cues. | Plan §1.6 | Unit: long doc sleep → gist in packet on “summarize” |
| **M29.2** Summ re-run | B | InfBench_sum 1.2M | Official. Judge disclosed (not fake gpt-4o). | §3 LRU | Score vs BM25 19 |
| **M29.3** Packet cap | O | formatter | Gists do not blow k. | Plan §4 | Token cap test |
| **M29.4** Tests | T | gist tests | Empty cue no gist dump (Start). | M7.3 | Green ×3 |

**Wave close:** Summ strategy scored.

---

## Wave M30 — LRU DetQA + route *(debug)*

**Goal:** Detective_QA + optional long-context **route** (not a second product). If claiming overall **≥50 vs Claude 49.6**, LRU **≥46**. Else document concede LRU. Report **§4.10, Plan §9.2 vs Claude**.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M30.1** DetQA retrieve | D | gist + chunk lanes | Book-length QA uses gists then chunks. | Gate 4 | Unit |
| **M30.2** DetQA re-run | B | Detective_QA 200k | Score filed. | §3 | Number |
| **M30.3** Router stub | D | `src/memory-router.ts` (new) | Route: summary/book → gist+chunk; ICL → index; overwrite → assemble; default chat → JSONL. **No** six MIRIX ontologies. **No** tools. | §4.7 MIRIX take | Unit four routes |
| **M30.4** LRU avg | B | TABLE3-RESULTS | mean(Summ, DetQA) or named missing. | §7 | Written |

**Wave close:** LRU strategy written + scored. Claude 49.6 not claimed without the avg.

---

## Wave M31 — Recsys / TTL remainder *(debug)*

**Goal:** Recsys 1.44M is store-all, **not** extract. Evidence: Mem0 extract destroys TTL. Target not HippoRAG 10.2 as a costume; beat it if the lane is store-all. MCC already M19. TTL avg = mean(MCC, Recsys).

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M31.1** Recsys encode | D | kind=narrative or `kind=recsys` shots | Movie lists stored as atoms. | §3 Rec 1.44M | Unit |
| **M31.2** Recsys re-run | B | Recsys_redial_full | recall@5 filed. | §3 | Number |
| **M31.3** TTL avg | B | TABLE3-RESULTS | Requires MCC + Recsys. | §7 | Avg or missing |
| **M31.4** Tests | T | recsys atoms ⟂ facts | Movies are not SemanticStore triples. | M7.4 ICL≠facts | Green |

**Wave close:** TTL avg if both leaves exist.

---

## Wave M32 — Terminal-Bench 2.1 Δ *(check)*

**Goal:** memory = **Δ** vs locked harness, k=5, same model, wrap ± inject. Absolute % is terminus-2. Harbor must **run**. Job dirs tagged by model. Report **§11.1, Proactive Memory**. Evidence: no product Δ at M15 lock.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M32.1** Harness | B | `benchmarks/terminal-bench/run.ts` | Both arms complete. Stale GLM job dirs cannot block Gemma. NIM 504 is not a skip. | M15.3 | Harbor ran=yes, n_trials parsed k×tasks |
| **M32.2** Δ RESULTS | B | RESULTS.md | accuracy Δ, tokens, $. | Plan §9.2 CLI SOTA | Dated |
| **M32.3** Remain-silent **measure** | B | TB Δ RESULTS note | Count trials where packet was empty vs junk. **Do not implement the omit gate here** — that is M38. | Proactive Memory | Dated count. If always-on lost, that is evidence for M38 |
| **M32.4** Honesty | T | protocol-style asserts | No public-board 89-task claim. | §0 | Green |

**Wave close:** Δ filed. +pts or honest 0 / negative.

---

## Wave M33 — Competency router *(debug)*

**Goal:** one controller, several stores (already built). Wire M30.3 for real: ICL vs narrative vs fact vs trajectory vs gist. Must **not** add `memory_search`. Dense embed only if M18/M19/M27 still lose to BM25 on identical docs — else **reject in writing**. Report **§4.7, Plan §0**.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M33.1** Router on inject | D | `src/index.ts` `relevant` dispatch | Calls one lane. Measures misroute rate on fixtures. | MIRIX take | Four fixtures route correctly |
| **M33.2** Dense reject-or-add | D | written note or tiny local embed | If added: local only, ICL still store-all. | §4.3 dense lost overall | Note in STATUS or code + test |
| **M33.3** Isolation tests | T | lanes | Cross-talk tests (ICL shots not in EventQA packet). | M16.2 | Green ×3 |
| **M33.4** Holdout | B | memory-holdout | Gate 1 still WIN after router. | M6 | RESULTS append |

**Wave close:** one brain, several lanes, still silent.

---

## Wave M34 — Packet + persist quality *(optimize)*

**Goal:** correctness first (M17–M33). Then cheaper/faster. WAL, retrieve loop, packet bytes. Procedure ≤~300 tokens. No 60ms CLI. Compare M6.4. Report **§5.2**.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M34.1** Persist WAL | O | persist/load | Lock stays. | §5.2 | p95 vs M6.4 WIN or parity |
| **M34.2** Retrieve loop | O | `relevant` score loop only | No hay return. | §5.1 | inject p95 parity; holdout not worse |
| **M34.3** Packet budget | O | formatter | k 6–10 chat; slice budget named; `[procedure]` cap. | Plan §4 | Tokens with M32 |
| **M34.4** BASELINE append | B | BASELINE.md | Dated. | M1.4 | File |

**Wave close:** faster or documented parity. No retrieve@5.

---

## Wave M35 — Negative + savings *(check)*

**Goal:** prove where memory must **not** lie and **not** help. Memorable 454/454 and Mem0 92 fail by construction. This wave is the **bench annex** (NEGATIVE.md / SAVINGS.md). Live wrap+hook HELP.md and wiring harmed-ids into inject are **M47**.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M35.1** No-lift | B | `benchmarks/memory-holdout/NEGATIVE.md` | on vs off, Δ≈0 filed. | COMPETITORS V-zero | Dated |
| **M35.2** Savings + harmed | B | SAVINGS.md | Helped / no-lift / **harmed**. CI fails if lift claimed without control. | §11.2 | Dated |
| **M35.3** Leftover identity | T | sleep + wrap + hook | Tombstone absent from packet **and** gists **and** experience files. cwd/email/session_id never stored. | M7, M13 | Green ×3 |
| **M35.4** Fail-open + schema | T | struggle + howto | Throw → original messages. `command`→`cmd` still injects. | M6.3, M12 | Green ×3 |

**Wave close:** **four** artifacts: NEGATIVE.md, SAVINGS.md, leftover-identity tests, fail-open+schema tests. Live wrap/hook ledger is M47.

---

## Wave M36 — Adversarial + walkthrough *(debug + test)*

**Goal:** a fresh agent that did not write M16–M35 tries to break the product. Plan **§7** walkthrough is a **test**, on wrap **and** hook. Every hit fixed and tested.

**Product walkthrough (all three hosts where they apply):**

1. Fresh store. “Always run tests before committing.” Next commit-shaped cue → labeled `[rule]`.
2. “Auth is Clerk.” Then “Auth is failing.” Sleep. Later: Clerk **present**.
3. “Use postgres.” Then “Use sqlite instead.” After sleep, postgres **absent**; sqlite `[fact]`.
4. Host with tools: failing test stored; later flake cue retrieves it.
5. Successful fix sleeps into `[procedure]` (≤~300 tokens). Schema rename still matches. Chat-only: **no** `[procedure]`.
6. New SessionStart: gists + pins, **not** eviction junk, **not** a traj dump.
7. Ranker/persist/experience fault → original messages (fail-open). `EDEN_MEMORY=0` identity.
8. Chat-only still gets 1–3 and 6–7. No diet/CircleCI pins.
9. **New:** two-hop overwrite fixture from M22 still holds after sleep.
10. **New:** ICL shot still in store after a novel-sized narrative ingest (lane isolation).

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M36.1** Hostile probe | D | wrap + hook + persist + experience + assemble | Empty cue, unicode path, concurrent persist, k=40 as product, BrainMemory column, label-strip, GraphRAG EventQA, memory_search, leftover identity | §0 | Re-probe clean |
| **M36.2** Walkthrough test | T | `src/memory-walkthrough.test.ts` (new) | Automate 1–10 on wrap **and** hook. | Plan §7 | Green ×3 |
| **M36.3** Thorough suite | T | memory / hook / wrap / doctor / lanes | Full suite 3×. M1.3 historical reds that flipped stay green. | §5.4 | Counts |
| **M36.4** Audit callers | D | every inject/observe/sleep site | Dual-API gone. | §5.4 | STATUS evidence |

**Wave close:** re-probe zero; walkthrough 1–10 green. Remain-silent math (M38) and session-B sqlite (M44) are **not** required here. **Not** yet ship — M37 is the first official re-bench; M38–M49 make it help; M50 ships.

---

## Wave M37 — SOTA re-bench *(check; checkpoint)*

**Goal:** re-run the official inject scoreboard after M16–M36 mechanisms. Plan §7 walkthrough must still be green. **Do not delete `/memory-wave`.** Helping a user is M38–M50. SOTA **sentences** require Plan §9.2; otherwise publish the number.

This wave does **not** close on “the benches exist” alone. Walkthrough (M36.2) must still pass. It **does** close without a help ledger — that is M47.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M37.1** Walkthrough still green | T | `src/memory-walkthrough.test.ts` | Re-run wrap **and** hook after M16–M36. | Plan §7 | Green ×3 |
| **M37.2** Table 3 re-run | B | MAB inject official leaves | k=10, official lengths, disclosed backbone. **Four avgs + overall.** | §3, Plan §9.2 | overall published. SOTA memory-agent only if **> 41.6**; bar **≥ 50**. SF SOTA only if FC-SH ≥82 **and** FC-MH ≥27 |
| **M37.3** LME + TB | B | LME-V2 Small + TB Δ | Acc vs 42.8 / 74.9. TB Δ vs locked harness k=5. | §4.12, §11.1 | Artifacts. Trajectory SOTA only if LME ≥ AgentRunbook-C |
| **M37.4** Honest claims | T | PROTOCOL + RESULTS headers | No 92, no k=40-as-MCC, no 64k-as-534k, no BrainMemory column. Backbone named. | §0 | Green |

**Wave close:** scoreboard filed. Command **stays**. M38 starts the help path.

---

## Wave M38 — Remain-silent *(debug; junk is harm)*

**Goal:** always-on inject that cannot help **hurts**. After **all** lanes (facts / gist / procedure / experience), if aboutness is below `EDEN_MEMORY_MIN`, inject is identity — **except** SessionStart / empty-cue briefing, which may still inject **pins + latest gists only** (no traj dump, no sqlite `[fact]` on math). Proactive Memory: remain-silent is compatible with fail-open. Evidence: TB always-on can lose; LME UNKNOWN from wrong six notes.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M38.1** Aboutness gate | D | `src/index.ts` `inject` after `relevant`, before format | If max on-cue score < `EDEN_MEMORY_MIN` (**default 0.15**, documented in README/env), return original messages. Metric: `memoryInjectSilent`. Low aboutness omits experience slices too (M24). | COMPETITORS V-zero; Plan silent trade | Unit: “what’s 2+2?” + sqlite store → identity (no Eden Memory mark). Unit: SessionStart after sleep → pins/gists present; math cue still silent |
| **M38.2** Wrap + hook honor it | D | wrap injectBody + hook memoryHookResponse | Empty/omitted packet does not add `Eden Memory:` chrome. Start briefing still allowed (pins+gists). | M3; M7.3 | Snapshot: no mark when silent; Start still briefs |
| **M38.3** Holdout A/A | B | `benchmarks/memory-holdout/SILENCE.md` (new) | Tasks where memory must not move the answer. Δ ≈ 0 **and** packet omitted. | M35.1 | Dated |
| **M38.4** Tests | T | `src/memory-silence.test.ts` (new) | Off still identity; silent ≠ 403; fail-open still swallows throws; Start exempt. | Plan fail-open | Green ×3 (`memory-silence.test.ts`) |

**Parallelism:** inject gate vs hosts vs bench vs tests. M32.3 is the TB **count**; this wave owns the gate. Silence runs after experience retrieve (M24).

**Wave close:** unrelated cues do not pollute context. Start still knows the project. Helping starts with not harming.

---

## Wave M39 — Diverse packet *(debug)*

**Goal:** k=10 of the same exemplar or the same fact is not help. Diversity at retrieve so the packet is 10 **different** useful traces. Evidence: ICL near-duplicates; LME packet_chars high with gold still missing.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M39.1** Near-dup suppress | D | `relevant` post-rank only | Jaccard/stem overlap cap per lane. Keep highest score. | M19 diversity | Unit: 10 clones → 1 slot |
| **M39.2** Lane mix budget | D | `notesFor` cap split | Slot floors: ≥1 on-cue fact if any; ≥1 procedure/slice if on-cue; remainder diverse. Procedure ≤~300 tokens. Dedup must not drop the sole other-class ICL gold (M39.3). | Plan §4 packet | Snapshot shows mix, not 10 facts |
| **M39.3** ICL still diverse | T | icl-index tests | Gold other-class still in k=10 after dedup. | M19.1 | Green |
| **M39.4** Tests | T | `src/memory-packet.test.ts` | Clone suppress + mix budget. Silent (M38) still wins if all clones are off-cue. | M38 | Green ×3 |

**Wave close:** packet is small and varied. Not 10 copies of sqlite.

---

## Wave M40 — Provenance *(debug; trust)*

**Goal:** label notes the model can weigh when several **on-cue** items remain: `[fact · 3h · user]` / `[procedure · verified]`. Assembly still **drops losers** (M21); provenance must never reintroduce a tombstoned object. Not a memory UI.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M40.1** Format ages | D | `formatNote` / packet labels | Relative age + source (user / tool / sleep). No cwd/email/session_id (M13). | M8.4; M13 scrub | Snapshot: remaining sqlite fact is dated; postgres loser still absent |
| **M40.2** Assembly agrees | D | assemble winners already only object | Provenance must not reintroduce losers. | M21 | Packet still one object per (s,p) |
| **M40.3** Log line | D | wrap/hook debug log (not user UI) | Optional `EDEN_MEMORY_LOG=1` prints note ids+ages to stderr. Default off. | Plan no memory UI | Default: no extra user-visible chrome |
| **M40.4** Tests | T | packet + scrub | Age present; identifiers absent; log off by default. | M13 | Green ×3 |

**Wave close:** the packet is legible to the model. Humans are not required to open a dashboard.

---

## Wave M41 — Host artifacts as place cues *(debug)*

**Goal:** hosts that expose open files / last goal add **place cues** to this-turn `cueFor` (M3). Do **not** rewrite `convBlob` ranking beyond attaching `pathCues`. Transcript-40 stays banned. Helps the agent mid-refactor without stuffing file bodies.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M41.1** Hook artifacts | D | `memory-hook.ts` payload → `pathCues` only | If the host sends open files, they are place cues, not dumped bodies. Do not edit `relevant()` scores. | M4.3 | auth.ts cue fires without stuffing the file |
| **M41.2** Wrap artifacts | D | wrap last user message + optional path headers | Do not concatenate the whole OpenAI history as cue (M3 pin). | M3.1 | Identity test still green |
| **M41.3** No cue rewrite | D | `src/index.ts` pathCues attach only (not `convBlob` blob) | M3 `cueFor(this turn)` unchanged. | M3 | 40-line + new “fix auth.ts” still this-turn |
| **M41.4** Tests | T | `src/memory-order.test.ts` extend | 40-line + new line still this-turn; path cue without body dump. | M3.4 | Green ×3 |

**Wave close:** open files are keys. The transcript is not the cue.

---

## Wave M42 — Incremental sleep *(debug)*

**Goal:** a 4-hour session that only sleeps at Stop has a rotten hippocampus all afternoon. Idle / N-turns / byte threshold runs a **bounded** sleep. Fail-open if sleep is slow. Helps long coding sessions. Must **not** tombstone a fact still referenced by the open user goal until Stop / SessionEnd / idle>`EDEN_SLEEP_IDLE`.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M42.1** Triggers | D | `src/sleep.ts` idle trigger | Env: `EDEN_SLEEP_EVERY` turns or bytes; `EDEN_SLEEP_IDLE`. Default conservative. | Plan §1.5 | Unit: after N observes, a gist may appear; open-goal fact still in packet until idle/Stop |
| **M42.2** Bound | D | sleep time budget | Incremental pass may gist; must not block inject (async or time-capped). Inject never waits on sleep. | fail-open | Inject p95 not worse than M34 in a unit |
| **M42.3** Hook Stop still full | D | hook Stop/SessionEnd | Full replay still happens (tombstones allowed here). Incremental does not skip it. | M7.1 | Test |
| **M42.4** Tests | T | sleep tests | Incremental + full; throw in incremental → inject unchanged. | M7.4 | Green ×3 |

**Wave close:** rest happens during the day. Live-task facts survive until Stop. Inject stays non-blocking.

---

## Wave M43 — Pin and forget in language *(debug)*

**Goal:** “forget postgres” / “always use sqlite” from **observe** become tombstone/pin. This is the operator surface M13 owed (no `/forget` HTTP). `EDEN_MEMORY` off and read-only make forget/pin no-ops. No network, no `memory_search`. Sleep must not resurrect an observe-emitted tombstone.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M43.1** Forget utterances | D | observe / extractDurable chat lane | “forget X” / “don’t use X anymore” tombstones matching (s,p) or deletes unpinned episode by cue. No network. | M13 ghost /forget | Unit: after “forget postgres”, postgres absent from packet. False-positive: “don’t forget to run tests” does **not** tombstone |
| **M43.2** Pin utterances | D | persist pin predicate | “remember X” / “always X” sets sal pin. | M5.3 | Unit: pinned rule survives cap pressure |
| **M43.3** Read-only / off | D | consent gate | Forget/pin are writes: no-ops in read-only and off. | M13.1 | Test |
| **M43.4** Tests | T | `src/memory-consent.test.ts` or new | Forget, pin, off, scrub (forget text may store a tombstone, not the secret). Sleep does not resurrect. | M13 | Green ×3 |

**Wave close:** the human steers memory in English. Still no MCP.

---

## Wave M44 — Project identity *(debug; it remembers this repo)*

**Goal:** **prove** M5/M14 layout: new Claude session, same `EDEN_HOME` / project dir, still has Clerk and sqlite. Do **not** fork a second dir scheme. Session JSONL may rotate; semantic + gist + how-to + experience stay on the **project root**. Fix only if the proof fails.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M44.1** Two-session proof | D | `openMemory` as it exists (M5/M14) | Episodes session-local; stores root. | M5.2; M14 | Two sessions, same dir: sqlite fact injects in session 2 |
| **M44.2** Start briefing | D | SessionStart | Pins + latest gists from **root**, not empty. Not a traj dump (M24.2). Exempt from M38 junk-silence. | M7.3; M38 | Start snapshot has sqlite `[fact]` or `[gist]` |
| **M44.3** Wrap singleton | D | processMemory | Wrap restart in the same cwd loads root. | M5.2 | Test |
| **M44.4** Tests | T | hook + wrap | Session A encode, session B inject. Chat-only too. Concurrent writers do not tear root. | Plan any-agent | Green ×3 |

**Wave close:** leaving and coming back still knows the project. That is help.

---

## Wave M45 — Subagent share *(debug)*

**Goal:** a subagent that cannot see parent pins will re-break Clerk. Share **read** of root stores; child writes stay in a child session file unless sleep promotes. Do not clobber parent how-to on a failed child (M10).

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M45.1** Child session | D | hook SubagentStop / wrap child env | `session_id` nested or suffixed. Reads root. Writes episodic child file. | M2.2 SubagentStop | Unit: child injects parent sqlite |
| **M45.2** Failed child | D | HowToStore + sleep | Child exit≠0 does not prune parent how-to. | M10 | Test |
| **M45.3** Isolation | T | two-session tests | Child “forget X” does not tombstone parent unless the utterance is in the parent transcript. | M43 | Green |
| **M45.4** Tests | T | hook tests | SubagentStop observed; fail-open. | M2.2 | Green ×3 |

**Wave close:** subagents inherit knowledge, not a blank brain, and cannot silently destroy the parent’s skill.

---

## Wave M46 — Import history *(debug; day-1 help)*

**Goal:** a repo with a week of Claude/Cursor transcripts should not start empty. One operator command **observes** existing logs into lanes (chat/icl/narrative/tools). Not cloud extract. Fail-open. Optional: default still empty-store honest. Imported junk must still lose to M38.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M46.1** Import CLI | D | `packages/cli/src/` import or setup hook | `eden memory import <path>` reads jsonl/transcript, calls observe. Scrub. Cap. | Plan operator | Dry-run counts records; no NVIDIA call required. Notes below `EDEN_MEMORY_MIN` never appear on an unrelated cue |
| **M46.2** Kind split | D | reuse M17 kinds | ICL vs chat vs tools vs skip binary. | M17 | Unit: mixed file |
| **M46.3** Doctor | D | doctor.ts | Mentions import. Does not invent a ghost API. | M13.3 | Doctor text matches command |
| **M46.4** Tests | T | cli tests | Import; secrets redacted; off skips writes; silence still wins. | M13; M38 | Green ×3 |

**Wave close:** day-1 *can* have a hippocampus. Default empty remains honest.

---

## Wave M47 — Help ledger *(check; the product metric)*

**Goal:** the metric that matters for “actually helps” is **helped / no-lift / harmed** on **live wrap+hook traces**, not only MAB. M35 SAVINGS.md is the bench annex; this file is the product ledger. Harmed ⇒ omit that procedure/note id next inject (M38). CI fails if a RESULTS file claims lift without a no-memory control. Do **not** require harmed→0 in one wave.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M47.1** HELP.md | B | `benchmarks/memory-holdout/HELP.md` (new) | Rows from **wrap and hook** sessions (scripted live-shaped tasks OK): flake, ADR, file rule, version, junk, silent-math. On vs off. Counts + control. | §11.2 MemoryBench humility | Dated table with helped / no-lift / harmed |
| **M47.2** Wire omit | D | howto + inject | Harmed procedure/note ids skipped on later inject. | M35.2; M38 | Unit: harmed id absent next cue |
| **M47.3** Token Δ | B | wrap token counts on vs off | If tokens up and accuracy Δ≤0, that cue class is silent (M38). | M32; M34.3 | Number filed |
| **M47.4** CI pin | T | inject-only or holdout test | RESULTS claiming lift without control fails. | M35.2 | Green |

**Wave close:** we can say “it helped N times, hurt M times” from wrap+hook. Harmed ids are omitted next time.

---

## Wave M48 — Live coding holdout *(check; the feeling)*

**Goal:** Gate 1 holdout (M6) is the user-facing product: flake, ADR, file rule, version, junk. After M16–M47 this must be **WIN** on hook inject, or an honest LOSS **named per case**. A developer would notice if it failed. Do not retune the ranker to costume a new holdout.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M48.1** Re-run holdout | B | `RESULTS.md` **body** (cases table) | Same inject API. Flake/ADR/file/version/junk/tools. | M6.1 Gate 1 | WIN or honest LOSS named per case |
| **M48.2** Multi-session | B | `RESULTS.md` **Multi-session** section only | ADR from session A injects in B (M44). No second full re-run. | M44 | Pass |
| **M48.3** Silence junk | B | `RESULTS.md` **Silence** section only | Packet omitted or no harm (M38). | M38 | Pass |
| **M48.4** Dual-API still banned | T | inject-only.test.ts | Green | M6.2 | Green |

**Parallelism:** one RESULTS.md with owned sections; test file is T’s.

**Wave close:** the coding agent that people use is measurably helped. This is the bar, not LoCoMo.

---

## Wave M49 — First session *(debug; setup polish)*

**Goal:** a stranger runs `eden setup` / doctor, starts wrap or Claude, and **in one session** feels encode → retrieve → sleep. Latency the user can stand (inject p95 vs M34). Docs match. No bench flags. No 60ms CLI in front of the model.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M49.1** Setup default on | D | setup.ts + README | Memory events installed; `EDEN_MEMORY` default on. No Memorable. | Plan §7 operator | Doctor lists 7 events actually installed |
| **M49.2** Latency budget | O | inject path | Document p50/p95 for a 2k-store inject. Wrap still **streams**. Fail if inject is a subprocess round-trip in front of the model. | Plan anti-goal | BASELINE append; wrap still streams |
| **M49.3** One-session script | T | `src/memory-walkthrough.test.ts` | Scripted session: decide sqlite, new cue, packet has sqlite, sleep, still sqlite. | Plan §7 | Green on wrap **and** hook |
| **M49.4** Docs | D | cli README / env list | Matches code. Three states. Import (M46) documented. `EDEN_MEMORY_MIN` / `EDEN_SLEEP_*` named. | M13 | Grep env names = code |

**Wave close:** first hour works without reading MEMORY-WAVES.md.

---

## Wave M50 — Ship *(ship)*

**Goal:** Eden Memory is a product a long-running agent **uses** with no memory UI: silent encode, this-turn retrieve, labeled inject, sleep, remain-silent, project identity, pin/forget in language. Plan **§7** true on wrap+hook. Official inject scoreboard current. **HELP.md** exists. Leftovers **none**. Then `/memory-wave` deletes itself.

Does **not** close on benches alone, §7 alone, or HELP alone. All three. The four parts are **close measurements**, not independent product rewrites.

| Part | Type | Owner files | Deliverables | Report | Done when |
|---|---|---|---|---|---|
| **M50.1** Product completeness | D | live wrap + hook + setup/doctor/README | **Verify** (do not re-implement) M36.2 + M38–M49 Done-whens. Dense/PreToolUse/MCP: reject in writing unless a named §7 step still fails. | Plan §7 | M36.2 + M49.3 green after this pass |
| **M50.2** Scoreboard | B | Table 3 four avgs+overall, LME, TB Δ | Re-run or certify M37 artifacts still valid. Backbone named. | Plan §9.2 | Filed. SOTA sentences only if §9.2 holds |
| **M50.3** Help ledger | B | HELP.md + holdout | Helped > harmed. Junk silent. Multi-session identity. | M47, M48 | Dated WIN/LOSS per case |
| **M50.4** Honest claims | T | PROTOCOL + RESULTS + README | No 92, no k=40-as-MCC, no 64k, no BrainMemory column, no “memory UI”. | §0 | Green |

**Wave close:** Plan §7 true in production callers. Scoreboard filed. Help ledger filed. Leftovers **none**. Slash command §4 parent pass, then delete `/memory-wave`.


## Wave-close scoreboard (copy into RESULTS)

| Wave | Kind | Gate |
|---|---|---|
| M1 | check | API freeze, protocol sheet, characterization, baselines |
| M2 | debug | please/tools stored on hook and wrap |
| M3 | debug | this-turn cue; one observe/inject order |
| M4 | debug | hay gone; `auth.ts`; Clerk not deleted |
| M5 | debug | lock; session `ep`; honest pin |
| M6 | check | hook holdout RESULTS; dual-API CI; struggle; baseline remeasure |
| M7 | debug | sleep tombstones; Start gists |
| M8 | debug | **unit** max(t)+fuse+labeled packet; official FC-MH hops are M22 |
| M9 | debug | traces keep order/exit; HowToStore shell; chat-only zero how-to |
| M10 | debug | sleep writes how-to; revisions; stale prune |
| M11 | debug | no invented steps; named gaps; omit stale place |
| M12 | debug | silent `[procedure]` on existing inject; aboutness; no MCP |
| M13 | debug | on/read-only/off; scrub; doctor truth |
| M14 | debug | wrap+hook share HowToStore; half-wired hooks named |
| M15 | check | MAB / LME-V2 / TB Δ artifacts + protocol auditor |
| M16 | check | M15-EVIDENCE.md; lane types; extract/hop red pins |
| M17 | debug | ICL/narrative bypass extractDurable |
| M18 | debug | 512-token chunks; EventQA vs BM25 74.6 |
| M19 | debug | ICL index k=10; TREC-F; no label-strip |
| M20 | debug | SF candidates from fact lists |
| M21 | debug | code-pick max(serial); FC-SH vs 54→82 |
| M22 | debug | CAR hops; FC-MH vs 7→27 |
| M23 | debug | ExperienceStore files; not JSONL cap 2000 |
| M24 | debug | silent traj slices on inject |
| M25 | debug | sleep gists/how-to; files remain |
| M26 | check | LME-V2 Small n=451 vs 42.8 / 74.9 |
| M27 | debug | SH 197k AR |
| M28 | debug | MH 421k; AR avg |
| M29 | debug | gist retrieve; Summ vs 19 |
| M30 | debug | DetQA + router stub; LRU avg |
| M31 | debug | Recsys store-all; TTL avg |
| M32 | check | TB 2.1 Δ filed; silence **count** only (gate is M38) |
| M33 | debug | router on inject; isolation |
| M34 | optimize | persist/retrieve/packet vs M6.4 |
| M35 | check | four annex artifacts (NEGATIVE/SAVINGS/identity/fail-open); HELP.md is M47 |
| M36 | debug | adversarial zero; walkthrough automated |
| M37 | check | Official inject scoreboard after M16–M36. Command **stays** |
| M38 | debug | Remain-silent: math omits packet; Start still briefs |
| M39 | debug | Diverse packet; clones collapse; ICL gold kept |
| M40 | debug | Provenance/ages; losers stay absent |
| M41 | debug | Host pathCues; M3 cue unchanged |
| M42 | debug | Incremental sleep; no mid-task tombstone |
| M43 | debug | Pin/forget in English; “don’t forget to…” is not a tombstone |
| M44 | debug | Two-session proof; layout stays M5/M14 |
| M45 | debug | Child reads parent; failed child cannot prune skill |
| M46 | debug | `eden memory import`; M38 still wins on junk |
| M47 | check | HELP.md from wrap+hook; harmed ids omitted next |
| M48 | check | Live coding holdout WIN or LOSS named per case |
| M49 | debug | First session: setup → encode → retrieve → sleep |
| M50 | ship | Plan §7 **and** scoreboard **and** help ledger. Command deleted |

A broken Eden never breaks the agent.

---

## Pointers

- Locks / biology / take-leave: `docs/MEMORY-PLAN.md`
- 2026 competitors (integrate, do not clone): `docs/MEMORY-COMPETITORS.md`
- Autopsy / Table 3 / 2026 benches: `benchmarks/memoryagentbench/SOTA-GAP-REPORT.md`
- Company B/T/O/D rules: `docs/ROADMAP.md` §4, §4.9
- Product code: `src/index.ts`, `packages/cli/src/memory-hook.ts`, `packages/cli/src/hook.ts`, `packages/wrap/src/{proxy,anthropic,know-inject}.ts`
- New stores this program adds: `src/chunk-store.ts`, `src/icl-index.ts`, `src/experience-store.ts`, `src/experience-retrieve.ts`, `src/memory-lanes.ts`, `src/memory-router.ts`
- Help ledger / live coding: `benchmarks/memory-holdout/HELP.md` (M47), `RESULTS.md` (M48), `SILENCE.md` (M38)
- CLS (absorb, do not score as product): `src/brain-memory.ts`, `src/cls/*`
