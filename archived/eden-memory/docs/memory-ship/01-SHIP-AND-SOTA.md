# 1. Ship and SOTA — what is still required

**Dated 2026-09-29.** Locked this turn: coding-agent product **first**, official MemoryAgentBench / LongMemEval / Terminal-Bench **second**. Grain: inherited product-folder directories (see report 3).

Locked animal from `docs/MEMORY-COMPLETE.md` and `docs/MEMORY-SOTA-BUILD-REPORT.md`: silent hook inject, copula + episode, ≤8 / ≤900, fail-open, dump-all is a miss, **no embeddings and no LLM on UserPromptSubmit**.

Wave status (`docs/MEMORY-WAVE-STATUS.md`) says **M50 closed 2026-09-25**. That is true of the **working tree** and the **help ledger**. It is **not** true of a GitHub clone, and it is **not** true of folder-aware long use.

---

## Verdict

| Bar | Status |
|---|---|
| Local sidecar, one user, one store, exact names (2k operator bench) | Working. Buried `op0042` hits. Inject in-process **~0.02 ms**. JSONL **~93 KB** |
| Short scripted coding holdout (flake / ADR / file rule / version / junk) | Working. Gate 1 **WIN 8/0/0**. HELP.md helped **10** / no-lift **2** / harmed **0** |
| Silent inject + fail-open + chatter/math omit | Working. 5-year junk still silent |
| Clean clone / GitHub ship | **Not ready.** Tracked `src/` is `index.ts` only. Sleep, sota, semantic, consent, wrap inject, tests are working-tree files |
| Coding-agent product over months (folder truth, remember-more) | **Not ready.** After 4752–15840 turns at cap 2000, Clerk / postgres / sqlite are **gone**. At cap 10k they **collide globally**. `scopedAuthOk` / `scopedDbOk` **false** on every arm |
| SOTA coding-agent memory (this animal) | **Not ready.** Retrieve is a rare-token union over a **global** posting list. Product `inject` **drops** `open_files`. SemanticStore is unscoped `(s,p)` |
| SOTA memory-agent (Table 3 / LME / TB) | **Not claimed.** Certified Gemma overall **44.8** (not 4o-mini). LME-V2 **1.8%** LOSS. TB Δ **−10.0 pp** LOSS. FC-MH **9** vs target **27** |

Until clone-track **and** folder sub-memory **and** hot copulas that survive the cap, do not call it shipped. Until the second-league numbers move under an honest protocol, do not call it SOTA on those boards.

---

## Two leagues (same brain, different exams)

### League A — coding-agent product (primary)

The exam is: after burial, tools, overwrites, **folder conflict**, and months of turns, the next coding turn still gets the **right live fact in a tiny packet** — or silence.

That is the 2026 coding-memory argument in [arXiv:2607.20972](https://arxiv.org/abs/2607.20972) (*Delivery, Not Storage*): voluntary `memory_search` is ~zero even when the store is pre-seeded (0 ops in 114 turns); facts held only in the window die at compaction; **deterministic harness injection** is the load-bearing channel. Eden already chose that channel. The missing piece is **path-scoped triggers** so `apps/web` Clerk and `packages/cli` `none` can both be live.

SOTA here is **not** LoCoMo 92. Competitors that win chat-QA by embedding the query and running a second model on retain/reflect are **disallowed on Submit**.

| Capability | Today | SOTA bar for this animal |
|---|---|---|
| Retrieve | Rarest posting union, `df≥80` cutoff, 12-needle drop, kind boost, **global** lists | Path-scoped postings **or** scope filter; gold with `df≥80` still enters a bounded pool; BM25 **on the pool only**; live SemanticStore copulas eligible even if JSONL evicted them |
| Conflict | One global `(subject, relation)` in JSONL **and** in `semantic.jsonl` | `(scope, subject, relation)` so web Clerk and cli `none` coexist |
| Scope | `attachPlaceCues` appends **basename** (`login.ts`) | Repo-relative **product folder**; exact match for copulas; inherit only for pins/rules |
| Memory | 2000 JSONL rows, oldest unpinned dropped | Hot live copulas + pins always; cold episodes on disk; Submit parses **hot** only |
| How-to | Injected only if cue matches `\bflake\b` | Path-scoped procedure when `hookLane === "procedure"` (or how-to / “how do I”); one bullet |
| Inject | Terse, skipStore on WH, chatter/math silent. **Hook Submit never passes `open_files`.** `inject(array)` then drops them even if wrap copied them onto the last user message | Cue = last user + **directory** from hook payload *and* wrap body; packet header names the scope; sibling copulas never packed |
| Cost | In-process inject **~0.01 ms**; spawn-reload **~11–50 ms** — **acceptable**. Do not optimize this. | Accuracy at 20k+ episodes: scopedAuthOk after 5y of turns; rare needles still hit; packet still tiny |

### League B — official inject scoreboard (second)

Same `openMemory` inject API. Protocol stays `benchmarks/memoryagentbench/PROTOCOL.md`. Backbone must be **named**. M50 certified the M37 Gemma column; it is **not** a 4o-mini SOTA sentence.

| Exam | Certified (2026-09-25, Gemma 4 31B) | Plan §9.2 bar | Gap |
|---|---|---|---|
| Table 3 overall | **44.8** (AR 57.3 / TTL 34.6 / LRU 53.8 / SF 33.5) | ≥ **50** on **4o-mini** to claim SOTA vs HippoRAG 41.6 / Claude LC 49.6 | Wrong backbone for the claim; overall short of 50; SF hops still dead |
| FC-SH / FC-MH | 58 / **9** | **82 / 27** | Multi-hop assembly |
| EventQA 534k | 67 (M37) | Beat identical-chunk BM25 **74.6** | Narrative retrieve still loses to BM25 |
| LME-V2 Small | **1.8%** | RAG 42.8 then AgentRunbook-C **74.9** | Trajectories are not in the hot packet; cap 2000 is not the LME store |
| Terminal-Bench 2.1 Δ | **−10.0 pp** (locked 2-task Harbor) | Positive Δ, k=5, tokens reported | Always-on can still hurt; silence gate exists but TB was pre-silence certified |

League B does **not** unlock embeddings on Submit. If EventQA still loses to identical-chunk BM25 after store-all chunks, **file LOSS and stop adding structure** (`docs/MEMORY-PLAN.md`).

---

## What “ship” means (must all be true)

1. **Clone works.** `sleep.ts`, `memory-sota.ts`, `semantic-store.ts`, `memory-consent.ts`, wrap `know-inject.ts` / `tool-observe.ts`, and the tests those files need are in git. `bun test` on the locked contract suite is green from a fresh clone.
2. **Docs match code.** CLI README still documents `EDEN_MEMORY_MIN`, `EDEN_MEMORY_AGENT` / `EDEN_MEMORY_PROJECT`, and `EDEN_MEMORY_SWALLOW`. Those knobs are **gone** from `src/index.ts` (silence is `isNoopCue` + `hookLane === "none"`; swallows increment a counter and are not logged). Ship with one truth.
3. **Off / readonly / on** stay fail-open. Off is identity. No 403.
4. **Secrets, 0o600 JSONL, redact, scrub cwd/session** stay.
5. **Hook + wrap** share one brain (same dir, session, child suffix).
6. **Packet contract:** labeled, no dump-all, chatter/math silent, skip-not-evict, ≤900 B. Default is **6** bullets (`min(8, k)`), not 8.
7. **Folder sub-memory** is on the product path, not a later idea.
8. **Live copulas survive the 2000 cap.** `semantic.jsonl` is already **527 bytes after 5 years** of this exam — inject currently **does not** pack those rows when JSONL evicted the episode. That is a ship bug, not a research idea.

Until (1), (7), and (8), do not call it shipped.

---

## Gaps that block both ship and SOTA

### A. Retrieval is the wrong index for a repo (the main miss)

Exact algorithm today (`src/index.ts` `relevant`):

1. `queryHay` tokenizes the cue (`cueFor` last user). `attachPlaceCues` would append **basenames**, but `inject(array)` / hook Submit never feed it paths — see below.
2. Tokens with `df>0` sorted rarest-first.
3. Union posting lists until `df≥80` **or** pool cap (`max(k*6, 30)`). **If a frequent token is the only content token, gold never enters.**
4. Score overlap + IDF; **drop any row with more than 12 needles** (hurts long episodes that still own the rare token).
5. `liveCopulaLatest` collapses `(s,p)` **globally**.
6. Kind boost, recency, slice k.

Failure modes for a monorepo agent:

- Postings are **global**. `auth` in `apps/web` and `packages/cli` share one list.
- Place cues are supposed to add `login.ts` / `cli.ts` leaves. On the **product path they add nothing.** `inject` calls `placePathsFrom(list)` on the **message array**. That path only walks `PLACE_OBJ_KEYS` (`path`, `filename`, …) on each object — not `open_files`. Wrap `injectBody` copies paths onto the last user message, then `inject` throws them away. The Claude hook (`memory-hook.ts` UserPromptSubmit) injects `{ role, content: prompt }` only — it never reads payload `open_files`. The long-horizon bench passed `open_files` on that same array shape, so it was scoring **global retrieve with no place at all**.
- Even if that were fixed, `attachPlaceCues` would still keep **basename** (`login.ts`), not `apps/web`. Sibling packages that share a filename would still collide.
- How-to merge is gated on the word `flake` (`mergeHowtoLane`). Most coding cues never see a procedure even when `hookLane` already knows `"procedure"`.
- SemanticStore LWW is **unscoped** and lives on the **memory root**, not the session file. Last `Auth is X` wins for the whole machine **and** every session. Key is `` `${s}\0${p}` `` (`src/semantic-store.ts`).
- `persist` writes `{ ...r, at: undefined, invalidAt: undefined, validUntil: undefined }`. After a hook spawn, recency and in-JSONL tombstones are gone. `liveCopulaLatest` then sees `undefined >= undefined` (false) and keeps **file order** — usually the older copula. Cross-process LWW is not the in-process LWW.
- `goldFirstNotes` exists and is **not** on `inject`. Kind boost already puts every overlapping fact above every episode.
- Default pack is **`min(8, k)` with k default 6**, not 8.
- After 10k rows × 5 years, even **trailing** Auth/db writes failed to pack (`cliHasNone` false). Candidate-gen + needle rules collapse under a fat index. Raising the cap is not retrieve.

Long-horizon evidence (this tree, 2026-09-29): after 18 months at cap **10k**, `what is auth` did **not** pack Clerk; the cli cue packed `none`. Place files were on the message object and **never entered the cue**. That is global LWW, not “web vs cli.”

### B. Injection is correct-small, wrong-cue

Already good: fail-open, skip chatter/math, pack skip-not-evict, provenance labels, WH `skipStore` so the question is not stored as a fact, strip `Eden Memory:` before observe. Wrap `injectBody` *tries* to stitch `open_files` onto the last user message — `inject` then ignores them.

Not good enough:

- Retrieve query is `cueFor` only on the hook. Wrap/bench `open_files` never become cue tokens (array `placePathsFrom`). Directory is unused as a **filter**.
- Empty packet after cap eviction even when `semantic.jsonl` still holds the live copula (527 B after 5 years).
- No “this packet is scoped to `apps/web`” marker, so the model cannot tell a leaked sibling fact from a live one.
- `EDEN_MEMORY_MIN` is documented and tested as an env **unset**, but `inject` no longer reads it. M38 aboutness floor is gone from the hot path.
- How-to only merges on `flake`.

### C. Remember-more vs the 2000 cap

Product intent (`docs/MEMORY-COMPLETE.md`): disk never forgets a raw turn; the packet stays tiny.

`trimToStoreCap` **deletes unpinned JSONL rows**. Pins survive (`.env` rule). Experience / how-to / chunks / ICL files already sit **outside** that cap. Chat JSONL does not. SemanticStore **does** keep live `(s,p,o)` outside the cap — inject just does not treat it as the hot copula set.

SOTA is **not** “raise the cap and put 50k rows in one global posting list.” Report 2: at 10k rows × 5 years, retrieve **missed even the trailing Auth/db writes**. More rows in one unscoped index **reduce** accuracy. The split is: live scoped copulas + pins always eligible; episodes append-only and retrieved **inside the cue directory**; packet stays 6×900.

Speed is acceptable (hook spawn ~11–50 ms on this exam). Do not spend slices on spawn p95. Spend them on gold-in-packet at 20k+ episodes.

### D. Compute / RAM / disk (measured)

Claude UserPromptSubmit is a **new process**. In-process inject numbers are the wrong SLO.

| Path | 2k rows (18 mo) | 4.7k rows | 10k rows (5 y) |
|---|---|---|---|
| In-process inject p50 | **0.013 ms** | 0.017 ms | 0.004 ms |
| Spawn parse p50 (`openMemory` JSONL load) | **9.7 ms** | **22.5 ms** | **45.8 ms** |
| Spawn total p50 (parse + inject) | **10.9 ms** | **25.6 ms** | **50.1 ms** |
| JSONL | 211 KB | 501 KB | **1.06 MB** |
| `semantic.jsonl` | **527 B** | 527 B | 527 B |
| RSS | 122 MB | 173 MB | 301 MB |

Spawn parse grows with JSONL size. **That is not the ship tax.** The tax is: one global index gets **worse** as it grows (`df≥80`, 12-needle drop, unscoped LWW). Partition by scope and keep live copulas out of the episode hay. Do not add embeddings to the retrieve path.

Still **unmeasured** on the hook: `messagesFromTranscript` reads the **entire** transcript JSONL then keeps the last 40 (`memory-hook.ts`). Incremental sleep (`setImmediate` after observe, 25 ms budget) can still run before the hook process exits. `sleep-postings.jsonl` is written on full sleep and **never read** by `relevant`. The `.wal` file is only `unlink`d — it is not a log.

### E. Product packaging

- Untracked brain files (see report 3 §0).
- No published package.
- `eden setup` vs Claude plugin double-attach still a footgun.
- Operator UI is **gated** (`apps/web/REBUILD.md`) and is **not** this ship.

### F. Scoreboard leftovers (league B, after A–D)

Do not retune retrieve@5. Do not swap in `BrainMemory`. The leftover mechanisms are already named in waves M18–M26 / M22: store-all chunks vs BM25, CAR hops for FC-MH, experience **files** for LME, remain-silent so TB cannot go negative. Those waves “closed” with LOSS numbers. Closing a wave with a named LOSS is not the same as beating the bar.

---

## What we will not do (still SOTA-disallowed)

Embeddings on Submit. Cue-time synonym explosion. Dump-all when postings miss. LLM extract/reflect on the hot path. Neo4j. Growing the packet until every past turn fits. Fail-closed unset. `memory_search` as the default loop. Per-file memory stores. Dashboard chrome.

Sleep **may** write extra aliases or a cold posting file. Submit may not open vectors.

---

## Done-when

### League A (must, before “shipped”)

A fresh clone, default env, coding-agent fixture:

1. Locked 2k operator bench stays **0 misses**. Packet still bounded. Speed as measured is fine.
2. Long-horizon bench **`scopedAuthOk` and `scopedDbOk` true** after 4752 **and** 15840 turns, with **all** junk episodes still on disk (not deleted by cap).
3. Sibling leak **false**: cli cue never packs web Clerk.
4. Pin “never commit .env” still injects in both trees.
5. Chatter/math still silent.
6. At **20k+** stored episodes: buried rare needle (`op00042`) still packs when cued; live scoped copulas still pack; packet still ≤6 / ≤900.
7. README matches env knobs.

### League B (must, before any SOTA **sentence**)

8. Table 3 four avgs + overall on a **named** backbone. SOTA memory-agent only if **4o-mini** overall **> 41.6** (bar **≥ 50**). Gemma 44.8 is a Gemma column.
9. FC-SH ≥ 82 **and** FC-MH ≥ 27 to claim SF SOTA.
10. LME-V2 Small vs RAG 42.8 / AgentRunbook-C 74.9 with gold_in_packet — or honest LOSS.
11. TB 2.1 Δ vs locked harness k=5, post-silence — or honest LOSS.

Until A.1–A.7, it is a strong local prototype, not a shipped coding-agent memory. Until B.8–B.11, do not say SOTA on those boards.
