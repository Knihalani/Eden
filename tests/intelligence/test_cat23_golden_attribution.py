"""Golden-set harness stub for Cat 23 attribution accuracy.

Loads ``cat23_attribution.json`` and soft-asserts structure +
``soft_assert_min`` (≥0 for now). Real linker scoring lands with
Gate 5; this harness keeps the fixture path wired.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

GOLDEN_PATH = Path(__file__).resolve().parent / "golden" / "cat23_attribution.json"


def test_cat23_attribution_golden_loads() -> None:
    assert GOLDEN_PATH.is_file(), f"missing golden set: {GOLDEN_PATH}"
    data = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    assert data["name"] == "cat23_attribution"
    assert isinstance(data["cases"], list)
    assert len(data["cases"]) >= 1
    soft_min = float(data.get("soft_assert_min", 0.0))
    assert soft_min >= 0.0

    # Soft accuracy: count cases with required fields present.
    scored = 0
    for case in data["cases"]:
        assert "id" in case
        assert "expected_primary_path" in case
        assert "stack_trace" in case
        scored += 1
    accuracy = scored / max(len(data["cases"]), 1)
    assert accuracy >= soft_min


@pytest.mark.asyncio
async def test_cat23_attribution_golden_structure_runner() -> None:
    """Optional soft runner: exercise CodeRootCauseLinker on golden cases.

    Without a live repo the linker returns empty links — we only
    assert the envelope shape and that accuracy soft-floor holds.
    """
    from eden.code_change.rca_linker import CodeRootCauseLinker

    data = json.loads(GOLDEN_PATH.read_text(encoding="utf-8"))
    linker = CodeRootCauseLinker(router=None, repo_connector=None)
    hits = 0
    for case in data["cases"]:
        result = await linker.link(
            org_id="org_golden",
            rca_id=case["id"],
            repo_id="repo_golden",
            rca_description=case.get("rca_summary", ""),
            stack_trace=case.get("stack_trace"),
            candidate_files=[case["expected_primary_path"]],
        )
        assert result["status"] in {"ok", "not_implemented"}
        # Soft hit: envelope is well-formed.
        if isinstance(result.get("data"), dict):
            hits += 1
    accuracy = hits / max(len(data["cases"]), 1)
    assert accuracy >= float(data.get("soft_assert_min", 0.0))
