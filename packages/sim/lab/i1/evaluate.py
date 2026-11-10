"""I1: a trained checker on this machine's CPU (D472, docs/research/i1-checker.md). Lab only.

    python3 -I evaluate.py --model DIR --pairs PAIRS.jsonl --labels LABELS.jsonl [--threads 1] [--n 200]

Quantizes `model.onnx` to `model.int8.onnx` (dynamic int8, once), then for fp32 and int8: the held-out templates' AUCs
(`i1_data.report`: against Opus, planted against the rest, planted against decoys) and the latency of one request's
15 pairs (p50/p90 over `--n` held-out groups). Writes `DIR/cpu.json`.
"""
import argparse
import json
import os
import statistics
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "modal"))
import i1_data as d  # noqa: E402
import sidecar  # noqa: E402


def run(folder, groups, labels, threads, n, int8):
    if int8:
        os.environ.pop("I1_FP32", None)
    else:
        os.environ["I1_FP32"] = "1"
    ch = sidecar.Checker(folder, threads)
    held = [g for g in groups if g["split"] == "eval"]
    lab = {(x["group"], x["key"]): x for x in labels}
    rows, scores = [], []
    for g in held:
        items = [it for it in g["items"] if (g["group"], it["key"]) in lab]
        rows += d.rows([{**g, "items": items}], labels)
        scores += ch.scores(g["request"], items)
    ms = []
    for g in held[:n]:
        t = time.perf_counter()
        ch.scores(g["request"], g["items"][:15])
        ms.append((time.perf_counter() - t) * 1000)
    ms.sort()
    return {**d.report(rows, scores), "p50_ms": round(statistics.median(ms), 1), "p90_ms": round(ms[int(0.9 * (len(ms) - 1))], 1)}


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--pairs", required=True)
    ap.add_argument("--labels", required=True)
    ap.add_argument("--threads", type=int, default=1)
    ap.add_argument("--n", type=int, default=200)
    a = ap.parse_args(argv)
    q = os.path.join(a.model, "model.int8.onnx")
    if not os.path.exists(q):
        from onnxruntime.quantization import QuantType, quantize_dynamic

        quantize_dynamic(os.path.join(a.model, "model.onnx"), q, weight_type=QuantType.QInt8)
    groups, labels = d.read_jsonl(a.pairs), d.read_jsonl(a.labels)
    out = {"threads": a.threads, "fp32": run(a.model, groups, labels, a.threads, a.n, False),
           "int8": run(a.model, groups, labels, a.threads, a.n, True)}
    with open(os.path.join(a.model, "cpu.json"), "w") as f:
        json.dump(out, f, indent=1)
    print(json.dumps(out))


if __name__ == "__main__":
    main(sys.argv[1:])
