# Eden Memory — ship, scale, retrieve, inject

> **Superseded as a plan (2026-09-29).** Build from [ROADMAP.md](./ROADMAP.md). Decisions are in [DECISIONS.md](./DECISIONS.md), and the normative design is [A4-DELIVERY-CONTRACT.md](./A4-DELIVERY-CONTRACT.md). [A1-ADVERSARIAL-REVIEW.md](./A1-ADVERSARIAL-REVIEW.md) confirms this file's code descriptions and numbers, but finds S0 defects it omits (per-session store, id collisions, stale reload, secrets, poisoning, repeated injection). This file stays as the record of the measurements and the prior locks.

**Dated 2026-09-29.** This is the single working document for what we locked this conversation, what the code does, what the long-horizon exam measured, and what to build. The split files `01-SHIP-AND-SOTA.md`, `02-LONG-HORIZON.md`, and `03-BUILD.md` are earlier drafts of the same material.

**This file wins** if anything conflicts with those three, with `docs/MEMORY-WAVE-STATUS.md`’s “M50 shipped” claim, or with CLI README env names that are not in `src/index.ts`.

Locked animal (`docs/MEMORY-COMPLETE.md`, `docs/MEMORY-SOTA-BUILD-REPORT.md`): silent hook inject, copula + episode, small labeled packet, fail-open, dump-all is a miss, **no embeddings and no LLM on UserPromptSubmit**.

Wave M1–M50 closed on the **working tree** (2026-09-25). That is not a GitHub clone and not folder-aware long use.

---

## Contents

1. [Locks](#1-locks)
2. [Verdict](#2-verdict)
3. [How a turn works today](#3-how-a-turn-works-today)
4. [What already works](#4-what-already-works)
5. [The three stacked failures](#5-the-three-stacked-failures)
6. [Retrieve algorithm (exact)](#6-retrieve-algorithm-exact)
7. [Inject path (exact)](#7-inject-path-exact)
8. [Disk layout, caps, sleep](#8-disk-layout-caps-sleep)
9. [Long-horizon measurement](#9-long-horizon-measurement)
10. [Accuracy at scale (20k → millions)](#10-accuracy-at-scale-20k--millions)
11. [Sub-memory grain](#11-sub-memory-grain)
12. [What to build](#12-what-to-build)
13. [Roadmap (slice order)](#13-roadmap-slice-order)
14. [Two SOTA leagues](#14-two-sota-leagues)
15. [Done-when](#15-done-when)
16. [Non-goals](#16-non-goals)
17. [Env knobs: docs vs code](#17-env-knobs-docs-vs-code)
18. [Pointers](#18-pointers)

---

## 1. Locks

From this conversation, not inferred from old waves:

| Lock | Choice |
|---|---|
| Primary exam | **Coding-agent product:** after burial, tools, overwrites, **folder conflict**, and months of turns, the next turn gets the **right live fact in a tiny packet** — or silence |
| Secondary exam | Official inject scoreboard (MemoryAgentBench Table 3, LME-V2, Terminal-Bench Δ). Same `openMemory` inject API. No dual scoring. No embeddings on Submit to chase a cell |
| Sub-memory grain | Inherited **product-folder** directories. `apps/web/app/login.ts` → `apps/web`. Copulas **exact-scope**. Pins/rules **inherit down**. Never siblings. Never per-file. Never basename-only. Never cwd as the retrieve key |
| Millions | **Both:** millions of diary rows (turns / tools / imports) **and** millions of live facts still true. Two indexes, two retrieve styles |
| Speed | **Acceptable** as measured (~11–50 ms hook spawn on this exam). Do not schedule work to make Submit faster. Spend slices on **retrieval accuracy** and **injection correctness** |
| Packet | Stays small. Default **6** bullets (`min(8, k)`), **900** bytes. Remembering more never means a bigger dump |
| Disk | Never delete a raw turn. Live copulas never evict. Cap 2000 deleting unpinned JSONL is a **bug** relative to product intent |
| Disallowed on Submit | Embeddings, LLM extract/reflect, dump-all, cue-time synonym explosion, `memory_search`, Neo4j, fail-closed, per-file stores, dashboard chrome |

Sessions (`parent--child`) are a **different axis** from folders. Do not reuse child session files as folder memory.

---

## 2. Verdict

| Bar | Status |
|---|---|
| Local sidecar, one user, one store, exact names (2k operator bench) | Working. Buried `op0042` hits. Inject in-process ~0.02 ms. JSONL ~93 KB |
| Short scripted coding holdout (flake / ADR / file rule / version / junk) | Working. Gate 1 **WIN 8/0/0**. HELP.md helped **10** / no-lift **2** / harmed **0** |
| Silent inject + fail-open + chatter/math omit | Working. 5-year junk still silent |
| Clean clone / GitHub ship | **Not ready.** Tracked `src/` is `index.ts` only. Sleep, sota, semantic, consent, wrap inject, tests are working-tree files. `index.ts` already imports them; a clone cannot load |
| Coding-agent product over months (folder truth, remember-more) | **Not ready.** After 4752–15840 turns at cap 2000, Clerk / postgres / sqlite are **gone**. At cap 10k they **collide globally**. `scopedAuthOk` / `scopedDbOk` **false** on every arm |
| SOTA coding-agent memory | **Not ready.** Global rare-token union. Product `inject` **drops** `open_files`. SemanticStore unscoped `(s,p)` |
| SOTA memory-agent (Table 3 / LME / TB) | **Not claimed.** Certified Gemma overall **44.8** (not 4o-mini). LME-V2 **1.8%** LOSS. TB Δ **−10.0 pp** LOSS. FC-MH **9** vs target **27** |

Until clone-track **and** folder sub-memory **and** live copulas that survive the cap **and** retrieve that does not get worse as the diary grows, do not call it shipped. Until league B numbers move under an honest protocol, do not call it SOTA on those boards.

---

## 3. How a turn works today

1. Host turn (Claude UserPromptSubmit or wrap `injectBody`).
2. `cueFor` = last user/human paragraph (short or question). Tool roles stripped.
3. If `isNoopCue` or `hookLane === "none"` → silence. No packet.
4. `notesFor` → `routeMemory` (regex): ICL / gist-chunk / sf-assemble / else `chat-jsonl`.
5. Ordinary coding (`what is auth`) is **`chat-jsonl`**: `relevant` only. Does **not** read `semantic.jsonl`.
6. `relevant`: tokenize, rarest posting union, `df≥80` stop, 12-needle drop, global `liveCopulaLatest`, kind boost, slice k=6.
7. Optional `assembleNotes` only if route is `sf-assemble`.
8. `packNotes` skip-not-evict, header `Eden Memory:`, ≤900 B, ≤6 bullets by default.
9. If cue is not WH, `observe` encodes this turn (questions skip store).
10. Claude hook is a **new process**: `openMemory` → `load()` entire `memories.jsonl` → inject → `close()`. Wrap may keep a process singleton.

Causal order (locked): retrieve from **previous** store using **this-turn** cue, then encode. Do not echo this sentence as “memory.”

---

## 4. What already works

Leave these. Do not rebuild them.

- Fail-open: inject throw → original messages. Consent off = identity. No 403.
- No embeddings / no LLM on Submit. Router and lanes are regex.
- Dump-all is a miss. Empty overlap → no `Eden Memory:` block.
- Chatter and math silent (`got it`, `2+2`). `CONTENT_TERM` keeps `auth` / `sqlite` live.
- Questions not stored as facts (`what|which|who|…` skipStore). Retrieve still runs.
- This-turn cue. Transcript-40 is not the rank blob.
- Packet contract: skip-not-evict, copula kept whole, provenance labels, strip packet before observe.
- In-process copula LWW and serial-over-wall for **one** `(s,p)`. Missing piece is **scope**, not a new conflict algorithm.
- Pins (`remember` / `always` / `kind=constraint`) survive `trimToStoreCap`.
- Write-time aliases small and on the row (`dlq`/`sqs`/`sidecar`/`istio`/`mesh`). No cue-time synonym explode.
- How-to **store**: overlap rank, exit 0, gaps not invented commands. Wire it to procedure cues and a directory; do not rewrite the store.
- Narrative BM25 and ICL diversity exist and are route-gated. Wrong index for `what is auth`.
- Lean episode tuples `[id,text]`, `0o600`, redact, scrub cwd/email/session.
- SemanticStore already keeps live `(s,p,o)` **outside** the 2000 cap (527 bytes after 5 years of this exam). Inject ignores it on `chat-jsonl`.

---

## 5. The three stacked failures

Fixing only one does not save the coding agent.

1. **Place is dead on the product path.** Hook Submit injects `{ role, content: prompt }` only. `inject(array)` walks `PLACE_OBJ_KEYS` on each message (`path`, `filename`, …), not `open_files`. Wrap copies paths onto the last user message, then inject throws them away. The long-horizon bench used that array shape, so it measured **global retrieve with no place at all**.
2. **Cap 2000 deletes live JSONL facts.** Pins stay. `semantic.jsonl` still has the copula. Inject does not pack it.
3. **One global `(subject, relation)`.** Even with infinite rows, web Clerk and cli `none` cannot both be live. At 10k rows × 5 years, retrieve then **missed even trailing Auth** (`df≥80`, 12-needle drop, fat postings). More rows **hurt**.

Silence, packet size, fail-open, pin survival are already good.

---

## 6. Retrieve algorithm (exact)

**Entry.** `AgentMemory.inject` (`src/index.ts`). Cue = `attachPlaceCues(cueFor(list), placePathsFrom(list))`. `placePathsFrom` on a **message array** does not see `open_files`, so `attachPlaceCues` usually gets `[]`. `hookLane` only decides silence vs retrieve; it does **not** pick an index.

**`relevant`:**

1. `queryHay`: `[a-z0-9]+(?:\.[a-z0-9]+)+|[a-z0-9]+`. Dotted names stay one token (`auth.ts`). Slashes do not.
2. `ensureIndex`: one `Map<token, Compiled[]>` for every live row in that session’s `memories.jsonl`. No directory partition. Hook rebuilds this every Submit.
3. Query terms length ≥3, not STOP, `df>0`, rarest-first.
4. Union into a pool capped at `max(k*6, 30)` (default **36**). Stop if `df≥80` and pool non-empty, or pool full. A `df≥80` term is used only if it is first (pool empty), then the walk ends. First 36 posting hits are **file order**, not score.
5. Drop row unless `needles.length ≤ 12`. Drop if an id-shaped needle is in the row but not the cue. Drop `is not` / `unrelated` / `red herring`.
6. Score: overlap count `n`, `rare` = Σ 1/df. Kind boost: constraint 50, procedure 40, fact 25, episode 0. Any overlapping fact outranks every episode.
7. `liveCopulaLatest` key `` `${s}\0${p}` `` — **global**. After persist, `at` is stripped, so spawn-reload LWW is **file order** (`undefined >= undefined` is false → first row wins, usually older).
8. Slice k (default 6).

**`goldFirstNotes`** exists (`memory-sota.ts`). Inject **does not call it**. Tests only.

**How-to.** `mergeHowtoLane` requires `/\bflake\b/i`. Otherwise lexical list unchanged. When it fires, one `howto.jsonl` row, often stamped `unknown: flake`.

**SemanticStore.** Key `(s,p)` on the **memory root** (cross-session). `chat-jsonl` does not read it. `sf-assemble` can write it during inject.

**Dump-all.** No overlap → `[]`. Keep that.

---

## 7. Inject path (exact)

| Host | What retrieve sees |
|---|---|
| Claude `UserPromptSubmit` | `inject([{ role: "user", content: prompt }])`. No `open_files`. Then, if consent on, `observe` last 40 transcript turns (`messagesFromTranscript` reads the **whole** transcript file first) |
| Wrap `injectBody` | Copies `placePathsFrom(body)` onto last user `open_files`, then `inject(msgs)` **drops** them |
| Long-horizon bench | Same array shape as wrap; place never entered the cue |

Pack: header `Eden Memory:\n` counts toward 900. Skip-not-evict. Default 6 bullets. Provenance brackets spend budget.

WH skipStore stays. Scope must still apply once place exists.

Target packet (not richer on the hot path):

```
Eden Memory (apps/web):
- [fact · 0m · user] auth.provider = Clerk
- [rule] never commit .env
- [procedure] auth flake → tests/auth/session.test.ts · verify: npm test -- auth
- [episode] 2026-09-16 src/auth.test.ts
```

---

## 8. Disk layout, caps, sleep

Root: `EDEN_MEMORY_DIR`, else `$EDEN_HOME/memory`, else `~/.eden/memory`. Session → `<root>/<session>/memories.jsonl`. Child → `parent--child`. Files `0o600`.

| File | Cap | Notes |
|---|---|---|
| `memories.jsonl` | `EDEN_MEMORY_STORE_CAP` default **2000** | Pinned / constraint kept. Oldest unpinned **deleted**. If pins exceed cap, all unpinned drop and file can exceed 2000. Episodes `[id,text]`; other rows JSON with **`at` / `invalidAt` / `validUntil` stripped** |
| `memories.jsonl.wal` | — | **Not a log.** Persist only `unlink`s it. `memory-wal.test.ts` still expects compact-at-32 |
| `semantic.jsonl` | **None** | Live copulas + tombstones. Inject does not read on `chat-jsonl`. 527 B after 5 years of this exam |
| `gists.jsonl` | text 800 | SessionStart briefing, not Submit |
| `howto.jsonl` | none | Flake-gated on inject |
| `chunks.jsonl` / `icl.jsonl` | none | Route-gated |
| `experience/<id>.jsonl` | `EDEN_EXPERIENCE_BYTES` 32 MiB | Not the 2000 cap |
| `traces.jsonl` | none | Reread whole file each tool persist |
| `sleep-postings.jsonl` | — | Full sleep **writes**. `relevant` **never reads** |
| `miss.jsonl` / `sleep-clock.json` | — | Sleep bookkeeping |

**Sleep.** Incremental: turn/byte threshold, 25 ms budget, `EDEN_SLEEP_EVERY` unset → 32 turns. Full: Stop / SessionEnd / idle 5 min (idle does not fire in a short hook). Full: assemble, fast-memorize into SemanticStore, gists, how-to, JSONL tombstones, alias heal, `sleep-postings.jsonl`. Incremental does not tombstone JSONL. `remember` then **filters tags back down** to pin + small `WRITE_ALIASES` map.

JSONL persist is lock + rewrite of the **whole** file, not append.

---

## 9. Long-horizon measurement

Not the locked whatever 2k operator bench. That world has **one** auth and **one** database.

**Runner:** `bun benchmarks/memory-long-horizon/run.ts`  
**Artifact:** `benchmarks/memory-long-horizon/RESULTS.json` (2026-09-29)

Duration is **turn count** (what evicts), not wall-clock. 22 workdays × 12 turns/day.

| Arm | Turns |
|---|---:|
| 18 months | 4752 |
| 36 months | 9504 |
| 5 years | 15840 |

Folders: `apps/web`, `apps/control`, `packages/cli`, `packages/wrap`, `src`, `benchmarks`.  
Gold: web Clerk + postgres; cli none + sqlite; pin never commit `.env`. Re-asserted at 50% and at end of write.  
Score: **packet** after `inject`, not JSONL.  
Spawn-reload: `openMemory` + inject 11× (Claude = new process).

Place files were on the message object and **never entered the cue**. These numbers are global retrieve.

### Cap 2000 × 18 months (ship default)

| | |
|---|---|
| Rows / JSONL | 2000 / 211,194 B |
| `semantic.jsonl` | **527 B** |
| Write | 406 ms |
| Inject p50 / p95 in-process | 0.013 / 0.029 ms |
| Spawn parse p50 | 9.65 ms |
| Spawn total p50 / p95 | 10.93 / 12.69 ms |
| Heap Δ / RSS | 6.96 MB / 122.4 MB |
| Web Clerk / cli none | false / false |
| Web postgres / cli sqlite | false / false |
| Pin `.env` | **true** |
| Buried `op00042` | false |
| Chatter / xyzzy silent | true |
| `scopedAuthOk` / `scopedDbOk` | **false / false** |

Live product facts **gone from the packet**. Semantic file still holds copulas. Inject ignores it.

### Cap 10000 × 18 months

| | |
|---|---|
| Rows / JSONL | 4759 / 500,723 B |
| Spawn parse / total p50 | 22.5 / 25.6 ms |
| Web Clerk | **false** |
| Cli none | **true** |
| Web postgres / cli sqlite | **true / false** |
| Buried `op00042` | **true** |
| `scopedAuthOk` / `scopedDbOk` | **false / false** |

Raising the cap does **not** give folder memory. Last global `Auth is none` kills Clerk everywhere. Last db write is postgres; cli sqlite is dead. Buried names survive if not evicted.

### Cap 2000 × 36 months and × 5 years

Same shape as 18 months. Rows stuck at 2000. JSONL ~211–213 KB. Pin true. Scoped flags false. Buried false. Spawn total p50 ~9.6 ms. Write time grows (~1.0 s / ~2.2 s) because observe still walks 9k–15k turns before trim. Extra years at the ship cap do not create a new packet failure; the cap already forgot the product at 18 months.

### Cap 10000 × 5 years

| | |
|---|---|
| Rows / JSONL | 10000 / **1,064,495 B** |
| `semantic.jsonl` | 527 B |
| Write | 2333 ms |
| Inject p50 in-process | 0.004 ms |
| Spawn parse p50 | 45.8 ms |
| Spawn total p50 / p95 | **50.1 / 53.1 ms** |
| RSS | 300.6 MB |
| Web Clerk / cli none | false / false |
| Web postgres / cli sqlite | false / false |
| Buried `op00042` | false |
| Pin `.env` | true |
| `scopedAuthOk` / `scopedDbOk` | **false / false** |

10k rows over 5 years **evicts the buried needle** and **fails to pack even trailing Auth/db**. Retrieve collapsed under posting-list size / `df≥80` / 12-needle rules. Spawn ~50 ms is **acceptable** (speed is not the ship tax). Mem0 search p50 is 148 ms; we already beat that. Do not optimize 50 ms → 1 ms.

### Contrast: 2k operator bench

0 misses, ~0.02 ms in-process, ~93 KB. Cannot see folder conflict. Does not measure spawn-reload.

M49.2 BASELINE 2k p50/p95 **24.5 / 28.4 ms** is a different inject path (lanes). Do not mix with this runner’s 0.013 ms.

### Implications

1. Cap 2000 = forget unpinned JSONL copulas. Pins stay. Semantic 527 B ignored.
2. Bigger cap = remember episodes, still one world-model, then the **index itself fails**.
3. Place never reached retrieve. Fix `placePathsFrom` / hook first, then directory filter.
4. Persist drops `at`. Spawn LWW is file order.
5. Silence holds under 5 years of junk. Keep that.
6. RSS grew with write-loop heap more than with the 2k file.

### Re-run

```bash
bun benchmarks/memory-long-horizon/run.ts
```

When sub-memory ships, same runner, new assertions: `scopedAuthOk` / `scopedDbOk` true after 4752 **and** 15840 with junk still on disk; sibling leak false; pin inherit true; root cue with no files does not pack folder copulas; 20k+ episodes: rare needle still packs; live scoped copulas still pack; packet still ≤6/900; non-`flake` how-to in `apps/web` only. Do not replace the locked whatever harness.

---

## 10. Accuracy at scale (20k → millions)

Raising `EDEN_MEMORY_STORE_CAP` does not keep this working. At 10k unscoped rows the index missed Auth that had just been written.

**Speed is not the program.** Partition so retrieve does not get worse as the store grows.

### Three stores, one packet (coding-agent ship)

1. **Live world — always eligible, never evicted.** Scoped SemanticStore: `(scope, s, p)` → value. Inject **always** unions this into the pool for copula/path cues. Hundreds–thousands of facts in a normal repo; not tens of thousands of turns.
2. **Pins / constraints.** Inherit to descendant folders. Always eligible. Small.
3. **Episodes — the bulk.** Append-only. **Never delete** a raw turn. Indexed as **path-scoped postings** `(scope, token) → ids`. Filter to cue directory **first**. Generic `what is auth` hits layer 1, not 20k diary lines. Rare needles (`op00042`, hash, test name) may hit layer 3.

Sleep writes aliases **on the row**. Sleep keeps layer 1 true (tombstone **inside scope**) and scoped postings honest. It does not have to shrink the episode log.

Packet stays **6 × 900**: live scoped fact, inheritable pin, at most one procedure, at most one episode. Header names the folder. Siblings never pack.

**Proof (ship):** 15840 junk turns still on disk; `scopedAuthOk` / `scopedDbOk` true; `op00042` packs on that cue; cli silent on Clerk; math silent.

### Millions — diary **and** live world (locked)

A JSONL `Map` rebuilt on Submit does not extend to 10⁶. **Two indexes, two retrieve styles.** The log remains source of truth. Submit never scores the log.

**A. Live world (millions of triples still true)**

LWW inside `(scope, s, p)` means millions of *writes* must not mean millions of *live* rows. Sleep compact tombstones so retrieve sees **live only**.

If the live set is still ~10⁶ (many folders × many entities):

- **Keyed table**, not BM25-over-all-facts. PK `(scope, s, p)` → `{o, t}`. Point lookup.
- Copula retrieve: parse subject from cue (`auth`, `database`) → `get(cueScope, s, *)` plus ancestor pins. **Do not** union every company fact that contains `is`.
- No files open → `scope==""` + inheritable pins only. Repo-root `what is auth` does **not** search 10⁶ triples.
- If **one** product folder still has tens of thousands of live facts, tighten **retrieve** (not write grain) to the open file’s parent directory, or to a symbol if the hook ever has one. Write grain stays product-folder so `login.ts` and `db.ts` still share Clerk.
- Token index over live objects only for leftover cues with no parseable subject, scoped, walk cap 64. Empty → silence.

**B. Diary (millions of turns / tools / imports)**

- Append-only log. Do **not** load texts into RAM to retrieve.
- On-disk inverted index: `(scope, token) → [id…]`. Sleep owns rebuild. Submit reads ids for the cue directory and the rarest 1–4 tokens, hydrates **≤64** rows, then kind / gold-first / pack.
- Do not post stop-words or high-df verbs (`shipped`, `file`, `operator`). Post entities, paths, error-shaped tokens, write-time aliases.
- Fat folder + common token: **AND** with a rarer token, or skip that list. Never `df≥80` then stop. Never walk a million-id list in file order.
- Generic `what is auth` still hits **A**, not B.
- Rank may decay with heat/age. **Deletion does not.**

**C. Inject at 10⁶**

Unchanged: 6 × 900, folder in the header, no sibling leak. Millions in store ≠ millions in the window.

**D. Not**

Embeddings on Submit. Neo4j on the hook. FTS the whole company. A named on-disk lexical index (SQLite FTS, mmap postings, or equivalent) is allowed. Vectors, if ever, stay in sleep.

**Proof (later):** synthetic 1e6 episodes + 1e6 live triples, many scopes. Web auth cue packs Clerk only. Rare id packs. Root/math silent. Do **not** wait on that fixture to ship P1–P4.

---

## 11. Sub-memory grain

| Open path | Scope |
|---|---|
| `apps/web/app/login.ts` | `apps/web` |
| `apps/web/lib/db.ts` | `apps/web` (same product; **not** per-file) |
| `packages/cli/src/cli.ts` | `packages/cli` |
| `src/index.ts` | `src` |
| missing / cwd-only | `""` (repo root) |

Rule: drop the filename; if the first segment is `apps` or `packages`, keep **two** segments; else keep the **first** segment.

| Axis | What it is | Not |
|---|---|---|
| `session` / `parent--child` | Which agent run | Not a repo folder |
| `scope` directory | Which tree the fact is true in | Not a Claude session id |
| `cwd` scrub | Privacy | Not a retrieve key |

Prefer **one store, scope on the row**, so wrap and hook share facts when they share the repo.

Cue-anchored paper ([arXiv:2607.20972](https://arxiv.org/abs/2607.20972)): triggers over `{path, symbol, semantic, event, temporal}`; voluntary memory tools ≈ 0 ops in 114 turns; delivery must be harness-side. Eden already has event (Submit) + lexical semantic. **Path as first-class scope** is the unbuilt trigger. Symbol graph is later (sleep can afford an index).

---

## 12. What to build

Do not start UI. Do not git-add secrets. League A first. League B after A’s retrieve/scope path is real. Speed is not a slice.

### P0 — Packaging

`git ls-files src/` is **`index.ts` only**.

Track (and tests they need): `sleep.ts`, `memory-sota.ts`, `semantic-store.ts`, `memory-consent.ts`, `assemble.ts`, `memory-router.ts`, `memory-lanes.ts`, `memory-forget.ts`, `memory-provenance.ts`, `memory-scrub.ts`, `memory-harmed.ts`, `memory-log.ts`, `memory-dense.ts`, `chunk-store.ts`, `chunk-retrieve.ts`, `icl-index.ts`, `experience-store.ts`, `experience-retrieve.ts`, `gist-store.ts`, `gist-retrieve.ts`, `howto-store.ts`, `howto-retrieve.ts`, `tool-trace.ts`, `src/cls/{complete,controller,episodic}.ts`, wrap `know-inject.ts` / `tool-observe.ts`, CLI `memory-import.ts` if still untracked, then `src/memory-*.test.ts`.

Rewrite CLI + plugin README to match code. `eden doctor`: memory files tracked, hook events, cap, **scope**.

Without this, teammates do not have the product. M50 “shipped” is a working-tree claim.

### P1 — Sub-memory

1. `scope` on JSONL rows **and** SemanticStore rows. Collapse rule above. Missing → `""`.
2. `observe` / `remember` stamp scope. Do not stuff path into cue tokens.
3. Copula key `(scope, s, p)`. Same in `liveCopulaLatest`.
4. Retrieve: exact scope for copulas; pins/constraints match cue directory **or ancestor**. Never siblings. Never descendants for copulas (root postgres does not leak into `apps/web` unless inherit on — default **off** for facts).
5. One place function: hook Submit, `inject`, `injectBody` — `placePathsFrom` on **body and last user message**. Today array path returns `[]` for `open_files`.
6. Cue directory: `dirname` then collapse, **not** `basenamePath`. Filter beats extra tokens.
7. Root cue: only `scope==""` + inheritable pins.
8. Persist `at` / `invalidAt` / `validUntil`. Do not stringify them away.

**Tests:** long-horizon `scopedAuthOk` / `scopedDbOk` after 4752 at default settings; pin inherit both trees; parent postgres inherit-off absent in children; web fact absent at root with no files; `apps/web/app` and `apps/web/lib` **share** Clerk.

Do not: per-file stores. Do not: cwd-only.

### P2 — Inject reads live copulas

Union scoped SemanticStore into the pool before pack. Live copulas do not count toward JSONL eviction. After 4752 turns, Clerk still injects in `apps/web`.

### P3 — Candidate generation

1. Stop cutting gold on `df≥80`. Union a few rare lists **and** always include the cue’s content tokens even if `df=100`, with a walk cap (e.g. 64 ids).
2. 12-needle drop on **episodes only**.
3. Scope filter first.
4. Path-scoped postings once volume is high; until then filter the global pool by scope.

### P4 — Inject polish

1. Hook passes payload `open_files`. `placePathsFrom` reads `open_files` / `files` on message objects.
2. Call `goldFirstNotes` on the scoped pool.
3. Header `Eden Memory (apps/web):`. Default pack is **6**, not 8.
4. Never pack sibling copulas.
5. Restore or delete `EDEN_MEMORY_MIN` / `SWALLOW` / `AGENT` / `PROJECT` honestly.
6. WH skipStore stays; scope still applies.
7. Wrap: after copying paths, `inject` must still see them. Stamp scope on observe.
8. `thanks, auth is Clerk` still encodes; `thanks` stays silent.
9. How-to: `hookLane === "procedure"` or how-do-I / howto / verify — **not** `\bflake\b` only. One bullet, data not orders.

### P5 — Remember-all without a global haystack

Episodes append-only. Live copulas never evict. Scoped postings so 20k junk does not bury Auth. Long-horizon flags true after 15840 with junk still on disk.

### P5b — Millions (after first coding-agent ship)

On-disk scoped postings + keyed live table (not JSONL `Map`). SQLite FTS / mmap postings allowed. Required before 10⁶, not before P1–P4.

### P6 — Sleep aliases + path-scoped how-to

Widen `WRITE_ALIASES` on the **row**. Submit does not expand the cue. How-to scoped like JSONL.

### P7 — Pool BM25

Only if P3 still misses. **On the scoped pool only.** Never `bm25All` over the store on Submit.

### P8 — League B

Only when A’s long-horizon flags are green.

| Slice | Outcome |
|---|---|
| EventQA | Identical-chunk BM25; if still &lt; 74.6, **LOSS** and stop structure |
| FC-MH | Real CAR hops, last hop first; target 27 |
| LME-V2 | Experience **files** in slice budget; 1.8% is not a retrieve-k problem |
| TB Δ | Re-run **post-silence** |
| 4o-mini Table 3 | Required for a SOTA **sentence**; Gemma 44.8 stays a Gemma column |

---

## 13. Roadmap (slice order)

| Slice | Outcome |
|---|---|
| **P0** | Track files + doc truth |
| **P1** | `(scope,s,p)` + retrieve filter + inherit pins + product-folder collapse + place actually reaches retrieve |
| **P2** | Inject reads SemanticStore; copulas never evict; `scopedAuthOk` at default cap after 4752 |
| **P3** | Candidate-gen (`df≥80`, needle drop on episodes only) |
| **P4** | Packet scope label; how-to not flake-only; `goldFirstNotes`; persist `at` |
| **P5** | Append-only episodes; scoped postings; flags true after 15840 |
| **P5b** | On-disk indexes for millions |
| **P6** | Sleep aliases; path-scoped how-to |
| **P7** | Pool BM25 if still missing |
| **P8** | League B re-bench |

P1+P2+P3+P4 are the product. P5 is years of turns without a global haystack. P5b is 10⁶. Speed work is not a slice.

Hygiene (not a speed program): persist timestamps; read or delete `sleep-postings.jsonl`; WAL unlink-or-implement; transcript `slice(-40)` without scanning the whole file.

---

## 14. Two SOTA leagues

Same brain. Different exams.

### League A — coding agent (primary)

After burial, tools, overwrites, **folder conflict**, and months of turns: right live fact in a tiny packet, or silence.

SOTA is **not** LoCoMo 92. Chat-QA systems that embed the query and run a second model on retain/reflect are **disallowed on Submit**.

| Capability | Today | Bar |
|---|---|---|
| Retrieve | Global rare-token union, `df≥80`, 12-needle drop | Scoped postings or filter; gold with high df still enters a bounded pool; pool BM25 optional; live table eligible |
| Conflict | Global `(s,p)` | `(scope,s,p)` |
| Scope | Place dropped; basename-only even if fixed | Product folder; exact copulas; inherit pins |
| Memory | 2000 JSONL deletes facts | Live copulas + pins always; episodes never deleted |
| How-to | `\bflake\b` only | Procedure lane / how-do-I, path-scoped, one bullet |
| Inject | Tiny, wrong cue | Last user + **directory**; header names scope; no siblings |
| Cost | ~11–50 ms spawn | **Acceptable.** Accuracy at 20k+ / later 1e6 |

### League B — official inject scoreboard (second)

Protocol: `benchmarks/memoryagentbench/PROTOCOL.md`. Backbone **named**. M50 certified M37 Gemma; that is **not** a 4o-mini SOTA sentence.

| Exam | Certified (2026-09-25, Gemma 4 31B) | Plan §9.2 bar |
|---|---|---|
| Table 3 overall | **44.8** (AR 57.3 / TTL 34.6 / LRU 53.8 / SF 33.5) | ≥ **50** on **4o-mini** to claim vs HippoRAG 41.6 / Claude LC 49.6 |
| FC-SH / FC-MH | 58 / **9** | **82 / 27** |
| EventQA 534k | 67 | Beat identical-chunk BM25 **74.6** or LOSS |
| LME-V2 Small | **1.8%** | RAG 42.8 then AgentRunbook-C **74.9** |
| TB 2.1 Δ | **−10.0 pp** (locked 2-task Harbor) | Positive Δ, k=5, post-silence |

League B does not unlock embeddings on Submit. Waves that “closed” with named LOSS are not the bar.

---

## 15. Done-when

### League A (before “shipped”)

Fresh clone, default env, coding-agent fixture:

1. Locked 2k operator bench stays **0 misses**. Packet bounded. Speed as measured is fine.
2. Long-horizon **`scopedAuthOk` and `scopedDbOk` true** after 4752 **and** 15840, with **all** junk episodes still on disk.
3. Sibling leak **false**.
4. Pin `.env` injects in both trees.
5. Chatter/math still silent.
6. At **20k+** stored episodes: buried rare needle still packs when cued; live scoped copulas still pack; packet still ≤6 / ≤900.
7. README matches env knobs.

### League B (before any SOTA **sentence**)

8. Table 3 four avgs + overall on a **named** backbone. SOTA memory-agent only if **4o-mini** overall **> 41.6** (bar **≥ 50**).
9. FC-SH ≥ 82 **and** FC-MH ≥ 27 for SF SOTA.
10. LME-V2 vs 42.8 / 74.9 with gold_in_packet — or honest LOSS.
11. TB 2.1 Δ vs locked harness k=5, post-silence — or honest LOSS.

Until A.1–A.7: strong local prototype, not shipped coding-agent memory. Until B.8–B.11: do not say SOTA on those boards.

---

## 16. Non-goals

- `memory_search` / Memorable CLI / MCP recall as the default loop
- Fail-closed default
- Dashboard chrome (`apps/web/REBUILD.md` stays one phase at a time, separate)
- Per-file memory stores
- Embeddings on UserPromptSubmit
- LoCoMo 92 / Gemma-44.8-as-4o-mini
- Changing the locked whatever harness
- Growing the packet until every past turn fits
- Optimizing spawn 50 ms → 1 ms
- Neo4j / four live graphs / reflect loops on Submit

Sleep **may** write aliases or a cold posting file. Submit may not open vectors.

---

## 17. Env knobs: docs vs code

| Knob | Docs | Code |
|---|---|---|
| `EDEN_MEMORY` | on / readonly / off | Real. Unset → on |
| `EDEN_MEMORY_DIR`, `EDEN_HOME` | store location | Real |
| `EDEN_MEMORY_CAP` | retrieve k 6–10 | Real. Unset → **6** |
| `EDEN_MEMORY_STORE_CAP` | JSONL 2000 | Real. JSONL only. Deletes unpinned facts |
| `EDEN_MEMORY_SESSION` / `PARENT` / `CHILD` | session file | Real |
| `EDEN_MEMORY_LOG` | stderr ids | Real |
| `EDEN_SLEEP_EVERY` / `IDLE` / `BUDGET` | 32 turns / 5 min / 25 ms | Real. Idle does not fire in a short hook |
| `EDEN_EXPERIENCE_BYTES` | often missing from CLI README | Real. Default 32 MiB |
| `EDEN_MEMORY_MIN` | aboutness 0.15 | **Gone.** Silence is `isNoopCue` + empty postings |
| `EDEN_MEMORY_AGENT` / `PROJECT` | isolate store | **Gone** |
| `EDEN_MEMORY_SWALLOW` | print swallows | **Not read.** Counter only |
| `EDEN_MEMORY_INJECT_LOG` | metric path | Wrap `tool-observe.ts` (often untracked) |

Ship with one truth.

---

## 18. Pointers

| What | Where |
|---|---|
| This document | `docs/memory-ship/EDEN-MEMORY.md` |
| Long-horizon runner / numbers | `benchmarks/memory-long-horizon/` |
| Product locks / biology | `docs/MEMORY-PLAN.md` |
| Completeness vs drowning | `docs/MEMORY-COMPLETE.md` |
| Mechanism backlog vs 2026 papers | `docs/MEMORY-SOTA-BUILD-REPORT.md` |
| Competitors | `docs/MEMORY-COMPETITORS.md` |
| 50 waves (historical; M50 closed on working tree) | `docs/MEMORY-WAVES.md`, `docs/MEMORY-WAVE-STATUS.md` |
| M50 scoreboard | `benchmarks/memoryagentbench/M50-SCOREBOARD.md` |
| Help ledger | `benchmarks/memory-holdout/HELP.md` |
| Product code | `src/index.ts`, `src/memory-sota.ts`, `src/semantic-store.ts`, `packages/cli/src/memory-hook.ts`, `packages/wrap/src/know-inject.ts` |
| UI rebuild (unrelated) | `apps/web/REBUILD.md` |

Remote for git/GitHub work stays `KaiavN/Eden`.
