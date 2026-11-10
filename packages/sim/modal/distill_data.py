"""The card distillation's data handling and arithmetic, with no Modal and no ML library in it (M0): rows from
`cards-distill.ts export`, the base models on offer, the GPU each gets, vLLM's arguments and cost estimates.
`cards_distill.py` uses them on Modal; `tests/test_distill_data.py` tests them with `python3 -I -m unittest`.
"""
import json
import math

# The base models on offer. Licences matter even in the lab: a distilled model that might be served later must be
# one we may serve. Qwen2.5-3B-Instruct is under the Qwen Research License (non-commercial), so it is not offered.
BASES = {
    "qwen2.5-1.5b": {"hf": "Qwen/Qwen2.5-1.5B-Instruct", "params_b": 1.5, "licence": "Apache-2.0", "gpu": "A10G",
                     "serve_gpu": "L4"},
    "qwen3-4b": {"hf": "Qwen/Qwen3-4B-Instruct-2507", "params_b": 4.0, "licence": "Apache-2.0", "gpu": "L40S",
                 "serve_gpu": "L40S"},
}
DEFAULT_BASE = "qwen2.5-1.5b"
# Modal's per-second GPU list prices as hourly rates (USD), as published in 2025: an ESTIMATE to plan with, not a
# quote. Check modal.com/pricing before a large run.
GPU_USD_PER_HOUR = {"T4": 0.59, "L4": 0.80, "A10G": 1.10, "L40S": 1.95, "A100-40GB": 2.10, "A100-80GB": 2.50,
                    "H100": 3.95}
# Training throughput assumed for a LoRA pass with gradient checkpointing (tokens a second, bf16), by base: an
# ESTIMATE from the usual figures for these sizes and GPUs, to be replaced by the first run's own.
ASSUMED_TRAIN_TOKENS_PER_S = {"qwen2.5-1.5b": 4000, "qwen3-4b": 3000}
# Characters per token for this text (English prose with JSON): an estimate for planning only.
CHARS_PER_TOKEN = 3.6
# The longest row the export makes is ~14,400 characters with its target (batch 20, intent), ~4,000 tokens.
MAX_LENGTH = 8192
SERVED_NAME = "eden-cards"


def load_rows(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]


def check_rows(train, heldout):
    """Refuses a set whose splits share an item, or whose rows are not Eden's three-turn card call."""
    seen = {h for r in train for h in r["keys"]}
    both = [h for r in heldout for h in r["keys"] if h in seen]
    if both:
        raise ValueError(f"{len(both)} held-out items are also in training rows (first {both[0]})")
    for r in train + heldout:
        roles = [m["role"] for m in r["messages"]]
        if roles != ["system", "user", "assistant"]:
            raise ValueError(f"row {r['id']} has roles {roles}, not system/user/assistant")
        json.loads(r["messages"][2]["content"])
    return {"train": len(train), "heldout": len(heldout), "trainItems": len(seen),
            "heldoutItems": sum(len(r["keys"]) for r in heldout)}


def prompt_completion(row):
    """A row as TRL's conversational prompt-completion record: loss on the reply only."""
    return {"prompt": row["messages"][:2], "completion": row["messages"][2:]}


def row_tokens(row):
    return math.ceil(sum(len(m["content"]) for m in row["messages"]) / CHARS_PER_TOKEN)


def estimate_train(base, rows, epochs):
    """Estimated GPU hours and USD for a LoRA run (labelled an estimate: assumed throughput, list prices)."""
    b = BASES[base]
    tokens = sum(row_tokens(r) for r in rows) * epochs
    hours = tokens / ASSUMED_TRAIN_TOKENS_PER_S[base] / 3600 + 0.15  # + start-up, download, merge and save
    usd = hours * GPU_USD_PER_HOUR[b["gpu"]]
    return {"base": base, "gpu": b["gpu"], "tokens": tokens, "hours": round(hours, 2), "usd": round(usd, 2),
            "estimate": True}


def generation_params(row, max_model_len=MAX_LENGTH * 2):
    """Greedy decoding at Eden's own output cap for the batch, clipped to what the context leaves."""
    room = max_model_len - row_tokens({"messages": row["messages"][:2]}) - 64
    return {"temperature": 0.0, "max_tokens": max(256, min(int(row["maxTokens"]), room))}


def vllm_serve_args(model_dir, max_model_len=MAX_LENGTH * 2):
    """`vllm serve` arguments for the merged model; the key comes from the environment (`--api-key` reads none)."""
    return ["vllm", "serve", model_dir, "--served-model-name", SERVED_NAME, "--host", "0.0.0.0", "--port", "8000",
            "--max-model-len", str(max_model_len), "--dtype", "bfloat16", "--generation-config", "vllm"]


def output_lines(rows, texts):
    """`cards-distill.ts score`'s outputs file: one `{id, text}` per held-out row, in order."""
    if len(rows) != len(texts):
        raise ValueError(f"{len(texts)} outputs for {len(rows)} rows")
    return "".join(json.dumps({"id": r["id"], "text": t}) + "\n" for r, t in zip(rows, texts))


def quality_per_dollar(score, usd):
    """The pick between bases: constraint-flag F1 against Haiku per training dollar (higher is better)."""
    p, r = score.get("flagPrecision"), score.get("flagRecall")
    if not p or not r:
        return 0.0
    f1 = 2 * p * r / (p + r)
    return round(f1 / max(usd, 0.01), 3)
