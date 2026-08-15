"""Trace fixtures for non-LLM trace evaluation tests.

This package exposes a single helper:

    from tests.fixtures.traces import load_synthetic_dataset
    dataset = load_synthetic_dataset()
    for events, gt in dataset:
        ...

where ``events`` is a list of ``TelemetryEvent`` instances reconstructed
from the JSON files under ``synthetic/traces/`` and ``gt`` is the
matching ground-truth dict loaded from ``synthetic/ground_truth/``.

The loader is lazy and side-effect free — it does not import the rest
of the test suite and is safe to call from any pytest test, doctest,
or script.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# TelemetryEvent lives in the source tree; importing it here keeps the
# loader honest — a malformed fixture fails at load time, not at test
# time.
from eden.observability.telemetry_collector import TelemetryEvent

SYNTH_ROOT = Path(__file__).parent / "synthetic"


@dataclass(frozen=True)
class SyntheticExample:
    """One labelled synthetic trace."""

    trace_id: str
    archetype_id: str
    agent_id: str
    events: list[TelemetryEvent]
    ground_truth: dict[str, Any]

    @property
    def expected_tas(self) -> int:
        return int(self.ground_truth["expected_TAS"])

    @property
    def expected_intervention(self) -> str:
        return str(self.ground_truth["expected_intervention"])

    @property
    def expected_loop_detected(self) -> bool:
        return bool(self.ground_truth.get("expected_loop_detected", False))

    @property
    def expected_hallucination_detected(self) -> bool:
        return bool(self.ground_truth.get("expected_hallucination_detected", False))

    @property
    def expected_redundancy_pct(self) -> float:
        return float(self.ground_truth.get("expected_redundancy_pct", 0.0))


def load_synthetic_dataset(
    *,
    root: Path | str | None = None,
    strict: bool = True,
) -> list[SyntheticExample]:
    """Load every trace + ground-truth pair from the synthetic dataset.

    Parameters
    ----------
    root : Path | str | None
        Override the synthetic dataset root (mostly for testing).
    strict : bool
        When True (default), raise ValueError if any trace file is
        missing a matching ground-truth file or vice versa. When False,
        skip mismatched files and log a warning.

    Returns
    -------
    list[SyntheticExample]
        Sorted by filename so the order is deterministic across runs.
    """
    base = Path(root) if root is not None else SYNTH_ROOT
    traces_dir = base / "traces"
    gt_dir = base / "ground_truth"

    if not traces_dir.exists():
        raise FileNotFoundError(f"synthetic traces dir not found: {traces_dir}")
    if not gt_dir.exists():
        raise FileNotFoundError(f"synthetic ground-truth dir not found: {gt_dir}")

    trace_files = sorted(traces_dir.glob("*.json"))
    examples: list[SyntheticExample] = []
    for trace_path in trace_files:
        gt_path = gt_dir / trace_path.name
        if not gt_path.exists():
            msg = f"missing ground truth for {trace_path.name}"
            if strict:
                raise ValueError(msg)
            continue

        trace_blob = json.loads(trace_path.read_text())
        gt_blob = json.loads(gt_path.read_text())

        events = [TelemetryEvent.from_dict(e) for e in trace_blob["events"]]

        examples.append(SyntheticExample(
            trace_id=trace_blob["trace_id"],
            archetype_id=trace_blob["archetype_id"],
            agent_id=trace_blob["agent_id"],
            events=events,
            ground_truth=gt_blob,
        ))

    return examples


__all__ = ["SyntheticExample", "load_synthetic_dataset", "SYNTH_ROOT"]
