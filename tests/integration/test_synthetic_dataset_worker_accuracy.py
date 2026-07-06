"""End-to-end test: every synthetic trace produces the expected
TAS + intervention when run through the actual production worker
pipeline (5 concurrent steps).

This test guards against a class of regressions where:

  - The synthetic dataset's ground-truth TAS goes stale as the
    composite formula evolves.
  - The worker silently drops events or picks the wrong API
    (e.g. calling ``.get()`` on a dataclass).
  - The worker forgets to forward ``archetype_id`` to
    ``compute_tas``, breaking the per-archetype TVS scale.

Run with::

    .venv/bin/pytest tests/integration/test_synthetic_dataset_worker_accuracy.py -v
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from eden.observability.quality_pipeline.worker import compute_trace_reports


_SYNTH_ROOT = Path("tests/fixtures/traces/synthetic/traces")


def _all_synthetic_traces() -> list[Path]:
    """Return every synthetic trace JSON, sorted for determinism."""
    return sorted(_SYNTH_ROOT.glob("*.json"))


@pytest.mark.parametrize("trace_path", _all_synthetic_traces(), ids=lambda p: p.name)
def test_synthetic_dataset_matches_worker_output(trace_path: Path) -> None:
    """The worker produces TAS + intervention matching the ground truth
    (within ±5 TAS) for every synthetic trace.
    """
    data = json.loads(trace_path.read_text())
    gt = json.loads((trace_path.parent.parent / "ground_truth" / trace_path.name).read_text())

    # Recover the archetype_id from the first event's attributes —
    # the worker reads it the same way.
    arc_id = (data["events"][0].get("attributes") or {}).get("archetype_id")

    result = asyncio.run(compute_trace_reports(
        tenant_id="org_test",
        trace_id=data["trace_id"],
        events=data["events"],
        archetype_id=arc_id,
    ))

    tas_payload = result["tas"]
    assert tas_payload.get("status") != "error", (
        f"TAS step failed: {tas_payload.get('error')}"
    )

    got_tas = tas_payload["tas"]
    got_int = tas_payload["intervention"]
    exp_tas = gt["expected_TAS"]
    exp_int = gt["expected_intervention"]

    # Intervention must match exactly.
    assert got_int == exp_int, (
        f"{trace_path.name}: intervention mismatch — "
        f"got {got_int!r}, expected {exp_int!r}"
    )

    # TAS must be within ±5 of the (re-baselined) ground truth.
    assert abs(got_tas - exp_tas) <= 5, (
        f"{trace_path.name}: TAS off by {got_tas - exp_tas:+.1f} — "
        f"got {got_tas}, expected {exp_tas}"
    )


def test_synthetic_dataset_all_variants_are_distinct() -> None:
    """Within each archetype, the 3 variants must produce genuinely
    different event streams — not just different ``event_id``s.
    """
    from collections import defaultdict
    by_arch: dict[str, list[Path]] = defaultdict(list)
    for p in _all_synthetic_traces():
        # Filename is "<index>_<archetype>_<variant>.json".
        stem = p.stem  # e.g. "01_efficient-good-support_01"
        parts = stem.split("_")
        archetype = "_".join(parts[1:-1])
        by_arch[archetype].append(p)

    for archetype, files in by_arch.items():
        signatures: list[tuple] = []
        for f in files:
            data = json.loads(f.read_text())
            sig = []
            for e in data["events"]:
                etype = e.get("event_type")
                name = e.get("name")
                duration = e.get("duration_ms")
                attrs = e.get("attributes") or {}
                # Drop the archetype_id attribute since it's stamped on
                # every event by the generator.
                attrs = {k: v for k, v in attrs.items() if k != "archetype_id"}
                rb = e.get("request_body") or {}
                # Extract the meaningful args (for tool calls).
                args = ""
                if rb.get("arguments"):
                    args = rb["arguments"]
                # Build a signature that captures every meaningful
                # difference across variants: duration, tool arguments,
                # tool responses, user-prompt content, response-body
                # content.
                response = e.get("response_body") or {}
                if isinstance(response, dict):
                    response = json.dumps(response, sort_keys=True)
                user_msg = ""
                for m in (rb.get("messages") or []):
                    if isinstance(m, dict) and m.get("role") == "user":
                        user_msg = m.get("content") or ""
                        break
                sig.append((
                    etype, name, duration,
                    str(attrs), str(args), str(response), user_msg,
                ))
            signatures.append(tuple(sig))

        # Variant 1 must differ from variants 2 and 3 on at least
        # one of: duration, args, response, or user-prompt content.
        v1, v2, v3 = signatures
        diffs_12 = any(
            v1[i][2:] != v2[i][2:]
            for i in range(min(len(v1), len(v2)))
        )
        diffs_13 = any(
            v1[i][2:] != v3[i][2:]
            for i in range(min(len(v1), len(v3)))
        )
        assert diffs_12, f"{archetype}: variant 1 and 2 are identical"
        assert diffs_13, f"{archetype}: variant 1 and 3 are identical"


def test_synthetic_dataset_all_events_have_archetype_id() -> None:
    """Every event in every synthetic trace carries the archetype_id
    in its attributes — so the worker can recover it without parsing
    the trace metadata.
    """
    for p in _all_synthetic_traces():
        data = json.loads(p.read_text())
        expected = data["archetype_id"]
        for i, e in enumerate(data["events"]):
            attrs = e.get("attributes") or {}
            assert attrs.get("archetype_id") == expected, (
                f"{p.name} event {i}: archetype_id missing or wrong "
                f"(got {attrs.get('archetype_id')!r}, expected {expected!r})"
            )
