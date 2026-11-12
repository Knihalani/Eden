# F1's lab scripts (docs/research/f1-intent-bridge.md)

Lab only; sim data only. Paths are the ones the note's runs used (`.local/f1/…`); pass others by editing the top lines.

- Models: Xenova/multilingual-e5-small, -base, -large and paraphrase-multilingual-MiniLM-L12-v2 from Hugging Face
  (`onnx/model_quantized.onnx` and `tokenizer.json` into `.local/f1/models/<name>/`; not checked in). Python 3 with
  `tokenizers`, `onnxruntime`, `numpy` in a venv (`.local/f1/venv`). Mean pooling, L2-normalised; e5 with `query:` /
  `passage:` prefixes.
- Exports: `bun packages/sim/src/lab/m11-export.ts --suites train,reworded,longtail --seeds 41-44 --out .local/f1/x`
  (and `--suites dev20 --out .local/f1/x20`): items with card keys and the checked-in requests, worlds with each task's
  planted key (hidden: the fact, control: the look-alike).
- Pools: `bun run funnel --suite S --seeds 41,42,43,44 -- --pool-dump .local/f1/pool-S.jsonl --neutral --ask`.
- `prep.py` + `enc_requests.py` + `gain_requests.py`: requests against the anticipated requests (§2).
  `enc_items.py X MODEL` + `gain_items.py X MODEL POOLS K TAU`: requests against item title and head, counted where the
  planted item was not in the pool's first 15 (§8). `extras.py X MODEL K` writes each task's top-k item keys for
  `packages/sim/src/lab/f1-check-pilot.ts`, which builds the push check's exact prompts; `pilot_score.py` scores the
  answers (`ans-*.jsonl`).
- `run.sh`, `credit.sh`: the pre-registered paid runs (blocked by the credit; see the note).
