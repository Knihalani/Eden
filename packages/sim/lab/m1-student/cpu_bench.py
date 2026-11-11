"""M1 (D893): one push's check on CPU, the student's architecture with int8 dynamic quantization of its linear layers
(torch), 15 pool items as one batch. Latency depends on the architecture and the tokens, not the trained weights,
so the base model stands in for a merged student. Lab tooling.

    .venv-cpu/bin/python -I packages/sim/lab/m1-student/cpu_bench.py --rows .local/m1/data/train-truth.jsonl \
        --base Qwen/Qwen3-0.6B --threads 4 [--int8] [--pools 5]
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "modal"))
import m1_data as d  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rows", required=True)
    ap.add_argument("--base", default="Qwen/Qwen3-0.6B")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--int8", action="store_true")
    ap.add_argument("--pools", type=int, default=5)
    ap.add_argument("--max-len", type=int, default=512)
    a = ap.parse_args()
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    torch.set_num_threads(a.threads)
    tok = AutoTokenizer.from_pretrained(a.base)
    tok.padding_side = "left"
    model = AutoModelForCausalLM.from_pretrained(a.base, dtype=torch.float32).eval()
    if a.int8:
        model = torch.ao.quantization.quantize_dynamic(model, {torch.nn.Linear}, dtype=torch.qint8)
    rows = [r for r in d.read_jsonl(a.rows) if r["split"] == "eval"][: 15 * (a.pools + 1)]
    ts, toks = [], []
    for k in range(a.pools + 1):
        pool = rows[k * 15 : (k + 1) * 15]
        texts = [tok.apply_chat_template([{"role": "user", "content": d.render(r)}], tokenize=False,
                                         add_generation_prompt=True, enable_thinking=False) for r in pool]
        enc = tok(texts, return_tensors="pt", padding=True, truncation=True, max_length=a.max_len)
        t = time.perf_counter()
        with torch.no_grad():
            model.model(input_ids=enc.input_ids, attention_mask=enc.attention_mask).last_hidden_state[:, -1]
        if k:
            ts.append((time.perf_counter() - t) * 1000)
            toks.append(int(enc.attention_mask.sum()))
    ts.sort()
    print(json.dumps({"base": a.base, "int8": a.int8, "threads": a.threads, "pools": len(ts),
                      "p50_ms": round(ts[len(ts) // 2]), "max_ms": round(ts[-1]),
                      "tokens_per_pool": round(sum(toks) / len(toks))}))


if __name__ == "__main__":
    main()
