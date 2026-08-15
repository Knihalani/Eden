"""Compare two ``bench.run_all`` result files and fail on regressions.

Usage::

    python -m bench.compare baseline.json candidate.json
    python -m bench.compare baseline.json candidate.json --threshold 0.10
    python -m bench.compare baseline.json candidate.json --json

Exit codes: ``0`` no regression · ``1`` regression beyond the threshold ·
``2`` usage/parse error.

Two rules make this trustworthy rather than decorative:

* **Simulated suites are never gated on.** ``bench/run_all.py`` tags the
  sleep-based suites with ``"simulated": true``. Their numbers describe a
  hard-coded constant, so a "regression" in one would mean the machine's sleep
  resolution changed. They are reported and skipped.
* **Direction is per metric, not global.** Latency regressions are increases;
  throughput and compression-ratio regressions are decreases. Treating every
  metric as lower-is-better would silently invert the throughput checks and
  pass a build that got 10x slower at compression.

A metric present in the baseline but missing from the candidate is reported as
``dropped`` — a suite that stops running is the most effective way to make a
regression invisible, so it must not read as "no regression".
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

Direction = Literal["lower_is_better", "higher_is_better"]

#: Default regression threshold: a metric may worsen by up to this fraction
#: before the gate fails.
_DEFAULT_THRESHOLD = 0.20

#: A regression must clear the relative threshold *and* move by at least this
#: many milliseconds. Middleware dispatch is measured in single-digit
#: microseconds, where ordinary scheduler jitter between two runs easily
#: exceeds 20% while meaning nothing. Requiring an absolute move of ~1µs as
#: well keeps the suite gateable instead of permanently amber.
_MIN_ABSOLUTE_MS = 0.001

#: Below this, a duration is at the resolution limit of the timer itself and
#: no comparison is meaningful.
_NOISE_FLOOR_MS = 0.0001


@dataclass(frozen=True)
class Metric:
    suite: str
    name: str
    value: float
    direction: Direction

    @property
    def key(self) -> str:
        return f"{self.suite}.{self.name}"


def _extract(results: dict[str, Any]) -> tuple[dict[str, Metric], list[str]]:
    """Flatten a results document into comparable metrics.

    Returns ``(metrics, skipped_suite_names)``.
    """
    metrics: dict[str, Metric] = {}
    skipped: list[str] = []

    def add(suite: str, name: str, value: Any, direction: Direction) -> None:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            m = Metric(suite, name, float(value), direction)
            metrics[m.key] = m

    for suite, payload in (results.get("suites") or {}).items():
        if isinstance(payload, dict) and payload.get("simulated"):
            skipped.append(suite)
            continue
        if isinstance(payload, dict) and payload.get("skipped"):
            skipped.append(suite)
            continue

        # Suites that return a list of per-benchmark rows.
        if isinstance(payload, list):
            for row in payload:
                if not isinstance(row, dict):
                    continue
                label = row.get("name")
                if not label:
                    continue
                for field in ("p50_ms", "p95_ms", "p99_ms", "median_ms"):
                    if field in row:
                        add(suite, f"{label}.{field}", row[field], "lower_is_better")
            continue

        if not isinstance(payload, dict):
            continue

        # Compression: a mix of ratios, throughputs and durations.
        for field, direction in (
            ("compression_ratio", "higher_is_better"),
            ("single_thread_ops_per_sec", "higher_is_better"),
            ("batch_compress_ops_per_sec", "higher_is_better"),
            ("batch_decompress_ops_per_sec", "higher_is_better"),
            ("batch_speedup_vs_single", "higher_is_better"),
            ("single_thread_ms", "lower_is_better"),
            ("batch_compress_ms", "lower_is_better"),
            ("batch_decompress_ms", "lower_is_better"),
        ):
            if field in payload:
                add(suite, field, payload[field], direction)

        # Request path: nested per-endpoint percentile dicts.
        for label, row in payload.items():
            if not isinstance(row, dict):
                continue
            for field in ("p50_ms", "p95_ms", "p99_ms", "mean_ms"):
                if field in row:
                    add(suite, f"{label}.{field}", row[field], "lower_is_better")

    return metrics, skipped


@dataclass(frozen=True)
class Regression:
    key: str
    baseline: float
    candidate: float
    change: float
    direction: Direction

    def describe(self) -> str:
        arrow = "↑" if self.candidate > self.baseline else "↓"
        return (
            f"{self.key}: {self.baseline:.4g} → {self.candidate:.4g} "
            f"({arrow}{abs(self.change) * 100:.1f}%)"
        )


def compare(
    baseline: dict[str, Any], candidate: dict[str, Any], threshold: float
) -> tuple[list[Regression], list[str], list[str]]:
    """Return ``(regressions, dropped_metric_keys, skipped_suites)``."""
    base_metrics, base_skipped = _extract(baseline)
    cand_metrics, cand_skipped = _extract(candidate)

    regressions: list[Regression] = []
    dropped: list[str] = []

    for key, base in base_metrics.items():
        cand = cand_metrics.get(key)
        if cand is None:
            dropped.append(key)
            continue
        if base.value == 0:
            continue
        if base.direction == "lower_is_better" and base.value < _NOISE_FLOOR_MS:
            continue

        change = (cand.value - base.value) / abs(base.value)
        worse = change if base.direction == "lower_is_better" else -change
        if (
            base.direction == "lower_is_better"
            and abs(cand.value - base.value) < _MIN_ABSOLUTE_MS
        ):
            # A 20% swing on a 2µs measurement is jitter, not a regression.
            continue
        if worse > threshold:
            regressions.append(
                Regression(key, base.value, cand.value, change, base.direction)
            )

    return (
        sorted(regressions, key=lambda r: r.key),
        sorted(dropped),
        sorted(set(base_skipped) | set(cand_skipped)),
    )


def _load(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise SystemExit(f"no such results file: {path}") from None
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{path} is not valid JSON: {exc}") from None
    if not isinstance(data, dict) or "suites" not in data:
        raise SystemExit(f"{path} does not look like a bench.run_all result")
    return data


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("baseline", type=Path)
    ap.add_argument("candidate", type=Path)
    ap.add_argument(
        "--threshold",
        type=float,
        default=_DEFAULT_THRESHOLD,
        help=f"fractional regression tolerated (default {_DEFAULT_THRESHOLD})",
    )
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument(
        "--allow-dropped",
        action="store_true",
        help="do not fail when a baseline metric is missing from the candidate",
    )
    args = ap.parse_args(argv)

    if not 0 < args.threshold < 10:
        raise SystemExit("--threshold must be a fraction such as 0.20")

    regressions, dropped, skipped = compare(
        _load(args.baseline), _load(args.candidate), args.threshold
    )

    failed = bool(regressions) or (bool(dropped) and not args.allow_dropped)

    if args.json:
        print(
            json.dumps(
                {
                    "threshold": args.threshold,
                    "regressions": [
                        {
                            "metric": r.key,
                            "baseline": r.baseline,
                            "candidate": r.candidate,
                            "change": round(r.change, 4),
                        }
                        for r in regressions
                    ],
                    "dropped": dropped,
                    "skipped_simulated_suites": skipped,
                    "failed": failed,
                },
                indent=2,
            )
        )
        return 1 if failed else 0

    if skipped:
        print(f"skipped (simulated or dead, never gated on): {', '.join(skipped)}")
    if dropped:
        print(f"\n{len(dropped)} metric(s) present in baseline but missing now:")
        for key in dropped:
            print(f"  {key}")
        print("  a suite that stops running hides every regression in it")
    if regressions:
        print(f"\n{len(regressions)} regression(s) beyond {args.threshold:.0%}:")
        for r in regressions:
            print(f"  {r.describe()}")
    elif not dropped:
        print(f"\nno regression beyond {args.threshold:.0%}")

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
