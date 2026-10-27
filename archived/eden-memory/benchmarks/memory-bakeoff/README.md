# Memory bakeoff

Live comparison of Eden memory (passive ingest + inject + retrieve) against
architectural stand-ins of the 2026 agent-memory field, plus LoCoMo retrieval
on the public Snap Research dataset.

```bash
bun benchmarks/memory-bakeoff/run.ts
```

Writes `last-run.json`. LoCoMo is cached at `/tmp/eden-mem-bakeoff/locomo10.json`.

## Protocol (what this is / is not)

| This run | Vendor LoCoMo / LongMemEval headlines |
|---|---|
| Retrieval hit@5: gold string (or all content tokens) in top-5 notes | LLM answerer + LLM judge on retrieved context |
| Passive inject: `observe` then `inject(asked)` contains gold | Same, plus prompt-tuned judges |
| Cats 1–4 of LoCoMo (1540 Q); skip adversarial cat 5 | Same convention |
| No Mem0/Zep/Letta SaaS (no live vendor keys here) | Hosted products |

Do not compare our 10% LoCoMo **retrieve** number to Mem0 Cloud’s 92% **judge** number. Those are different metrics. The Mem0 **paper** (ECAI 2025, gpt-4o-mini, OSS-shaped stack) is **~67% J** on LoCoMo; the **92.5 / 94.4** figures are the managed platform with `top_200` and are not what `pip install mem0ai` scores. Independent LongMemEval on OSS-default extract is in the **44–74%** band. A long-context model that sees the whole dialogue will beat every memory layer on LoCoMo; the reason to ship memory is cost, latency, and focused context.

**Pre-registered product-bet rule:** if Eden loses LoCoMo retrieve to BM25-on-raw-turns, the extract filter is the bug, not the ranker. **This run: Eden 32.4% vs BM25 17.6%** — extract+rank now beat dump-everything BM25 on full LoCoMo. Mem0 store-all dense still leads on a 3-conversation subset (40.5%) because it keeps every turn and uses embeddings.

## Measured (this machine, 2026-09-08)

Passive suite: 29 capture cases (eng / personal / update / paraphrase / buried) plus 8 junk probes. Gold is ingested **first**, then 10 distractors, then retrieve/inject. `lastk=8` therefore drops the gold — that is the working-memory failure mode.

| System | Passive | Eng | Personal | Junk stored | Notes |
|---|---|---|---|---|---|
| **eden** | **28/29 (97%)** | **17/17** | **6/7** | **0/8** | only miss: `per-terse` |
| **mem0-storeall** (OSS, `infer=False` + FastEmbed) | **29/29** | 17/17 | 7/7 | ~8/8 | stores everything; dense retrieve |
| **memfabric** (OSS, SQLite FTS) | **25/29** | 17/17 | 5/7 | ~8/8 | zero-LLM |
| store-all + overlap | 23/29 | — | — | 7/8 | lexical stand-in |
| store-all + BM25 | 23/29 | — | — | 7/8 | RAG stand-in |
| lastk (Letta-core analogue) | 5/29 | — | — | 8/8 | working-memory failure |
| mem0-ollama (`llama3.2:1b` extract) | smoke **6/6** | — | — | — | full 29 aborted (~12min+, JSON parse errors) |

LoCoMo retrieval@5, cats 1–4 (no LLM judge):

| System | hit@5 | rate | scope |
|---|---|---|---|
| **eden** | **499/1540** | **32.4%** | full 10 conv |
| **memfabric** | **403/1540** | **26.2%** | full 10 conv |
| store-all BM25 | 271/1540 | 17.6% | full 10 conv |
| store-all overlap | 237/1540 | 15.4% | full 10 conv |
| lastk | 20/1540 | 1.3% | full 10 conv |
| **mem0-storeall** | **156/385** | **40.5%** | **first 3 conv only** (dense ingest cost) |

Eden now **beats BM25 and overlap on full LoCoMo** (was 10.1% on 2026-09-07). Mem0 store-all dense leads on the 3-conversation subset but stores junk and is ~150× slower to ingest.

Live OSS packages also attempted: see `competitors-local.py` / `competitors-local.json`. **Could not fair-run without cloud LLM:** Cognee, Graphiti (needs OpenAI-class embedder despite Kuzu), Letta, LangMem, Memobase, SuperMemory/Zep Cloud.

Know (encyclopedia, not chat memory):

| Surface | Score | Notes |
|---|---|---|
| `knowQuery` | 4/5 | Kenya capital, RFC 9110, jq used-for hit; ripgrep miss on this wording |
| `injectFromText` | 2/5 | The 2 hits are **silence on junk**. jq / ripgrep / RFC 9110 did **not** inject — inject is gated to `used for …` / RFC successor phrasing |

## Top 10 public systems (literature, not this run)

Headline LoCoMo / LongMemEval numbers are vendor-run unless marked independent. Independent reproductions often drop 20+ points. Sources: Mem0 research page; Zep/Graphiti paper; [Maximem claimed-vs-observed](https://www.maximem.ai/blog/state-of-ai-memory-2026-claimed-vs-observed); [AutoMem 2026 comparison](https://automem.ai/blog/agent-memory-in-2026-an-honest-comparison-of-mem0-zep-letta-and-the-rest); [Mnemoverse Q3 2026](https://mnemoverse.com/docs/library/ai-memory-solutions-2026-q3); Vectorize/Hindsight evals.

| # | System | Architecture | Claimed (vendor) | Independent / caveat | vs Eden |
|---|---|---|---|---|---|
| 1 | **Mem0** | LLM extract + vector (+ light graph) | Cloud LoCoMo **92.5**, LME **94.4**; paper OSS-stack LoCoMo **J 66.9** | Maximem LME **73.8** hosted; Atlaso OSS-default **44.2** LME-S; Vectorize **49.0** | Compare Eden to OSS-default, not Cloud. No LLM extract here. |
| 2 | **Zep / Graphiti** | Bi-temporal knowledge graph | LongMemEval ~71 (gpt-4o); own DMR bench | Vectorize LongMemEval **63.8**; LoCoMo once corrected ~58 | Temporal “what was true in March”. Eden has `at` stamps, no bi-temporal graph. |
| 3 | **Letta / MemGPT** | Agent-curated core / archival tiers | Strong on their leaderboard | No standard LoCoMo/LongMemEval they publish | Working memory + paging. Eden `lastk` analogue dies on LoCoMo (1.3%). |
| 4 | **SuperMemory** | Hosted long-term memory | LongMemEval-S ~81.6 | Competitor-run only | Hosted SaaS. Eden is local jsonl. |
| 5 | **Cognee** | Ontology / graph RAG | Few standard scores | Research-leaning | Heavier than Eden; needs LLM + graph store. |
| 6 | **LangMem / LangGraph store** | Framework memory primitives | No standard LoCoMo | “Recent-turn + KV” class | Closest cousin to Eden `notesFor`, but they expect embeddings. |
| 7 | **AutoMem** | Relational / temporal | LoCoMo 84.7, LongMemEval 87 (their harness) | Self-run with hashes | Different target (relationships). |
| 8 | **Memori** | Structured memory | Own table ~82 LoCoMo; puts Mem0 last in their table | Vendor-vs-vendor | Not reproduced here. |
| 9 | **Hindsight / Vectorize** | Eval harness + memory product | Hindsight LongMemEval **94.6** in their comparison | They also measured Mem0 49 / Zep 64 | Eval shop, not an Eden replacement. |
| 10 | **Memobase / Synap / Mastra** | Hosted or framework memory | Mastra LongMemEval ~95 claimed | Same judge-prompt problem as the field | Not runnable without their cloud. |

**Cannot live-run 1–10 here:** no Mem0/Zep/Letta/OpenAI keys. `OPENROUTER_API_KEY` in this environment is a placeholder (`your_…`), so the Mem0-class LLM extractor was skipped rather than faked.

## Ready for real use?

**For a local coding-agent sidecar (Claude Code hooks, engineering chat):** yes, with a tight contract. Passive `observe`/`inject` stores ops facts, rejects chatter/secrets, retrieves in well under a millisecond, and the packed know graph answers a small encyclopedia (capitals, RFC titles, jq). That is what the `/whatever` holdout optimized.

**For a general “ChatGPT memory / Mem0 / Zep” product:** no.

Blockers, from this run plus the code:

1. Extractor still drops some personal phrasing (`per-terse`); LoCoMo multi-hop/temporal (cats 1–2) stay weak vs single-hop.
2. Retrieve is lexical (IDF + bonuses), not embeddings — Mem0 store-all dense wins paraphrase-heavy subsets when it can embed every turn.
3. Know **inject** is narrower than know **query**.
4. Cap 2000 rows, jsonl, no multi-tenant graph, no bi-temporal validity.
5. Vendor SOTA headlines use LLM answerer+judge. This bakeoff is retrieve@5 only.

## Files

- `cases.ts` — passive capture / junk / know-inject probes
- `run.ts` — Eden, lastk, overlap, BM25, optional OpenRouter LLM extract
- `competitors-local.py` — real OSS packages (mem0ai, memfabric, optional Ollama)
- `competitors-local.json` — last OSS competitor report
- `last-run.json` — last Eden / stand-in measured report
