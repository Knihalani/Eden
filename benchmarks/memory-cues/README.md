# CueBench-code (memory cue experiment)

Fixture and scripts behind `docs/memory-ship/research/R1-cue-experiment.md` (2026-09-29).

- `fixture/`: 214 memories (6 scopes, including 30 policy/preference rows) and 666 cues (476 hand-written, 190 written by Qwen2.5-3B). Cues fall into lex / para / natural / ctx / indirect / policy / negative categories, with gold ids. The dev/test split is grouped by gold memory.
- `out/`: result tables, latency and sanity outputs. The large feature dumps were not kept.
- Scripts were written against a session scratchpad; some contain absolute paths. Models (Model2Vec potion, bge-small int8 ONNX, ms-marco cross-encoder, Qwen2.5-3B, Phi-3.5-mini) are **not** vendored. `dl.py` re-downloads them. The run order is in R1 §8.

Caveat: synthetic single-repo fixture; one author wrote both the memories and the hand cues. Use it for relative comparisons.

## NIM re-run (R8, `docs/memory-ship/research/R8-nim-experiments.md`)

- `fixture/cues-nim.json`: split `test_nim`, 558 cues written by kimi-k3 via NVIDIA NIM (400 zero-overlap paraphrases `nim-para`, 60 policy-need `nim-policy`, 98 hard negatives `nim-neg`). Never used for tuning. `gold_orig_split` records whether the gold memory is a dev or a test memory.
- `fixture/extraction-e3.json`: 330 hand-annotated synthetic user phrasings for slot / policy / intent extraction (D7 / D9 schema). Batch B (60) was written after the regex extractor was frozen.
- `fixture/aliases-{gemma,nemosuper,gptoss20b}.json`: blind doc2query aliases from gemma-4-31b, nemotron-3-super and gpt-oss-20b.
- `nim/`: scripts (`nim.py` is the cached, throttled NIM client; it reads `NVIDIA_API_KEY` from the repo `.env` at call time and never stores it). `eval.py`, `features.ts`, `py_features.py` and `m0.ts` there are the R1 scripts plus `CUES` / `OUT_SFX` parameters. `nim/out/`: results, raw LLM extraction outputs and the per-call log (`calls.jsonl`: model, latency, tokens). Run order is in R8 §7.
