"""Real-use compression benchmark for Eden span storage.

Builds a corpus from:
  * ``tests/fixtures/traces/**`` (synthetic Eden agent traces)
  * realistic per-column shapes Eden actually writes to ``*_zstd``
    (request_body, response_body, attributes, metrics, tool_calls, …)
  * a controlled high-entropy slice (UUIDs / hex) so never-expand is exercised

Reports full stats vs the previous shipped dictionary (if
``--baseline-dict`` is given) and vs empty-dict / no never-expand ablations.

Usage:
    PYTHONPATH=src:. python -m bench.compression_real_use
    PYTHONPATH=src:. python -m bench.compression_real_use \\
        --baseline-dict /tmp/zstd_dict_before.bin --json out.json
"""

from __future__ import annotations

import argparse
import json
import random
import statistics
import sys
import time
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

import zstandard as zstd  # noqa: E402

from eden.storage import compression  # noqa: E402
from eden.storage.compression import (  # noqa: E402
    ZSTD_MAGIC,
    _to_json_bytes,
    compress_jsonb,
    compress_many,
    decompress_jsonb,
    decompress_many,
    invalidate_caches,
)


def _load_fixture_payloads() -> list[Any]:
    out: list[Any] = []
    root = REPO_ROOT / "tests" / "fixtures" / "traces"
    if not root.exists():
        return out
    for path in root.rglob("*.json"):
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        events: list[Any]
        if isinstance(data, dict):
            if isinstance(data.get("events"), list):
                events = data["events"]
            elif isinstance(data.get("spans"), list):
                events = data["spans"]
            else:
                events = [data]
        elif isinstance(data, list):
            events = data
        else:
            continue
        for ev in events:
            if not isinstance(ev, dict):
                continue
            for key in (
                "input",
                "output",
                "request_body",
                "response_body",
                "payload",
                "attributes",
                "metrics",
                "tool_calls",
                "tool_results",
                "reasoning",
                "content",
                "messages",
            ):
                val = ev.get(key)
                if val not in (None, {}, [], ""):
                    out.append(val)
            slim = {
                k: v
                for k, v in ev.items()
                if k
                in (
                    "type",
                    "name",
                    "input",
                    "output",
                    "error",
                    "model",
                    "usage",
                    "attributes",
                    "metrics",
                    "tool_calls",
                )
            }
            if slim:
                out.append(slim)
    return out


def _synthetic_column_shapes(rng: random.Random, n: int = 1200) -> list[Any]:
    """Shapes that mirror the 8 ``*_zstd`` columns on ``telemetry_events``."""
    topics = [
        "orders",
        "refunds",
        "inventory",
        "shipping",
        "auth",
        "billing",
        "support",
        "SQL",
        "RAG",
    ]
    sys_msgs = [
        "You are a helpful assistant. Follow the user's instructions carefully. " * 3,
        "You are Eden's agent runtime. Prefer tools when uncertain. " * 4,
    ]
    out: list[Any] = []
    for _ in range(n):
        turns = rng.randint(2, 14)
        msgs = [{"role": "system", "content": rng.choice(sys_msgs)}]
        for i in range(turns):
            role = "user" if i % 2 == 0 else "assistant"
            msgs.append(
                {
                    "role": role,
                    "content": (
                        f"Regarding {rng.choice(topics)}: "
                        + "detail " * rng.randint(4, 35)
                    ),
                }
            )
        # request_body
        out.append(
            {
                "model": rng.choice(["gpt-4o", "claude-3-5-sonnet", "deepseek-chat"]),
                "messages": msgs,
                "temperature": 0.2,
                "stream": False,
            }
        )
        # response_body
        out.append(
            {
                "id": f"chatcmpl-{rng.randrange(10**8):08d}",
                "object": "chat.completion",
                "model": "gpt-4o",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": "Here is the answer. " * rng.randint(2, 20),
                        },
                    }
                ],
                "usage": {
                    "prompt_tokens": rng.randint(20, 4000),
                    "completion_tokens": rng.randint(5, 800),
                    "total_tokens": rng.randint(30, 4800),
                },
            }
        )
        # attributes
        out.append(
            {
                "agent_id": "agent_" + rng.choice(topics),
                "org_id": "org_" + "".join(rng.choice("abcdef0123456789") for _ in range(8)),
                "eden.model": "gpt-4o",
                "eden.cost_usd": f"{rng.uniform(0.0001, 0.05):.6f}",
            }
        )
        # metrics
        out.append(
            {
                "prompt_tokens": rng.randint(10, 4000),
                "completion_tokens": rng.randint(5, 800),
                "latency_ms": round(rng.uniform(40, 6000), 2),
                "cost_usd": round(rng.uniform(0.0001, 0.08), 6),
            }
        )
        # tool_calls_full
        out.append(
            [
                {
                    "id": f"call_{rng.randrange(10**6)}",
                    "type": "function",
                    "function": {
                        "name": rng.choice(["search", "get_order", "refund"]),
                        "arguments": json.dumps(
                            {"q": rng.choice(topics), "limit": 10}
                        ),
                    },
                }
            ]
        )
        # high-entropy (~8% of synthetic) — forces never-expand path
        if rng.random() < 0.08:
            out.append(
                {
                    "blob": "".join(
                        rng.choice("abcdef0123456789") for _ in range(rng.randint(800, 4000))
                    )
                }
            )
    return out


def build_corpus(*, seed: int = 42) -> list[Any]:
    rng = random.Random(seed)
    payloads = _load_fixture_payloads() + _synthetic_column_shapes(rng)
    # Drop empties / tiny noise that would dominate counts without teaching much
    filtered: list[Any] = []
    for p in payloads:
        try:
            raw = _to_json_bytes(p)
        except (TypeError, ValueError):
            continue
        if len(raw) >= 8:
            filtered.append(p)
    rng.shuffle(filtered)
    return filtered


def _pct(sorted_vals: list[float], q: float) -> float:
    if not sorted_vals:
        return 0.0
    idx = min(len(sorted_vals) - 1, max(0, int(round((q / 100.0) * (len(sorted_vals) - 1)))))
    return sorted_vals[idx]


def _measure(
    payloads: list[Any],
    *,
    label: str,
    dict_path: Path | None,
    never_expand: bool,
) -> dict[str, Any]:
    """Measure one configuration.

    When ``never_expand`` is False we temporarily bypass ``_maybe_compress``
    by compressing with a raw zstd compressor (same level/dict) so the
    ablation is honest.
    """
    if dict_path is None or not dict_path.exists():
        compression.DICT_PATH = Path("/nonexistent/zstd_dict.bin")
    else:
        compression.DICT_PATH = dict_path
    invalidate_caches()
    dict_obj = compression.get_dict()
    dict_bytes = len(dict_obj.as_bytes())

    raw_sizes: list[int] = []
    comp_sizes: list[int] = []
    ratios: list[float] = []
    zstd_frames = 0
    raw_stored = 0
    expanded_if_forced = 0

    # Warm caches
    for p in payloads[:50]:
        compress_jsonb(p)

    t0 = time.perf_counter()
    stored: list[bytes] = []
    if never_expand:
        for p in payloads:
            raw = _to_json_bytes(p)
            out = compress_jsonb(p)
            stored.append(out)
            raw_sizes.append(len(raw))
            comp_sizes.append(len(out))
            ratios.append(len(raw) / len(out) if out else 0.0)
            if out.startswith(ZSTD_MAGIC):
                zstd_frames += 1
            else:
                raw_stored += 1
    else:
        # Ablation: always store the zstd frame even if larger (old behaviour
        # above SMALL_PAYLOAD_BYTES). Still skip the tiny fast-path the same way.
        c = zstd.ZstdCompressor(dict_data=dict_obj, level=compression.DEFAULT_LEVEL)
        for p in payloads:
            raw = _to_json_bytes(p)
            if len(raw) < compression.SMALL_PAYLOAD_BYTES:
                out = raw
            else:
                out = c.compress(raw)
                if len(out) >= len(raw):
                    expanded_if_forced += 1
            stored.append(out)
            raw_sizes.append(len(raw))
            comp_sizes.append(len(out))
            ratios.append(len(raw) / len(out) if out else 0.0)
            if out.startswith(ZSTD_MAGIC):
                zstd_frames += 1
            else:
                raw_stored += 1
    encode_s = time.perf_counter() - t0

    # Round-trip
    errors = 0
    t0 = time.perf_counter()
    for p, blob in zip(payloads, stored, strict=True):
        try:
            got = decompress_jsonb(blob)
            if json.dumps(got, default=str, sort_keys=True) != json.dumps(
                p, default=str, sort_keys=True
            ):
                errors += 1
        except Exception:
            errors += 1
    decode_s = time.perf_counter() - t0

    # Batch path (production write shape: 8 fields × N events ≈ many values)
    t0 = time.perf_counter()
    batch_out = compress_many(payloads)
    batch_encode_s = time.perf_counter() - t0
    t0 = time.perf_counter()
    decompress_many(batch_out)
    batch_decode_s = time.perf_counter() - t0

    total_raw = sum(raw_sizes)
    total_comp = sum(comp_sizes)
    ratios_sorted = sorted(ratios)
    raw_sorted = sorted(float(x) for x in raw_sizes)

    return {
        "label": label,
        "dict_bytes": dict_bytes,
        "never_expand": never_expand,
        "n": len(payloads),
        "total_raw_bytes": total_raw,
        "total_comp_bytes": total_comp,
        "compression_ratio": round(total_raw / total_comp, 4) if total_comp else 0.0,
        "bytes_saved": total_raw - total_comp,
        "bytes_saved_pct": round(100.0 * (1.0 - total_comp / total_raw), 2) if total_raw else 0.0,
        "ratio_p50": round(_pct(ratios_sorted, 50), 3),
        "ratio_p95": round(_pct(ratios_sorted, 95), 3),
        "ratio_p99": round(_pct(ratios_sorted, 99), 3),
        "ratio_mean": round(statistics.fmean(ratios), 3) if ratios else 0.0,
        "raw_bytes_p50": int(_pct(raw_sorted, 50)),
        "raw_bytes_p95": int(_pct(raw_sorted, 95)),
        "zstd_frames": zstd_frames,
        "raw_stored": raw_stored,
        "would_have_expanded": expanded_if_forced,
        "encode_ops_per_sec": int(len(payloads) / encode_s) if encode_s else 0,
        "decode_ops_per_sec": int(len(payloads) / decode_s) if decode_s else 0,
        "encode_mb_per_sec": round((total_raw / 1e6) / encode_s, 2) if encode_s else 0.0,
        "batch_encode_ops_per_sec": int(len(payloads) / batch_encode_s) if batch_encode_s else 0,
        "batch_decode_ops_per_sec": int(len(payloads) / batch_decode_s) if batch_decode_s else 0,
        "round_trip_errors": errors,
    }


def run(*, baseline_dict: Path | None = None, seed: int = 42) -> dict[str, Any]:
    payloads = build_corpus(seed=seed)
    current = REPO_ROOT / "var" / "zstd_dict.bin"
    configs: list[tuple[str, Path | None, bool]] = [
        ("empty_dict+always_zstd", None, False),
        ("empty_dict+never_expand", None, True),
        ("current_dict+always_zstd", current, False),
        ("current_dict+never_expand", current, True),
    ]
    if baseline_dict is not None:
        configs.insert(2, ("baseline_dict+always_zstd", baseline_dict, False))
        configs.insert(3, ("baseline_dict+never_expand", baseline_dict, True))

    rows = [
        _measure(payloads, label=label, dict_path=path, never_expand=ne)
        for label, path, ne in configs
    ]
    return {
        "corpus": {
            "n": len(payloads),
            "fixture_files": sum(1 for _ in (REPO_ROOT / "tests" / "fixtures" / "traces").rglob("*.json"))
            if (REPO_ROOT / "tests" / "fixtures" / "traces").exists()
            else 0,
            "seed": seed,
        },
        "results": rows,
    }


def _print_table(report: dict[str, Any]) -> None:
    corp = report["corpus"]
    print("=" * 96)
    print("Eden compression — real-use benchmark")
    print(
        f"corpus n={corp['n']}  fixture_json_files={corp['fixture_files']}  seed={corp['seed']}"
    )
    print("=" * 96)
    hdr = (
        f"{'config':<32} {'ratio':>7} {'save%':>7} {'p50':>6} {'p95':>6} "
        f"{'enc/s':>8} {'batch/s':>8} {'zstd':>6} {'raw':>5} {'err':>4}"
    )
    print(hdr)
    print("-" * len(hdr))
    for r in report["results"]:
        print(
            f"{r['label']:<32} {r['compression_ratio']:>7.3f} {r['bytes_saved_pct']:>6.1f}% "
            f"{r['ratio_p50']:>6.2f} {r['ratio_p95']:>6.2f} "
            f"{r['encode_ops_per_sec']:>8} {r['batch_encode_ops_per_sec']:>8} "
            f"{r['zstd_frames']:>6} {r['raw_stored']:>5} {r['round_trip_errors']:>4}"
        )
    print("=" * 96)
    # Headline: current never-expand vs baseline always-zstd if present
    by_label = {r["label"]: r for r in report["results"]}
    cur = by_label.get("current_dict+never_expand")
    base = by_label.get("baseline_dict+always_zstd") or by_label.get("baseline_dict+never_expand")
    if cur and base:
        print(
            f"HEADLINE  baseline {base['compression_ratio']:.3f}× → "
            f"current {cur['compression_ratio']:.3f}×  "
            f"({cur['total_raw_bytes']:,} → {cur['total_comp_bytes']:,} bytes, "
            f"{cur['bytes_saved_pct']:.1f}% saved, "
            f"round-trip errors={cur['round_trip_errors']})"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--baseline-dict",
        type=Path,
        default=None,
        help="Previous dict (e.g. /tmp/zstd_dict_before.bin) for before/after",
    )
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--json", type=Path, default=None, help="Write full JSON report")
    args = parser.parse_args()
    report = run(baseline_dict=args.baseline_dict, seed=args.seed)
    _print_table(report)
    if args.json:
        args.json.write_text(json.dumps(report, indent=2))
        print(f"Wrote {args.json}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
