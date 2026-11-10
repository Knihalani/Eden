"""The background card model distilled into a small open model on Modal (M0, lab tooling): LoRA on Haiku 5.5's cards
for the train worlds, an eval of agreement with Haiku on held-out items, and a vLLM OpenAI-compatible endpoint the
funnel can card through (`bun run funnel --cards-endpoint URL`, lab only). Data handling is distill_data.py.

    bun packages/sim/src/lab/cards-distill.ts export --out .local/modal/cards/data      # local, $0
    modal run packages/sim/modal/cards_distill.py::train --data .local/modal/cards/data --run q15-a --base qwen2.5-1.5b
    modal run packages/sim/modal/cards_distill.py::evaluate --data .local/modal/cards/data --run q15-a
    EDEN_CARDS_RUN=q15-a modal serve packages/sim/modal/cards_distill.py   # or `modal deploy`; prints the URL

D235 measured small local models as the *reader* and they failed (AUC 0.44-0.61); a card is a different job (one
item, a fixed schema, a teacher's labels to copy), which is what the eval measures before the funnel trusts it.
"""
import json
import os
import subprocess
import sys
import time

import modal

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import distill_data as dd  # noqa: E402

ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
VOLUME = "eden-cards-distill"
ENDPOINT_SECRET = "eden-cards-endpoint"
vol = modal.Volume.from_name(VOLUME, create_if_missing=True)

train_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("torch==2.8.0", "transformers==4.56.2", "peft==0.17.1", "trl==0.23.0", "accelerate==1.10.1",
                 "datasets==4.1.1")
    .env({"HF_HOME": "/vol/hf"})
    .add_local_python_source("distill_data")
)
vllm_image = (
    modal.Image.debian_slim(python_version="3.12")
    .pip_install("vllm==0.10.2")
    .env({"HF_HOME": "/vol/hf", "EDEN_CARDS_RUN": os.environ.get("EDEN_CARDS_RUN", "")})
    .add_local_python_source("distill_data")
)
app = modal.App("eden-cards-distill")


def _model_dir(run):
    return f"/vol/models/{run}/merged"


@app.function(image=train_image, gpu="A10G", volumes={"/vol": vol}, timeout=6 * 3600)
def train_remote(data_dir: str, run: str, base: str, epochs: float, lr: float, rank: int, gpu: str) -> dict:
    """LoRA SFT on the reply only, merged into the base and saved to the volume with its metrics."""
    import torch
    from datasets import Dataset
    from peft import LoraConfig
    from transformers import AutoModelForCausalLM, AutoTokenizer
    from trl import SFTConfig, SFTTrainer

    t0 = time.time()
    train = dd.load_rows(f"/vol/data/{data_dir}/train.jsonl")
    held = dd.load_rows(f"/vol/data/{data_dir}/heldout.jsonl")
    dd.check_rows(train, held)
    hf = dd.BASES[base]["hf"]
    tok = AutoTokenizer.from_pretrained(hf)
    model = AutoModelForCausalLM.from_pretrained(hf, torch_dtype=torch.bfloat16)
    ds = Dataset.from_list([dd.prompt_completion(r) for r in train])
    # A small eval slice of the held-out rows for the loss curve only; the real eval is `evaluate`.
    ev = Dataset.from_list([dd.prompt_completion(r) for r in held[:16]])
    cfg = SFTConfig(output_dir=f"/vol/models/{run}/ckpt", num_train_epochs=epochs, learning_rate=lr,
                    per_device_train_batch_size=1, gradient_accumulation_steps=8, lr_scheduler_type="cosine",
                    warmup_ratio=0.05, max_length=dd.MAX_LENGTH, bf16=True, gradient_checkpointing=True,
                    logging_steps=5, eval_strategy="epoch", save_strategy="no", report_to="none",
                    completion_only_loss=True, packing=False, seed=7)
    lora = LoraConfig(r=rank, lora_alpha=2 * rank, lora_dropout=0.05, task_type="CAUSAL_LM",
                      target_modules="all-linear")
    trainer = SFTTrainer(model=model, args=cfg, train_dataset=ds, eval_dataset=ev, peft_config=lora,
                         processing_class=tok)
    out = trainer.train()
    merged = trainer.model.merge_and_unload()
    merged.save_pretrained(_model_dir(run), safe_serialization=True)
    tok.save_pretrained(_model_dir(run))
    metrics = {"run": run, "base": base, "hf": hf, "epochs": epochs, "lr": lr, "rank": rank,
               "trainLoss": out.training_loss, "log": trainer.state.log_history, "rows": len(train),
               "seconds": round(time.time() - t0), "gpu": gpu}
    with open(f"/vol/models/{run}/train.json", "w") as f:
        json.dump(metrics, f, indent=2)
    vol.commit()
    return metrics


@app.function(image=vllm_image, gpu="L40S", volumes={"/vol": vol}, timeout=2 * 3600)
def generate_remote(model: str, rows: list, guided_json: bool) -> dict:
    """Greedy outputs for the rows' prompts with vLLM offline: a run's merged model, or a base model's HF id."""
    from vllm import LLM, SamplingParams
    from vllm.sampling_params import GuidedDecodingParams

    t0 = time.time()
    path = _model_dir(model) if os.path.isdir(_model_dir(model)) else model
    llm = LLM(model=path, max_model_len=dd.MAX_LENGTH * 2, dtype="bfloat16", seed=7)
    params = []
    for r in rows:
        g = dd.generation_params(r)
        params.append(SamplingParams(temperature=g["temperature"], max_tokens=g["max_tokens"],
                                     guided_decoding=GuidedDecodingParams(json_object=True) if guided_json else None))
    outs = llm.chat([r["messages"][:2] for r in rows], params, use_tqdm=False)
    texts = [o.outputs[0].text for o in outs]
    return {"texts": texts, "seconds": round(time.time() - t0), "model": path}


@app.function(image=vllm_image, gpu="L4", volumes={"/vol": vol}, timeout=24 * 3600, scaledown_window=300,
              secrets=[modal.Secret.from_name(ENDPOINT_SECRET)])
@modal.concurrent(max_inputs=32)
@modal.web_server(port=8000, startup_timeout=600)
def serve():
    """vLLM's OpenAI-compatible server for EDEN_CARDS_RUN's merged model, behind the endpoint secret's bearer key."""
    run = os.environ["EDEN_CARDS_RUN"]
    args = dd.vllm_serve_args(_model_dir(run))
    env = dict(os.environ, VLLM_API_KEY=os.environ["EDEN_LAB_CARDS_KEY"])
    subprocess.Popen(args, env=env)


def _upload(data):
    name = os.path.basename(os.path.normpath(data))
    train = dd.load_rows(os.path.join(data, "train.jsonl"))
    held = dd.load_rows(os.path.join(data, "heldout.jsonl"))
    stats = dd.check_rows(train, held)
    with vol.batch_upload(force=True) as b:
        for f in ("train.jsonl", "heldout.jsonl", "manifest.json"):
            b.put_file(os.path.join(data, f), f"/data/{name}/{f}")
    return name, train, held, stats


@app.local_entrypoint()
def train(data: str, run: str, base: str = dd.DEFAULT_BASE, epochs: float = 2.0, lr: float = 2e-4, rank: int = 16):
    if base not in dd.BASES:
        sys.exit(f"--base is one of {', '.join(dd.BASES)}")
    name, rows, _, stats = _upload(data)
    est = dd.estimate_train(base, rows, epochs)
    print(f"data {name}: {stats}; estimate (assumed throughput, list price): {est}")
    # The base's GPU (a 4B model wants an L40S's 48 GB; the decorator's A10G fits 1.5B).
    gpu = dd.BASES[base]["gpu"]
    metrics = train_remote.with_options(gpu=gpu).remote(name, run, base, epochs, lr, rank, gpu)
    out = os.path.join(ROOT, ".local", "modal", "cards", run)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "train.json"), "w") as f:
        json.dump({**metrics, "estimate": est}, f, indent=2)
    print(f"trained {run} in {metrics['seconds']} s, loss {metrics['trainLoss']:.4f}; {out}/train.json")


@app.local_entrypoint()
def evaluate(data: str, run: str, guided_json: bool = False):
    """`--run` a trained run, or a base key (`qwen2.5-1.5b`) for the untrained baseline; scored by Eden's parsers."""
    held = dd.load_rows(os.path.join(data, "heldout.jsonl"))
    model = dd.BASES[run]["hf"] if run in dd.BASES else run
    got = generate_remote.remote(model, held, guided_json)
    out = os.path.join(ROOT, ".local", "modal", "cards", run)
    os.makedirs(out, exist_ok=True)
    outputs = os.path.join(out, "outputs.jsonl")
    with open(outputs, "w") as f:
        f.write(dd.output_lines(held, got["texts"]))
    score = os.path.join(out, "score.json")
    subprocess.run(["bun", "packages/sim/src/lab/cards-distill.ts", "score", "--data",
                    os.path.join(data, "heldout.jsonl"), "--outputs", outputs, "--json", score], cwd=ROOT, check=True)
    with open(score) as f:
        s = json.load(f)
    train_json = os.path.join(out, "train.json")
    usd = json.load(open(train_json)).get("estimate", {}).get("usd") if os.path.exists(train_json) else None
    print(f"{run}: generated {len(held)} rows in {got['seconds']} s; flag precision {s['flagPrecision']}, recall "
          f"{s['flagRecall']}, parse {s['batchParseRate']}"
          + (f"; F1 per training $ (estimate) {dd.quality_per_dollar(s, usd)}" if usd else ""))
