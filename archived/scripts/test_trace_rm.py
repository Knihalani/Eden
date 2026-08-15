#!/usr/bin/env python3
"""Smoke + eval test for narcolepticchicken/trace-reward-model-final-v5."""

from __future__ import annotations

import json
import sys
import time
from collections import defaultdict
from typing import Any

MODEL_ID = "narcolepticchicken/trace-reward-model-final-v5"
DATASET_ID = "narcolepticchicken/trace-reward-gauntlet-v1"


def linearize_trace(trace: list[dict[str, Any]], *, max_chars: int = 6000) -> str:
    parts: list[str] = []
    for step in trace:
        role = step.get("role") or "unknown"
        content = step.get("content") or ""
        if isinstance(content, dict):
            content = json.dumps(content, ensure_ascii=False)
        content = str(content)
        parts.append(f"[{role}]\n{content}")
        if sum(len(p) for p in parts) >= max_chars:
            break
    return "\n\n".join(parts)[:max_chars]


def score_text(model, tokenizer, text: str, device: str) -> float:
    import torch

    inputs = tokenizer(
        text,
        return_tensors="pt",
        truncation=True,
        max_length=2048,
    )
    inputs = {k: v.to(device) for k, v in inputs.items()}
    with torch.no_grad():
        out = model(**inputs)
    logits = out.logits
    if logits.shape[-1] == 1:
        return float(logits.squeeze().cpu().item())
    # Binary / multi-class: use logit index 1 as "positive" if 2-class
    if logits.shape[-1] == 2:
        probs = torch.softmax(logits, dim=-1)
        return float(probs[0, 1].cpu().item())
    return float(logits.squeeze().cpu().item())


def main() -> int:
    import torch
    from datasets import load_dataset
    from transformers import AutoModelForSequenceClassification, AutoTokenizer

    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"device={device}")
    print(f"loading model {MODEL_ID} ...")
    t0 = time.perf_counter()
    tokenizer = AutoTokenizer.from_pretrained(MODEL_ID, trust_remote_code=True)
    model = AutoModelForSequenceClassification.from_pretrained(
        MODEL_ID,
        trust_remote_code=True,
    )
    model.to(device)
    model.eval()
    print(f"model loaded in {time.perf_counter() - t0:.1f}s")
    print(f"arch={model.config.architectures}, num_labels={model.config.num_labels}")

    # README sanity check
    readme_text = "The capital of France is Paris."
    readme_score = score_text(model, tokenizer, readme_text, device)
    print(f"\n--- README example ---")
    print(f"text: {readme_text!r}")
    print(f"score: {readme_score:.6f}")

    print(f"\nloading dataset {DATASET_ID} ...")
    ds = load_dataset(DATASET_ID, split="train")
    print(f"rows={len(ds)}, columns={ds.column_names}")

    scores_by_expected: dict[str, list[float]] = defaultdict(list)
    scores_by_category: dict[str, list[float]] = defaultdict(list)
    rows: list[dict[str, Any]] = []

    print("\n--- per-sample scores (first 15 + stratified rest) ---")
    indices = list(range(min(15, len(ds))))
    # one per category
    seen_cats: set[str] = set()
    for i, row in enumerate(ds):
        cat = row["category"]
        if cat not in seen_cats:
            indices.append(i)
            seen_cats.add(cat)

    indices = sorted(set(indices))
    latencies: list[float] = []

    for i in indices:
        row = ds[i]
        text = linearize_trace(row["trace"])
        t1 = time.perf_counter()
        sc = score_text(model, tokenizer, text, device)
        latencies.append((time.perf_counter() - t1) * 1000)
        expected = row["expected_score"]
        cat = row["category"]
        scores_by_expected[expected].append(sc)
        scores_by_category[cat].append(sc)
        rows.append(
            {
                "idx": i,
                "category": cat,
                "expected_score": expected,
                "score": sc,
                "description": row["description"],
                "trace_chars": len(text),
                "trace_steps": len(row["trace"]),
            }
        )
        print(
            f"[{i:3d}] {cat:28s} expect={expected:6s} "
            f"score={sc:+.4f}  steps={len(row['trace']):2d}  "
            f"{row['description'][:55]}"
        )

    # Full dataset pass for aggregate stats
    print("\n--- full dataset pass ---")
    all_expected: dict[str, list[float]] = defaultdict(list)
    all_category: dict[str, list[float]] = defaultdict(list)
    full_lat: list[float] = []
    for row in ds:
        text = linearize_trace(row["trace"])
        t1 = time.perf_counter()
        sc = score_text(model, tokenizer, text, device)
        full_lat.append((time.perf_counter() - t1) * 1000)
        all_expected[row["expected_score"]].append(sc)
        all_category[row["category"]].append(sc)

    def stats(vals: list[float]) -> str:
        if not vals:
            return "n=0"
        import statistics

        return (
            f"n={len(vals)} mean={statistics.mean(vals):.4f} "
            f"median={statistics.median(vals):.4f} "
            f"min={min(vals):.4f} max={max(vals):.4f}"
        )

    print("\nBy expected_score:")
    for k in sorted(all_expected):
        print(f"  {k:8s}: {stats(all_expected[k])}")

    print("\nBy category:")
    for k in sorted(all_category):
        print(f"  {k:28s}: {stats(all_category[k])}")

    # Separation check: can model distinguish low vs medium?
    low = all_expected.get("low", [])
    med = all_expected.get("medium", [])
    if low and med:
        low_mean = sum(low) / len(low)
        med_mean = sum(med) / len(med)
        print(f"\nSeparation low vs medium: low_mean={low_mean:.4f} med_mean={med_mean:.4f} delta={med_mean-low_mean:+.4f}")
        # threshold sweep for classifying low (expect lower RM score?)
        import statistics

        best_acc = 0.0
        best_t = 0.0
        for t in [x / 100 for x in range(-100, 101, 2)]:
            correct = sum(1 for s in low if s < t) + sum(1 for s in med if s >= t)
            acc = correct / len(ds)
            if acc > best_acc:
                best_acc = acc
                best_t = t
        print(f"Best threshold classify (score<t => low): t={best_t:.2f} acc={best_acc:.1%}")

    if full_lat:
        full_lat.sort()
        p50 = full_lat[len(full_lat) // 2]
        p95 = full_lat[int(len(full_lat) * 0.95)]
        print(f"\nLatency ms: mean={sum(full_lat)/len(full_lat):.1f} p50={p50:.1f} p95={p95:.1f}")

    # Save machine-readable results
    out_path = "/Users/kaiavnihalani/Downloads/Eden/scripts/trace_rm_eval_results.json"
    payload = {
        "model": MODEL_ID,
        "dataset": DATASET_ID,
        "device": device,
        "num_labels": model.config.num_labels,
        "readme_example_score": readme_score,
        "by_expected": {k: {"n": len(v), "mean": sum(v) / len(v)} for k, v in all_expected.items()},
        "by_category": {k: {"n": len(v), "mean": sum(v) / len(v)} for k, v in all_category.items()},
        "samples": rows,
    }
    with open(out_path, "w") as f:
        json.dump(payload, f, indent=2)
    print(f"\nWrote {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
