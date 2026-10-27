# R4 — Citation and number audit (A2, A3, A4–A6, EDEN-MEMORY §11)

**Dated 2026-09-29.** Primary sources fetched this run: arXiv API (`export.arxiv.org/api/query`, abstract + comment + journal_ref), arXiv HTML full text where needed, Crossref (`api.crossref.org/works/<doi>`), and official docs pages. Status values:

- **VERIFIED** — the primary source says it; quote/figure given.
- **CORRECTED** — source exists but says something different; the doc was edited.
- **NOT FOUND** — no primary source supports the claim; removed or flagged.

This log is written incrementally; later sections were appended as checks finished.

## 1. arXiv id existence (batch, arXiv API)

All 33 arXiv ids cited across A2, A3 and EDEN-MEMORY resolve to real papers. **No fabricated arXiv ids were found.** Both 2026 ids exist and match their descriptions:

| id | Cited as | arXiv record (title, first author, v1 date) | Status |
|---|---|---|---|
| 2606.24775 | Zhou et al. 2026, "Are We Ready For An Agent-Native Memory System?" | same title; Wei Zhou, Xuanhe Zhou, … (8 authors); 2026-06-23 | VERIFIED (exists, title/author match) |
| 2607.20972 | Cue-anchored memory paper (EDEN-MEMORY §11) | "Delivery, Not Storage: Cue-Anchored Working Memory as a Harness Property for Coding Agents"; Swapnanil Saha (sole author); 2026-07-23 | VERIFIED (exists, content matches, see §3 row 38) |
| 2504.19413 | Mem0 | "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory"; Chhikara; 2025-04-28 | VERIFIED |
| 2501.13956 | Zep / Graphiti | "Zep: A Temporal Knowledge Graph Architecture for Agent Memory"; Rasmussen; 2025-01-20 | VERIFIED |
| 2310.08560 | MemGPT | "MemGPT: Towards LLMs as Operating Systems"; Packer; 2023-10-12 | VERIFIED |
| 2504.13171 | Letta sleep-time compute (Lin et al.) | "Sleep-time Compute: Beyond Inference Scaling at Test-time"; Kevin Lin; 2025-04-17 | VERIFIED |
| 2502.12110 | A-MEM | "A-MEM: Agentic Memory for LLM Agents"; Xu; NeurIPS 2025 | VERIFIED |
| 2507.03724 | MemOS | "MemOS: A Memory OS for AI System"; Li; 2025-07-04 | VERIFIED |
| 2510.18866 | LightMem | "LightMem: Lightweight and Efficient Memory-Augmented Generation"; Fang; ICLR 2026 | VERIFIED |
| 2508.19828 | Memory-R1 | same title; Yan; 2025-08-27 | VERIFIED |
| 2507.07957 | MIRIX | "MIRIX: Multi-Agent Memory System for LLM-Based Agents"; Wang, Chen | VERIFIED |
| 2502.14802 | HippoRAG 2 | "From RAG to Memory: Non-Parametric Continual Learning for LLMs"; Gutiérrez; ICML 2025 | VERIFIED |
| 2505.24478 | Cognee | "Optimizing the Interface Between Knowledge Graphs and LLMs for Complex Reasoning"; Markovic et al. | **MISATTRIBUTED for the claims it is cited for** — see §3 row 26 |
| 2512.12818 | Hindsight | "Hindsight is 20/20: Building Agent Memory that Retains, Recalls, and Reflects"; Latimer; 2025-12-14 | VERIFIED |
| 2304.03442 | Generative Agents | Park et al. | VERIFIED |
| 2305.10250 | MemoryBank | Zhong et al. | VERIFIED |
| 2505.16067 | Experience-following (Xiong et al.) | "How Memory Management Impacts LLM Agents: An Empirical Study of Experience-Following Behavior"; Zidi Xiong | VERIFIED |
| 2402.17753 | LoCoMo | Maharana et al. | VERIFIED |
| 2410.10813 | LongMemEval | Di Wu et al.; ICLR 2025 | VERIFIED |
| 2507.05257 | MemoryAgentBench | "Evaluating Memory in LLM Agents via Incremental Multi-Turn Interactions"; Hu, Wang, McAuley | VERIFIED (see §3 row 41 on category name) |
| 2502.09597 | PrefEval | Zhao et al.; ICLR 2025 oral | VERIFIED |
| 2504.14225 | PersonaMem | "Know Me, Respond to Me: …"; Jiang et al.; COLM 2025 | VERIFIED |
| 2307.03172 | Lost in the Middle | Liu et al.; TACL | VERIFIED |
| 2302.00093 | GSM-IC | Shi et al.; ICML 2023 | VERIFIED |
| 2510.05381 | Context Length Alone Hurts | Du et al.; Findings of EMNLP 2025 | VERIFIED |
| 2502.05167 | NoLiMa | Modarressi et al.; ICML 2025 | VERIFIED |
| 2401.14887 | The Power of Noise | Cuconasu et al. | VERIFIED |
| 2104.08663 | BEIR | Thakur et al.; NeurIPS 2021 D&B | VERIFIED |
| 2310.06770 | SWE-bench | Jimenez et al.; ICLR 2024 | VERIFIED |
| 1904.08375 | doc2query | Nogueira et al. 2019 | VERIFIED |
| 2405.14831 | HippoRAG | Gutiérrez et al.; NeurIPS 2024 | VERIFIED |
| 2407.09450 | EM-LLM | "Human-**inspired** Episodic Memory for Infinite Context LLMs"; Fountas; ICLR 2025 | CORRECTED (A3 title said "Human-like") |
| 2501.00663 | Titans | Behrouz, Zhong, Mirrokni; v1 2024-12-31 | VERIFIED |

## 2. Crossref re-check of every DOI in A3 §R

All 99 DOIs in A3 §R were re-resolved on Crossref this run. Every one resolves, and first author / year / journal / volume / pages match the reference line. Two notes:

- Redondo & Morris: Crossref `issued` is 2010 (online first); print is *Nat Rev Neurosci* 12 (2011), 17–30. The 2011 citation is correct.
- McDaniel & Einstein (2000), `10.1002/acp.775`: Crossref has no page field; see §3 row 50.

## 3. Claim-level checks (numbers and content)

| # | Doc § | Claim as written | Status | Source and exact figure | Edit made |
|---|---|---|---|---|---|
| 1 | A2 §2.1, §4 | Mem0 search p50 148 ms; total p95 ~1.4 s | VERIFIED | arXiv:2504.19413 Table 2: Mem0 search p50 0.148 s / p95 0.200 s; total p50 0.708 s / p95 1.440 s. Embeddings `text-embedding-small-3`, LLM gpt-4o-mini | Tag replaced; matrix U→V |
| 2 | A2 §4 | Mem0ᵍ conflicting edges marked invalid (soft); ~2× tokens | VERIFIED | "marking them as invalid rather than physically removing them"; memory tokens 3,616 (graph) vs 1,764 | U→V |
| 3 | A2 §4 | Zep LongMemEval latency ~2.6 s vs ~29 s | VERIFIED | Zep Table 2: gpt-4o 2.58 s vs 28.9 s full-context (gpt-4o-mini 3.20 s vs 31.3 s); context 1.6k vs 115k tokens | U→V |
| 4 | A2 §2.7 | Zep's largest gains are on knowledge-update and temporal | **CORRECTED** | Zep Table 3: largest gains are single-session-preference (+184% gpt-4o), temporal-reasoning (+38.4%), multi-session (+30.7%). Knowledge-update: +6.52% (gpt-4o, 78.2→83.3), −3.36% (gpt-4o-mini, 76.9→74.4) | Bullet rewritten |
| 5 | A2 §2.7 | Zep four timestamps, LLM contradiction → invalidate | VERIFIED | "the system tracks four timestamps"; "employs an LLM to compare new edges against semantically related existing edges to identify potential contradictions" | none |
| 6 | A2 §2.7 | Zhou et al. 2606.24775: bitemporal invalidate-not-delete led fact revision (~44 substring-EM) | VERIFIED with nuance | Table 2 / O4: "Zep leads Knowledge Update with 44.4 Substring EM and 36.8 ROUGE-L F1". Authors credit "graph- or relation-organized memory", not invalidation per se; Zep is classed "Timestamp-Based Multi-Versioning (Logical Invalidation)" (so is Mem0) | Bullet reworded |
| 7 | A2 §2.14c | Zhou et al.: MemOS fine extraction 25.5 → 2.5 EM | VERIFIED with nuance | Table 4: MemOS Fast 25.5 / Fine 2.5 EM **on LoCoMo**; on LongMemEval Fine is slightly *better* (22.3 vs 20.7 Substr. EM). Authors: "broader, less selective extraction better preserves the context" | none (claim already says EM) |
| 8 | A2 §2.1 | Static embeddings 100–500× faster than MiniLM/mpnet at 85–90% quality | **CORRECTED** | HF blog (Aarsen, 15 Jan 2025): "100x to 400x faster on CPU than … all-mpnet-base-v2 and multilingual-e5-small … at least 85% of their performance". Model2Vec README: "up to 500 times faster on CPU than the original model", "small drop in performance" | Sentence rewritten |
| 9 | A2 §2.1 | BEIR: BM25 beats most dense retrievers OOD; SWE-bench uses BM25 | VERIFIED | BEIR abstract: "BM25 is a robust baseline … dense and sparse-retrieval models … often underperform"; SWE-bench: "we choose to use BM25 retrieval … to retrieve relevant files" | Tag replaced |
| 10 | A2 §2.1 | Power of Noise: related-but-irrelevant hurts more than random | VERIFIED | Abstract: "highest-scoring documents that are not directly relevant … negatively impact"; "adding random documents … improves the LLM accuracy by up to 35%" | Tag replaced |
| 11 | A2 §2.3 | OpenSearch inference-free sparse: query = tokenizer + IDF weights | VERIFIED (wording tightened) | Model card doc-v3-distill: "For queries, it just use a tokenizer and a weight look-up table". "Latency close to BM25" is not stated by the source; now marked as our inference | Reworded |
| 12 | A2 §2.8 | UserPromptSubmit 30 s timeout; 600 s default | VERIFIED | hooks doc: "UserPromptSubmit hooks have a default timeout of 30 seconds … shorter than the 600-second default" | none |
| 13 | A2 §2.8 | 10,000-char cap; path + 2,000-char preview | VERIFIED | "capped at 10,000 characters"; "passes Claude the file path with a preview of up to the first 2,000 characters" | none |
| 14 | A2 §2.8 | Since v2.1.248, stdout starting with `{` that fails to parse is dropped | **CORRECTED** | Doc: output is parsed as JSON only if it "Starts with { and ends with }"; on parse failure "Claude Code doesn't add the text. Before v2.1.248, Claude Code treated that stdout as plain text." Output that "Starts with { but doesn't end with }" is plain text | Bullet rewritten |
| 15 | A2 §2.9, A4 §5 | Hook context wrapped in a system reminder at the point the hook fired; replayed on resume; UserPromptSubmit "alongside the submitted prompt" | VERIFIED | Exact quotes present in hooks doc | none |
| 16 | A2 §2.11, A4 §3 | PreCompact (manual/auto, can block), PostCompact, SessionStart source `compact` | VERIFIED | Matcher table: PreCompact/PostCompact "manual, auto"; PreCompact exit 2 "Blocks compaction"; SessionStart sources "startup, resume, clear, compact, fork" | none. Note for A4 §3: SessionStart also has `fork` |
| 17 | A2 §3, §4 | Auto memory at `~/.claude/projects/<project>/memory/`, `MEMORY.md` "loaded into every session"; nested CLAUDE.md on demand; AGENTS.md since v2.1.277; `autoMemoryEnabled` | VERIFIED | memory doc: all quoted. MEMORY.md load is capped at "first 200 lines or 25KB" | matrix U→V |
| 18 | A2 §2.10 | Prompt caching: order, 4 breakpoints, 20-block lookback, 0.05× on Opus 5.5, 512–4,096 min | VERIFIED | caching doc: "tools → system → messages"; "The lookback window is 20 blocks"; "Opus 5.5 … 0.05x"; minimums 512 (Opus 5.5) up to 4,096 | none |
| 19 | A2 §2.12a | Copilot Memory citations, validate vs current branch, 28 days, timer reset | VERIFIED (one word) | docs.github.com: quotes present; timer "**may** reset whenever Copilot successfully validates and uses an entry" | "resets" → quoted "may reset" |
| 20 | A2 §2.9 | Context Rot: 18 models, similarity, distractors, shuffled haystacks hurt less | VERIFIED | research.trychroma.com/context-rot (14 Jul 2025): "we evaluate 18 LLMs"; "as needle-question similarity decreases, model performance degrades more significantly"; "Even a single distractor reduces performance"; "Shuffling the haystack … consistently improves performance" | Tag replaced, date added |
| 21 | A2 §2.9 | Lost in the Middle: GPT-3.5 middle position below closed-book ~56% in 20-doc | VERIFIED (slightly broadened) | Table 1 closed-book 56.1%; "in the worst case, performance in 20- and 30-document settings is lower than performance without any input documents" | "20-document" → "20- and 30-document", 56.1% |
| 22 | A2 §2.9 | Context Length Alone Hurts (2510.05381): double-digit drops even with whitespace/masking | VERIFIED | 5 LLMs; "degrades substantially (13.9%–85%)"; whitespace and masking conditions confirmed; Findings of EMNLP 2025 | Figures and venue added |
| 23 | A2 §2.9 | NoLiMa: most models < 50% of short-context score at 32K | VERIFIED | "At 32K, for instance, 11 models drop below 50% of their strong short-length baselines" (13 models evaluated) | Count added |
| 24 | A2 §2.9 | GSM-IC: irrelevant sentence drops accuracy; ignore-instruction helps | VERIFIED | Abstract: "performance is dramatically decreased"; mitigations include "adding to the prompt an instruction that tells the language model to ignore the irrelevant information" | none |
| 25 | A2 §2.9 | Experience-following: error propagation, misaligned replay, selective add + deletion helps | VERIFIED (magnitude modest) | Abstract confirms error propagation and misaligned replay. Table 2: history-based deletion with a strict evaluator helps (EHRAgent 38.67→42.06, CIC-IoT 85.4→89.6), but other agent/strategy combinations lose accuracy | Magnitude stated |
| 26 | A2 §2.12c, §4 | Cognee "memify from feedback" (arXiv:2505.24478); schema-constrained relations; `forget` op | **MISATTRIBUTED (partly)** | arXiv:2505.24478 is "Optimizing the Interface Between Knowledge Graphs and LLMs for Complex Reasoning" (Markovic et al.): hyperparameter tuning of Cognee on HotPotQA / 2Wiki / MuSiQue. It does support "Cognify … schema-based transformations using Pydantic models". It contains **no** memify, feedback loop or forget. Those exist in the Cognee docs (docs.cognee.ai: `memify` legacy op "Enrich a knowledge graph with derived knowledge"; `improve` "apply feedback"; `forget`) | Citation redirected to docs.cognee.ai in §2.12c, matrix row and refs |
| 27 | A2 §2.14a | PrefEval: < 10% after "a few turns (~3k tokens)" | VERIFIED (wording) | "preference following accuracy falls below 10% at merely 10 turns (~3k tokens) across most evaluated models"; 3,000 pairs, 20 topics | "a few turns" → "10 turns" |
| 28 | A2 §2.15, §4 | Letta sleep-time ~5× less test-time compute; +13–18% | VERIFIED | "~ 5x on Stateful GSM-Symbolic and Stateful AIME"; "up to 13% on Stateful GSM-Symbolic and 18% on Stateful AIME"; also 2.5× lower cost per query with Multi-Query | Tag replaced |
| 29 | A2 §2.15, §4 | LightMem large token / API-call reductions | VERIFIED | "reducing total token usage by up to 38x / 20.9x and API calls by up to 30x / 55.5x" (LongMemEval / LoCoMo); ICLR 2026 | Figures added |
| 30 | A2 §4 | MemOS MemCube plaintext/KV/LoRA, versioned | VERIFIED (versioning); lifecycle policies still U | "plaintext, activation-based, and parameter-level memories"; MemCube carries "metadata such as provenance and versioning" | Versioned U→V |
| 31 | A2 §4 | MIRIX 6 stores; active retrieval (topic then search); injected into system prompt | VERIFIED | Six types listed; "the agent is required to generate a topic before answering … and the retrieved information is inputted into the model in the system prompt" | U→V |
| 32 | A2 §4 | Memory-R1 ADD/UPDATE/DELETE/NOOP, RL | VERIFIED | Abstract | none |
| 33 | A2 §4 | A-MEM Zettelkasten notes, keywords/tags, memory evolution | VERIFIED | Abstract | none |
| 34 | A2 §4 | Windsurf auto memories + 4 rule modes | VERIFIED | docs (now docs.devin.ai/desktop/cascade/memories): "Always On", "Manual", "Model Decision", "Glob"; memories "associated with the workspace they were created in" | U→V |
| 35 | A2 §4 | Codex AGENTS.md hierarchical, ~32 KiB | VERIFIED | "project_doc_max_bytes (32 KiB by default)"; "Codex concatenates files from the root down" | U→V |
| 36 | A2 §4 | Cursor Memories folded into rules | NOT CHECKED | docs.cursor.com unreachable from the audit environment | U left |
| 37 | A2 §4, §3 | ChatGPT: saved memories Feb 2024; chat-history reference Apr 2025; profile + recent summaries in system prompt | Dates VERIFIED (secondary: openai.com returned 403; multiple reports give 10 Apr 2025 and Feb 2024). Injection mechanism **not verifiable** (reverse-engineering, no primary source) | U left on mechanism |
| 38 | A2 §4, EDEN-MEMORY §11 | Cue-anchored paper: triggers {path, symbol, semantic, event, temporal}; ≈0 voluntary ops in 114 turns | VERIFIED | arXiv:2607.20972 (Saha, 23 Jul 2026) abstract: "(path, symbol, semantic, event, temporal)"; "voluntary memory use is near zero even with a pre-seeded store (0 memory operations in 114 turns)". Also reports "39% of intra-session re-reads re-buy content paid for before a compaction boundary" | Matrix row and ref updated |
| 39 | A2 §5 | LoCoMo ~300 turns, ~9k tokens | VERIFIED | "each encompassing 300 turns and 9K tokens on avg., over up to 35 sessions" | none |
| 40 | A2 §5 | LongMemEval 500 Qs, five abilities, S ≈ 115k, M ≈ 1.5M | VERIFIED | "LongMemEval S with approximately 115k tokens per problem and LongMemEval M with 500 sessions (around 1.5 million tokens)" | U→V |
| 41 | A2 §5 | MemoryAgentBench "conflict resolution" competency | CORRECTED (naming) | v4 lists "accurate retrieval, test-time learning, long-range understanding, and selective forgetting"; FactConsolidation-SH/MH sit under Selective Forgetting | Renaming noted in table |
| 42 | A2 §5 | BEAM "Beyond a Million Tokens" — arXiv id not verified | **VERIFIED, id supplied** | arXiv:2510.27246 (Tavakoli, Salemi, Ye, Abdalla, Zamani, Mitchell; v1 2025-10-31): 100 conversations, up to 10M tokens, 2,000 questions; 10 abilities incl. Contradiction Resolution, Instruction Following, Preference Following | id added in table and refs |
| 43 | A2 §5 | PersonaMem dynamic preferences | VERIFIED | COLM 2025; "track how the user profiling and preferences evolve over time" | U→V |
| 44 | A2 §2.12b | Generative Agents recency 0.995, α = 1, min-max | VERIFIED | "all αs are set to 1"; "min-max scaling"; decay factor 0.995 in paper HTML | ref note |
| 45 | A2 §2.12b, A3 §3.9 | Petrov 2006 hybrid formula; A&L 1998 approximation | VERIFIED | Preprint Eq. 2 `B ≈ ln(n/(1−d) · t_n^{−d})` and Eq. 3 `ln[Σ_{i=1..k} t_i^{−d} + (n−k)(t_n^{1−d} − t_k^{1−d}) / ((1−d)(t_n − t_k))]` match A2 exactly. Proc. 7th ICCM, pp. 391–392 | Pages added (A2 refs, A3 refs) |
| 46 | A3 §5 | MemoryAgentBench: HippoRAG-v2 41.6 ≈ BM25 41.5 | VERIFIED | MemoryAgentBench main table overall column: BM25 41.5, HippoRAG-v2 41.6 | none |
| 47 | A3 §3.9, §R | Ryan et al. 2015 †, *Science* 348, 1007–1013 | VERIFIED | Crossref 10.1126/science.aaa5542: Ryan, 2015, Science 348, 1007–1013, "Engram cells retain memory under retrograde amnesia" | † → ✓ |
| 48 | A3 §3.3, §R | Posner & Cohen 1984, *Attention and Performance X*, pp. 531–556 † | VERIFIED | No DOI. Multiple bibliographic records (PhilPapers, SCIRP reference lists) plus a hosted chapter PDF (utoronto course readings) give Bouma & Bouwhuis (Eds.), Erlbaum, pp. 531–556 | † → ✓ |
| 49 | A3 §R | Smith & Vela 2001 volume/pages † | VERIFIED | Crossref: *Psychon Bull Rev* 8, 203–220 | † removed |
| 50 | A3 §R | McDaniel & Einstein 2000 pages † | VERIFIED | Wiley record: *Appl Cogn Psychol* 14, S127–S144 (Crossref has no page field) | † removed |
| 51 | A3 §5, §R | HippoRAG arXiv:2405.14831 †, NeurIPS 2024 | VERIFIED | arXiv comment "NeurIPS 2024" | † → ✓ |
| 52 | A3 §5, §R | EM-LLM arXiv:2407.09450 †, "Human-like episodic memory…" | **CORRECTED (title)** | Actual title "Human-inspired Episodic Memory for Infinite Context LLMs"; journal_ref ICLR 2025 | Title fixed, † → ✓ |
| 53 | A3 §5, §R | Titans arXiv:2501.00663 †, 2025 | VERIFIED | Behrouz, Zhong, Mirrokni; v1 posted 2024-12-31 (id is a Jan-2025 id) | † → ✓, date note |
| 54 | A3 §R | Cue-anchored arXiv:2607.20972 † | VERIFIED | see row 38 | Full reference written |
| 55 | A3 §3.12, §5 | Liu et al. 2024 TACL 12, 157–173 | VERIFIED | Crossref 10.1162/tacl_a_00638 | none |
| 56 | A3 §3.10, §3.6, §3.14 | Untagged bio figures (Dasgupta: ~50 PN types → ~2,000 KCs, ~6 inputs, 40×, ~5% active; Tse 48 h; Kaech 90–95% contraction) | NOT RE-QUOTED | PubMed abstracts confirm each paper's topic and claim direction; the specific figures sit in paywalled full text and were not re-quoted. They are standard values for these papers. No edit | none |

## 4. Out-of-scope "unverified" tags left in A2

These are engineering or measurement claims with no single primary source. They need a local benchmark, not a citation, so the tags stay:

- int8 ONNX MiniLM query latency and 100–300 ms runtime cold load (§2.1)
- static-embedding mmap load time (§2.1)
- `O_APPEND` atomicity on APFS; `F_FULLFSYNC` ~10× (§2.4)
- trigram index ~3× size (§2.5); no maintained Bun binding for tantivy (§2.5)
- `bun build --compile` startup (§2.8)
- Claude Code's own `cache_control` placement; whether CLAUDE.md / MEMORY.md reload mid-session (§2.10)
- NLI cross-encoder 10–30 ms/pair (§2.12c)
- product write-policy guidance "verbatim" (§2.14c)
- ChatGPT injection mechanism (§3, §4)
- "no public benchmark measures restatement / redundant injection" (§5; also A5 §1). This is a negative claim. BEAM, PrefEval, PersonaMem and MemoryAgentBench, all checked here, do not measure (i)–(iv), which is consistent with the claim. The cue-anchored paper does measure re-read waste ("39% of intra-session re-reads re-buy content"), the closest published measurement to G5 redundancy.

## 5. A4 / A5 / A6

A4, A5 and A6 contain no literature citations. Their external facts are Claude Code hook behaviour, all covered above (rows 12–17): additionalContext placement, cache interaction and compaction hooks. A4 §3's epoch-bump list (`SessionStart(startup|resume|clear|compact)`) is consistent with the doc; the doc also lists a `fork` source, which A4 does not mention. A5 §1's "no public benchmark measures G1/G5" is covered in §4 above. No edits were made to A4–A6 (out of scope).

## 6. Corrections that affect recommendations

None of the corrections requires changing a recommendation. Three weaken the evidence behind one, and are listed for the owners of A2 and A4:

1. **Zep knowledge-update gains (row 4).** A2 §2.7 and the §4 "Pattern across the matrix" line ("every system that scores well on knowledge-update keeps history and invalidates (Zep, …)") leaned on Zep's own LongMemEval numbers. Those show only a small knowledge-update gain (+6.5%), and a *loss* with gpt-4o-mini. The bitemporal / invalidate-not-delete recommendation still stands on Zhou et al. (Zep leads Knowledge Update, 44.4 Substr. EM). But Zhou attribute that lead to graph/relation organisation, not to invalidation. The "pattern" sentence in §4 is left as written. It is now an inference, not a finding.
2. **Zhou MemOS 25.5 → 2.5 EM (row 7).** This holds on LoCoMo only. On LongMemEval, fine extraction was slightly better. "Write wide, filter late" (A2 §2.14c) is still supported by the authors' own conclusion, but the evidence is one benchmark, not both.
3. **Cognee memify citation (row 26).** A2 §2.12c's "feedback → invalidation" idea is product precedent from the Cognee docs, not a paper result. No peer-reviewed support was found for the "failed command prioritises a fact check" heuristic. The recommendation is unchanged: it is a sleep-time priority signal, low risk.

Minor, no recommendation impact: the static-embedding speedup range (100–400× vs mpnet/e5, not MiniLM), the v2.1.248 JSON rule (half-JSON with no closing brace is treated as plain text, not dropped, so "never print half-JSON" is still right), and Copilot's timer "may" reset.

## 7. Fabricated or misattributed references

- **Fabricated arXiv ids: none.** All 33 ids resolve. Both 2026 ids (2606.24775, 2607.20972) exist and match the content described.
- **Misattributed:** arXiv:2505.24478 was cited for Cognee's "memify from feedback" loop and `forget` op. The paper is a hyperparameter-tuning study and contains neither. Redirected to docs.cognee.ai.
- **Wrong title:** EM-LLM ("Human-like" → "Human-inspired").
- **Missing id supplied:** BEAM = arXiv:2510.27246.
