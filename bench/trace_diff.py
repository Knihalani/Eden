"""Bench the trace-diff alignment + fetch shape (Wave 9).

Two measurements, both purely in-process (no external services):

1. **Alignment**: naive pairwise ``O(n*m)`` join vs the hashed
   ``O(n+m)`` aligner. With ``n == m == 2000`` (the ``TRACE_EVENTS_LIMIT``
   ceiling) the naive join degrades badly; the hashed version should stay
   in the low-millisecond range.

2. **Fetch shape**: the full ``_fetch_trace_events`` column set drags the
   widest blobs (``payload``, ``attributes``, ``request_body``,
   ``response_body``, ``tool_calls_full``…) for every row; the diff only
   needs a lean projection (identity + timing + outcome + cost/token
   extracts). We measure the projected row-size ratio, which is what the
   SQL ``SELECT`` will actually return off the wire.

Run: ``uv run python -m bench.trace_diff``
"""
from __future__ import annotations

import random
import time

import bench.common  # noqa: F401  (sys.path fixup: src before sdk stub)

_EVENT_TYPES = (
    "llm.call",
    "llm.completion",
    "tool.call",
    "tool.result",
    "retrieval.call",
    "memory.read",
    "prompt.build",
)
_NAMES = ("gpt-4o-mini", "tool_search", "tool_web_fetch", "kb_retrieve", "memory_get", "planner")

# Full column set mirrors ``rca/_common.py::_TRACE_EVENTS_COLUMNS_FULL``.
_FULL_COLUMNS = 21
# Lean projection the diff uses (Wave 9).
_LEAN_COLUMNS = 14


def _events(n: int, seed: int) -> list[dict]:
    rng = random.Random(seed)
    out: list[dict] = []
    for i in range(n):
        ev = {
            "event_id": f"e{i}",
            "trace_id": "t",
            "span_id": f"span-{i}",
            "event_type": rng.choice(_EVENT_TYPES),
            "name": rng.choice(_NAMES),
            "timestamp": f"2026-08-10T00:00:{i:02d}Z",
            "duration_ms": round(rng.uniform(5, 5000), 2),
            "outcome": rng.choice(("success", "success", "failure")),
            "error_type": "timeout" if i % 97 == 0 else None,
            "parent_span_id": f"span-{i - 1}" if i else None,
            "agent_id": "agent-a",
            # The wide blobs the full fetch carries but the diff ignores.
            "payload": {"input_tokens": i, "output_tokens": i // 2, "cost_usd": i / 1000},
            "attributes": {"model": "gpt-4o-mini", "provider": "openai"},
            "request_body": {"messages": [{"role": "user", "content": "x" * 200}]},
            "response_body": {"content": "y" * 400},
            "tool_calls_full": [{"name": "tool_a", "arguments": {"q": "z" * 50}}],
            "tool_results": [{"tool_call_id": "c1", "output": "w" * 100}],
        }
        out.append(ev)
    return out


def naive_align(a: list[dict], b: list[dict]) -> list[tuple[dict | None, dict | None]]:
    """Baseline: for every A step, scan B for a span_id match — O(n*m)."""
    b_by_span = {ev.get("span_id"): ev for ev in b}
    rows: list[tuple[dict | None, dict | None]] = []
    for ev_a in a:
        cand = None
        for ev_b in b:
            if ev_b.get("span_id") == ev_a.get("span_id"):
                cand = ev_b
                break
        rows.append((ev_a, cand))
    _ = b_by_span  # (naive loop intentionally does the scan)
    return rows


def hashed_align(a: list[dict], b: list[dict]) -> list[tuple[dict | None, dict | None]]:
    """Wave 9: index B once by span_id (fallback key), merge in O(n+m)."""
    b_by_span = {str(ev.get("span_id")): ev for ev in b if ev.get("span_id")}
    rows: list[tuple[dict | None, dict | None]] = []
    used: set[str] = set()
    for ev_a in a:
        key = str(ev_a.get("span_id"))
        cand = b_by_span.get(key)
        if cand is not None and key not in used:
            used.add(key)
            rows.append((ev_a, cand))
        else:
            rows.append((ev_a, None))
    for ev_b in b:
        if str(ev_b.get("span_id")) not in used:
            rows.append((None, ev_b))
    return rows


def main() -> None:
    for n in (500, 2000):
        a = _events(n, seed=1)
        b = _events(n, seed=2)

        t0 = time.perf_counter()
        naive_align(a, b)
        naive_s = time.perf_counter() - t0

        t0 = time.perf_counter()
        hashed_align(a, b)
        hashed_s = time.perf_counter() - t0

        print(f"n=m={n}:")
        print(f"  naive  O(n*m)   : {naive_s * 1000:8.2f} ms")
        print(f"  hashed O(n+m)   : {hashed_s * 1000:8.2f} ms")
        print(f"  speedup         : {naive_s / hashed_s:8.1f}x")
        print()

    # Fetch-shape ratio: lean projection returns ~_LEAN_COLUMNS columns and
    # skips the wide blob columns entirely.
    ev = _events(1, seed=3)[0]
    lean_bytes = sum(
        len(str(ev.get(k, ""))) for k in (
            "event_id", "trace_id", "span_id", "event_type", "name", "timestamp",
            "duration_ms", "outcome", "error_type", "parent_span_id", "agent_id",
        )
    )
    full_bytes = sum(len(str(v)) for v in ev.values())
    print("fetch shape (per event):")
    print(f"  full column set : {full_bytes:7d} bytes")
    print(f"  lean projection : {lean_bytes:7d} bytes  ({_LEAN_COLUMNS}/{_FULL_COLUMNS} cols)")
    print(f"  wire ratio      : {full_bytes / lean_bytes:5.1f}x fewer bytes")
    print()
    print("Post-fix target: alignment sub-10ms at n=2000, diff fetch ~10-60x lighter than full.")


if __name__ == "__main__":
    main()
