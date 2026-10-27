# What to build into Eden Memory

> **Superseded: history of the M1–M50 memory waves (September 2026).** The memory program now builds from [memory-ship/](memory-ship/): [ROADMAP.md](memory-ship/ROADMAP.md) orders the work, [DECISIONS.md](memory-ship/DECISIONS.md) wins every conflict, and [PROGRESS.md](memory-ship/PROGRESS.md) says what is done.

**Dated 2026-09-28.** SOTA / new / innovative agent-memory systems, filtered through Eden’s locked product: silent Claude-hook inject, copula + episode facts, ≤8 bullets ≤900 bytes, sub-millisecond fail-open, dump-all is not a win.

This is a **build brief**, not a clone list. Earlier autopsies: `docs/MEMORY-COMPETITORS.md` (2026-09-19), `docs/MEMORY-PLAN.md` (locked animal). This file supersedes those as the **mechanism backlog** after Hindsight source review (`vectorize-io/hindsight` main, 2026-09-28) and 2025–2026 papers.

**Do not treat LoCoMo 92 / LongMemEval 91 / retrieve@40 as a ship bar.** Those numbers are conversational-QA under a vendor’s judge, often with an LLM on retain *and* reflect. Eden’s exam is gold in a small hook packet after burial, tools, overwrites, and hops — or silence on math/chatter.

---

## 0. Filter: what is even allowed

| Constraint | Fits | Does not fit |
|---|---|---|
| UserPromptSubmit ~0.4 ms | In-process inverted index, exact key, byte cap | Embed query, cross-encoder, Neo4j, HTTP, second process |
| ≤8 × ≤900 B labeled packet | Cut the ranked list; skip-not-evict | 1024-token `<hindsight_memories>` dump; dual-channel graph+passage |
| No LLM on submit | Write-time aliases, LWW in code, empty packet | Retain extract, reflect, sufficiency verifier, `memory_search` |
| Fail-open | Throw → original prompt | Memorable unset=deny |
| Dump-all is a miss | Empty retrieve → **no packet** | Score the entire store when hay is thin |
| Copula mismatch (`dlq` vs `Dead letters are SQS`) | Entity/alias **tags on the row** at observe | Exploding `CUE_EXPAND` on the cue (grows hay, blows ms) |

Mem0 search is p50 **148 ms** ([arXiv:2504.19413](https://arxiv.org/abs/2504.19413)). That is already ~370× over the hook. Any “SOTA retrieve” that needs embeddings on submit is a **sleep** feature or a different product.

---

## 1. What the 2026 evidence actually says

### 1.1 No architecture wins all workloads

Zhou et al., **“Are We Ready For An Agent-Native Memory System?”** ([arXiv:2606.24775](https://arxiv.org/abs/2606.24775), code [OpenDataBox/MemoryData](https://github.com/OpenDataBox/MemoryData)): 12 systems + long-context + embedding RAG, 11 datasets, four modules (representation, extraction, retrieval, maintenance).

| Workload | Who led | Form that won |
|---|---|---|
| Cross-session chat (LongMemEval judge) | Zep ~48 judge acc.; Cognee strong ROUGE | Relation + time index |
| Exact latest state (LoCoMo EM) | MemOS ~11.5 overall EM | Coarse-to-fine, **light** write |
| Fact revision (knowledge update) | Zep ~44 substr EM | Bi-temporal **invalidate**, not delete |
| Temporal reasoning | Cognee | Dated evidence in a graph |
| Stateful execution (DB-Bench) | Long context / MemoChat | **Ordered trace**, not a summary graph |
| Evidence far from the query | A-MEM / MemTree at R@5–10; SimpleMem high R@1 | Links or a tree once facts scatter |
| Cost | LightMem best utility/second | Bounded neighborhood, sleep consolidate |

**Finding that transfers:** match the form to the bottleneck. Dispersed facts want entity+time keys. Coherent chat wants a coarse filter then an exact value. Stateful/coding work wants the **trace**. Eden is the third plus a thin copula layer for the first.

**Ablations that transfer:**

- **Raw beats summary.** LightMem user-only raw LoCoMo EM ~24 vs summary ~8.5. Do not paraphrase the copula object on the hot path.
- **Write wide, filter late.** Aggressive LLM extract looks precise and cannot be recomposed. MemOS “fine memorize” dropped LoCoMo EM **25.5 → 2.5**.
- **One planning step, no reflect.** SimpleMem planning-only beat planning+reflect.
- **Conservative merge, flush immediately.** Delayed flush hurt MemoryOS. Near-miss assimilation hurts.
- **Localized maintenance** beats global reclustering on cost.

### 1.2 Leaderboard inflation

- LoCoMo (~26k tokens) often **fits in context**. Mem0’s own table: full context ~73 judge vs Mem0 ~67. Memory won **latency**, not accuracy vs stuffing.
- Hindsight 83.6% (20B) / 91.4% (Gemini) on LongMemEval ([arXiv:2512.12818](https://arxiv.org/abs/2512.12818)) is **TEMPR retain + CARA reflect** — a second model writing the answer, not a hook packet.
- AutoMem field note: retrieve@5 can be ~97% while answer accuracy is ~87%. Lookup saturates; the miss is **synthesis and staleness**.
- Memorable 100% / 98% less context uses a saturated fixture and a skill-dump denominator.
- A 2026 result ([arXiv:2606.04315](https://arxiv.org/html/2606.04315v1)) finds index-style memory fails many **agentic trajectories**, while grepping the raw trace generalizes. For a coding hook: repo + episode log are the corpus; the packet is an **index**, not the answer.

---

## 2. Hindsight (deep, from source)

Repo: [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight). Paper: TEMPR + CARA.

**They do not inject like Eden.** Recall returns JSON facts. A **Claude hook** wraps them. Reflect is a tool-calling agent.

### Hook (`hindsight-integrations/claude-code/scripts/recall.py`)

1. Skip `len(prompt) < 5` (not a chatter model; `"thanks"` still recalls).
2. Cap query at **800 chars**, keep **latest utterance**, drop oldest prior context first.
3. `recall(max_tokens=1024, budget=mid, timeout=10)`.
4. Missing scores **pass** (fail-open).
5. **Empty results → print nothing, exit 0.**
6. Else emit `<hindsight_memories>` with bullets `text [type] (mentioned_at)` and current UTC time.
7. Errors → stderr, **exit 0**.

**Anti-feedback:** `strip_memory_tags` deletes `<hindsight_memories>…` from any later retain transcript.

**Packing:** `select_facts_within_budget` spends tokens in rank order; oversized facts are **skipped**, shorter later facts still get in; if nothing fits, return the **top fact whole** so empty ≠ “no memory.” Never clip mid-sentence.

### TEMPR four arms

Semantic (cosine floor 0.3) · keyword/`ts_rank` (omit arm if no word chars; max 16 rarest tokens; **no query-time synonym expand**) · graph (seed top 20 semantic, one hop, `tanh` on shared entities) · temporal (only if a date window parses).

Fusion: **RRF k=60**. They later added **interleave (round-robin)** because RRF buries single-arm winners (the consolidator’s semantic #1 with no graph overlap).

### Retain

Facts are `{what} | When: | Involving: | why` plus a separate **`entities[]` array**. That is why paraphrase retrieve works: “dlq” can live on the entity list while the sentence says “dead letters.” Chunk split is `". "` (period+space). Concise LLM extract **refuses** greetings / thanks / ok. World facts are **append-only**; “latest `mentioned_at` wins” is a **read-time instruction**, not a delete.

### Steal vs refuse

| Steal | Refuse |
|---|---|
| Empty-arm → no packet | LLM on every retain |
| Entity tokens **beside** the copula | Reflect / disposition / opinions in the packet |
| Skip-not-evict packing | 1024-token hook dumps |
| Strip injected block before observe | Cross-encoder on submit |
| Preserve-latest query cap | Query-time synonym explosion |
| Read-time latest-wins, keep both rows | Document wipe as overwrite |

Eden’s dangerous retrieve line: if posting lookup is empty, **score the entire compiled store**. Hindsight returns nothing. That dump-all fallback is the inject-ms and drowning bug.

---

## 3. Other SOTA / new systems (what they are, what to take)

### Mem0 / Mem0-graph — [arXiv:2504.19413](https://arxiv.org/abs/2504.19413)

LLM extract → embed → ADD/UPDATE/DELETE/NOOP. Graph variant adds triples. Search ~100–200 ms. Full context still beat them on LoCoMo judge. **Steal:** typed write ops especially **NOOP**; dedup before insert; async add. **Refuse:** extract-every-turn; `search()` as the agent API; graph for +2% judge.

### Zep / Graphiti — [arXiv:2501.13956](https://arxiv.org/abs/2501.13956), [getzep/graphiti](https://github.com/getzep/graphiti)

Episode + entity/edge + community. Edges have **valid time** and **transaction time**. Contradictions **invalidate**, they do not delete. Best knowledge-update scores; worst efficiency class (~100s+ amortized in Zhou). **Steal:** `valid_at` / `invalid_at` on `(entity, relation, value)`; reader `invalid_at IS NULL` then `max(valid_from)`. **Refuse:** Neo4j on the hook; LLM edge extract; community summaries in the packet.

### Letta / MemGPT — [arXiv:2310.08560](https://arxiv.org/abs/2310.08560)

Core vs archival; the **model** calls `archival_memory.search`. Zhou: near-last on updates. **Steal:** persisted working set; flush the live buffer at a byte cap. **Refuse:** memory tools in the default loop.

### A-MEM — [arXiv:2502.12110](https://arxiv.org/abs/2502.12110)

Zettelkasten notes that **rewrite neighbors**. Best large-budget recall; neighbor mutation destroys the value you meant to keep. **Steal:** keywords as a second lexical channel; “see also” only at sleep. **Refuse:** write-time LLM notes; mutating old facts; R@10 as permission to inject 10 passages.

### MemOS — [arXiv:2507.03724](https://arxiv.org/abs/2507.03724)

MemCube (plaintext / KV / LoRA) + scheduler. **Fast memorize >> fine memorize** on LoCoMo. **Steal:** sleep may compress, the hot path may not; new version, old id kept. **Refuse:** KV/LoRA cubes; fine extraction on the turn.

### MemoryOS — EMNLP 2025

STM / mid-term pages / LPM; heat = frequency × decay. Delayed flush **hurt**. **Steal:** heat as a **sleep** eviction score; flush the short buffer immediately; search inside a segment (repo area / entity). **Refuse:** three physical stores; profile dump at session start.

### MAGMA — ACL 2026 [anthology](https://aclanthology.org/2026.acl-long.1709/)

One item, four orthogonal graphs; retrieval is a **policy** over views. LoCoMo/LongMemEval wins; ~0.7–4.2k tokens vs 100k full context. **Steal:** a **code** router from cue shape → lane (copula key, path/URL, procedure, time). Causal edges only where a tool outcome was observed, written at sleep. **Refuse:** four live graphs; learned traversal on submit.

### EverMemOS — [arXiv:2601.02163](https://arxiv.org/abs/2601.02163), [EverMind-AI/EverMemOS](https://github.com/EverMind-AI/EverMemOS)

MemCell → MemScene → agentic recollection with an LLM **sufficiency loop**. **Steal:** episode schema with facts beside the raw turn; foresight with `valid_until`; scene as one sleep gist. Sufficiency = byte budget + needle check, **not** a verifier model. **Refuse:** query rewrite loops; profile inject.

### MemWeaver — ACL 2026 Findings [arXiv:2601.18204](https://arxiv.org/abs/2601.18204)

Graph + experience abstractions + **passage ids**. Dual-channel retrieve; >95% context cut vs stuffing (same denominator as everyone). **Steal:** every copula/procedure carries a source id; inject the fact; leave the passage on disk. Experience bullets only from **repeated, supported** clusters. **Refuse:** injecting both channels on the hook.

### HippoRAG / HippoRAG 2 — [arXiv:2502.14802](https://arxiv.org/abs/2502.14802)

Offline triples + Personalized PageRank. On MemoryAgentBench, HippoRAG overall **ties BM25**. **Steal:** store-all episodes + a sparse associative index beside them; passage nodes as seeds so entity extract is not the only door. **Refuse:** PPR on submit; query-time NER; running it on ICL or tool traces.

### Cognee — [cognee.ai](https://www.cognee.ai/), [arXiv:2505.24478](https://arxiv.org/abs/2505.24478)

Schema-constrained graph + **memify** from later feedback. Strong temporal/update; ~100s class. **Steal:** memify as sleep (failed/corrected turn invalidates the copula). Closed relation set (`uses`, `fails_when`, `verified_by`). **Refuse:** cognify on the turn; auto-ontology growth.

### LangMem

Background LLM memories + vector search. Mem0’s table: search p50 ~18 s. **Steal:** procedural memory as an outcome-conditioned one-liner written at sleep from a passing verify. **Refuse:** LangGraph lock-in; manager tools; vector-only.

### SuperMemory — [supermemory.ai](https://supermemory.ai)

Hosted hybrid search + profiles. Network RTT alone exceeds 0.4 ms. **Steal:** lexical always works if vectors are absent. **Refuse:** managed profile; vendor SDK on submit.

### Nemori — [arXiv:2508.03341](https://arxiv.org/abs/2508.03341)

Event segmentation + predict-calibrate. **Steal:** boundary = salience change (correction, test flip, explicit remember) **without** a model; sleep writes a semantic delta only on **string inequality** (match → NOOP). **Refuse:** LLM segmentation per turn.

### SimpleMem — [arXiv:2601.02553](https://arxiv.org/abs/2601.02553)

Multi-view units + LLM planner. High R@1; knowledge-update collapsed (~6.7 EM) because timestamp precedence **without invalidation** keeps the old sentence. **Steal:** entity/time/place keys on a unit you already store; `max(t)` in **code**; stop after first-stage lookup. **Refuse:** online synthesis; intent planning on submit.

### PlugMem — [arXiv:2603.03296](https://arxiv.org/abs/2603.03296)

Propositional vs **prescriptive** knowledge. **Steal:** `[fact]` vs `[procedure]`; do not retrieve a trajectory when a verified prescription exists; same brain on wrap and hook. **Refuse:** online KG construction; second compression LLM.

### MemU

Files → categories; RAG or LLM progressive read. **Steal:** coarse key then fine key; early stop = 8-bullet cap. **Refuse:** LLM retrieve; rewriting categories online.

### Memory-R1 — [arXiv:2508.19828](https://arxiv.org/abs/2508.19828)

RL ADD/UPDATE/DELETE/NOOP. **Steal:** NOOP as first-class (remain silent); distill to rules. **Refuse:** a reward model in the product.

### LightMem — [arXiv:2510.18866](https://arxiv.org/abs/2510.18866)

Sensory → STM → **sleep** LTM. Best cost/utility in Zhou. The win is the **split**, not the summarizer (raw >> summary). **Steal:** consolidation never on UserPromptSubmit; topic postings built offline. **Refuse:** topic LLM at ingest; cosine as the retriever.

### memorable.sh (YC)

Ordered tool traces → procedures with verify → sibling revisions. Marketed ~60 ms. Fail-closed. **Steal:** order+exit; sleep compresses **success only**; worse retry is a sibling not LWW; ledger of runs where memory did **not** help; data-not-instructions on how-to. **Refuse:** `memorable recall` CLI; 60 ms SLO; fail-closed; closed extractor.

### AutoMem

Field: ~97% retrieve vs ~87% answer. Paper (architecture search): tag misses as Encode / Store / Retrieve / Manage. **Steal:** decay failed paths at sleep; tag the miss class before adding an index. **Refuse:** MCP recall as the product.

### KARMA

PubMed multi-agent debate **or** robot 3D scene graph. **Steal:** nothing into the hook. Conflict-before-insert is already bi-temporal invalidation.

---

## 4. Eden today (honest)

Locked animal (`docs/MEMORY-PLAN.md`): observe → this-turn `cueFor` → inject labeled packet → sleep. Fail-open. One brain wrap+hook. No Letta tools.

What the hook actually does (2026-09-28 `src/index.ts` + `packages/cli/src/memory-hook.ts`):

- Stop / PostToolUse **observe** (regex copulas, observe-aliases, hop-copula rewrites, unglue digit-period+capital, skip `qx…z` harness junk).
- UserPromptSubmit **inject**: chatter gate → lexical postings + `CUE_EXPAND` + gated hops → LWW on a few regexes → `Eden Memory:` bullets.
- If postings miss, retrieve **falls back to scoring the whole store**.
- Constraints can prepend even when they did not match the cue.
- Sleep exists in the tree; the Claude hook path does not wait on it.

That is closer to “fast lexical hippocampus” than to TEMPR. The 2026 literature says: **keep the hippocampus fast; put structure at write and in sleep; never dump the bank.**

---

## 5. Ranked backlog (build this)

Mechanism names only. P0 is the hook. P1 is sleep. P2 stays out until a named gate fails.

### P0 — silent hook

1. **Empty-arm rule.** Delete whole-store fallback. No posting / alias / rare-token hit → **no packet**. This is Hindsight’s empty results path and the inject-ms fix.
2. **Byte-budgeted labeled recall.** Keep ≤8 / ≤900. Skip-not-evict (Hindsight `fact_budget`). Never clip a copula. Never fill from unscored compiled rows.
3. **Write-time aliases / entity tags.** Static table on observe (`dlq↔dead letters↔sqs`, `sidecar↔mesh↔istio`, …). Tokens live **on the row**, not in `CUE_EXPAND` on the cue. This is TEMPR `entities[]` without an LLM.
4. **Period-space + digit-period unglue.** Split on `". "`; extra-split `(?<=\d\.)\s+(?=[A-Z])` so `Node 18.` / `Auth0.` / `R2.` / `sha256:…4.` do not glue to the next recap sentence.
5. **Bi-temporal copula.** `(entity, relation, value, valid_from, invalid_at)`. Reader: live rows then `max(valid_from)`. Generalize today’s sha256/based-in LWW. **Do not subjectKey-delete** at observe.
6. **NOOP / remain silent.** Chatter list **and** empty-arm. `got it` / `nice` / `cool` / `will do` plus any cue with no content terms.
7. **Fail-open pass-through.** Keep inject catch. Memorable deny is the anti-pattern.
8. **Lane router (code, one lane).** Cue shape → copula key | path/URL | procedure aboutness | time range. MAGMA’s idea without four graphs. No second chance that widens into a dump.
9. **Source id, not passage.** Bullet may end with file/episode id. MemWeaver’s `C_TXT` stays on disk.
10. **Strip `Eden Memory:` before observe.** Port `strip_memory_tags`.
11. **Preserve-latest cue.** Keep `cueFor` last-line on fat paste. Default: this utterance only.
12. **Verbatim value.** Copy the object; do not paraphrase on the hot path (Zhou raw vs summary).
13. **Conservative key match.** Same entity + same relation, or it is not an update.

### P1 — sleep / idle only

1. **Fast-memorize policy.** Explicit pins + identity copulas become semantic. Everything else stays episode. MemOS fine-extract destroyed EM.
2. **Prediction-error write.** Nemori as string compare: same value → NOOP; changed → tombstone + insert.
3. **Local maintenance.** Touch that entity’s rows. No global reclustering.
4. **Success-only procedure compression.** PlugMem prescriptive + memorable L2: order, files, exit, verify. Worse retry = sibling revision. Chat-only mints none.
5. **Foresight expiry / freshness.** EverMemOS `valid_until`; Hindsight observation freshness. Stale drops out of the reader.
6. **Heat decay.** Unused episodes and failed procedures lose rank. Do not delete if they are the only provenance for a live copula.
7. **Salience boundaries.** Correction, test flip, explicit remember, non-zero exit — sleep reads these first.
8. **Rule temporal parse.** dateutil-class rules, not a T5. Parse fail → skip the time lane.
9. **Optional inverted postings at sleep.** LightMem topic groups / SimpleMem multi-view, still no embedder. First thing to try if exact keys miss real hook traffic.
10. **Miss taxonomy.** Tag a failed needle Encode / Store / Retrieve / Maintain (AutoMem paper) before adding an index.
11. **Prefer-observation-over-sources.** If a gist exists, do not also inject the contradicted raw lines.

### P2 — do not build unless a named gate fails

| Mechanism | Why it stays out |
|---|---|
| Dense embeddings, reranker | 148 ms class; embedding RAG dies as evidence distance grows |
| PPR, A-MEM neighbor rewrite | HippoRAG ≈ BM25 on MAB; mutation deletes evidence |
| Four graphs, Neo4j, cognify | 100s+ class; Mem0-graph was +2% judge and 2× tokens |
| Agentic routing, sufficiency LLM, reflect | Extra reflect often **hurts**; Letta last on updates |
| MemCube KV / LoRA | Different machine |
| RL memory policy | Distill to P0 rules |
| Opinion / disposition inject | Beliefs look like facts |
| Cloud extract, MCP recall, dashboards | Other companies’ products |
| LoCoMo 92 / k=40 / dual-API scores | Honesty lock |

---

## 6. Target packet

Nothing richer than this on the hot path:

```
Eden Memory:
- [fact] auth.provider = Clerk  (as of 2026-09-10)
- [procedure] auth flake → tests/auth/session.test.ts · verify: npm test -- auth
- [episode] 2026-09-16 src/auth.test.ts
```

TEMPR would have retrieved a subgraph and reranked it. CARA would have written an opinion. Mem0 would have embedded the prompt. Zep would have walked Neo4j. MAGMA would have chosen a graph with a model. Eden does the lane switch, the tombstone filter, and the byte cap — and if that throws, injects nothing.

---

## 7. Sources (primary)

- Zhou et al. 2026, *Are We Ready For An Agent-Native Memory System?* [arXiv:2606.24775](https://arxiv.org/abs/2606.24775)
- Latimer et al. 2025, *Hindsight is 20/20* [arXiv:2512.12818](https://arxiv.org/abs/2512.12818); source [vectorize-io/hindsight](https://github.com/vectorize-io/hindsight)
- Chhikara et al. 2025, Mem0 [arXiv:2504.19413](https://arxiv.org/abs/2504.19413)
- Rasmussen et al. 2025, Zep [arXiv:2501.13956](https://arxiv.org/abs/2501.13956)
- Xu et al. 2025, A-MEM [arXiv:2502.12110](https://arxiv.org/abs/2502.12110)
- Li et al. 2025, MemOS [arXiv:2507.03724](https://arxiv.org/abs/2507.03724)
- Jiang et al. 2026, MAGMA ACL long
- Hu et al. 2026, EverMemOS [arXiv:2601.02163](https://arxiv.org/abs/2601.02163)
- MemWeaver ACL 2026 Findings [arXiv:2601.18204](https://arxiv.org/abs/2601.18204)
- Gutiérrez et al., HippoRAG 2 [arXiv:2502.14802](https://arxiv.org/abs/2502.14802)
- Liu et al., SimpleMem [arXiv:2601.02553](https://arxiv.org/abs/2601.02553)
- Yang et al., PlugMem [arXiv:2603.03296](https://arxiv.org/abs/2603.03296)
- Fang et al., LightMem [arXiv:2510.18866](https://arxiv.org/abs/2510.18866)
- Nan et al., Nemori [arXiv:2508.03341](https://arxiv.org/abs/2508.03341)
- Yan et al., Memory-R1 [arXiv:2508.19828](https://arxiv.org/abs/2508.19828)
- Packer et al., MemGPT [arXiv:2310.08560](https://arxiv.org/abs/2310.08560)
- Eden locks: `docs/MEMORY-PLAN.md`, `docs/MEMORY-COMPETITORS.md`

---

## 8. One-line strategy

**Structure at write, silence when retrieve is empty, invalidate instead of overwrite, keep the raw value and the ordered trace, consolidate only offline and only locally.** The 2025–2026 accuracy race is real on chat QA and mostly the wrong SLO for a coding/chat hook. Build P0 until the packet is empty on chatter and complete on copulas; then sleep.
