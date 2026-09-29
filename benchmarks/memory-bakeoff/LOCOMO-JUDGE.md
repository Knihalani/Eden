# Achieving Mem0-class ~92% LoCoMo (judge protocol)

Mem0 Cloud’s **92.5%** is **not** retrieve@5. It is roughly:

1. **Ingest** dialogue with LLM fact extraction (or store-all + graph)
2. **Retrieve** top-k notes (often large k; Cloud uses up to `top_200`)
3. **Answerer LLM** writes a natural-language answer from those notes
4. **Judge LLM** scores answer vs gold (exact / semantic)

Our bakeoff measures step 2 only (gold string in top-5 notes). Eden is at **~32% retrieve@5** on full LoCoMo; that is a different number.

## Realistic targets on this codebase

| Target | What to build | Est. vs Cloud |
|---|---|---|
| A. Retrieve@5 ≥ BM25 (done) | extract + rank | Eden **32%** > BM25 **18%** |
| B. Retrieve@5 ≥ Mem0 store-all dense | embeddings or store-more | Mem0 store-all ~40% on 3-conv subset |
| C. Paper-style OSS Mem0 (~67% J) | LLM extract + answerer + judge, gpt-4o-mini | Needs API key |
| D. Cloud-style ~92% J | managed extract + large top-k + tuned judge | Needs API key + close judge prompt |

## Recipe for C/D (run when you have a key)

```bash
export OPENAI_API_KEY=sk-...   # or OPENROUTER_API_KEY
# 1) Store: either Eden observe-all turns, or mem0 infer=True
# 2) For each LoCoMo Q: retrieve k=10..50 notes
# 3) Answerer: "Answer using only the memories below…"
# 4) Judge: LoCoMo-style binary/partial credit

bun benchmarks/memory-bakeoff/locomo-judge.ts   # when implemented + key present
```

Without a live LLM key we **cannot** reproduce 92% on this machine. Install Ollama + a strong instruct model is a weaker local substitute (expect well below Cloud).

## Product path (what we are doing instead)

- Never drop durable personal/eng facts on passive ingest (extract + style retrieve)
- Inject matching notes into every agent turn (hooks + wrap)
- Optionally later: embedding retrieve + optional answerer for a published judge score
