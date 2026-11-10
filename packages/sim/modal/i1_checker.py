"""I1 (D470-D474, docs/research/i1-checker.md): a small cross-encoder fine-tuned on Opus-labelled near-miss pairs from
the train suites, on a Modal GPU. Lab tooling, not product code. Data checks and scoring are i1_data.py (tested
without Modal).

    bun packages/sim/src/lab/i1-label.ts pairs --pool .local/i1/pool.jsonl --out .local/i1/pairs.jsonl
    bun packages/sim/src/lab/i1-label.ts label ... --out .local/i1/labels.jsonl               # Opus, ledger-capped
    modal run packages/sim/modal/i1_checker.py --pairs .local/i1/pairs.jsonl --labels .local/i1/labels.jsonl \
        --base cross-encoder/ms-marco-MiniLM-L6-v2 --run minilm [--target opus|truth|mix] [--epochs 3]

Comes back to `.local/i1/models/<run>/`: `model.onnx`, `tokenizer.json`, `report.json` (AUCs on the held-out templates,
before and after training) and `eval_scores.jsonl` (each held-out pair's score). Only simulated worlds' text is sent.
"""
import json
import os
import sys
import time

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import i1_data as d  # noqa: E402

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch==2.8.0", "transformers==4.56.2", "numpy==2.3.3", "onnx==1.19.0", "onnxscript==0.5.4")
    .env({"HF_HOME": "/cache/hf"})
    .add_local_python_source("i1_data")
)
cache = modal.Volume.from_name("eden-embed-cache", create_if_missing=True)
app = modal.App("eden-i1-checker", image=image)


@app.function(gpu=["L4", "A10G", "T4"], volumes={"/cache": cache}, timeout=2 * 3600)
def train_remote(base: str, rows: list, epochs: int, lr: float, target: str, max_len: int, decoy_weight: float) -> dict:
    import numpy as np
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    t0 = time.time()
    torch.manual_seed(7)
    tok = AutoTokenizer.from_pretrained(base)
    model = AutoModelForSequenceClassification.from_pretrained(base, num_labels=1).cuda()
    train = [r for r in rows if r["split"] == "train"]
    held = [r for r in rows if r["split"] == "eval"]

    def scores(rs):
        model.eval()
        out = []
        with torch.no_grad():
            for i in range(0, len(rs), 128):
                b = rs[i : i + 128]
                enc = tok([r["request"] for r in b], [r["item"] for r in b], truncation="only_second",
                          max_length=max_len, padding=True, return_tensors="pt").to("cuda")
                out += model(**enc).logits.squeeze(-1).float().cpu().tolist()
        return out

    before = d.report(held, scores(held))
    opt = torch.optim.AdamW(model.parameters(), lr=lr, weight_decay=0.01)
    steps = epochs * ((len(train) + 31) // 32)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, s / max(1, steps // 10)) * max(0.0, 1 - s / steps))
    rng = np.random.default_rng(7)
    losses = []
    for ep in range(epochs):
        model.train()
        order = rng.permutation(len(train))
        for i in range(0, len(order), 32):
            b = [train[j] for j in order[i : i + 32]]
            enc = tok([r["request"] for r in b], [r["item"] for r in b], truncation="only_second",
                      max_length=max_len, padding=True, return_tensors="pt").to("cuda")
            y = torch.tensor([d.target_of(r, target) for r in b], dtype=torch.float32, device="cuda")
            w = torch.tensor([decoy_weight if r["truth"] != "other" else 1.0 for r in b], device="cuda")
            logits = model(**enc).logits.squeeze(-1).float()
            loss = (torch.nn.functional.binary_cross_entropy_with_logits(logits, y, reduction="none") * w).mean()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            opt.zero_grad()
            losses.append(loss.item())
        print(f"epoch {ep}: loss {np.mean(losses[-50:]):.4f}")
    held_scores = scores(held)
    after = d.report(held, held_scores)
    # ONNX for the CPU sidecar (`packages/sim/lab/i1/sidecar.py`): logits for (request, item) pairs.
    model.eval().float().cpu()
    enc = tok(["a request"], ["an item"], return_tensors="pt")
    # Positional inputs must follow forward()'s order (BERT: input_ids, attention_mask, token_type_ids), not the
    # tokenizer's (input_ids, token_type_ids, attention_mask): in the tokenizer's order the graph's inputs come out
    # cross-wired (the first export's did: its attention_mask input fed token_type_ids).
    import inspect

    order = list(inspect.signature(model.forward).parameters)
    names = sorted(enc.keys(), key=order.index)
    path = "/tmp/model.onnx"
    torch.onnx.export(model, tuple(enc[n] for n in names), path, input_names=names, output_names=["logits"],
                      dynamic_axes={n: {0: "batch", 1: "seq"} for n in names} | {"logits": {0: "batch"}},
                      opset_version=17, dynamo=False)
    tok.save_pretrained("/tmp/tok")
    with open(path, "rb") as f:
        onnx_bytes = f.read()
    with open("/tmp/tok/tokenizer.json", "rb") as f:
        tok_bytes = f.read()
    cache.commit()
    return {"before": before, "after": after, "scores": held_scores, "onnx": onnx_bytes, "tokenizer": tok_bytes,
            "inputs": names, "seconds": round(time.time() - t0), "train_pairs": len(train), "eval_pairs": len(held)}


@app.local_entrypoint()
def main(pairs: str, labels: str, base: str = "cross-encoder/ms-marco-MiniLM-L6-v2", run: str = "", epochs: int = 3,
         lr: float = 3e-5, target: str = "opus", max_len: int = 320, decoy_weight: float = 2.0):
    rows = d.rows(d.read_jsonl(pairs), d.read_jsonl(labels))
    run = run or base.split("/")[-1]
    out = os.path.join(".local", "i1", "models", run)
    os.makedirs(out, exist_ok=True)
    print(f"i1 train {base} ({run}): {sum(r['split'] == 'train' for r in rows)} train pairs, "
          f"{sum(r['split'] == 'eval' for r in rows)} held-out pairs, target {target}")
    r = train_remote.remote(base, rows, epochs, lr, target, max_len, decoy_weight)
    with open(os.path.join(out, "model.onnx"), "wb") as f:
        f.write(r.pop("onnx"))
    with open(os.path.join(out, "tokenizer.json"), "wb") as f:
        f.write(r.pop("tokenizer"))
    held = [x for x in rows if x["split"] == "eval"]
    with open(os.path.join(out, "eval_scores.jsonl"), "w") as f:
        for x, s in zip(held, r.pop("scores")):
            f.write(json.dumps({"group": x["group"], "key": x["key"], "truth": x["truth"], "y": x["y"], "s": s}) + "\n")
    meta = {"base": base, "target": target, "epochs": epochs, "lr": lr, "max_len": max_len,
            "decoy_weight": decoy_weight, **r}
    with open(os.path.join(out, "report.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print(json.dumps({"before": r["before"], "after": r["after"], "seconds": r["seconds"]}, indent=1))
