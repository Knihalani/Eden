# Appendix A2 — Eden technical choices vs the 2024–2026 state of the art

> **Code citations.** `file:line` references in this document point at commit `11c3101c3`, when it was written. Later commits, including R-5's reformat (#94, #97, #99), moved those lines. To read one: `git show 11c3101c3:<path>`.

> **Precedence note (v2, 2026-09-29):** [DECISIONS.md](DECISIONS.md) and [A4 v2](A4-DELIVERY-CONTRACT.md) supersede this appendix wherever they differ. Examples: the ledger is per context window, `resume` never resets it, scope follows R5 §9, and only slot facts supersede by key.

**Dated 2026-09-29.** Part of the memory-ship set; the index is `ROADMAP.md`. Where this appendix and `A4-DELIVERY-CONTRACT.md` differ, **A4 decides**. For example, A4 names the session ledger `delivery.json` (this appendix's `injected.json`), and A4 §2 replaces the scope rule. Background: `docs/MEMORY-COMPETITORS.md`, `docs/MEMORY-SOTA-BUILD-REPORT.md`.

**Scope.** For each Eden choice: verdict **KEEP / CHANGE / ADD**, evidence, concrete recommendation. Then a competitor matrix, a benchmark note, and references.

**Evidence labels.**
- **[measured]** — run on this machine today (Apple M3, Bun 1.3.13, Node 22.14, bun:sqlite), scripts in the session scratchpad; reproducible in ~10 min.
- **[doc]** — fetched from the primary doc/page on 2026-09-29.
- **[paper]** — primary paper; figures quoted from the paper as I know them. Where I could not re-open the page today, the claim is tagged **unverified (from model knowledge)**. Web tools were intermittently blocked during this run, so several paper numbers carry that tag. Re-check any tagged number before quoting it externally. **Citation audit 2026-09-29:** paper numbers and ids were re-checked against primary sources (`research/R4-citation-audit.md`); checked items now read **[verified 2026-09-29]** or were corrected in place. Remaining *unverified* tags are local-engineering claims that need a measurement, not a citation.

**User goal this appendix is graded against** (from the brief):
1. The user never has to restate anything.
2. Stale or irrelevant memories never drag the agent down.
3. Nothing already in context is injected again.
4. Minimal tokens.
5. Injected automatically.

Goal 3 and the "restatement" half of goal 1 are **not measured by any public benchmark** (§6). Eden should own those metrics.

---

## 0. Verdict table (one screen)

| # | Eden choice | Verdict | One-line reason |
|---|---|---|---|
| 1 | No embeddings on Submit | **KEEP — but re-justify** | Latency is no longer the reason (static embeddings encode in µs). Reasons that survive: dense always returns *something* (breaks silence), identifier cues favor lexical, and model load per fresh process. |
| 2 | Lexical rare-token retrieval | **KEEP + CHANGE ranking** | Keep rare-first. Replace `df≥80` stop + file-order pool with BM25 over a **bounded** candidate set; fat postings read newest-first. |
| 3 | Vectors only in sleep | **KEEP + ADD document expansion** | Use sleep-time vectors/LLM to write **alias tokens onto rows** (inference-free sparse / doc2query idea). Semantic recall, lexical query path. |
| 4 | JSONL loaded whole + whole-file rewrite | **CHANGE** | Append-only for episodes now (0.3 ms append+fsync vs 37 ms rewrite of 18.7 MB [measured]); SQLite as store of record at P5b. |
| 5 | SQLite FTS5 vs mmap postings vs tantivy | **ADD SQLite (FTS5 + keyed table), with ranking guards** | Fresh-process open 1.4–2.5 ms; rare-term match 0.2–1.7 ms; keyed lookup at 1M rows 0.7–2.3 ms [measured]. **But** `ORDER BY bm25()` on a term with df≈700k took **1.6–2.1 s** [measured]. Never rank a fat posting. |
| 6 | Keyed live table `(scope,s,p)` | **KEEP (as planned) + history table** | Point lookup 0.7 ms at 1M live rows [measured]. Keep superseded rows in a history table, not deleted. |
| 7 | Last-write-wins | **CHANGE → LWW read rule over bitemporal-lite rows** | Never overwrite. `valid_from` / `invalid_at` / monotonic `seq`. Today spawn-LWW is file order because `at` is stripped. |
| 8 | Process-per-hook | **KEEP** | Bun hello p50 20–23 ms, Node 57 ms [measured]. Open+2 queries in a fresh Bun process p50 24 ms [measured]. Hook timeout for UserPromptSubmit is 30 s [doc]. Add an internal budget, fail silent. |
| 9 | Packet 6 bullets / 900 chars | **KEEP + ADD a session budget** | Context-rot and distractor evidence supports small. The real cost is **accumulation**: hook text stays in the transcript every turn. |
| 10 | Prompt-cache interaction | **KEEP placement (no action), ADD dedup** | Hook context lands next to the newest prompt [doc], after all cache breakpoints. Varying text costs ~225 uncached tokens once, then is cached. It does not invalidate the prefix. |
| 11 | "Already in context" suppression | **ADD (new)** | Session injected-ledger + transcript-tail containment check + CLAUDE.md/MEMORY.md shadow set. Reset on compaction. |
| 12 | Staleness | **ADD citation validation + decay for rank only** | Copilot Memory stores facts with code citations and validates them against the current branch before use [doc]. Eden can stat/grep citations in µs–ms. |
| 13 | Usage feedback | **ADD** | Stop hook: rare-token overlap between each injected bullet and the assistant response + tool calls → `used` / `ignored` / `contradicted`. Feeds rank and suppression. |
| 14 | Never-restate | **ADD restatement-as-miss + correction capture** | A user re-asserting a live `(scope,s,p,o)` is a logged miss. The miss is classified (not injected vs injected-but-ignored). Sleep writes the cue tokens as aliases. |
| 15 | Sleep / consolidation | **KEEP** | Matches Letta sleep-time compute, LightMem, MemOS "fast memorize". Contradiction checks with an LLM or NLI are allowed here. |

---

## 1. Local measurements (2026-09-29, Apple M3, Bun 1.3.13)

**Fixture.** 1,000,000 synthetic episodes (8–28 words each from a 26-word vocabulary, plus a unique `opNNNNNNN` id and one of 50k `fNNNN.ts` paths). Stored in an FTS5 external-content table (`tokenize="unicode61 tokenchars '._'"`). Alongside it, 1,000,000 live facts in `live(scope,s,p,o,valid_from,invalid_at, PRIMARY KEY(scope,s,p)) WITHOUT ROWID`. DB 212 MB after `optimize`. Numbers are single runs unless a p50/p95 is shown, which comes from 30 spawns.

**Build and write**

| What | Result |
|---|---|
| Build 1M episodes + FTS rows (one transaction) | 6.8 s |
| Build 1M live facts | 2.7 s |
| FTS `optimize` | 0.8 s |
| JSONL, 100k rows / 18.7 MB: read | 19 ms |
| JSONL: `JSON.parse` per line | 70 ms (**268 MB/s**) |
| JSONL: whole-file rewrite | 37 ms |
| Append one line + `fsync` (not `F_FULLFSYNC`) | **0.30 ms** |

**Process startup**

| What | Result |
|---|---|
| `bun hello.js` spawn | p50 **20–23 ms**, p95 23–49 ms |
| `node hello.js` spawn | p50 **57 ms** |
| Fresh `bun` process: open DB + keyed lookup + FTS rare match + AND match | p50 **24.2 ms**, p95 28.8 ms |

**Per-query cost inside that fresh process**

| Query | Cold | Warm |
|---|---|---|
| `new Database(readonly)` | 1.4–2.5 ms | — |
| Keyed `live WHERE scope=? AND s=?` (1M rows), incl. prepare | 0.7–2.3 ms | — |
| FTS rare token (`"op0424242"`, df=1) join + `bm25` LIMIT 64 | 1.2–1.7 ms | **0.19–0.25 ms** |

**Ranking cost vs document frequency (the key finding)**

| Term df | `ORDER BY bm25() LIMIT 64` | `ORDER BY rowid DESC LIMIT 64` |
|---|---|---|
| 1,880 | 6.0–6.5 ms | 0.03–0.09 ms |
| 5,639 | 22 ms | 0.13 ms |
| ~682k–712k | **1,645–2,072 ms** | 0.11–0.29 ms |
| 4-term AND of common terms | 34 ms | — |

**Reading the numbers**

1. **Speed is not the problem at 10⁶ with SQLite**, provided no query ranks a fat posting list. FTS5 `bm25()` ranking is O(df), about **3–4 µs per posting** [measured]. A single common word in the cue turns a 25 ms hook into a 2 s hook. The current `df≥80` rule exists to dodge exactly this; the fix is to bound the candidate set, not to stop early (§2.2).
2. **Process spawn dominates.** The Bun runtime alone is ~20 ms. Everything Eden does on top at 10⁶ rows is ~2–5 ms if guarded. The doc's "do not optimize 50 ms → 1 ms" is right. What matters is the tail: a fat-term rank (seconds) is the risk, not the median.
3. **Whole-file JSONL rewrite scales with store size; append does not.** 37 ms per 18.7 MB rewrite versus 0.3 ms per append. At the long-horizon 5-year arm (1.06 MB) this is invisible. At 10⁶ rows (~200 MB) a rewrite per turn is ~0.4 s plus the parse on reload (~0.75 s at 268 MB/s). The spawn-parse design stops working somewhere around 10⁵ rows.

---

## 2. Choice-by-choice

### 2.1 No embeddings on the Submit hot path — **KEEP, re-justify**

**The lock is still right in 2026, but the doc's stated reason ("148 ms class") is stale.**

- Mem0's 148 ms p50 search [arXiv:2504.19413] is a networked vector DB plus an OpenAI embedding call. It is not the cost of a local embedding. [verified 2026-09-29: Table 2, Mem0 search p50 0.148 s / p95 0.200 s; total p50 0.708 s / p95 1.440 s; embeddings `text-embedding-small-3`]
- **Static embeddings** (Model2Vec `potion-base-8M` / `potion-retrieval-32M`, MinishLab 2024–25; Sentence-Transformers `static-retrieval-mrl-en-v1`, Jan 2025) encode a query as a token-embedding lookup plus mean pool. That is microseconds per query on CPU.
  - Their authors report 100–400× faster on CPU than all-mpnet-base-v2 / multilingual-e5-small "while reaching at least 85% of their performance" (Sentence-Transformers blog, 15 Jan 2025); Model2Vec's README claims "up to 500 times faster on CPU than the original model", "with a small drop in performance". [verified 2026-09-29]
- **int8 ONNX all-MiniLM-L6-v2** encodes a short query in the low-single-digit ms on a modern CPU. *unverified*
  - In a fresh process the cost is **loading the runtime and weights** (onnxruntime-node / transformers.js), typically **100–300 ms cold**. *unverified*
  - That alone is 5–15× Eden's whole hook budget.
- Static embeddings avoid the runtime (a 30–60 MB `safetensors` matrix can be mmapped), so load could be single-digit ms. *unverified; measure before claiming.*

**So in 2026 a local query embedding on Submit is feasible in ~5–10 ms.** The reasons to keep the lock anyway are correctness reasons.

1. **Silence contract.** Cosine top-k always returns k items. Eden's best property is an empty packet on `got it` / `2+2` / off-topic cues (5-year junk still silent, §9 of EDEN-MEMORY). Dense scoring needs a threshold, and calibrated thresholds are notoriously unstable across queries. Hindsight uses a cosine floor of 0.3 plus a keyword arm (see SOTA report §2). A lexical "no shared rare token → silence" rule is exact.
2. **Identifier cues.** Coding cues are dominated by paths, symbols, ids, error codes and versions (`op00042`, `auth.ts`, `ERR_REQUIRE_ESM`). BM25 is a strong zero-shot baseline on BEIR (Thakur et al. 2021, arXiv:2104.08663: BM25 beat most dense retrievers out of domain). SWE-bench's own retrieval baseline is BM25 (arXiv:2310.06770). Dense models tokenize ids into sub-word soup. [verified 2026-09-29: BEIR abstract, "BM25 is a robust baseline … dense and sparse-retrieval models … often underperform"; SWE-bench uses "BM25 retrieval … to retrieve relevant files"; per-dataset numbers not re-quoted]
3. **Distractor harm is worse for near-misses.** "The Power of Noise" (arXiv:2401.14887) finds *related-but-irrelevant* passages hurt RAG accuracy more than random ones. Dense retrieval is precisely a generator of related-but-irrelevant neighbors. [verified 2026-09-29: "highest-scoring documents that are not directly relevant … negatively impact" the LLM, while "adding random documents … improves the LLM accuracy by up to 35%"]
4. **Determinism and testability.** The long-horizon exam asserts exact packet contents. A lexical path keeps the tests exact.

**Recommendation.**
- Keep the lock, but rewrite its justification in EDEN-MEMORY §1 as *"silence + identifiers + determinism"*, not latency.
- Get the semantic recall that embeddings would give through **§2.3 document expansion at sleep**.
- Re-open this only if the miss ledger (§2.14) shows more than ~10% of misses are *paraphrase* misses that aliases failed to fix.

### 2.2 Lexical rare-token retrieval — **KEEP rare-first, CHANGE candidate generation and ranking**

**What is wrong today** (EDEN-MEMORY §6):
- Posting union stops at `df≥80`.
- The first 36 hits are in **file order**.
- A 12-needle drop discards rows.
- At 10k rows × 5 years the index missed Auth that had just been written.

This is a candidate-generation bug, not a lexical-vs-dense problem.

**Fix (concrete).**

1. **Filter by scope first.** Cue scope plus ancestor pins. Copulas use exact scope.
2. **Keyed layer.** If the cue parses a subject (`auth`, `db`, `database`, `package manager`), do a point lookup in `live(scope,s,*)`. No scoring.
3. **Bounded candidate set C** (target |C| ≤ 64–200). For each cue term t (len ≥ 3, not a stopword), rarest first:
   - `df(t) ≤ D_rank` (e.g. 2,000): add all postings.
   - `df(t) > D_rank`: add only the **newest 64** postings (`ORDER BY rowid DESC LIMIT 64`, 0.1–0.3 ms at df=700k [measured]), **or** intersect with the next-rarer term (`t AND u`). Never rank the whole list.
   - Stop when |C| ≥ 200 or terms are exhausted.
4. **Score C in JS with BM25** (Robertson & Zaragoza 2009), k1 = 1.2, b = 0.75:
   `score(d,q) = Σ_{t∈q} IDF(t) · tf(t,d)·(k1+1) / (tf(t,d) + k1·(1 − b + b·|d|/avgdl))`, with `IDF(t) = ln(1 + (N − df + 0.5)/(df + 0.5))`.
   - For short rows use **BM25F**-style field weights: object/value ×3, subject ×2, aliases ×1.5, body ×1. That lets `auth = Clerk` beat an episode that merely mentions auth.
   - Then apply the kind prior (constraint / procedure / fact / episode) and the decay prior (§2.12).
5. **Silence gate.** Emit nothing unless the top candidate has either a keyed hit, or ≥1 matched term with `df ≤ D_rare` (e.g. ≤ 50) or ≥ 2 matched content terms. That keeps "dump-all is a miss".
6. **Drop the 12-needle rule** for facts, procedures and pins; keep it for episodes only (already P3).

**Why BM25 and not raw overlap count.** Today's rank is `n` then Σ 1/df. BM25 saturates tf and normalizes length, so one long diary line that mentions `auth` five times cannot outrank the short copula. Cost: C ≤ 200 rows × ≤ 10 terms is microseconds.

### 2.3 Vectors only in sleep — **KEEP, ADD document-side expansion**

**Idea.** Put all "semantic" work on the **document side at write/sleep time**, so the query side stays a tokenizer.

This is the logic of:
- **inference-free learned sparse retrieval**: OpenSearch `neural-sparse-encoding-doc-*` models expand documents offline, and the query side is "just … a tokenizer and a weight look-up table", so query cost is BM25-class (our inference). [verified 2026-09-29: HF model card `opensearch-neural-sparse-encoding-doc-v3-distill`]
- **doc2query / docTTTTTquery** (Nogueira et al. 2019).

**Recommended sleep pass (per new or changed row):**
1. Generate ≤ 8 alias tokens by one of:
   - (a) a small LLM prompt: *"list the words a developer would type when they need this fact"*;
   - (b) nearest neighbours in a static-embedding vocabulary, restricted to tokens that occur in the user's own past cues (keeps it grounded);
   - (c) co-occurrence mining from the miss ledger (§2.14: the cue that should have fetched the row).
2. Store the aliases on the row in a separate `aliases` field, weighted 1.5 in BM25F.
3. Cap aliases per row and require each alias to have `df ≤ D_rank` in the store, so expansion cannot create fat postings.

**Why not query-side expansion.** Already locked out as "cue-time synonym explosion". It grows the haystack per query and cannot learn from misses.

### 2.4 JSONL whole-file load + rewrite — **CHANGE**

| Store | Now | Change to |
|---|---|---|
| Episodes | `memories.jsonl`, lock + full rewrite, cap 2000 deletes | **Append-only** segment files (`episodes-000123.jsonl`), roll at ~8 MB. Never rewritten. Tombstones are separate append records |
| Live facts | JSONL + `semantic.jsonl` | Keyed table (§2.6). Until P5b, a small `live.jsonl` compacted at sleep (hundreds–thousands of rows is fine to rewrite) |
| Index | Rebuilt `Map` every Submit | Until ~10⁵ rows: in-memory rebuild is OK (~70 ms parse per 18.7 MB [measured]). Beyond that: SQLite FTS5 (§2.5) written by observe/sleep |

**LSM framing** (O'Neil et al. 1996):
- The append log is the memtable flush.
- Sleep is compaction: merge tombstones, rebuild postings, drop superseded rows **from the index, not from disk**.
- Write amplification ≈ 1 for episodes.

**Crash safety.**
- Appends are atomic enough for single-line JSON under `O_APPEND` for lines below the pipe/page size. *unverified for APFS; treat as best-effort.*
- A torn last line must be skipped on load, not throw. It already fails open; make that explicit in `load()`.
- For compaction, write to `*.tmp`, `fsync`, then `rename` (atomic on POSIX).
- On macOS, `fsync` does not flush the drive cache; `F_FULLFSYNC` does, and is ~10× slower. *unverified magnitude.* A memory store can accept `fsync`.

### 2.5 SQLite FTS5 vs custom mmap postings vs tantivy — **ADD SQLite; reject tantivy; mmap only if SQLite fails**

**SQLite (via `bun:sqlite`)**
- Built into Bun, so zero dependencies.
- One file; WAL mode allows concurrent readers during a writer.
- Keyed table and FTS5 in one transaction.
- Measured open 1.4–2.5 ms and rare-term match 0.2–1.7 ms in a fresh process.

**FTS5 settings to use** (SQLite FTS5 docs, sqlite.org/fts5.html):
- `content='ep', content_rowid='id'` — external content, so text is stored once.
- `tokenize="unicode61 tokenchars '._-/'"` — keep `auth.ts`, `apps/web`, `ERR_X` whole. Consider a second `trigram` table **only** for substring search on ids; it is ~3× larger. *unverified ratio*
- `detail=column` or `detail=none` if phrase queries are not needed. That shrinks the index substantially.
- **Scope as a token.** Prepend `§apps_web` to each row's indexed text, or keep one FTS table per product scope. `MATCH '§apps_web AND auth'` then intersects postings instead of filtering afterwards.
- `INSERT INTO ep_fts(ep_fts) VALUES('optimize')` at sleep (0.8 s at 1M [measured]); `'merge'` for incremental work.
- **Never** `ORDER BY bm25()` on an unbounded MATCH. Use the bounded C from §2.2 and score in JS, or put a `df` guard first (FTS5 `fts5vocab` gives df cheaply).

**Tantivy**
- Rust/Lucene-class, very fast.
- No first-party Bun binding: a native addon or subprocess. More moving parts than SQLite for no gain at the sizes that matter (10⁶ rows, top-64). *unverified that no maintained Bun binding exists.*

**Custom mmap postings**
- Viable (varint-delta posting lists, a sorted term dictionary, `Bun.mmap`).
- But Eden would own compaction, crash recovery and concurrency. Only build it if SQLite shows a measured failure.

### 2.6 Keyed live table `(scope, s, p)` — **KEEP as planned + history**

```sql
CREATE TABLE live(scope TEXT, s TEXT, p TEXT, o TEXT, seq INTEGER, valid_from INTEGER,
                  src TEXT, cite TEXT, PRIMARY KEY(scope,s,p)) WITHOUT ROWID;
CREATE TABLE fact_hist(scope TEXT, s TEXT, p TEXT, o TEXT, seq INTEGER, valid_from INTEGER,
                  invalid_at INTEGER, superseded_by INTEGER, src TEXT);
```

- **Update.** Move the old row to `fact_hist` with `invalid_at = now`, then upsert `live`. Two statements, one transaction.
- **Lookup.** 0.7–2.3 ms at 1M rows [measured], mostly prepare cost.
- **What this buys.**
  - Zep/Graphiti-style *knowledge-update* answers ("what did we use before Clerk?") from `fact_hist`.
  - Retrieve only ever sees `live`.
- **Predicate normalization matters more than storage.** `auth is Clerk` / `we use Clerk for auth` / `auth provider: Clerk` must all map to `(apps/web, auth, provider)`. That needs a closed predicate vocabulary, as Cognee's schema-constrained relations suggest: `provider`, `version`, `command`, `package_manager`, `port`, `path`, `convention`, `forbidden`. Anything else is stored as an episode, not a copula.

### 2.7 Last-write-wins — **CHANGE to "LWW read rule over bitemporal-lite rows"**

**Graphiti/Zep** (arXiv:2501.13956, Jan 2025):
- Every edge carries **four timestamps**: `t_valid` / `t_invalid` (world time) and `t'_created` / `t'_expired` (system time).
- When a new edge contradicts an existing one (LLM-judged, over semantically related edges), the old edge's `t_invalid` is set to the new edge's `t_valid`. Nothing is deleted.
- Zep's LongMemEval gains are largest on *single-session-preference*, *temporal-reasoning* and *multi-session*; *knowledge-update* moved little (+6.5% relative with gpt-4o, 78.2→83.3; −3.4% with gpt-4o-mini, 76.9→74.4). [corrected 2026-09-29, Zep paper Table 3; the earlier text said knowledge-update was among the largest gains]
- Zhou et al. 2026 (arXiv:2606.24775, cited in SOTA report) find Zep, which they class as timestamp-based multi-versioning with logical invalidation, "leads Knowledge Update with 44.4 Substring EM" (Table 2). The authors credit graph/relation-organized memory rather than invalidation as such. [verified 2026-09-29]

**Eden keeps LWW as the read rule** (newest valid row per key). It adopts:
1. **Monotonic `seq`**, a per-store counter incremented on every write, as the tiebreak instead of wall clock. Today spawn-reload LWW is file order because `at` is stripped on persist (EDEN-MEMORY §6.7). This fixes it.
2. **`valid_from` distinct from `seq`** when the user states a time ("we switched to Clerk last week"). Rule-parsed at sleep; default `valid_from = seq time`.
3. **`invalid_at`, never delete.**
4. **Conservative key match** (already in SOTA report P0.13): same `(scope,s,p)` or it is not an update. Near-miss keys (e.g. `auth.provider` vs `auth.library`) go to sleep for an LLM/NLI "same slot?" judgment. They are never merged on the hot path.
5. **Explicit negation.** "we no longer use Redis" sets `invalid_at` with no successor. The read returns nothing for that slot rather than the stale value. *This is the silent failure mode of pure LWW.*

### 2.8 Process-per-hook — **KEEP, add an internal budget**

**What the docs say** (code.claude.com/docs/en/hooks, fetched 2026-09-29) [doc]:
- UserPromptSubmit fires on every prompt, with no matcher.
- The default hook timeout is 600 s, but it is **lowered to 30 s for UserPromptSubmit**.
- Plain stdout, or JSON `hookSpecificOutput.additionalContext`, is added as context.
- Since v2.1.248, stdout that Claude Code tries to parse as JSON (it starts with `{` **and ends with `}`**) but cannot parse is **not added as context** and shows a hook-error notice. Output that starts with `{` but does not end with `}` is treated as plain text. [corrected 2026-09-29 against the hooks doc] Eden must never print half-JSON.
- The output cap is **10,000 characters**. Above it, output is replaced by a file path plus a 2,000-character preview. Eden's 900 is safe.

**Measured** [measured]:
- Bun runtime floor ~20 ms (Node ~57 ms).
- Open SQLite + 2 queries: 24 ms p50.
- EDEN-MEMORY §9 reports 11–50 ms today.

**Recommendation.**
- Keep a fresh process; it is what makes fail-open trivial.
- Add a **hard internal budget** (e.g. 150 ms wall from process start). If exceeded, print nothing and exit 0. This protects against the fat-posting 2 s tail (§1).
- `bun build --compile` produces a single binary. Its startup is roughly Bun's own. *unverified whether it beats `bun file.ts` materially.* Worth a 5-minute measurement; not a slice.
- **Do not** add a daemon: it breaks fail-open semantics and the doc says speed is not a slice.

### 2.9 Packet size 6 bullets / 900 chars — **KEEP; ADD a session-level budget**

**Evidence that small is right:**
- **Chroma "Context Rot"** (Hong, Troynikov, Huber, 14 July 2025, research.trychroma.com/context-rot). 18 models; performance degrades as input length grows even on trivial tasks. Degradation is worse when needle–question similarity is lower and when **distractors** are present. Counter-intuitively, logically shuffled haystacks hurt *less* than coherent ones. [verified 2026-09-29: "we evaluate 18 LLMs"; "Shuffling the haystack and removing local coherence consistently improves performance"; "Even a single distractor reduces performance"]
- **Lost in the Middle** (Liu et al., arXiv:2307.03172, TACL 2024). U-shaped accuracy over position. In 20- and 30-document multi-doc QA, GPT-3.5-Turbo with the answer in the middle fell *below its closed-book accuracy* (56.1%). [verified 2026-09-29, Table 1 and §2.3]
- **GSM-IC** (Shi et al., arXiv:2302.00093, ICML 2023). Adding one irrelevant sentence to math problems drops accuracy sharply. Instructing the model to ignore irrelevant information partly recovers it.
- **"Context Length Alone Hurts LLM Performance Despite Perfect Retrieval"** (arXiv:2510.05381, Findings of EMNLP 2025). Accuracy falls as input grows even when irrelevant tokens are whitespace or masked. [verified 2026-09-29: 5 LLMs, performance "degrades substantially (13.9%–85%)"]
- **NoLiMa** (arXiv:2502.05167, ICML 2025). With minimal lexical overlap between needle and question, most models fall below 50% of their short-context score by 32K tokens. [verified 2026-09-29: "At 32K … 11 models drop below 50% of their strong short-length baselines" (13 evaluated)]
- **Experience-following** (Xiong et al., arXiv:2505.16067, 2025). Agents copy retrieved past experiences whose inputs look similar. Bad records **propagate errors** and misaligned records are replayed. Selective add plus deletion of low-quality records improved results. [verified 2026-09-29: gains are modest and evaluator-dependent, e.g. EHRAgent 38.7→42.1 with a strict evaluator plus history-based deletion; some agent/deletion combinations lose accuracy (Table 2)] This is direct evidence that an *irrelevant or wrong* injected memory actively harms an agent, not just wastes tokens.

**Where the doc is incomplete.**
- 900 chars ≈ **~225 tokens per turn**.
- Hook context is **persisted in the transcript**: "Claude Code wraps the string in a system reminder and inserts it into the conversation at the point where the hook fired"; on resume it "replays the saved text" [doc].
- So a 300-turn session that injects every turn carries **~67k tokens of Eden text**, mostly the *same* facts repeated.
- That accumulation, not the per-turn size, is what drives context rot and earlier compaction.

**Recommendation.**
1. Keep 6 × 900 per turn.
2. Add a **per-session novelty rule** (§3). Most turns should inject 0–2 bullets.
3. Add a **session budget** (e.g. 6k tokens of Eden text between compactions). After it is spent, only (a) facts whose `seq` changed since last injected, or (b) pins relevant to a newly opened scope.
4. Consider **one line per fact** without provenance brackets when the bullet repeats a kind already shown this session. Every byte of `[fact · 0m · user]` is spent 300 times.

### 2.10 Prompt caching — **no action needed on placement; the lever is dedup**

**Anthropic prompt caching** (platform.claude.com/docs/en/build-with-claude/prompt-caching, fetched 2026-09-29) [doc]:
- The prefix order is tools → system → messages. "Changes at each level invalidate that level and all subsequent levels."
- Up to 4 breakpoints; the lookback window is 20 blocks.
- TTL is 5 min (refreshed on use), or 1 h optional.
- Cache write costs 1.25× (5 min) or 2× (1 h) base input; read costs 0.1× (0.05× on Opus 5.5).
- Minimum cacheable length is 512–4,096 tokens depending on model.

**Implication (inference, not stated in the docs):**
- The UserPromptSubmit context sits alongside the *newest* prompt [doc], which is after every earlier breakpoint.
- Varying Eden text each turn therefore does **not** invalidate the cached conversation prefix.
- Each packet is paid once as uncached / cache-write input (~225 tokens), then read at 0.05–0.1× on every later turn while cached.
- **Dollar cost is negligible. The cost is context length (§2.9).** Where Claude Code places its own `cache_control` breakpoints is not documented — *unverified*.

**Exception: Eden's own wrap path.** `packages/wrap/src/know-inject.ts:120-123` appends the packet to `system`, and the OpenAI-shaped `inject` splices it before the first non-system message (`src/index.ts:336`). Both sit *before* the message history, so a changed packet invalidates the cached conversation. Fix: A4 §5.1 / ROADMAP P3.6. The "no action" verdict above applies only to the Claude Code hook.

**One more thing that *would* hurt caching:** writing to CLAUDE.md or auto-memory `MEMORY.md` mid-session. If those are re-read into the system/early-message region, the whole prefix is invalidated. *Whether Claude Code reloads them mid-session is unverified.* Eden should write to its own store, not to CLAUDE.md, during a session. Promotion to CLAUDE.md (if ever) is a between-sessions, user-approved action.

### 2.11 Compaction — **ADD reset hooks**

**Claude Code hooks for compaction** [doc]:
- `PreCompact` (matcher `manual` / `auto`; can block with exit 2)
- `PostCompact`
- `SessionStart` with source `compact`

**Behavior:** after compaction, earlier injected packets survive only as whatever the summary kept.

**Recommendation:**
- On `SessionStart(source=compact)`, **clear the session injected-ledger (§3)** so facts can be re-injected when cued.
- Optionally emit a ≤ 400-char "pins for current scope" block once. Pins are the one class that should survive compaction verbatim.

### 2.12 Staleness — **ADD citation validation; ADD decay for rank only**

**(a) Citation validation (the strongest 2025–26 idea for coding memory).**

GitHub Copilot Memory (docs.github.com/en/copilot/concepts/agents/copilot-memory, fetched 2026-09-29) [doc]:
- "Repository-level facts are stored with citations pointing to the code that supports them."
- Before use, Copilot "checks those citations against the current branch to confirm the information is still accurate… Only validated facts are used."
- "Any stored fact or preference that goes unused is automatically deleted after 28 days", and "the 28-day timer may reset whenever Copilot successfully validates and uses an entry". [verified 2026-09-29]
- Facts learned from unmerged PRs affect behavior only "if the current codebase still substantiates the information."

Copilot validates with an LLM agent. **Eden can do a cheap, deterministic subset on Submit:**

| Fact type | Citation stored at write/sleep | Submit-time check (µs–ms) | On fail |
|---|---|---|---|
| Path fact (`tests live in tests/auth`) | the path | `existsSync(path)` | Skip; queue for sleep invalidation |
| Dependency fact (`auth provider = Clerk`) | `package.json` key `@clerk/nextjs` + file mtime | `mtime` changed? → re-read the one key | Key gone → skip + invalidate at sleep |
| Command fact (`test: pnpm test -- auth`) | `package.json` `scripts.test` hash | same | Hash changed → mark `[check]` or skip |
| Version fact (`node 20`) | `.nvmrc` / `engines` | same | Mismatch → skip |
| Convention / preference (no file) | user quote + turn id | none | Decays only by §2.12b / supersession |

- Cap validation at ~6 stats per Submit.
- A skipped fact is a **staleness catch**, logged to `miss.jsonl` as class `stale`.
- This directly serves goal 2 ("stale memories never drag the agent down") without an LLM on the hot path.

**(b) Decay: rank prior, never deletion** (EDEN-MEMORY: "Rank may decay with heat/age. Deletion does not").

Use ACT-R base-level activation (Anderson & Lebiere 1998; Anderson & Schooler 1991):

`B_i = ln( Σ_{j=1..n} t_j^{−d} )`, with d = 0.5, where t_j is the time since the j-th *use* of item i.

To avoid storing every use, apply the standard approximation (Anderson & Lebiere 1998; Petrov 2006 hybrid) with n uses and lifetime L:

`B_i ≈ ln( n / (1 − d) ) − d · ln(L)`

Petrov's hybrid keeps the k = 1–3 most recent uses exactly and approximates the rest:

`B ≈ ln( Σ_{j=1..k} t_j^{−d} + (n−k)(t_n^{1−d} − t_k^{1−d}) / ((1−d)(t_n − t_k)) )`

- Store per row: `n_used`, `first_seen`, `last_used[≤3]`.
- Final score: `score = BM25F + w_kind + w_act · B_i`.
- Apply it to **episodes and procedures only**. A live copula's truth is decided by validity (§2.7) and citations (§2.12a), not by how recently it was used. Auth = Clerk does not become less true because nobody asked for three months.

**Alternatives seen in the literature:**
- **Generative Agents** (Park et al., arXiv:2304.03442): `score = α_rec·recency + α_imp·importance + α_rel·relevance`, all α = 1, min-max normalized; recency = 0.995^{hours since last access}.
- **MemoryBank** (arXiv:2305.10250): Ebbinghaus retention `R = e^{−t/S}`, with strength S incremented on each recall.
- **MemoryOS** (EMNLP 2025): "heat" = frequency × recency decay, used for mid-term → long-term promotion.

ACT-R is preferred because its "use" events are exactly what §2.13 produces, and its power law matches the retention curve better than exponential decay (Anderson & Schooler 1991).

**(c) Contradiction detection without an LLM on the hot path.**

- **Hot path:** slot collision only, i.e. same `(scope,s,p)` with a different `o` → supersede (§2.7).
- **Sleep (LLM / NLI allowed):**
  1. Candidate pairs = facts sharing a subject token within a scope, or episodes that mention a live fact's subject after its `valid_from`.
  2. Judge with a small NLI cross-encoder (DeBERTa-v3 MNLI class, ~10–30 ms per pair on CPU; *unverified*) or one batched LLM call.
  3. Contradiction → `invalid_at`. This is what Graphiti does at write time with an LLM; Eden defers it to sleep.
- **Signal for which facts to check first:** a failing command that a fact recommended (non-zero exit on `pnpm test -- auth` after injecting it). That is the Cognee "memify / improve from feedback" idea (docs.cognee.ai; not in arXiv:2505.24478, which only covers Cognee hyperparameter tuning [corrected 2026-09-29]) in code.

### 2.13 Usage feedback — **ADD**

**Mechanism (Stop / PostToolUse hooks, already wired for observe):**

1. On inject, write `injected.jsonl` records `{session, turn, fact_id, seq, rare_tokens[]}`, where `rare_tokens` are the bullet's value tokens with `df ≤ D_rare` (e.g. `Clerk`, `tests/auth/session.test.ts`, `pnpm`).
2. On Stop for that turn, scan the assistant text and tool-call inputs of the turn. Assign each injected bullet one label:
   - **used**: ≥ 1 rare token appears in a tool input (file path opened, command run) or ≥ 2 in the reply.
   - **ignored**: no overlap.
   - **contradicted**: the agent or user asserts a different `o` for the same slot this turn, or a command from the bullet exits non-zero.
3. **Effects:**
   - `used` → ACT-R use event (§2.12b); resets the Copilot-style 28-day clock.
   - `ignored` ×3 in a row for the same cue class → demote.
   - `contradicted` → sleep priority invalidation check.

This is token-overlap attribution, the cheap version of citation-based attribution. It is noisy for common words, which is why only rare tokens count. *No published paper validates this exact heuristic for agent memory; treat thresholds as tunable.* Copilot's "reset timer when successfully validates and uses" is the closest product precedent [doc].

### 2.14 "Never restate" — **ADD restatement-as-miss, correction capture, write-time policy**

**(a) Restatement is the product's primary miss signal.**

On observe, when a user turn yields a copula `(scope,s,p,o)` that is **already live with the same `o`**, or a normalized near-duplicate of a pin, the user just restated something Eden knew. Near-duplicate means token-set Jaccard ≥ 0.8 on content tokens; MinHash with 128 permutations and LSH bands is only needed at 10⁵+ pins (Broder 1997).

Log a `restate` miss with a class:

| Class | Test | Sleep action |
|---|---|---|
| `not_retrieved` | Fact not in any packet in the last N turns | Add this turn's cue content tokens as **aliases** on the fact row (§2.3c). This is the learning loop: the next time the user phrases it this way, it fires |
| `retrieved_ignored` | Fact was injected this session and labelled `ignored` (§2.13) | Salience problem. Promote to rule wording (`[rule] use pnpm, not npm`), move to the top of the pack order, or promote to pin |
| `scope_miss` | Fact is live in a **sibling / other** scope | Candidate for a parent-scope or pin. Ask nothing; at sleep, if the same fact appears in ≥ 2 sibling scopes, write it at the common ancestor with inherit on |
| `expired` | Fact had been invalidated / skipped by a stale citation | Re-validate. The user's restatement is itself fresh evidence: set `valid_from = now` |

**Headline metric: restatement rate RR = restated live facts per 100 user turns.** Target → 0. PrefEval (Zhao et al., arXiv:2502.09597, ICLR 2025) is the closest public evidence that this matters. In zero-shot settings, frontier LLMs follow a preference stated earlier in the conversation poorly once 10 turns (~3k tokens) of intervening dialogue pass, with reported accuracy under 10% for most models. [verified 2026-09-29: "preference following accuracy falls below 10% at merely 10 turns (~3k tokens) across most evaluated models"] Without memory, users *must* restate. RR measures whether Eden fixed that.

**(b) Correction capture on observe (regex, no LLM).**

Corrections are the highest-value writes: the user is paying attention and has just seen the agent fail. Patterns, applied to the *user* turn only:

```
no[,.]?\s+(?:use|it's|it is|we use)\s+(X)\s*(?:,|\s)\s*(?:not|instead of)\s+(Y)
(?:don't|do not|never|stop)\s+(?:use|using|run|running|commit|touch)\s+(X)
(?:always|from now on|going forward)\s+(.+)
(?:actually|correction)[,:]?\s+(S)\s+(?:is|are|uses?)\s+(O)
(X)\s*,?\s+not\s+(Y)            # only if X,Y are both CONTENT_TERM / known-entity tokens
we (?:switched|moved|migrated) (?:from (Y) )?to (X)
```

Write rules:
- `(s, p, o=X)` with `src=user-correction`, `salience=high`, and `(s,p,o=Y)` explicitly invalidated.
- Imperative forms (`never`, `always`, `don't`) become **constraint** kind: inherited, never evicted.
- **Tool-grounded corrections at sleep:** `npm install` exits non-zero, then within 3 turns `pnpm install` exits 0 in the same scope → propose `(scope, package_manager, pnpm)` with citation `pnpm-lock.yaml`. A citation that exists → auto-accept.

**(c) What to write at all (write-time precision).** Converging product guidance (from model knowledge; *unverified* verbatim):
- Anthropic memory-tool guidance, Claude Code auto-memory topic files (`user_role.md`, `feedback_testing.md` per the fetched doc [doc]).
- Mem0's extraction prompt categories.
- Windsurf / Cursor memory criteria.
- Copilot's "repository facts" vs "user preferences" [doc].

Remember:
1. **Preferences** (tooling, style, tone, verbosity).
2. **Decisions** ("we're going with X because Y"), with the reason.
3. **Conventions** (paths, naming, test/verify commands, branch/commit rules).
4. **Corrections** (above).
5. **Environment facts** (versions, ports, services, credentials *location*, never values).
6. **Gotchas** (error signature → fix that passed).

Do **not** remember:
- Questions (already skipStore).
- Transient state ("now editing X").
- Anything derivable in one `grep` from the repo **unless** it is a decision about the repo.
- Secrets.
- Assistant speculation. Only user statements and tool-verified outcomes become facts.

Zhou et al. 2026 (via SOTA report) back the "write wide, filter late" stance: aggressive fine extraction destroyed exact-match (MemOS 25.5 → 2.5 EM). So the episode is always kept raw, and the copula is an index into it, not a replacement.

### 2.15 Sleep / consolidation — **KEEP**

- **Letta "sleep-time compute"** (Lin et al., arXiv:2504.13171, Apr 2025): pre-compute over context while idle so test-time work shrinks. Reported ~5× less test-time compute at equal accuracy on stateful GSM-Symbolic / AIME variants, and accuracy gains up to ~13–18% when scaling sleep compute. [verified 2026-09-29: "~ 5x"; "up to 13% on Stateful GSM-Symbolic and 18% on Stateful AIME"]
- **LightMem** (arXiv:2510.18866, ICLR 2026): the sleep-time update split is where its reported large token / API-call reductions come from. [verified 2026-09-29: total tokens cut up to 38× / 20.9× and API calls up to 30× / 55.5× (LongMemEval / LoCoMo)]
- **MemOS**: "fast memorize" on the hot path beats fine extraction.

Eden's split (regex observe on the hot path, consolidation at Stop / SessionEnd) is the same architecture.

**Add to sleep's job list** (from §2.3, §2.12, §2.14):
- alias expansion;
- NLI / LLM contradiction pass on candidate pairs;
- citation refresh;
- restatement-miss learning;
- tool-grounded corrections;
- FTS `optimize`.

Idle-5-min sleep does not fire in a short hook (EDEN-MEMORY §8). Run full sleep **detached** from the Stop hook (`spawn(..., {detached:true}).unref()`) so it never blocks the user.

---

## 3. Not re-injecting what is already in context — design

**Goal 3 has no off-the-shelf solution in any memory system reviewed.**
- Mem0, Zep, Letta and Hindsight all retrieve per query with no memory of what the conversation already contains.
- Hindsight's `strip_memory_tags` prevents *re-storing* injected text, not *re-injecting* it.
- ChatGPT injects a fixed profile / recent-chat block. *unverified (from model knowledge).*

The nearest literature is **MMR** (Carbonell & Goldstein, SIGIR 1998):

`MMR = argmax_{D_i ∈ R\S} [ λ·Sim1(D_i, Q) − (1−λ)·max_{D_j ∈ S} Sim2(D_i, D_j) ]`

Eden needs MMR where **S = everything already in the context window**, not just the current packet.

**Three cheap filters, applied after ranking and before packing:**

1. **Session injected-ledger.** `<root>/<session>/injected.json` = `{fact_id → seq_at_injection, turn}`.
   - Skip a candidate if `fact_id` is in the ledger **and** its `seq` is unchanged.
   - A changed fact (new `seq`) is exactly what *should* be re-injected. Label it `[updated]`.
   - Clear the ledger on `SessionStart(source=compact|clear)` (§2.11).
   - Cost: one small file read.
2. **Transcript-tail containment.**
   - Read the last ~64 KB of `transcript_path` (seek from the end; do **not** read the whole file — EDEN-MEMORY hygiene item).
   - Skip a candidate whose **value string** (`o`, path, or command) appears verbatim in the user or assistant text or tool outputs there.
   - If the agent just ran `pnpm test` or the user just said "Clerk", the fact is in context.
   - Cost: substring search over 64 KB, well under 1 ms.
3. **Static-context shadow set.**
   - At sleep, hash normalized lines of CLAUDE.md (all levels in scope), `.claude/rules/*`, `AGENTS.md`, and Claude Code auto-memory `MEMORY.md` [doc: auto memory at `~/.claude/projects/<project>/memory/`, `MEMORY.md` index "loaded into every session"].
   - Skip any fact whose normalized `s p o` or rule text is in the set.
   - That text is already in the system prompt of every turn, so injecting it duplicates tokens and adds a competing phrasing.

**Within the packet:** a cheap MMR with Sim2 = token-set Jaccard. Drop a candidate whose Jaccard with an already-packed bullet exceeds 0.6. Already implicit for copulas via one-per-`(scope,s,p)`; needed for episodes.

**Expected effect:** most turns in a focused session inject **0 bullets** after the first mention of each fact. Tokens fall roughly in proportion to fact reuse per session, and context-rot exposure falls with them. *Not yet measured; add to the long-horizon runner (§6).*

---

## 4. Competitor matrix

Legend:
- **LLM-W** = LLM on write.
- **Hot path** = what runs per user turn before the model sees the prompt.
- **U** = unverified (from model knowledge). **V** = verified against the primary source on 2026-09-29 (see `research/R4-citation-audit.md`).

| System (source, date) | Write | Update / conflict | Retrieve (hot path) | Forget | Inject style | Take for Eden |
|---|---|---|---|---|---|---|
| **Eden (today)** | Regex copula + raw episode; sleep consolidates | Global `(s,p)` LWW, file-order after reload | Rare-token union, `df≥80` stop, kind boost | Cap 2000 deletes unpinned (bug) | Silent hook, ≤6 / 900 B, empty = silence | — |
| **Mem0** (arXiv:2504.19413, Apr 2025) | LLM-W extract → ADD / UPDATE / DELETE / NOOP vs top-s similar memories | LLM decides; DELETE removes | Vector search; search p50 0.148 s, total p95 1.440 s (paper Table 2) V | LLM DELETE | Returned to app | NOOP as first-class; typed ops at sleep |
| **Mem0ᵍ** (same) | + LLM entity/relation extract to graph | Conflicting edges marked invalid (soft) V | Vector + graph; ~2× tokens of Mem0 (3,616 vs 1,764) V | as above | as above | Little; +~2 pts judge (SOTA report) |
| **Zep / Graphiti** (arXiv:2501.13956, Jan 2025) | LLM-W entity + edge extract, episode kept | **Bitemporal** `t_valid / t_invalid / t'_created / t'_expired`; LLM contradiction → invalidate | Hybrid cosine + BM25 + BFS; rerank RRF / MMR / node-distance / cross-encoder; LME latency 2.58 s vs 28.9 s full context (gpt-4o) V | Never deletes; invalidates | Context string to app | Invalidate-not-delete; `fact_hist` (§2.6–2.7) |
| **Letta / MemGPT** (arXiv:2310.08560, 2023; sleep-time arXiv:2504.13171, Apr 2025) | Agent edits core memory blocks via tools; sleep-time agent rewrites blocks async | Agent overwrites block text | Core blocks always in context; archival via tool call | Agent-driven | Always-in-prompt blocks | Sleep-time split (KEEP); not tools |
| **A-MEM** (arXiv:2502.12110, Feb 2025) | LLM-W Zettelkasten note (keywords, tags, context), links to neighbours, **evolves** neighbours | Rewrites neighbour notes | Embedding top-k + linked notes | none | to app | Keywords as a second lexical field (BM25F); no neighbour mutation |
| **MemOS** (arXiv:2507.03724, Jul 2025) | MemCube (plaintext / KV / LoRA) + scheduler | Versioned cubes (MemCube metadata incl. versioning) V | Scheduler-selected | Lifecycle policies U | to app | Fast memorize on hot path |
| **LightMem** (arXiv:2510.18866, Oct 2025) | Sensory compress → topic STM → **sleep-time** LTM update | Offline update | Embedding | Offline | to app | Online/offline split; token cuts up to 38× and API-call cuts up to 55.5× reported V |
| **Memory-R1** (arXiv:2508.19828, Aug 2025) | RL-trained manager: ADD / UPDATE / DELETE / NOOP | Learned | RAG + RL answer agent that distills memories | Learned DELETE | to app | NOOP; distil policies into rules |
| **MIRIX** (arXiv:2507.07957, Jul 2025) | 6 typed stores (core, episodic, semantic, procedural, resource, knowledge vault) + meta router, LLM-W | Per-store agents | "Active retrieval": LLM generates a topic then searches V | per store | Injected into system prompt V | Typed kinds (already have); router in code |
| **HippoRAG 2** (arXiv:2502.14802, Feb 2025) | Offline OpenIE triples + passage nodes | none (static corpus) | Query embedding → seed nodes → **Personalized PageRank** | — | passages | Passage nodes + associative index at sleep; PPR not on Submit |
| **Cognee** (docs.cognee.ai; arXiv:2505.24478 covers only cognify hyperparameter tuning, not memify/forget) | cognify: schema-constrained graph + vectors | memify feedback loop | graph + vector | `forget` op | tools / API | Closed predicate vocabulary; feedback → invalidation |
| **LangMem** (LangChain docs, 2025) | Hot-path tools **or** background memory manager (LLM); semantic / episodic / procedural; prompt optimizer | Manager consolidates / updates | Vector store search | Manager-driven | to app / tools | Procedural = prompt patch from outcomes (sleep) |
| **Hindsight** (arXiv:2512.12818, Dec 2025) | LLM retain → facts + `entities[]`, append-only | Read-time latest `mentioned_at` wins | 4 arms (semantic, BM25, graph, temporal) + RRF / interleave; Claude hook, 1024-token budget | none | `<hindsight_memories>`, empty → nothing | Empty = silence; strip own tags; entities beside fact |
| **Supermemory** (supermemory.ai, 2025–26) | Hosted ingest, LLM-W U | Versioned "memory updates" U | Hosted hybrid vector + keyword U | U | API / MCP / plugins | Lexical must work without vectors |
| **ChatGPT memory** (OpenAI, Feb 2024 saved; Apr 2025 chat history) | Model saves "memories"; plus chat-history reference | User edits / deletes | Reverse-engineering (2025): profile + recent-chat summaries injected into system prompt; no per-turn RAG over all history U | User-controlled | System-prompt block | A small always-on profile is cheap *because* it is static and cached |
| **Claude Code** (code.claude.com/docs, fetched 2026-09-29) | CLAUDE.md (human); **auto memory**: Claude writes `MEMORY.md` index + topic files per project | File edits | `MEMORY.md` "loaded into every session"; topic files read on demand [doc]; nested CLAUDE.md on demand [doc] V | Manual; `autoMemoryEnabled:false` | System prompt / files | Shadow set (§3); never write CLAUDE.md mid-session |
| **Anthropic memory tool** (`memory_20250818`, Sep 2025) + context editing | Model issues view / create / str_replace / … on client `/memories` | Model edits files | Model-initiated file reads | Model deletes | Tool results | Contrast: voluntary tool use ≈ rarely invoked (cue-anchored paper, below) V |
| **Cursor** (docs.cursor.com, 2025) | Rules `.cursor/rules/*.mdc` (`globs`, `alwaysApply`); Memories beta (sidecar-proposed, user-approved) later reportedly folded into rules U | manual | Always / auto-attached by glob / agent-requested | manual | Rules in prompt | **Glob-scoped rules = Eden scope + inherit** |
| **Windsurf Cascade** (docs.windsurf.com, 2025) | Auto-generated workspace memories + rules (always / manual / model-decision / glob) V | manual | Model-decision retrieval V | manual | prompt | Workspace scoping |
| **GitHub Copilot Memory** (docs.github.com, preview → 2026) | Agent deduces repo facts **with code citations**; user preferences with quotes | **Validate citations vs current branch before use**; only validated facts used | Agentic | **Unused 28 days → deleted**; reset on validated use | into agent context | **Citation validation (§2.12a)**; use-reset clock (rank, not delete) |
| **OpenAI Codex** (AGENTS.md, 2025) | Human `AGENTS.md`, hierarchical root→cwd, 32 KiB default cap (`project_doc_max_bytes`) V | manual | Concatenated into prompt | manual | prompt | Directory hierarchy = scope inheritance precedent |
| **Cue-anchored memory** (Saha, "Delivery, Not Storage", arXiv:2607.20972, Jul 2026; as cited in EDEN-MEMORY §11) | Harness-side triggers over {path, symbol, semantic, event, temporal} | — | Trigger match, harness delivers | — | Harness inject | Voluntary memory use: "0 memory operations in 114 turns" even with a pre-seeded store → delivery must be automatic. V (abstract re-fetched 2026-09-29) |

**Pattern across the matrix.**
- Every system that scores well on knowledge-update keeps history and invalidates (Zep, Hindsight's read-time latest, Copilot's validate-before-use).
- Every system that relies on the model to *ask* for memory (Letta archival, memory tool, MCP recall) under-uses it.
- The coding products (Cursor, Codex, Windsurf, Claude Code) converge on **directory / glob scoping** — which Eden's P1 adopts.
- None of them addresses re-injection of in-context facts; Eden §3 would be novel.

---

## 5. Benchmarks — what they measure and what they miss

| Benchmark | Measures | Relevance to Eden goals |
|---|---|---|
| **LoCoMo** (Maharana et al., arXiv:2402.17753, ACL 2024) | QA over ~10 long multi-session dialogues (~300 turns, ~9k tokens avg): single-hop, multi-hop, temporal, open-domain, adversarial | Low. Fits in context (~26k tokens per SOTA report); chat, not coding |
| **LongMemEval** (Wu et al., arXiv:2410.10813, ICLR 2025) | 500 questions; five abilities: extraction, multi-session reasoning, temporal reasoning, **knowledge update**, **abstention**; S ≈ 115k tokens, M ≈ 1.5M V | Knowledge-update ≈ goal 2; abstention ≈ silence |
| **MemoryAgentBench** (Hu, Wang, McAuley, arXiv:2507.05257, Jul 2025) | Accurate retrieval, test-time learning, long-range understanding, **conflict resolution** (renamed *selective forgetting* in v4; FactConsolidation SH / MH) V | Conflict resolution ≈ LWW / invalidation; all systems weak on MH (Eden 9 vs target 27, EDEN-MEMORY §14) |
| **BEAM** "Beyond a Million Tokens" (Tavakoli et al., arXiv:2510.27246, Oct 2025) | 100 conversations up to 10M tokens, 2,000 questions over 10 abilities incl. contradiction resolution, instruction following, **preference following** V | Scale + preference following |
| **PrefEval** (Zhao et al., arXiv:2502.09597, ICLR 2025) | Does the model follow a stated or implied preference later without being reminded; 3,000 pairs, 20 topics | **Closest proxy for "never restate"** |
| **PersonaMem** (arXiv:2504.14225, COLM 2025) | Evolving user profiles; dynamic-preference questions V | Preference updates |
| **Terminal-Bench Δ / HELP.md** (Eden-internal) | Task delta with vs without memory; helped / no-lift / harmed | Goal 2 (harm) |

**Gap:** no public benchmark measures (i) **restatement** by a user, (ii) **redundant injection** of in-context facts, (iii) **stale injection** after the repo changed, or (iv) per-session **injected-token accumulation**. Goals 1–4 of this appendix are exactly those. *"No benchmark exists" is a negative claim from model knowledge — unverified by exhaustive search in this run.*

## 6. Metrics Eden should add to the long-horizon runner

Emit per arm, alongside `scopedAuthOk` / `scopedDbOk`:

| Metric | Definition | Target |
|---|---|---|
| **RR** restatement rate | User turns re-asserting a live `(scope,s,p,o)` or pin ÷ 100 user turns; split by class (§2.14a) | → 0; `not_retrieved` class 0 on scripted fixtures |
| **RIR** redundant-inject rate | Packet bullets whose value was already in ledger / transcript tail / shadow set ÷ bullets | < 5% |
| **SIR** stale-inject rate | Bullets whose fact was invalid, or whose citation failed, at inject time ÷ bullets | 0 |
| **Silence precision** | Chatter / math / off-topic turns with empty packet ÷ such turns | 1.0 (today already) |
| **Used rate** | Bullets labelled `used` (§2.13) ÷ bullets | Report; trend up |
| **Tokens / session** | Σ Eden packet tokens between compactions | < 6k (§2.9) |
| **Tail latency** | p99 hook wall time incl. spawn | < 150 ms (budget abort) |

**Fixture additions:**
- A repo that **changes under the memory**: delete `@clerk/nextjs` at month 12, add `pnpm-lock.yaml` at month 6. Assert SIR = 0.
- A user who restates a preference in a new phrasing. Assert that the second restatement never happens: `not_retrieved` → alias learned at sleep → packs next time.
- A 300-turn single session. Assert RIR and tokens/session.

---

## 7. Recommended slice mapping (fits EDEN-MEMORY §13 order)

| Existing slice | Add from this appendix |
|---|---|
| P1 scope | Closed predicate vocabulary (§2.6); `seq` + `valid_from` + `invalid_at` persisted (§2.7) |
| P2 live copulas | `live` + `fact_hist` shape (§2.6), even if still JSONL |
| P3 candidate-gen | Bounded C, BM25F in JS, newest-64 for fat terms, silence gate (§2.2); 150 ms budget (§2.8) |
| P4 inject polish | Injected-ledger + transcript-tail + shadow set (§3); compaction reset (§2.11); session token budget (§2.9) |
| **P4b (new)** | Citation capture on write + Submit validation (§2.12a); correction regexes (§2.14b); restatement logging (§2.14a); usage labels at Stop (§2.13) |
| P5 append-only | Segment files, sleep compaction (§2.4) |
| P5b millions | SQLite FTS5 + keyed table with guards (§2.5); df-guarded ranking |
| P6 sleep aliases | Document expansion from misses + optional LLM / static-embedding neighbours (§2.3); NLI contradiction pass (§2.12c) |
| P7 pool BM25 | Superseded by §2.2 step 4 (BM25F on the bounded pool is cheap; do it in P3) |

---

## 8. References

Status tags:
- **[F]** fetched and checked 2026-09-29.
- **[M]** from model knowledge (cutoff mid-2026), not re-opened in this run. Verify before external citation.
- **[V]** re-opened and checked in the 2026-09-29 citation audit (`research/R4-citation-audit.md`).

**Primary docs**
- [F] Claude Code hooks — https://code.claude.com/docs/en/hooks (UserPromptSubmit 30 s timeout; additionalContext as system reminder "alongside the submitted prompt"; 10,000-char cap; PreCompact / PostCompact / SessionStart `compact`; invalid JSON dropped since v2.1.248)
- [F, partial] Claude Code memory — https://code.claude.com/docs/en/memory (auto memory `~/.claude/projects/<project>/memory/MEMORY.md` + topic files; `autoMemoryEnabled`; AGENTS.md support since v2.1.277)
- [F] Anthropic prompt caching — https://platform.claude.com/docs/en/build-with-claude/prompt-caching (tools → system → messages; 4 breakpoints; 20-block lookback; 5 min / 1 h TTL; write 1.25× / 2×; read 0.1×, 0.05× Opus 5.5; min 512–4,096 tokens)
- [F] GitHub Copilot Memory — https://docs.github.com/en/copilot/concepts/agents/copilot-memory (citations; validate against current branch; unused → deleted after 28 days; timer resets on validated use)
- [M] Anthropic memory tool — https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool ; context editing — https://platform.claude.com/docs/en/build-with-claude/context-editing ; announcement https://www.anthropic.com/news/context-management (2025-09-29)
- [M] Anthropic, "Effective context engineering for AI agents" (Sep 2025) — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- [M] OpenAI ChatGPT memory — https://openai.com/index/memory-and-new-controls-for-chatgpt/ ; FAQ https://help.openai.com/en/articles/8590148-memory-faq
- [M] Cursor rules — https://docs.cursor.com/context/rules (unreachable in audit) ; [V] Windsurf memories — https://docs.windsurf.com/windsurf/cascade/memories (now redirects to docs.devin.ai) ; [V] Codex AGENTS.md (32 KiB `project_doc_max_bytes`, root→cwd concatenation) — https://developers.openai.com/codex/guides/agents-md ; AGENTS.md — https://agents.md
- [M] SQLite FTS5 — https://www.sqlite.org/fts5.html ; WAL — https://www.sqlite.org/wal.html
- [V] Model2Vec — https://github.com/MinishLab/model2vec ; static embeddings blog (15 Jan 2025) — https://huggingface.co/blog/static-embeddings
- [V] OpenSearch inference-free sparse — https://huggingface.co/opensearch-project/opensearch-neural-sparse-encoding-doc-v3-distill

**Memory systems**
- [V] Mem0 — arXiv:2504.19413 (Apr 2025) https://arxiv.org/abs/2504.19413
- [V] Zep / Graphiti — arXiv:2501.13956 (Jan 2025) https://arxiv.org/abs/2501.13956 ; https://github.com/getzep/graphiti
- [V] MemGPT — arXiv:2310.08560 (Oct 2023) ; Sleep-time compute — arXiv:2504.13171 (Apr 2025)
- [V] A-MEM — arXiv:2502.12110 ; MemOS — arXiv:2507.03724 ; LightMem — arXiv:2510.18866 ; Memory-R1 — arXiv:2508.19828 ; MIRIX — arXiv:2507.07957 ; HippoRAG 2 — arXiv:2502.14802 ; Cognee — arXiv:2505.24478 (Markovic et al., KG–LLM hyperparameter tuning in Cognee; memify / forget are documented at https://docs.cognee.ai, not in this paper) ; Hindsight — arXiv:2512.12818
- [M] LangMem — https://langchain-ai.github.io/langmem/ ; Supermemory — https://supermemory.ai
- [V] Zhou et al., "Are We Ready For An Agent-Native Memory System?" — arXiv:2606.24775 (Jun 2026) (via MEMORY-SOTA-BUILD-REPORT)
- [V] Saha, "Delivery, Not Storage: Cue-Anchored Working Memory as a Harness Property for Coding Agents" — arXiv:2607.20972 (Jul 2026) (via EDEN-MEMORY §11)
- [V] Generative Agents — arXiv:2304.03442 (decay 0.995, all α = 1, min-max confirmed) ; MemoryBank — arXiv:2305.10250 ; experience-following — arXiv:2505.16067

**Benchmarks**
- [V] LoCoMo arXiv:2402.17753 ; LongMemEval arXiv:2410.10813 ; MemoryAgentBench arXiv:2507.05257 ; PrefEval arXiv:2502.09597 ; PersonaMem arXiv:2504.14225 ; BEAM arXiv:2510.27246 (Oct 2025)

**Context-length harm**
- [V] Chroma, "Context Rot" (14 Jul 2025) https://research.trychroma.com/context-rot
- [V] Lost in the Middle arXiv:2307.03172 ; GSM-IC arXiv:2302.00093 ; Context Length Alone Hurts arXiv:2510.05381 ; NoLiMa arXiv:2502.05167 ; The Power of Noise arXiv:2401.14887

**Retrieval / IR classics**
- [M] Robertson & Zaragoza 2009, "The Probabilistic Relevance Framework: BM25 and Beyond", FnTIR 3(4)
- [V] Carbonell & Goldstein 1998, MMR, SIGIR (doi:10.1145/290941.291025)
- [M] Cormack, Clarke, Büttcher 2009, RRF (k=60), SIGIR
- [V] Thakur et al. 2021, BEIR arXiv:2104.08663
- [V] Jimenez et al., SWE-bench arXiv:2310.06770 (BM25 retrieval baseline)
- [V] Nogueira et al. 2019, doc2query arXiv:1904.08375
- [M] Broder 1997, MinHash / resemblance
- [M] O'Neil et al. 1996, LSM-tree, Acta Informatica

**Cognitive models**
- [V] Anderson & Schooler 1991, "Reflections of the environment in memory", Psych. Science 2, 396–408
- [M] Anderson & Lebiere 1998, *The Atomic Components of Thought* (base-level learning, d = 0.5)
- [V] Petrov 2006, "Computationally efficient approximation of the base-level learning equation in ACT-R", Proc. 7th ICCM, pp. 391–392 (Eq. 2 and hybrid Eq. 3 as given in §2.12b confirmed against the preprint)

**Local measurements:** Bun / SQLite scripts in the session scratchpad (`build.ts`, `q.ts`). Re-create from §1's description.
