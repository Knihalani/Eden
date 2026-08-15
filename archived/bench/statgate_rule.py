"""OPT-22 microbenchmark for ``_eval_statgate_rule``.

Measures capped + shared-state StatGate evaluation over a long synthetic
trace (500 events) × N rules — the pattern ``investigate_trace`` hits
when many ``statgate_rule`` signal definitions are enabled.

Run from repo root::

    PYTHONPATH=src uv run python bench/statgate_rule.py
"""

from __future__ import annotations

import sys
import time
from dataclasses import dataclass
from pathlib import Path

# Prefer ``src/eden`` over the SDK package that also claims the ``eden`` name.
_ROOT = Path(__file__).resolve().parents[1]
_SRC = _ROOT / "src"
_src_s = str(_SRC)
if _src_s in sys.path:
    sys.path.remove(_src_s)
sys.path.insert(0, _src_s)
# Drop any already-imported SDK ``eden`` so the src package wins.
for _mod in list(sys.modules):
    if _mod == "eden" or _mod.startswith("eden."):
        del sys.modules[_mod]

from eden.signals.investigator import (  # noqa: E402
    _eval_statgate_rule,
    _precompute_statgate_state,
)


@dataclass
class StatGateBenchResult:
    name: str
    n_events: int
    n_rules: int
    iterations: int
    elapsed_ms: float
    per_call_us: float


def _synthetic_events(n: int) -> list[dict]:
    events: list[dict] = []
    for i in range(n):
        if i % 3 == 0:
            events.append(
                {
                    "event_type": "tool.call",
                    "name": f"tool_{i % 7}",
                    "attributes": {},
                }
            )
        else:
            events.append(
                {
                    "event_type": "llm.call",
                    "name": "chat",
                    "attributes": {"cost_z_score": float(i % 5)},
                }
            )
    return events


def bench_statgate(
    *,
    n_events: int = 500,
    n_rules: int = 20,
    iterations: int = 200,
) -> list[StatGateBenchResult]:
    events = _synthetic_events(n_events)
    rules = (
        ["tool_call_rate > 0.05"] * (n_rules // 2)
        + ["cost_per_call > 3sigma"] * (n_rules - n_rules // 2)
    )

    # Baseline: naive per-rule scan (shared=None recomputes each time).
    t0 = time.perf_counter()
    for _ in range(iterations):
        for rule in rules:
            _eval_statgate_rule(rule, events)
    naive_ms = (time.perf_counter() - t0) * 1000.0

    # OPT-22 path: precompute once, reuse across rules.
    t0 = time.perf_counter()
    for _ in range(iterations):
        shared = _precompute_statgate_state(events)
        for rule in rules:
            _eval_statgate_rule(rule, events, shared=shared)
    shared_ms = (time.perf_counter() - t0) * 1000.0

    calls = iterations * n_rules
    return [
        StatGateBenchResult(
            name="statgate_naive_per_rule",
            n_events=n_events,
            n_rules=n_rules,
            iterations=iterations,
            elapsed_ms=naive_ms,
            per_call_us=(naive_ms * 1000.0) / calls,
        ),
        StatGateBenchResult(
            name="statgate_shared_precompute",
            n_events=n_events,
            n_rules=n_rules,
            iterations=iterations,
            elapsed_ms=shared_ms,
            per_call_us=(shared_ms * 1000.0) / calls,
        ),
    ]


if __name__ == "__main__":
    for row in bench_statgate():
        print(
            f"{row.name}: {row.elapsed_ms:.2f}ms total, "
            f"{row.per_call_us:.2f}µs/call "
            f"({row.n_events} events × {row.n_rules} rules × {row.iterations} iters)"
        )
