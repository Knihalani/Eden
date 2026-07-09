"""Compression micro-benchmark for the storage layer.

Runs N compressions against a representative LLM-payload corpus and
prints:
- raw vs compressed bytes
- compression ratio
- single-thread throughput (ops/sec)
- batch-API throughput (ops/sec)
- batch-API speedup over single-threaded
- round-trip lossless check (errors / total)

The harness uses ``var/zstd_dict.bin`` if available; otherwise it
falls back to the empty dictionary (and prints the ratio is the
"no-dict" baseline). This mirrors the production behaviour so a
trained-dict swap is measurable.

Usage:
    uv run python bench/compression_bench.py [--n 5000] [--seed 42]
"""
from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from pathlib import Path

# Make ``src/eden`` importable when run from the repo root.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
# Also make tests/ importable for REPRESENTATIVE_PAYLOADS.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests" / "unit" / "storage"))

from eden.storage import compression  # noqa: E402
from eden.storage.compression import (  # noqa: E402
    compress_jsonb,
    compress_many,
    decompress_many,
    get_dict,
)


def _build_corpus(n: int, seed: int) -> list[dict]:
    """Build a realistic mix of LLM payloads."""
    rng = random.Random(seed)
    sys_msgs = [
        "You are a helpful assistant. " * 5,
        "You are Eden, an AI-native environment generation platform. " * 3,
    ]
    user_templates = [
        "Tell me about TOPIC.",
        "Explain TOPIC in detail.",
        "Why is TOPIC important?",
    ]
    topics = [
        "Python async", "Kubernetes", "PostgreSQL", "Redis",
        "machine learning", "neural networks", "distributed systems",
        "API design", "REST patterns", "SQL optimization",
        "index design", "transaction isolation",
    ]
    models = ["gpt-4o", "claude-3-5-sonnet-20241022", "openai/gpt-4o-mini"]

    def make_conv(turns: int) -> dict:
        msgs = [{"role": "system", "content": rng.choice(sys_msgs)}]
        for i in range(turns):
            msgs.append({
                "role": "user" if i % 2 == 0 else "assistant",
                "content": rng.choice(user_templates).replace("TOPIC", rng.choice(topics))
                * rng.randint(2, 8),
            })
        return {
            "model": rng.choice(models),
            "messages": msgs,
            "temperature": rng.choice([0, 0.3, 0.7, 1.0]),
            "max_tokens": rng.choice([256, 1024, 4096]),
            "stream": False,
        }

    out: list[dict] = []
    for _ in range(n):
        r = rng.random()
        if r < 0.5:
            out.append(make_conv(rng.randint(5, 30)))
        elif r < 0.8:
            out.append({
                "model": "gpt-4o",
                "messages": [{
                    "role": "user",
                    "content": "hi " * rng.randint(20, 200),
                }],
            })
        else:
            out.append({"k": "v", "n": rng.randint(1, 10)})
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--n", type=int, default=5000, help="corpus size (default 5000)")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--no-dict", action="store_true",
                        help="force empty dictionary (baseline measurement)")
    args = parser.parse_args()

    # Point the storage layer at the trained dict (if it ships).
    dict_path = Path(__file__).resolve().parents[1] / "var" / "zstd_dict.bin"
    if args.no_dict or not dict_path.exists():
        # Use an empty sentinel: ``DICT_PATH`` pointing at a missing
        # file → ``get_dict()`` returns the empty dict.
        compression.DICT_PATH = Path("/nonexistent/zstd_dict.bin")
    else:
        compression.DICT_PATH = dict_path
    compression.invalidate_caches()
    d = get_dict()
    dict_size = len(d.as_bytes())
    dict_label = "trained" if dict_size > 0 else "empty"

    print(f"== compression benchmark (n={args.n}, seed={args.seed}, dict={dict_label} {dict_size} bytes) ==", file=sys.stderr)
    corpus = _build_corpus(args.n, args.seed)

    # 1. Round-trip check on the first 100 (catches regressions early).
    errors = 0
    for p in corpus[:100]:
        c = compress_jsonb(p)
        from eden.storage.compression import decompress_jsonb
        d_out = decompress_jsonb(c)
        if json.dumps(d_out, default=str, sort_keys=True) != json.dumps(p, default=str, sort_keys=True):
            errors += 1
    print(f"round-trip errors on first 100: {errors}", file=sys.stderr)

    # 2. Single-thread throughput + ratio.
    total_raw = 0
    total_comp = 0
    t0 = time.perf_counter()
    for p in corpus:
        raw = json.dumps(p, default=str, separators=(",", ":")).encode("utf-8")
        c = compress_jsonb(p)
        total_raw += len(raw)
        total_comp += len(c)
    single_time = time.perf_counter() - t0

    # 3. Batch API throughput.
    t0 = time.perf_counter()
    compressed = compress_many(corpus)
    batch_time = time.perf_counter() - t0

    # 4. Batch decompress throughput.
    t0 = time.perf_counter()
    decoded = decompress_many(compressed)
    decomp_time = time.perf_counter() - t0

    # 5. JSON output for CI parsing.
    out = {
        "n": args.n,
        "dict_bytes": dict_size,
        "dict_label": dict_label,
        "raw_bytes": total_raw,
        "compressed_bytes": total_comp,
        "compression_ratio": round(total_raw / total_comp, 2),
        "single_thread_ops_per_sec": round(args.n / single_time, 1),
        "single_thread_ms": round(single_time * 1000, 1),
        "batch_compress_ops_per_sec": round(args.n / batch_time, 1),
        "batch_compress_ms": round(batch_time * 1000, 1),
        "batch_speedup_vs_single": round(single_time / batch_time, 2),
        "batch_decompress_ops_per_sec": round(args.n / decomp_time, 1),
        "batch_decompress_ms": round(decomp_time * 1000, 1),
        "round_trip_errors": errors,
    }
    print(json.dumps(out, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
