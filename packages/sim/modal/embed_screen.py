"""An embedding retrieval screen on Modal (M0, lab tooling): the train suites' corpus dump embedded with an open model
on a GPU, and for each hidden task whether the planted item ranks in the top k by similarity to the request, against
Eden's lexical pool (the funnel's `pushPoolAt`), especially for planted items that share no word with the request
(A15's target set; D331 (4) screened all-MiniLM-L6-v2 on CPU). Scoring is embed_score.py, tested without Modal.

    bun run funnel --suite train --seeds 41,42,43,44 --json .local/modal/embed/funnel.json \
        -- --corpus-dump .local/modal/embed/corpus.jsonl                                  # local, $0
    modal run packages/sim/modal/embed_screen.py --corpus .local/modal/embed/corpus.jsonl \
        --funnel .local/modal/embed/funnel.json [--model Qwen/Qwen3-Embedding-0.6B] [--ks 1,5,10] \
        [--pools .local/modal/embed/pool.jsonl --hybrid-ks 3,5,10]           # M3's hybrid (funnel --pool-dump)

Only planted ids, ranks and the top ids come back; the corpus is simulated (generated worlds), never user data.
"""
import json
import os
import sys
import time

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import embed_score as es  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
# Open embedding models and how each wants its query phrased (sentence-transformers' prompt names).
MODELS = {
    "Qwen/Qwen3-Embedding-0.6B": {"query_prompt": "query", "licence": "Apache-2.0"},
    # M3's larger model: half precision so 4B parameters and their activations fit an L4's 24 GB.
    "Qwen/Qwen3-Embedding-4B": {"query_prompt": "query", "licence": "Apache-2.0", "half": True, "batch": 32},
    "BAAI/bge-large-en-v1.5": {"query_prefix": "Represent this sentence for searching relevant passages: ",
                               "licence": "MIT"},
    "sentence-transformers/all-MiniLM-L6-v2": {"licence": "Apache-2.0"},
}
DEFAULT_MODEL = "Qwen/Qwen3-Embedding-0.6B"
TOP = 20

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch==2.8.0", "sentence-transformers==5.1.1", "transformers==4.56.2", "numpy==2.3.3")
    .env({"HF_HOME": "/cache/hf"})
    .add_local_python_source("embed_score")
)
cache = modal.Volume.from_name("eden-embed-cache", create_if_missing=True)
app = modal.App("eden-embed-screen", image=image)


@app.function(gpu="L4", volumes={"/cache": cache}, timeout=2 * 3600)
def embed_remote(model: str, texts: list, worlds: list) -> dict:
    """Each world's items and requests embedded (normalised), each task's planted rank and top ids by cosine."""
    import numpy as np
    from sentence_transformers import SentenceTransformer

    t0 = time.time()
    spec = MODELS.get(model, {})
    kw = {"model_kwargs": {"torch_dtype": "float16"}} if spec.get("half") else {}
    m = SentenceTransformer(model, device="cuda", **kw)
    E = m.encode(texts, batch_size=spec.get("batch", 128), normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
    requests = [t["request"] for w in worlds for t in w["tasks"]]
    if "query_prompt" in spec:
        Q = m.encode(requests, prompt_name=spec["query_prompt"], batch_size=spec.get("batch", 32),
                     normalize_embeddings=True, convert_to_numpy=True)
    else:
        Q = m.encode([spec.get("query_prefix", "") + r for r in requests], normalize_embeddings=True,
                     convert_to_numpy=True)
    out, qi = [], 0
    for w in worlds:
        W = E[np.array(w["items"], dtype=np.int64)]
        for t in w["tasks"]:
            sims = W @ Q[qi]
            qi += 1
            rank = es.rank_of(sims.tolist(), t["planted"]) if t["planted"] >= 0 else -1
            top = np.argsort(-sims)[:TOP].tolist()
            out.append({"key": w["key"] + [t["template"]], "rank": rank, "top": top})
    cache.commit()
    return {"tasks": out, "texts": len(texts), "dim": int(E.shape[1]), "seconds": round(time.time() - t0)}


@app.local_entrypoint()
def main(corpus: str, funnel: str, model: str = DEFAULT_MODEL, ks: str = "1,5,10", run: str = "", pools: str = "",
         hybrid_ks: str = "3,5,10"):
    worlds = es.load_corpus(corpus)
    es.check_train(worlds)
    rows = es.funnel_rows(funnel)
    texts, packed = es.pack(worlds)
    print(f"{len(worlds)} worlds, {len(texts)} unique item texts, {sum(len(w['tasks']) for w in packed)} tasks; "
          f"model {model}")
    got = embed_remote.remote(model, texts, packed)
    ranks = {tuple(t["key"]): t["rank"] for t in got["tasks"] if t["rank"] > 0}
    k = tuple(int(x) for x in ks.split(","))
    summary = es.screen(worlds, ranks, rows, k)
    run = run or f"{model.split('/')[-1]}-{time.strftime('%Y%m%d-%H%M%S')}"
    out = os.path.join(ROOT, ".local", "modal", "embed", run)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "ranks.jsonl"), "w") as f:
        for t in got["tasks"]:
            f.write(json.dumps(t) + "\n")
    report = es.lines(summary, model)
    hybrid = None
    if pools:
        # M3's hybrid: the lexical pool (`--pool-dump`, ids only) fused with the embedding's top k.
        ids = {(w["suite"], w["seed"], w["variant"]): [x["id"] for x in w["items"]] for w in worlds}
        tops = {tuple(t["key"]): [ids[tuple(t["key"][:3])][i] for i in t["top"]] for t in got["tasks"]}
        hk = tuple(int(x) for x in hybrid_ks.split(","))
        hybrid = es.hybrid(worlds, tops, es.load_pools(pools), hk)
        report += es.hybrid_lines(hybrid, model)
    with open(os.path.join(out, "report.json"), "w") as f:
        json.dump({"model": model, "corpus": corpus, "funnel": funnel, "seconds": got["seconds"], "dim": got["dim"],
                   "summary": summary, "pools": pools, "hybrid": hybrid}, f, indent=2)
    with open(os.path.join(out, "report.txt"), "w") as f:
        f.write("\n".join(report) + "\n")
    print("\n".join(report))
    print(f"embedded in {got['seconds']} s on an L4; {out}")
