"""I1's checker as a CPU sidecar the lab calls (D471, docs/research/i1-checker.md). Lab only, not product code.

    python3 -I sidecar.py serve --model DIR [--port 8471] [--threads 1]      # POST /score
    python3 -I sidecar.py bench --model DIR --pairs PAIRS.jsonl [--threads 1] [--k 15] [--n 300]
    python3 -I sidecar.py score --model DIR --pairs PAIRS.jsonl --out SCORES.jsonl
    python3 -I sidecar.py serve --oracle LABELS.jsonl --pairs PAIRS.jsonl [--port 8472]   # I2: the teacher's labels

DIR holds `model.onnx`, `tokenizer.json` and `report.json` (`packages/sim/modal/i1_checker.py`). Needs `onnxruntime`,
`tokenizers` and `numpy`. `/score` takes {"request": str, "items": [{"title": str, "text": str}]} and answers
{"scores": [p, ...]}: the sigmoid of the cross-encoder's logit per item, in order. Simulated worlds' text only.
"""
import argparse
import json
import os
import statistics
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort
from tokenizers import Tokenizer

MAX_ITEMS = 40


class Checker:
    def __init__(self, folder, threads=1, max_len=None):
        meta = json.load(open(os.path.join(folder, "report.json")))
        self.inputs = meta["inputs"]
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = threads
        opts.inter_op_num_threads = 1
        path = os.path.join(folder, "model.int8.onnx")
        if not os.path.exists(path) or os.environ.get("I1_FP32"):
            path = os.path.join(folder, "model.onnx")
        self.session = ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])
        self.tok = Tokenizer.from_file(os.path.join(folder, "tokenizer.json"))
        self.tok.enable_truncation(max_length=max_len or meta.get("max_len", 320), strategy="only_second")
        self.tok.enable_padding()

    def scores(self, request, items):
        if not items:
            return []
        enc = self.tok.encode_batch([(request, f"{it['title']}\n{it['text']}") for it in items])
        feed = {}
        for name in self.inputs:
            field = {"input_ids": "ids", "attention_mask": "attention_mask", "token_type_ids": "type_ids"}[name]
            feed[name] = np.array([getattr(e, field) for e in enc], dtype=np.int64)
        logits = self.session.run(["logits"], feed)[0].reshape(-1)
        return (1 / (1 + np.exp(-logits))).tolist()


class OracleChecker:
    """I2 (D492): the teacher's own labels as the checker, an upper bound for any distilled one (not shippable: a
    model call a push). Looks each (request, item) up by the request and `i1-label.ts`'s hash of the item's title and
    text; an item the teacher did not label scores 0 and is counted (`misses`)."""

    def __init__(self, pairs, labels):
        import hashlib

        self.h = lambda t: hashlib.sha256(t.encode()).hexdigest()[:10]
        y = {(x["group"], x["key"]): x["y"] / 100.0 for x in groups_of(labels)}
        self.by = {}
        for g in groups_of(pairs):
            for it in g["items"]:
                if (g["group"], it["key"]) in y:
                    self.by[(g["request"], self.h(f"{it['title']}\n{it['text']}"))] = y[(g["group"], it["key"])]
        self.hits = self.misses = 0

    def scores(self, request, items):
        out = []
        for it in items:
            v = self.by.get((request, self.h(f"{it['title']}\n{it['text']}")))
            self.hits += v is not None
            self.misses += v is None
            out.append(0.0 if v is None else v)
        if (self.hits + self.misses) % 500 < len(items):
            print(f"oracle: {self.hits} hits, {self.misses} misses", flush=True)
        return out


def serve(checker, port):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))))
                items = body["items"][:MAX_ITEMS]
                out = {"scores": checker.scores(str(body["request"]), items)}
                code = 200
            except Exception as e:  # noqa: BLE001 - the caller fails open on any non-200
                out, code = {"error": str(e)[:200]}, 400
            data = json.dumps(out).encode()
            self.send_response(code)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"i1 sidecar on 127.0.0.1:{port}", flush=True)
    srv.serve_forever()


def groups_of(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["serve", "bench", "score"])
    ap.add_argument("--model")
    ap.add_argument("--oracle", help="I2: a labels file; serve the teacher's labels (with --pairs) instead of a model")
    ap.add_argument("--port", type=int, default=8471)
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--pairs")
    ap.add_argument("--out")
    ap.add_argument("--k", type=int, default=15)
    ap.add_argument("--n", type=int, default=300)
    a = ap.parse_args(argv)
    checker = OracleChecker(a.pairs, a.oracle) if a.oracle else Checker(a.model, a.threads)
    if a.cmd == "serve":
        serve(checker, a.port)
    elif a.cmd == "bench":
        gs = groups_of(a.pairs)[: a.n]
        checker.scores(gs[0]["request"], gs[0]["items"][: a.k])  # warm
        ms = []
        for g in gs:
            t = time.perf_counter()
            checker.scores(g["request"], g["items"][: a.k])
            ms.append((time.perf_counter() - t) * 1000)
        ms.sort()
        print(json.dumps({"requests": len(ms), "k": a.k, "threads": a.threads, "p50_ms": round(statistics.median(ms), 2),
                          "p90_ms": round(ms[int(0.9 * (len(ms) - 1))], 2), "mean_ms": round(statistics.mean(ms), 2)}))
    else:
        with open(a.out, "w") as f:
            for g in groups_of(a.pairs):
                for it, s in zip(g["items"], checker.scores(g["request"], g["items"])):
                    f.write(json.dumps({"group": g["group"], "key": it["key"], "truth": it["truth"], "s": s}) + "\n")


if __name__ == "__main__":
    main(sys.argv[1:])
