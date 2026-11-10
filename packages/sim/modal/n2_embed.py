"""N2 (D511, docs/research/n2-recall.md): the `pushWiden` trial's embedding table on Modal, lab tooling. M3's model
(Qwen3-Embedding-0.6B, `embed_screen.py`) embeds every item of the train worlds of a funnel `--corpus-dump`, the
neutral worlds included, and writes, per (suite, seed, variant, request), the 20 item ids nearest the request. The
funnel reads the table with `--widen-table` (`packages/sim/src/lab/n2-widen.ts`) as the engine's `widen` dependency.

    bun run funnel --suite train --seeds 41,...,48 -- --neutral --corpus-dump .local/n2/corpus.jsonl   # local, $0
    modal run packages/sim/modal/n2_embed.py --corpus .local/n2/corpus.jsonl --out .local/n2/widen.jsonl.gz

Simulated worlds only; only ids come back.
"""
import gzip
import json
import os
import sys

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import embed_score as es  # noqa: E402
from embed_screen import DEFAULT_MODEL, MODELS, cache, image  # noqa: E402

TOP = 20
app = modal.App("eden-n2-embed", image=image.add_local_python_source("embed_screen"))


@app.function(gpu="L4", volumes={"/cache": cache}, timeout=3600)
def embed_top(model: str, texts: list, worlds: list) -> list:
    import numpy as np
    from sentence_transformers import SentenceTransformer

    spec = MODELS.get(model, {})
    m = SentenceTransformer(model, device="cuda")
    E = m.encode(texts, batch_size=128, normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
    requests = [t["request"] for w in worlds for t in w["tasks"]]
    Q = m.encode(requests, prompt_name=spec["query_prompt"], batch_size=32, normalize_embeddings=True,
                 convert_to_numpy=True)
    out, qi = [], 0
    for w in worlds:
        W = E[np.array(w["items"], dtype=np.int64)]
        for _t in w["tasks"]:
            out.append(np.argsort(-(W @ Q[qi]))[:TOP].tolist())
            qi += 1
    cache.commit()
    return out


@app.local_entrypoint()
def main(corpus: str, out: str, model: str = DEFAULT_MODEL):
    worlds = es.load_corpus(corpus, variants=("hidden", "control", "neutral"))
    es.check_train(worlds)
    texts, packed = es.pack(worlds)
    print(f"{len(worlds)} worlds, {len(texts)} unique texts, {sum(len(w['tasks']) for w in packed)} tasks; {model}")
    tops = embed_top.remote(model, texts, packed)
    k = 0
    with gzip.open(out, "wt") as f:
        for w in worlds:
            ids = [x["id"] for x in w["items"]]
            for t in w["tasks"]:
                f.write(json.dumps({"suite": w["suite"], "seed": w["seed"], "variant": w["variant"],
                                    "template": t["template"], "request": t["request"],
                                    "top": [ids[i] for i in tops[k]]}) + "\n")
                k += 1
    print(f"wrote {k} rows to {out}")
