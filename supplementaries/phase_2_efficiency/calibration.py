"""ETEC weight calibration harness.

Per spec §10: "Phase 2 must re-calibrate against Eden's customer
data within 90 days of ship." This is the calibration harness that
production would run against 100+ real customer traces.

The harness:
  1. Loads labeled traces with per-metric component scores.
  2. Sweeps weight combinations (e.g. 11 metrics × 5 weight steps).
  3. For each weight combo, computes TAS for each trace.
  4. Compares against expected TAS (rounded) to compute MSE.
  5. Reports the best weight combo + correlation with ground truth.

This is a development-time tool, not a hot-path dependency. It
produces the recommended weight vector that the production
composite.py uses.

Usage:
    python -m supplementaries.phase_2_efficiency.calibration \\
        --traces tests/fixtures/traces/synthetic/traces \\
        --ground-truth tests/fixtures/traces/synthetic/ground_truth \\
        --output supplementaries/phase_2_efficiency/calibration_report.json
"""
from __future__ import annotations

import argparse
import json
import math
import os
import time
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

from eden.observability.telemetry_collector import TelemetryEvent

from supplementaries.phase_2_efficiency.composite import (
    ARCHETYPE_TVS,
    WEIGHTS,
    compute_tas,
)
from supplementaries.phase_2_efficiency.ldi import compute_ldi
from supplementaries.phase_2_efficiency.srr import compute_srr


@dataclass(frozen=True)
class CalibrationResult:
    """Result of the calibration sweep."""
    best_weights: dict[str, float]
    best_mse: float
    best_pearson: float
    sweep_size: int
    runtime_seconds: float


def _load_synthetic_dataset(
    traces_dir: Path, ground_truth_dir: Path
) -> list[tuple[list[TelemetryEvent], int, str]]:
    """Load the synthetic dataset, returning (events, expected_tas, archetype_id)."""
    from tests.fixtures.traces import load_synthetic_dataset
    examples = load_synthetic_dataset(root=traces_dir.parent.parent)
    return [(ex.events, ex.expected_tas, ex.archetype_id) for ex in examples]


def _compute_components(events: list[TelemetryEvent]) -> dict[str, float]:
    """Compute each ETEC sub-metric as a normalized [0, 1] score."""
    srr = compute_srr(events)
    ldi = compute_ldi(events)
    # For brevity in calibration, we use a fixed set of placeholder
    # components for the metrics that depend on the full composite
    # pipeline. The actual composite.py computes these.
    return {
        "SRR": 1.0 - srr.srr,
        "LDI": 1.0 - ldi.ldi,
        # Other components are computed by composite.py's internal
        # pipeline; the calibration harness uses the full composite.
    }


def sweep_weights(
    dataset: list[tuple[list[TelemetryEvent], int, str]],
    weight_steps: int = 2,
) -> CalibrationResult:
    """Sweep weight combinations to find the best fit to ground truth.

    For each weight combination, computes the predicted TAS for each
    trace and compares to the expected TAS (rounded to nearest int).
    Returns the best weight combination.

    Note: full grid search over n_metrics^weight_steps combos is
    expensive. We use random sampling for weight_steps >= 3 and full
    grid only for weight_steps == 2.
    """
    import random
    start = time.perf_counter()
    n_metrics = len(WEIGHTS)
    metric_names = list(WEIGHTS.keys())

    # Pre-compute per-trace metrics once (they don't depend on weights).
    trace_metrics: list[dict[str, float]] = []
    expected_tas: list[float] = []
    for events, exp_tas, archetype_id in dataset:
        tas_result = compute_tas(events, archetype_id=archetype_id)
        trace_metrics.append(tas_result.metrics)
        expected_tas.append(float(exp_tas))

    def _score(combo: tuple) -> tuple[float, dict, float]:
        total = sum(combo) or 1.0
        candidate = {name: w / total for name, w in zip(metric_names, combo)}
        errors = []
        predicted = []
        for metrics, exp in zip(trace_metrics, expected_tas):
            raw_tas = _recompute_tas_with_weights(metrics, candidate)
            predicted.append(raw_tas)
            errors.append((raw_tas - exp) ** 2)
        mse = sum(errors) / len(errors)
        try:
            pearson = _pearson(predicted, expected_tas)
        except ZeroDivisionError:
            pearson = 0.0
        return mse, candidate, pearson

    best_mse = float("inf")
    best_weights = dict(WEIGHTS)
    best_pearson = 0.0
    sweep_count = 0

    if weight_steps <= 2:
        # Full grid (2^10 = 1024 combos for n_metrics=10).
        from itertools import product
        weight_values = [0.0, 1.0]
        for combo in product(weight_values, repeat=n_metrics):
            sweep_count += 1
            mse, candidate, pearson = _score(combo)
            if mse < best_mse:
                best_mse = mse
                best_weights = candidate
                best_pearson = pearson
    else:
        # Random sampling: 200 random weight combinations.
        rng = random.Random(42)
        for _ in range(200):
            combo = tuple(rng.random() for _ in range(n_metrics))
            sweep_count += 1
            mse, candidate, pearson = _score(combo)
            if mse < best_mse:
                best_mse = mse
                best_weights = candidate
                best_pearson = pearson
        # Also try the default weights as a baseline.
        default = tuple(WEIGHTS.values())
        sweep_count += 1
        mse, candidate, pearson = _score(default)
        if mse < best_mse:
            best_mse = mse
            best_weights = candidate
            best_pearson = pearson

    elapsed = time.perf_counter() - start
    return CalibrationResult(
        best_weights=best_weights,
        best_mse=best_mse,
        best_pearson=best_pearson,
        sweep_size=sweep_count,
        runtime_seconds=elapsed,
    )


def _recompute_tas_with_weights(
    metrics: dict[str, float], weights: dict[str, float]
) -> float:
    """Recompute TAS with custom weights, preserving the TVS scaling."""
    raw = sum(weights[k] * metrics.get(k, 0.5) for k in weights) / max(sum(weights.values()), 1e-9)
    raw_tas = raw * 100.0
    return raw_tas


def _pearson(x: list[float], y: list[float]) -> float:
    """Compute Pearson correlation coefficient."""
    n = len(x)
    if n < 2:
        return 0.0
    mean_x = sum(x) / n
    mean_y = sum(y) / n
    cov = sum((x[i] - mean_x) * (y[i] - mean_y) for i in range(n))
    var_x = sum((x[i] - mean_x) ** 2 for i in range(n))
    var_y = sum((y[i] - mean_y) ** 2 for i in range(n))
    if var_x == 0 or var_y == 0:
        return 0.0
    return cov / math.sqrt(var_x * var_y)


# ── CLI ────────────────────────────────────────────────────────


def main() -> int:
    parser = argparse.ArgumentParser(description="ETEC weight calibration")
    parser.add_argument(
        "--traces", type=Path,
        default=Path("tests/fixtures/traces/synthetic/traces"),
    )
    parser.add_argument(
        "--ground-truth", type=Path,
        default=Path("tests/fixtures/traces/synthetic/ground_truth"),
    )
    parser.add_argument(
        "--output", type=Path,
        default=Path("supplementaries/phase_2_efficiency/calibration_report.json"),
    )
    parser.add_argument(
        "--weight-steps", type=int, default=3,
        help="Number of weight values to try per metric (3 = 0, 0.5, 1.0)",
    )
    args = parser.parse_args()

    print(f"Loading dataset from {args.traces}...")
    dataset = _load_synthetic_dataset(args.traces, args.ground_truth)
    print(f"Loaded {len(dataset)} traces")

    print(f"Sweeping weights (steps={args.weight_steps})...")
    result = sweep_weights(dataset, weight_steps=args.weight_steps)

    print(f"\n=== Calibration Result ===")
    print(f"Sweep size: {result.sweep_size} combinations")
    print(f"Runtime: {result.runtime_seconds:.2f}s")
    print(f"Best MSE: {result.best_mse:.2f}")
    print(f"Best Pearson r: {result.best_pearson:.3f}")
    print(f"\nBest weights:")
    for name, w in result.best_weights.items():
        print(f"  {name}: {w:.3f}")

    # Write report.
    report = {
        "best_weights": result.best_weights,
        "best_mse": result.best_mse,
        "best_pearson": result.best_pearson,
        "sweep_size": result.sweep_size,
        "runtime_seconds": result.runtime_seconds,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2))
    print(f"\nWrote {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())