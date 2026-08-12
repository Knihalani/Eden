"""Production-weighted compression accuracy bench.

Unlike ``compression_real_use`` (flat bag of field blobs), this mirrors
exactly what ``TelemetryCollector._compress_fields`` writes per event:

    request_body, response_body, reasoning, tool_calls_full,
    tool_results, payload, metrics, attributes

Empty ``None`` / ``{}`` / ``[]`` become SQL NULL (not stored) — same as
``compress_many``. The headline ratio is therefore:

    sum(raw JSON bytes of stored columns) / sum(stored BYTEA bytes)

which is the number that shows up in Postgres storage, not an average
of per-blob ratios diluted by fields that were never written.

Also reports a bootstrap 95% CI on that bytes ratio so the "average"
claim is statistically grounded.

Usage:
    PYTHONPATH=src:. python -m bench.compression_prod_weighted
    PYTHONPATH=src:. python -m bench.compression_prod_weighted --json out.json
"""

from __future__ import annotations

import argparse
import json
import random
import statistics
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from eden.storage import compression  # noqa: E402
from eden.storage.compression import (  # noqa: E402
    ZSTD_MAGIC,
    _to_json_bytes,
    compress_many,
    decompress_many,
    invalidate_caches,
)

FIELD_NAMES = (
    "request_body",
    "response_body",
    "reasoning",
    "tool_calls_full",
    "tool_results",
    "payload",
    "metrics",
    "attributes",
)


# ---------------------------------------------------------------------------
# Event factory — occupancy calibrated to agent-observability traffic
# ---------------------------------------------------------------------------
# Mix (by event count):
#   55% llm_chat     — request+response+metrics+attributes (tools ~25%)
#   20% tool_only    — tool_calls+tool_results+metrics+attributes
#   15% light        — metrics+attributes only (heartbeats / custom spans)
#   7%  reasoning    — llm_chat + reasoning blob (o-series style)
#   3%  high_entropy — deliberately incompressible attribute bag
#
# These weights are an engineering estimate of Eden ingest shape, not live
# prod telemetry. They are the right unit for "what will Postgres store",
# and every ratio below is labeled as such.


@dataclass
class SynthEvent:
    request_body: Any = None
    response_body: Any = None
    reasoning: Any = None
    tool_calls_full: Any = None
    tool_results: Any = None
    payload: Any = None
    metrics: Any = None
    attributes: Any = None
    archetype: str = ""

    def as_fields(self) -> list[Any]:
        return [
            self.request_body,
            self.response_body,
            self.reasoning,
            self.tool_calls_full,
            self.tool_results,
            self.payload,
            self.metrics,
            self.attributes,
        ]


def _messages(rng: random.Random, turns: int) -> list[dict[str, str]]:
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
        "tool use",
    ]
    sys = (
        "You are a careful assistant for an e-commerce operations agent. "
        "Prefer tools when uncertain. Cite order ids. "
    ) * rng.randint(1, 3)
    msgs: list[dict[str, str]] = [{"role": "system", "content": sys}]
    for i in range(turns):
        role = "user" if i % 2 == 0 else "assistant"
        msgs.append(
            {
                "role": role,
                "content": (
                    f"About {rng.choice(topics)}: "
                    + ("detail " * rng.randint(6, 40))
                ),
            }
        )
    return msgs


def _metrics(rng: random.Random) -> dict[str, Any]:
    return {
        "prompt_tokens": rng.randint(40, 6000),
        "completion_tokens": rng.randint(10, 1200),
        "latency_ms": round(rng.uniform(80, 8000), 2),
        "cost_usd": round(rng.uniform(0.0002, 0.12), 6),
    }


def _attributes(rng: random.Random, *, noisy: bool = False) -> dict[str, Any]:
    base = {
        "agent_id": f"agent_{rng.choice(['ops', 'support', 'billing'])}",
        "org_id": "org_" + "".join(rng.choice("abcdef0123456789") for _ in range(10)),
        "eden.model": rng.choice(["gpt-4o", "claude-3-5-sonnet", "deepseek-chat"]),
        "eden.span_kind": rng.choice(["llm", "tool", "chain"]),
    }
    if noisy:
        base["noise"] = "".join(rng.choice("abcdef0123456789") for _ in range(3000))
    return base


def _tools(rng: random.Random) -> tuple[list[dict], list[dict]]:
    name = rng.choice(["search_orders", "get_refund", "lookup_sku"])
    call_id = f"call_{rng.randrange(10**8)}"
    args = json.dumps({"q": rng.choice(["pending", "failed", "sku-1"]), "limit": 10})
    calls = [
        {
            "id": call_id,
            "type": "function",
            "function": {"name": name, "arguments": args},
        }
    ]
    results = [
        {
            "tool_call_id": call_id,
            "content": [
                {"type": "text", "text": json.dumps({"ok": True, "n": rng.randint(0, 20)})}
            ],
        }
    ]
    return calls, results


def make_event(rng: random.Random, archetype: str) -> SynthEvent:
    if archetype == "llm_chat":
        ev = SynthEvent(
            request_body={
                "model": "gpt-4o",
                "messages": _messages(rng, rng.randint(2, 12)),
                "temperature": 0.2,
                "stream": False,
            },
            response_body={
                "id": f"chatcmpl-{rng.randrange(10**8):08d}",
                "object": "chat.completion",
                "model": "gpt-4o",
                "choices": [
                    {
                        "index": 0,
                        "finish_reason": "stop",
                        "message": {
                            "role": "assistant",
                            "content": "Here is the answer. " * rng.randint(3, 25),
                        },
                    }
                ],
                "usage": {
                    "prompt_tokens": rng.randint(40, 4000),
                    "completion_tokens": rng.randint(10, 800),
                    "total_tokens": rng.randint(50, 4800),
                },
            },
            metrics=_metrics(rng),
            attributes=_attributes(rng),
            payload={"feature": "chat", "session": f"s{rng.randrange(10**5)}"},
            archetype=archetype,
        )
        if rng.random() < 0.25:
            calls, results = _tools(rng)
            ev.tool_calls_full = calls
            ev.tool_results = results
        return ev
    if archetype == "tool_only":
        calls, results = _tools(rng)
        return SynthEvent(
            tool_calls_full=calls,
            tool_results=results,
            metrics=_metrics(rng),
            attributes=_attributes(rng),
            archetype=archetype,
        )
    if archetype == "light":
        return SynthEvent(
            metrics=_metrics(rng),
            attributes=_attributes(rng),
            payload={"tick": True},
            archetype=archetype,
        )
    if archetype == "reasoning":
        ev = make_event(rng, "llm_chat")
        ev.archetype = "reasoning"
        ev.reasoning = {
            "summary": "Step-by-step plan. " * rng.randint(5, 20),
            "steps": [
                {"step": i, "thought": f"Consider option {i}. " * 8}
                for i in range(1, rng.randint(3, 8))
            ],
            "model": "o3-mini",
            "tokens": rng.randint(500, 5000),
        }
        return ev
    if archetype == "high_entropy":
        return SynthEvent(
            metrics=_metrics(rng),
            attributes=_attributes(rng, noisy=True),
            payload={
                "blob": "".join(rng.choice("abcdef0123456789") for _ in range(2500))
            },
            archetype=archetype,
        )
    raise ValueError(archetype)


ARCHETYPE_WEIGHTS = (
    ("llm_chat", 0.55),
    ("tool_only", 0.20),
    ("light", 0.15),
    ("reasoning", 0.07),
    ("high_entropy", 0.03),
)


def build_events(n: int, *, seed: int = 42) -> list[SynthEvent]:
    rng = random.Random(seed)
    names, weights = zip(*ARCHETYPE_WEIGHTS, strict=True)
    return [make_event(rng, rng.choices(names, weights=weights, k=1)[0]) for _ in range(n)]


def _canonical(obj: Any) -> str:
    return json.dumps(obj, default=str, sort_keys=True, allow_nan=False)


@dataclass
class WeightedReport:
    n_events: int
    stored_fields: int
    null_fields: int
    total_raw: int
    total_comp: int
    bytes_ratio: float
    bytes_saved_pct: float
    mean_field_ratio: float
    p50_field_ratio: float
    p95_field_ratio: float
    p99_field_ratio: float
    bootstrap_ci95: tuple[float, float]
    per_archetype: dict[str, dict[str, float]] = field(default_factory=dict)
    per_field: dict[str, dict[str, float]] = field(default_factory=dict)
    round_trip_errors: int = 0
    never_expand_violations: int = 0
    encode_events_per_sec: float = 0.0
    single_vs_batch_mismatches: int = 0


def _field_stats(ratios: list[float], raw: int, comp: int) -> dict[str, float]:
    if not ratios:
        return {
            "n": 0,
            "bytes_ratio": 0.0,
            "mean": 0.0,
            "p50": 0.0,
            "p95": 0.0,
        }
    xs = sorted(ratios)
    return {
        "n": float(len(xs)),
        "bytes_ratio": round(raw / comp, 4) if comp else 0.0,
        "mean": round(statistics.fmean(xs), 4),
        "p50": round(xs[len(xs) // 2], 4),
        "p95": round(xs[min(len(xs) - 1, int(0.95 * (len(xs) - 1)))], 4),
    }


def measure(events: list[SynthEvent], *, bootstraps: int = 400) -> WeightedReport:
    from eden.storage.compression import TELEMETRY_ZSTD_FIELDS, compress_jsonb
    from eden.storage.zstd_registry import set_dicts_dir

    compression.DICT_PATH = REPO_ROOT / "var" / "zstd_dict.bin"
    set_dicts_dir(REPO_ROOT / "var" / "zstd_dicts")
    invalidate_caches()

    flat = [f for ev in events for f in ev.as_fields()]
    cols = list(TELEMETRY_ZSTD_FIELDS) * len(events)
    # Warm
    compress_many(events[0].as_fields(), columns=list(TELEMETRY_ZSTD_FIELDS))

    t0 = time.perf_counter()
    stored = compress_many(flat, columns=cols)
    encode_s = time.perf_counter() - t0
    decoded = decompress_many(stored)

    total_raw = 0
    total_comp = 0
    field_ratios: list[float] = []
    per_arch_raw: dict[str, int] = {}
    per_arch_comp: dict[str, int] = {}
    per_arch_ratios: dict[str, list[float]] = {}
    per_field_raw: dict[str, int] = {n: 0 for n in FIELD_NAMES}
    per_field_comp: dict[str, int] = {n: 0 for n in FIELD_NAMES}
    per_field_ratios: dict[str, list[float]] = {n: [] for n in FIELD_NAMES}
    null_fields = 0
    stored_fields = 0
    rt_errors = 0
    expand_violations = 0
    event_ratios: list[float] = []

    for i, ev in enumerate(events):
        ev_raw = 0
        ev_comp = 0
        for j, name in enumerate(FIELD_NAMES):
            idx = i * 8 + j
            original = flat[idx]
            blob = stored[idx]
            got = decoded[idx]
            if blob is None:
                null_fields += 1
                if original not in (None, {}, []):
                    rt_errors += 1
                continue
            stored_fields += 1
            raw_b = _to_json_bytes(original)
            if len(blob) > len(raw_b):
                expand_violations += 1
            total_raw += len(raw_b)
            total_comp += len(blob)
            ev_raw += len(raw_b)
            ev_comp += len(blob)
            ratio = len(raw_b) / len(blob)
            field_ratios.append(ratio)
            per_arch_raw[ev.archetype] = per_arch_raw.get(ev.archetype, 0) + len(raw_b)
            per_arch_comp[ev.archetype] = per_arch_comp.get(ev.archetype, 0) + len(blob)
            per_arch_ratios.setdefault(ev.archetype, []).append(ratio)
            per_field_raw[name] += len(raw_b)
            per_field_comp[name] += len(blob)
            per_field_ratios[name].append(ratio)
            try:
                if _canonical(got) != _canonical(original):
                    rt_errors += 1
            except (TypeError, ValueError):
                rt_errors += 1
            if len(raw_b) >= compression.SMALL_PAYLOAD_BYTES and len(blob) < len(raw_b):
                if not blob.startswith(ZSTD_MAGIC) and blob != raw_b:
                    rt_errors += 1
        if ev_comp:
            event_ratios.append(ev_raw / ev_comp)

    mismatches = 0
    for ev in events[:200]:
        for name, val in zip(TELEMETRY_ZSTD_FIELDS, ev.as_fields(), strict=True):
            if val in (None, {}, []):
                continue
            a = compress_jsonb(val, column=name)
            b = compress_many([val], columns=[name])[0]
            if a != b:
                mismatches += 1

    rng = random.Random(99)
    if event_ratios:
        boot: list[float] = []
        for _ in range(bootstraps):
            idxs = [rng.randrange(len(events)) for _ in range(len(events))]
            br = bc = 0
            for i in idxs:
                for j in range(8):
                    blob = stored[i * 8 + j]
                    if blob is None:
                        continue
                    br += len(_to_json_bytes(flat[i * 8 + j]))
                    bc += len(blob)
            if bc:
                boot.append(br / bc)
        boot.sort()
        lo = boot[int(0.025 * (len(boot) - 1))]
        hi = boot[int(0.975 * (len(boot) - 1))]
    else:
        lo = hi = 0.0

    xs = sorted(field_ratios)
    return WeightedReport(
        n_events=len(events),
        stored_fields=stored_fields,
        null_fields=null_fields,
        total_raw=total_raw,
        total_comp=total_comp,
        bytes_ratio=round(total_raw / total_comp, 4) if total_comp else 0.0,
        bytes_saved_pct=round(100.0 * (1.0 - total_comp / total_raw), 2) if total_raw else 0.0,
        mean_field_ratio=round(statistics.fmean(xs), 4) if xs else 0.0,
        p50_field_ratio=round(xs[len(xs) // 2], 4) if xs else 0.0,
        p95_field_ratio=round(xs[min(len(xs) - 1, int(0.95 * (len(xs) - 1)))], 4) if xs else 0.0,
        p99_field_ratio=round(xs[min(len(xs) - 1, int(0.99 * (len(xs) - 1)))], 4) if xs else 0.0,
        bootstrap_ci95=(round(lo, 4), round(hi, 4)),
        per_archetype={
            k: _field_stats(per_arch_ratios.get(k, []), per_arch_raw.get(k, 0), per_arch_comp.get(k, 0))
            for k in sorted(per_arch_raw)
        },
        per_field={
            k: _field_stats(per_field_ratios[k], per_field_raw[k], per_field_comp[k])
            for k in FIELD_NAMES
        },
        round_trip_errors=rt_errors,
        never_expand_violations=expand_violations,
        encode_events_per_sec=round(len(events) / encode_s, 1) if encode_s else 0.0,
        single_vs_batch_mismatches=mismatches,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--n", type=int, default=5000, help="synthetic events (default 5000)")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--bootstraps", type=int, default=400)
    parser.add_argument("--json", type=Path, default=None)
    args = parser.parse_args()

    events = build_events(args.n, seed=args.seed)
    report = measure(events, bootstraps=args.bootstraps)

    print("=" * 88)
    print("Eden compression — production-weighted accuracy")
    print(
        f"events={report.n_events}  stored_fields={report.stored_fields}  "
        f"null_fields={report.null_fields}  encode={report.encode_events_per_sec:.0f} ev/s"
    )
    print("=" * 88)
    print(
        f"BYTES RATIO (storage):  {report.bytes_ratio:.3f}×   "
        f"saved {report.bytes_saved_pct:.1f}%   "
        f"({report.total_raw:,} → {report.total_comp:,})"
    )
    print(
        f"bootstrap 95% CI:       {report.bootstrap_ci95[0]:.3f}× – {report.bootstrap_ci95[1]:.3f}×"
    )
    print(
        f"per-field mean/p50/p95/p99: "
        f"{report.mean_field_ratio:.2f} / {report.p50_field_ratio:.2f} / "
        f"{report.p95_field_ratio:.2f} / {report.p99_field_ratio:.2f}"
    )
    print(
        f"integrity: round_trip_errors={report.round_trip_errors}  "
        f"never_expand_violations={report.never_expand_violations}  "
        f"single_vs_batch_mismatches={report.single_vs_batch_mismatches}"
    )
    print("-" * 88)
    print(f"{'archetype':<16} {'n_fields':>8} {'bytes×':>8} {'mean':>8} {'p50':>8} {'p95':>8}")
    for name, st in report.per_archetype.items():
        print(
            f"{name:<16} {int(st['n']):>8} {st['bytes_ratio']:>8.3f} "
            f"{st['mean']:>8.2f} {st['p50']:>8.2f} {st['p95']:>8.2f}"
        )
    print("-" * 88)
    print(f"{'field':<18} {'n':>8} {'bytes×':>8} {'mean':>8} {'p50':>8} {'p95':>8}")
    for name, st in report.per_field.items():
        if st["n"] == 0:
            continue
        print(
            f"{name:<18} {int(st['n']):>8} {st['bytes_ratio']:>8.3f} "
            f"{st['mean']:>8.2f} {st['p50']:>8.2f} {st['p95']:>8.2f}"
        )
    print("=" * 88)
    print(
        f"AVERAGE (accurate): {report.bytes_ratio:.2f}×   "
        f"MAX REASONABLE (p95 stored field): {report.p95_field_ratio:.1f}×"
    )

    if args.json:
        payload = {
            "n_events": report.n_events,
            "stored_fields": report.stored_fields,
            "null_fields": report.null_fields,
            "total_raw": report.total_raw,
            "total_comp": report.total_comp,
            "bytes_ratio": report.bytes_ratio,
            "bytes_saved_pct": report.bytes_saved_pct,
            "bootstrap_ci95": list(report.bootstrap_ci95),
            "mean_field_ratio": report.mean_field_ratio,
            "p50_field_ratio": report.p50_field_ratio,
            "p95_field_ratio": report.p95_field_ratio,
            "p99_field_ratio": report.p99_field_ratio,
            "per_archetype": report.per_archetype,
            "per_field": report.per_field,
            "round_trip_errors": report.round_trip_errors,
            "never_expand_violations": report.never_expand_violations,
            "single_vs_batch_mismatches": report.single_vs_batch_mismatches,
            "encode_events_per_sec": report.encode_events_per_sec,
            "archetype_weights": dict(ARCHETYPE_WEIGHTS),
        }
        args.json.write_text(json.dumps(payload, indent=2))
        print(f"Wrote {args.json}", file=sys.stderr)
    return 0 if report.round_trip_errors == 0 and report.never_expand_violations == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
