"""OOM-plan W1-16 perf gate: end-to-end ``trace()`` context-manager overhead.

Reproduces the audit micro-benchmark (OOM-IMPROVEMENT-PLAN-2026-08-12,
findings S3/S4/S11).  N=10 000 full ``trace()`` ctx-manager calls against a
no-op sink (dry-run client, no network).

Gate:   median < 35 µs  (CI budget — generous vs. the 25 µs design target so
                         the test is stable under scheduling jitter)
Report: actual median printed for every run so regressions are auditable.

The test is tagged ``@pytest.mark.perf`` consistent with the existing perf
suite in ``tests/test_perf.py``; it runs as part of the normal ``pytest``
invocation (no explicit deselect in ``pyproject.toml``).
"""

from __future__ import annotations

import statistics
import time

import pytest

import eden
from eden_sdk import client as _client_mod
from eden_sdk.config import reset_config


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

_GATE_MEDIAN_US = 35.0  # CI gate
_DESIGN_TARGET_US = 25.0  # aspirational — not asserted, just reported
_N = 10_000


def _run_benchmark() -> list[float]:
    """Return N per-call timings (µs) for a no-op trace() loop."""
    reset_config()
    _client_mod.reset_default_client()
    eden.configure(org_id="bench", api_key="k", dry_run=True)

    # Warm-up: ensures import-time and first-call costs are not included in
    # the measurement, matching the audit's "hot path" definition.
    for _ in range(200):
        with eden.trace("warm"):
            pass

    samples: list[float] = []
    for _ in range(_N):
        t0 = time.perf_counter_ns()
        with eden.trace("bench"):
            pass
        samples.append((time.perf_counter_ns() - t0) / 1_000.0)  # → µs

    return samples


# ---------------------------------------------------------------------------
# Gate test
# ---------------------------------------------------------------------------


@pytest.mark.perf
def test_trace_overhead_median_under_gate() -> None:
    """Median ``trace()`` overhead (no input/output, dry-run) stays < 35 µs.

    This is the CI gate for OOM plan findings S3/S4/S11.  The 35 µs budget
    is generous enough to survive scheduling noise on CI agents; the design
    target is 25 µs (reported below but not asserted to stay robust).
    """
    samples = _run_benchmark()
    samples_sorted = sorted(samples)
    median = statistics.median(samples_sorted)
    p95 = samples_sorted[int(0.95 * _N)]
    p99 = samples_sorted[int(0.99 * _N)]

    print(
        f"\n[perf/trace-overhead] N={_N}"
        f"  median={median:.1f} µs"
        f"  p95={p95:.1f} µs"
        f"  p99={p99:.1f} µs"
        f"  (design target={_DESIGN_TARGET_US} µs, gate={_GATE_MEDIAN_US} µs)"
    )

    assert median < _GATE_MEDIAN_US, (
        f"trace() median overhead {median:.2f} µs exceeds {_GATE_MEDIAN_US} µs gate "
        f"(p95={p95:.1f} µs, p99={p99:.1f} µs)"
    )
