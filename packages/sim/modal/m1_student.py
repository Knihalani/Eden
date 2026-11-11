"""M1 (D890-D899, docs/research/m1-student.md): an open decoder model (Qwen3, 0.6B-8B, Apache-2.0) fine-tuned with LoRA
to answer I2's question (D490: does this item change what the assistant should do for this request?) for one
(request, item) pair at a time. Lab tooling, not product code. Data and scoring: m1_data.py (tested without Modal).

The student reads the pair in its chat template and answers; its score is log P(yes) - log P(no) at the answer's first
token (the same score before training, so the untrained model is the ladder's zero-shot rung). Training is pointwise
binary cross-entropy on that score against the construction label (`--target truth`), a teacher's confidence
(`teacher`) or their mean (`mix`), planted facts and look-alikes weighted `--near-weight`.

    python3 -I packages/sim/modal/m1_build.py ...                  # rows -> .local/m1/data/<name>.jsonl
    modal run packages/sim/modal/m1_student.py::train --data .local/m1/data/<name>.jsonl --base qwen3-0.6b --run r1
    modal run packages/sim/modal/m1_student.py::zero --data .local/m1/data/<name>.jsonl --base qwen3-8b

Weights stay on the Modal Volume `eden-checker` (`/runs/<run>/adapter`, and `merged` with `--merge`); only scores
and reports come back, to `.local/m1/runs/<run>/`. Only simulated worlds' text is sent. No secret is used.
"""
import json
import os
import sys
import time

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import m1_data as d  # noqa: E402

BASES = {
    "qwen3-0.6b": ("Qwen/Qwen3-0.6B", "L40S"),
    "qwen3-1.7b": ("Qwen/Qwen3-1.7B", "L40S"),
    "qwen3-4b": ("Qwen/Qwen3-4B-Instruct-2507", "H100"),
    "qwen3-8b": ("Qwen/Qwen3-8B", "H100"),
}

image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch==2.8.0", "transformers==4.56.2", "peft==0.17.1", "accelerate==1.10.1", "numpy==2.3.3",
                 "hf_transfer==0.1.9")
    .env({"HF_HOME": "/vol/hf", "HF_HUB_ENABLE_HF_TRANSFER": "1", "TOKENIZERS_PARALLELISM": "false"})
    .add_local_python_source("m1_data")
)
vol = modal.Volume.from_name("eden-checker", create_if_missing=True)
app = modal.App("eden-m1-student", image=image)


def _setup(base, adapter=None):
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer

    tok = AutoTokenizer.from_pretrained(base)
    tok.padding_side = "left"
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    model = AutoModelForCausalLM.from_pretrained(base, torch_dtype=torch.bfloat16, attn_implementation="sdpa").cuda()
    if adapter:
        from peft import PeftModel

        model = PeftModel.from_pretrained(model, adapter)
    # The answer's first token, any case and leading space: its log-sum-exp over the yes forms against the no forms.
    def ids(words):
        out = set()
        for w in words:
            t = tok.encode(w, add_special_tokens=False)
            if len(t) == 1:
                out.add(t[0])
        return sorted(out)

    yes, no = ids(["yes", "Yes", " yes", " Yes", "YES"]), ids(["no", "No", " no", " No", "NO"])
    return tok, model, yes, no


def _texts(tok, rows):
    return [tok.apply_chat_template([{"role": "user", "content": d.render(r)}], tokenize=False,
                                    add_generation_prompt=True, enable_thinking=False) for r in rows]


def _score(tok, model, yes, no, rows, max_len, grad=False):
    """log P(yes) - log P(no) at the first answer token, for a batch of rows (left-padded: the last position)."""
    import torch

    enc = tok(_texts(tok, rows), return_tensors="pt", padding=True, truncation=True, max_length=max_len).to("cuda")
    base = model.get_base_model() if hasattr(model, "get_base_model") else model
    with torch.set_grad_enabled(grad):
        hidden = base.model(input_ids=enc.input_ids, attention_mask=enc.attention_mask).last_hidden_state[:, -1]
        logits = base.lm_head(hidden).float()
    lp = torch.log_softmax(logits, dim=-1)
    return torch.logsumexp(lp[:, yes], -1) - torch.logsumexp(lp[:, no], -1)


def _score_all(tok, model, yes, no, rows, max_len, batch=32):
    import torch

    model.eval()
    order = sorted(range(len(rows)), key=lambda i: len(rows[i]["text"]) + len(rows[i]["request"]))
    out = [0.0] * len(rows)
    for i in range(0, len(order), batch):
        idx = order[i : i + batch]
        with torch.no_grad():
            s = _score(tok, model, yes, no, [rows[j] for j in idx], max_len).cpu().tolist()
        for j, v in zip(idx, s):
            out[j] = v
    return out


def _push_latency(tok, model, yes, no, rows, max_len, n=20):
    """One push's check on this GPU: 15 pool items scored as one batch, warm, p50 and p90 over `n` pools."""
    import torch

    model.eval()
    ts = []
    for k in range(n + 3):
        pool = [rows[(k * 15 + i) % len(rows)] for i in range(15)]
        torch.cuda.synchronize()
        t = time.perf_counter()
        with torch.no_grad():
            _score(tok, model, yes, no, pool, max_len)
        torch.cuda.synchronize()
        if k >= 3:
            ts.append((time.perf_counter() - t) * 1000)
    return {"p50_ms": round(d.quantile(ts, 0.5), 1), "p90_ms": round(d.quantile(ts, 0.9), 1)}


def _load(path):
    return d.read_jsonl(path)


@app.function(gpu="L40S", volumes={"/vol": vol}, timeout=6 * 3600)
def train_remote(cfg: dict) -> dict:
    import numpy as np
    import torch
    from peft import LoraConfig, get_peft_model

    t0 = time.time()
    torch.manual_seed(cfg["seed"])
    rows = _load(f"/vol/{cfg['data']}")
    train = [r for r in rows if r["split"] == "train" and r["src"] in cfg["train_src"]]
    train = d.subsample_other(train, cfg["other_per_group"], cfg["seed"])
    held = [r for r in rows if r["split"] != "train"]
    tok, model, yes, no = _setup(cfg["base"])
    print(f"m1 {cfg['run']}: {len(train)} train rows, {len(held)} held-out rows; yes ids {yes}, no ids {no}")
    if cfg["grad_ckpt"]:
        model.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
        model.enable_input_require_grads()
    model = get_peft_model(model, LoraConfig(r=cfg["r"], lora_alpha=2 * cfg["r"], lora_dropout=0.05,
                                             target_modules="all-linear", task_type="CAUSAL_LM"))
    params = [p for p in model.parameters() if p.requires_grad]
    opt = torch.optim.AdamW(params, lr=cfg["lr"], weight_decay=0.0)
    bs, acc = cfg["batch"], cfg["accum"]
    steps = cfg["epochs"] * ((len(train) + bs * acc - 1) // (bs * acc))
    warm = max(1, steps // 20)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / warm) * max(0.0, 1 - s / steps))
    rng = np.random.default_rng(cfg["seed"])
    losses, step = [], 0
    for ep in range(cfg["epochs"]):
        model.train()
        order = rng.permutation(len(train))
        for i in range(0, len(order), bs):
            b = [train[j] for j in order[i : i + bs]]
            s = _score(tok, model, yes, no, b, cfg["max_len"], grad=True)
            y = torch.tensor([d.target_of(r, cfg["target"]) for r in b], device="cuda")
            w = torch.tensor([d.weight_of(r, cfg["near_weight"]) for r in b], device="cuda")
            loss = (torch.nn.functional.binary_cross_entropy_with_logits(s, y, reduction="none") * w).sum() / (
                w.sum() * acc)
            loss.backward()
            losses.append(loss.item() * acc)
            if (i // bs + 1) % acc == 0:
                torch.nn.utils.clip_grad_norm_(params, 1.0)
                opt.step()
                sched.step()
                opt.zero_grad()
                step += 1
                if step % 50 == 0:
                    print(f"ep {ep} step {step}/{steps} loss {np.mean(losses[-50 * acc:]):.4f} "
                          f"{time.time() - t0:.0f}s")
    train_s = round(time.time() - t0)
    held_scores = _score_all(tok, model, yes, no, held, cfg["max_len"])
    ins = [r for r in train if r["truth"] != "other"][:600]
    ins_scores = _score_all(tok, model, yes, no, ins, cfg["max_len"])
    lat = _push_latency(tok, model, yes, no, held, cfg["max_len"])
    out_dir = f"/vol/runs/{cfg['run']}"
    model.save_pretrained(f"{out_dir}/adapter")
    tok.save_pretrained(f"{out_dir}/adapter")
    if cfg["merge"]:
        merged = model.merge_and_unload()
        merged.save_pretrained(f"{out_dir}/merged", safe_serialization=True)
        tok.save_pretrained(f"{out_dir}/merged")
    with open(f"{out_dir}/cfg.json", "w") as f:
        json.dump(cfg, f)
    vol.commit()
    return {"report": d.by_src(held, held_scores), "insample": d.report(ins, ins_scores), "scores": held_scores,
            "latency_15": lat, "train_seconds": train_s, "seconds": round(time.time() - t0),
            "train_rows": len(train), "held_rows": len(held), "steps": steps, "loss_tail": float(np.mean(losses[-200:]))}


@app.function(gpu="L40S", volumes={"/vol": vol}, timeout=3 * 3600)
def score_remote(cfg: dict) -> dict:
    """Scores the held-out rows with a base model (zero shot) or a trained run's adapter."""
    t0 = time.time()
    rows = [r for r in _load(f"/vol/{cfg['data']}") if r["split"] != "train" or cfg.get("all")]
    adapter = f"/vol/runs/{cfg['adapter_run']}/adapter" if cfg.get("adapter_run") else None
    tok, model, yes, no = _setup(cfg["base"], adapter)
    scores = _score_all(tok, model, yes, no, rows, cfg["max_len"])
    lat = _push_latency(tok, model, yes, no, rows, cfg["max_len"])
    return {"report": d.by_src(rows, scores), "scores": scores, "latency_15": lat, "seconds": round(time.time() - t0),
            "rows": len(rows)}


def _upload(data):
    """The rows file goes to the Volume under its content hash (a rerun uploads nothing)."""
    with open(data, "rb") as f:
        key = d.h(f.read().decode())[:16]
    remote = f"data/{key}.jsonl"
    try:
        with vol.batch_upload() as b:
            b.put_file(data, f"/{remote}")
    except FileExistsError:
        pass
    return remote


def _save(run, rows_path, remote_path, cfg, res):
    out = os.path.join(".local", "m1", "runs", run)
    os.makedirs(out, exist_ok=True)
    rows = [r for r in d.read_jsonl(rows_path) if r["split"] != "train" or cfg.get("all")]
    with open(os.path.join(out, "eval_scores.jsonl"), "w") as f:
        for r, s in zip(rows, res.pop("scores")):
            f.write(json.dumps({"src": r["src"], "family": r["family"], "group": r["group"], "key": r["key"],
                                "split": r["split"], "truth": r["truth"], "y": r.get("y"), "s": round(s, 4)}) + "\n")
    # The train suites' eval split is D890's test set: a trained run's figures on it go to their own file, not the
    # console, and are read once a rung (docs/research/m1-student.md §2). Zero-shot runs choose nothing: printed.
    if "epochs" in cfg or cfg.get("adapter_run"):
        sealed = {k: res["report"].pop(k) for k in list(res["report"]) if k == "train/eval"}
        with open(os.path.join(out, "eval_sealed.json"), "w") as f:
            json.dump(sealed, f, indent=1)
    with open(os.path.join(out, "report.json"), "w") as f:
        json.dump({"cfg": cfg, "data_remote": remote_path, **res}, f, indent=1)
    print(json.dumps(res, indent=1))


@app.local_entrypoint()
def train(data: str, base: str = "qwen3-0.6b", run: str = "", epochs: int = 1, lr: float = 1e-4, r: int = 16,
          target: str = "truth", near_weight: float = 4.0, other_per_group: int = 6, batch: int = 16, accum: int = 2,
          max_len: int = 512, train_src: str = "train,synth", gpu: str = "", merge: bool = False, seed: int = 7):
    name, default_gpu = BASES[base]
    run = run or base
    cfg = {"run": run, "base": name, "epochs": epochs, "lr": lr, "r": r, "target": target, "near_weight": near_weight,
           "other_per_group": other_per_group, "batch": batch, "accum": accum, "max_len": max_len,
           "train_src": train_src.split(","), "merge": merge, "seed": seed,
           "grad_ckpt": base in ("qwen3-4b", "qwen3-8b"), "gpu": gpu or default_gpu}
    cfg["data"] = _upload(data)
    print(f"m1 train {run}: {name} on {cfg['gpu']}, data {cfg['data']}")
    res = train_remote.with_options(gpu=cfg["gpu"]).remote(cfg)
    _save(run, data, cfg["data"], cfg, res)


@app.local_entrypoint()
def zero(data: str, base: str = "qwen3-0.6b", run: str = "", adapter_run: str = "", gpu: str = "",
         max_len: int = 512, all: bool = False):
    name, default_gpu = BASES[base]
    run = run or f"zero-{base}"
    cfg = {"base": name, "adapter_run": adapter_run, "max_len": max_len, "gpu": gpu or default_gpu, "all": all}
    cfg["data"] = _upload(data)
    res = score_remote.with_options(gpu=cfg["gpu"]).remote(cfg)
    _save(run, data, cfg["data"], cfg, res)
