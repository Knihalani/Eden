"""M3 retriever (D900): CPU cost of a trained model, one thread (the request path's share of a core).

dense/asym: item encoding at ingest (ONNX, fp32 and dynamic int8, ms an item at the eval's text length), the query
(dense: ONNX encode; asym: token-table lookup), and scoring a user's 3,000 int8 item vectors (numpy, one dot). sparse:
item expansion at ingest (ONNX MLM), the request's score as a sparse lookup over 3,000 items' expansion terms.
Memory a user: item vectors (3,000 x dim bytes) or expansion postings (nnz x (id, weight) bytes).

  .venv-m3/bin/python packages/sim/lab/m3r/cpu_bench.py --model DIR --family dense --eval eval.jsonl.gz
"""
import argparse, gzip, json, os, time
import numpy as np

def eval_texts(path, n_items=300, n_req=200):
    items, reqs = [], []
    with gzip.open(path, "rt") as f:
        for line in f:
            w = json.loads(line)
            if not w["key"].startswith("days/"):
                continue
            items += [i["text"] for i in w["items"][:n_items]]
            reqs += [r["request"] for r in w["requests"]]
            if len(items) >= n_items:
                break
    return items[:n_items], reqs[:n_req]

def export(model_dir, family, out):
    import torch
    from transformers import AutoModel, AutoModelForMaskedLM, AutoModelForSequenceClassification, AutoTokenizer
    tok = AutoTokenizer.from_pretrained(model_dir)
    cls = {"sparse": AutoModelForMaskedLM, "rerank": AutoModelForSequenceClassification}.get(family, AutoModel)
    m = cls.from_pretrained(model_dir).eval()
    b = tok(["hello world"], return_tensors="pt")
    names = [n for n in ("input_ids", "attention_mask", "token_type_ids") if n in b]

    class Wrap(torch.nn.Module):
        def __init__(s, m): super().__init__(); s.m = m
        def forward(s, *a):
            o = s.m(**dict(zip(names, a)))
            return o.logits if family in ("sparse", "rerank") else o.last_hidden_state

    dyn = {n: {0: "b", 1: "t"} for n in names}
    torch.onnx.export(Wrap(m), tuple(b[n] for n in names), out, input_names=names, output_names=["out"],
                      dynamic_axes={**dyn, "out": {0: "b", 1: "t"}}, opset_version=17, dynamo=False)
    from onnxruntime.quantization import quantize_dynamic, QuantType
    q = out.replace(".onnx", ".int8.onnx")
    quantize_dynamic(out, q, weight_type=QuantType.QInt8)
    return tok, names, q

def session(path):
    import onnxruntime as ort
    o = ort.SessionOptions(); o.intra_op_num_threads = 1; o.inter_op_num_threads = 1
    return ort.InferenceSession(path, o, providers=["CPUExecutionProvider"])

def timed(fn, xs, reps=1):
    t = time.perf_counter()
    for _ in range(reps):
        for x in xs: fn(x)
    return (time.perf_counter() - t) * 1000 / (len(xs) * reps)

if __name__ == "__main__":
    a = argparse.ArgumentParser()
    a.add_argument("--model", required=True); a.add_argument("--family", required=True)
    a.add_argument("--eval", required=True); a.add_argument("--max-len", type=int, default=256)
    o = a.parse_args()
    items, reqs = eval_texts(o.eval)
    out = os.path.join(o.model, "model.onnx")
    tok, names, q8 = export(o.model, o.family, out)
    res = {"family": o.family, "model": o.model, "fp32_mb": round(os.path.getsize(out) / 2**20, 1),
           "int8_mb": round(os.path.getsize(q8) / 2**20, 1)}
    for tag, path in (("fp32", out), ("int8", q8)):
        s = session(path)
        def run(texts, ml):
            b = tok(texts, truncation=True, max_length=ml, return_tensors="np")
            return s.run(None, {n: b[n].astype(np.int64) for n in names})[0]
        if o.family == "rerank":
            # One request's candidates scored in one batch: the request against 60 items (lexical 50 + first stage).
            def pairs(r):
                b = tok([r] * 60, items[:60], truncation="only_second", max_length=o.max_len, padding=True,
                        return_tensors="np")
                return s.run(None, {n: b[n].astype(np.int64) for n in names})[0]
            res[f"request_ms_60_pairs_{tag}"] = round(timed(pairs, reqs[:10]), 1)
            continue
        res[f"ingest_ms_item_{tag}"] = round(timed(lambda t: run([t], o.max_len), items[:100]), 2)
        if o.family == "dense":
            res[f"query_ms_{tag}"] = round(timed(lambda t: run([t], 64), reqs[:100]), 2)
    rng = np.random.default_rng(0)
    if o.family in ("dense", "asym"):
        dim = 384
        V = rng.integers(-127, 128, size=(3000, dim), dtype=np.int8)
        qv = rng.integers(-127, 128, size=dim, dtype=np.int8)
        res["score_3000_ms"] = round(timed(lambda _: np.argpartition(-(V.astype(np.int32) @ qv.astype(np.int32)), 15)[:15], range(200)), 3)
        res["user_bytes_3000"] = 3000 * dim
    print(json.dumps(res))
