# 3. What to build

**Dated 2026-09-29.** Ordered so each slice is shippable. Do not start UI. Do not git-add secrets.

You asked for: massively better retrieval, polished inject, compute/RAM/disk, remember as much as possible, **folder sub-memory** for the coding agent. League A first. League B only after A’s retrieve/scope/hot path is real.

**Grain (chosen):** inherited **product-folder** directories.

| Open path | Scope |
|---|---|
| `apps/web/app/login.ts` | `apps/web` |
| `apps/web/lib/db.ts` | `apps/web` (same product; **not** per-file) |
| `packages/cli/src/cli.ts` | `packages/cli` |
| `src/index.ts` | `src` |
| missing / cwd-only | `""` (repo root) |

Rule: drop the filename; if the first segment is `apps` or `packages`, keep **two** segments; else keep the **first** segment. Copulas **exact-scope**. Pins/constraints **inherit to descendants**. Never siblings. Never basename-only. Never cwd as the retrieve key (agents `cd`).

Sessions (`parent--child`) stay a **different axis** (M45). Do not reuse child session files as folder memory.

---

## 0. Packaging (unblocks every other item)

`git ls-files src/` is **`index.ts` only**. A clone does not have the brain.

Track (and the tests they need to compile):

- `src/sleep.ts`, `src/memory-sota.ts`, `src/semantic-store.ts`, `src/memory-consent.ts`
- `src/assemble.ts`, `src/memory-router.ts`, `src/memory-lanes.ts`, `src/memory-forget.ts`, `src/memory-provenance.ts`, `src/memory-scrub.ts`, `src/memory-harmed.ts`, `src/memory-log.ts`, `src/memory-dense.ts`
- stores: `chunk-store.ts`, `chunk-retrieve.ts`, `icl-index.ts`, `experience-store.ts`, `experience-retrieve.ts`, `gist-store.ts`, `gist-retrieve.ts`, `howto-store.ts`, `howto-retrieve.ts`, `tool-trace.ts`
- wrap: `packages/wrap/src/know-inject.ts`, `packages/wrap/src/tool-observe.ts`
- then the `src/memory-*.test.ts` / wrap tests that import them

Also:

1. Rewrite CLI + plugin README so they match `src/index.ts` (drop or reimplement `EDEN_MEMORY_MIN` / `EDEN_MEMORY_AGENT` / `EDEN_MEMORY_PROJECT`).
2. One `eden doctor` line: “memory files tracked, hook events, cap, **scope**.”

Without this, teammates do not have the product. M50 “shipped” is a working-tree claim.

---

## 1. Sub-memory (coding agent) — correctness

**Problem:** One SemanticStore key `(s, p)` and one posting list per token. `apps/web` Clerk and `packages/cli` `none` cannot both be live. Product retrieve does not see `open_files` at all; even a basename cue is not on the hook path.

**Build:**

1. **`scope` field** on the JSONL row **and** on SemanticStore rows. Stamp from `open_files` / wrap paths using the collapse rule above. Missing path → `""`.
2. **Write:** `observe` / `remember` stamps `scope`. Do **not** stuff the path into cue tokens.
3. **Copula key:** `(scope, s, p)`. LWW and `invalidAt` stay **inside** that key. Web Clerk does not tombstone cli `none`. Same change in `liveCopulaLatest` (today `` `${s}\0${p}` ``).
4. **Retrieve filter (Submit):** keep rows whose scope **equals** the cue directory, or (pins/constraints only) is an **ancestor** of the cue directory. Never siblings. Never descendants for copulas (a repo-root postgres does not leak into `apps/web` unless inherit is on — default **off** for facts).
5. **One place function** used by hook Submit, `inject`, and `injectBody`: `placePathsFrom` on the **body and the last user message** (what wrap’s `cueFromInjected` already does for logs). Today `inject(array)` returns `[]` for `open_files` on messages; the hook never copies payload files. Until that is fixed, scope has no cue directory.
6. **Cue directory:** from that list, `dirname` then collapse — **not** `basenamePath`. Filter beats extra tokens.
7. **Root cue** (no files): only `scope==""` rows + inheritable pins. Folder facts stay quiet.
8. **Persist `at` / `invalidAt` / `validUntil`.** Do not `JSON.stringify` them away. Spawn-reload LWW and cap trim are meaningless without timestamps on disk.

**Tests (must exist before claiming done):** long-horizon `scopedAuthOk` and `scopedDbOk` at cap 2000 after 4752 turns. Plus: inherit pin visible in both trees; parent postgres with inherit off **absent** in children; web fact **absent** at repo-root cue with no files; `apps/web/app` and `apps/web/lib` **share** Clerk (product-folder, not per-file).

**Do not:** per-file stores. Do not use cwd-only.

---

## 2. Retrieval — massive (this is the product)

Keep: inverted index, no dump-all, no cue-time synonym explode, kind boost, skip-not-evict pack, fail-open empty.

Today’s retrieve (`relevant`) is rarest-union + `df≥80` stop + 12-needle drop + global LWW. That is fine for “operator op0042” and **wrong** for a repo.

**Build in this order (do not skip to BM25):**

### 2.1 Candidate generation (cheapest miss cut)

1. **Stop cutting gold on `df≥80`.** Union up to a small number of rare lists (e.g. 4) **and** always include the cue’s content tokens even if `df=100`, with a **walk cap** (e.g. 64 ids, 256 posting entries). p99 stays &lt;1 ms on hot.
2. **12-needle drop on episodes only**, not facts/copulas/pins.
3. **Scope filter first** (section 1). A global `auth` list of 400 ids becomes 8 in `apps/web`. This is the actual “massive” gain.
4. **Path-scoped postings** (token → ids **in this scope**) once hot &gt; a few thousand. Until then, filter the global pool by scope.

### 2.2 Rank (pool only)

5. **Kind first, then BM25 on the candidate pool** (not `bm25All` over the store). Sleep can store `df` / avg length. Submit does not walk 20k docs.
6. **Hot SemanticStore merge:** for copula/path lanes, union **live** `(scope,s,p)` rows into the pool **before** pack. Report 2: this file is 527 B after 5 years and inject ignores it. That is why cap 2000 forgets Auth.
7. **Wire `goldFirstNotes`** on the scoped pool (exported, tests only). Kind boost already puts facts above episodes; gold-first is for rare-token order inside that.

### 2.3 How-to / aliases (sleep-shaped)

8. **How-to:** if `hookLane(cue) === "procedure"` **or** `\b(how do I|howto|verify:)\b`, read path-scoped `howto.jsonl`. One bullet. Delete the `\bflake\b`-only gate in `mergeHowtoLane`.
9. **Sleep aliases** onto the **row** (widen `WRITE_ALIASES` offline). Submit still does not expand the cue.
10. **Optional last:** sleep-time cluster ids. Submit never loads vectors.

### 2.4 What “massive” is not

Not a cross-encoder. Not TEMPR four-arm RRF on Submit. Not Hindsight 1024-token dumps. Not Mem0 embed search (148 ms). Those can live in **sleep** if a named league-B leaf still fails after 2.1–2.3.

The 2026 cue-anchored paper wants triggers over `{path, symbol, semantic, event, temporal}`. Eden already has event (Submit) + a weak path (basename) + lexical semantic. **Path as a first-class scope** is the unbuilt trigger. Symbol graph is P2 (needs an index sleep can afford). Temporal lane already parses dates; it does not filter by scope.

---

## 3. Inject polish

Keep: fail-open, `Eden Memory:`, ≤8/≤900, skipStore on WH, chatter/math silent, provenance labels, log off by default, strip packet before observe.

**Build:**

1. **Wire `open_files`.** Hook UserPromptSubmit must pass payload paths into `inject`. `placePathsFrom` must read `open_files` / `files` on message objects, not only `PLACE_OBJ_KEYS`. Then: cue = last user text + cue directory as **filter**, not a bag of colliding filenames. Filenames can stay as **optional** extra needles **after** the scope filter.
2. **Call `goldFirstNotes` on the scoped pool** (it exists; inject does not use it).
3. **Packet header** one short line: `Eden Memory (apps/web):` so the model knows the scope. Extend tests that grep `Eden Memory:` — do not rename blindly. Default pack is **6** bullets (`min(8, k)`); do not claim 8.
4. **Do not pack sibling copulas.** Even if the token hits.
5. **Hot copulas always eligible** (section 2.2 + 4).
6. **Restore or delete `EDEN_MEMORY_MIN` honestly.** If it comes back, it is a **score** on the scoped pool, not a reason to dump-all. Today README lies. Same for `EDEN_MEMORY_SWALLOW` (incremented, never logged) and `EDEN_MEMORY_AGENT` / `PROJECT`.
7. **WH skipStore stays.** Retrieve still runs. Scope still applies.
8. **Wrap `injectBody`:** after copying paths onto the last user message, `inject` must still see them (fix array `placePathsFrom`). Stamp `scope` on **observe** as well as retrieve.
9. Tighten `isNoopCue` so `thanks` stays silent but `thanks, auth is Clerk` still encodes (CONTENT_TERM already tries; add tests).
10. **How-to in the packet** is `[procedure]` data, one bullet, path-scoped, never a 300-line script.

---

## 4. Remember as much as possible (accuracy at scale)

**Do not** raise `EDEN_MEMORY_STORE_CAP` and keep one global posting list. Report 2: 10k unscoped rows **missed trailing Auth**. Speed (~50 ms spawn) is fine. The failure is retrieve.

Three stores, one packet:

1. **Live world (always retrieved).** Scoped SemanticStore: one row per `(scope, s, p)`. Uncapped. Tiny (527 B after 5 years of *unscoped* copulas; scoped will be larger but still hundreds–thousands of facts, not tens of thousands of turns). Inject **always** unions this into the pool for copula/path cues. These never evict.
2. **Pins / constraints.** Inherit down. Always eligible. Small.
3. **Episodes (the bulk).** Append-only. **Never delete** a raw turn. Indexed as **path-scoped postings** (token → ids **in this folder**), not one global `auth` list. Submit *may* open this index — latency is acceptable — but it **must filter to the cue directory first**. A rare needle (`op00042`, a hash, a test name) is allowed to hit cold. A generic `what is auth` must **not** rank 20k episodes; it should hit the live copula in layer 1.

Sleep writes aliases **onto the row** so a paraphrase still hits. Sleep does **not** have to shrink the episode log. It has to keep layer 1 true (tombstone inside scope) and keep scoped postings honest.

Experience / how-to stay files, also scoped. Packet stays **6 × 900**: live scoped fact, inheritable pin, at most one procedure, at most one episode. Remembering more never means a bigger dump.

**Proof:** 15840 junk turns still on disk, cap no longer deleting copulas, `scopedAuthOk` / `scopedDbOk` true, `op00042` still packs on that cue, cli still silent on Clerk.

### 4.1 Millions (diary **and** live world)

10k unscoped rows already missed trailing Auth. A single in-process `Map` over `memories.jsonl` does not extend to 10⁶. Speed is still not the issue. **Two indexes, two retrieve styles.** JSONL (or an append log) remains the source of truth. Submit never scores the log.

**A. Live world — millions of triples that are still true**

LWW inside `(scope, s, p)` means millions of *writes* must not mean millions of *live* rows. Sleep compact the tombstone log so the working set is **live only**.

If the live set is still ~10⁶ (many folders × many entities):

- Store is a **keyed table**, not a posting list of sentences. Primary key `(scope, s, p)` → `{o, t}`. Point lookup, not BM25-over-all-facts.
- Copula retrieve is: parse a subject from the cue (`auth`, `database`) → `get(cueScope, s, *)` (and ancestor pins). **Do not** union every live fact in the company that contains the word `is`.
- No files open → `scope==""` plus inheritable pins only. A repo-root `what is auth` does **not** search 10⁶ triples.
- If **one** product folder still has tens of thousands of live facts, tighten retrieve (not write grain) to the open file’s parent directory, or to a symbol if the hook ever has one. Write grain stays product-folder so `login.ts` and `db.ts` still share Clerk.
- Token index over live objects, if needed, is **scoped** and only for leftover cues with no parseable subject. Cap the walk (64 ids). Empty → silence, never dump-all.

**B. Diary — millions of turns / tools / imports**

- Append-only log. **Do not** load texts into RAM to retrieve.
- On-disk inverted index: `(scope, token) → [id…]`. Sleep owns rebuild. Submit reads posting **ids** for the cue directory and the rarest 1–4 tokens, hydrates **≤64** rows, then today’s kind/gold-first/pack.
- Do not post stop-words or high-df verbs (`shipped`, `file`, `operator`). Post entities, paths, error-shaped tokens, write-time aliases.
- Common token in a fat folder: **AND** with a rarer token, or skip that list. Never `df≥80` then stop (today’s bug). Never walk a million-id list in file order.
- Generic `what is auth` still hits **A**, not B. B is for needles (`op00042`, a stack hash, a test title).
- Rank may decay with heat/age. **Deletion does not.** Raw turns stay on disk.

**C. Inject does not change at 10⁶**

Same 6 × 900. Live scoped fact, pin, one procedure, one episode. Header names the folder. Sibling scopes never pack. Millions in the store must not mean millions in the window.

**D. What this is not**

Not embeddings on Submit. Not Neo4j on the hook. Not “FTS the whole company.” A named on-disk lexical index (SQLite FTS, mmap postings, or equivalent) is allowed. Vectors, if ever, stay in sleep.

**Proof at this scale (when we have it):** synthetic 1e6 episodes + 1e6 live triples (many scopes). Web auth cue still packs Clerk only. Rare id still packs. Root/math still silent. Do not wait on that fixture to ship P1–P4.

---

## 5. Compute, RAM, disk (not the focus)

Hook spawn at 10k rows was **~50 ms**. That is acceptable. Do not schedule work to make Submit faster.

Keep: lean `[id,text]` episodes, `0o600`, redact, no vectors on retrieve. Persist `at` so LWW and trim are real after spawn. Scoped postings can live in a side file sleep maintains — retrieve must **read** them (today `sleep-postings.jsonl` is write-only). Transcript `slice(-40)` without a full-file scan is hygiene, not a speed program.

If pins alone exceed a JSONL cap, **stop capping live copulas**. Cap, if any, applies to **unscoped episode packing in RAM**, not to whether the turn still exists on disk.

---

## 6. Sessions vs folders (do not mix)

| Axis | What it is | Not |
|---|---|---|
| `session` / `parent--child` | Which agent run | Not a repo folder |
| `scope` directory | Which tree the fact is true in | Not a Claude session id |
| `cwd` scrub | Privacy | Not a retrieve key |

Prefer **one store, scope on the row**, so wrap and hook share facts when they share the repo.

---

## 7. League B leftovers (after A)

Only when A’s long-horizon flags are green. Same inject API. No dual scoring.

| Slice | Outcome |
|---|---|
| EventQA | Identical-chunk BM25 on narrative; if still &lt; 74.6, **LOSS** and stop structure |
| FC-MH | Real CAR hops, last hop first; target 27 |
| LME-V2 | Experience **files** in the packet slice budget; 1.8% is not a retrieve-k problem |
| TB Δ | Re-run **post-silence**; negative Δ with junk packets is a product fail |
| 4o-mini Table 3 | Required for a SOTA **sentence**; Gemma 44.8 stays a Gemma column |

---

## 8. Suggested slice order

| Slice | Outcome |
|---|---|
| **P0** | Track files + doc truth |
| **P1** | `(scope,s,p)` + retrieve filter + inherit pins + product-folder collapse |
| **P2** | Inject reads SemanticStore live copulas; they never evict; long-horizon `scopedAuthOk` at cap 2000 |
| **P3** | Candidate-gen fix (`df≥80`, needle drop on episodes only) |
| **P4** | Hook + `placePathsFrom(array)` actually pass `open_files`; persist `at`; packet scope label; how-to not flake-only; wire `goldFirstNotes` |
| **P5** | Episodes append-only; live copulas never evict; **scoped** postings so 20k junk does not bury Auth; long-horizon `scopedAuthOk` after 15840 turns |
| **P5b** | On-disk scoped postings + keyed live table (not JSONL `Map`). Required before **millions**, not before first coding-agent ship |
| **P6** | Sleep aliases on the row; path-scoped how-to |
| **P7** | BM25 **on the scoped pool only**; only if P3 still misses |
| **P8** | League B re-bench (optional for ship; required for SOTA sentences) |

P1+P2+P3+P4 are the product. P5 is “remember the years of turns **without** turning retrieve into a global haystack.” Speed work is not a slice.

---

## 9. Explicit non-goals

- Memorable-style `memory_search` CLI in front of inject
- Fail-closed default
- Dashboard chrome (gated UI rebuild)
- Per-file memory stores
- Embeddings on UserPromptSubmit
- Claiming LoCoMo 92 / Gemma-44.8-as-4o-mini
- Changing the locked whatever harness
