"""M4 (D13) — the patch critic fails closed on every path.

``critic_fail_closed = not persist`` let the legacy ``persist=True``
path treat a critic outage as a pass and ship the unreviewed diff. Now
``_critic_review`` has no fail-open mode: outage, empty output, or an
exhausted LLM budget all return ``passed=False`` and the generate loop
suppresses the candidate regardless of ``persist``.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.patches.patch_generator import PatchGenerator, _critic_review

_GOOD_DIFF = (
    "diff --git a/agent/checkout.py b/agent/checkout.py\n"
    "--- a/agent/checkout.py\n"
    "+++ b/agent/checkout.py\n"
    "@@ -1,2 +1,2 @@\n"
    " def checkout():\n"
    "-    return 1\n"
    "+    return 2\n"
)
_LINKED = [{"path": "agent/checkout.py", "content": "def checkout():\n    return 1\n"}]


@pytest.mark.asyncio
async def test_critic_outage_fails_closed() -> None:
    router = MagicMock()
    router.aroute = AsyncMock(side_effect=RuntimeError("llm down"))
    verdict = await _critic_review(router, _GOOD_DIFF, rca_summary="s")
    assert verdict["passed"] is False
    assert verdict["reason"] == "critic_error"


@pytest.mark.asyncio
async def test_critic_empty_response_fails_closed() -> None:
    router = MagicMock()
    router.aroute = AsyncMock(
        return_value=SimpleNamespace(
            content="", usage=SimpleNamespace(cost=0.0), model="m"
        )
    )
    verdict = await _critic_review(router, _GOOD_DIFF, rca_summary="s")
    assert verdict["passed"] is False
    assert verdict["reason"] == "critic_error"


@pytest.mark.asyncio
async def test_critic_budget_exhaustion_fails_closed() -> None:
    from eden.improvement import sweep_budget as sb

    sb.clear_sweep_llm_budget()
    try:
        with sb.llm_budget_scope(0):
            verdict = await _critic_review(MagicMock(), _GOOD_DIFF, rca_summary="s")
    finally:
        sb.clear_sweep_llm_budget()
    assert verdict["passed"] is False
    assert verdict["reason"] == "llm_budget_exhausted"


def test_no_fail_open_carve_out_left() -> None:
    """The ``not persist`` fail-open switch must not come back."""
    import inspect
    import re

    from eden.patches import patch_generator as pg

    assert "fail_closed" not in inspect.signature(_critic_review).parameters
    src = inspect.getsource(pg.PatchGenerator.generate)
    # No live assignment (a comment explaining the removal is fine).
    assert not re.search(r"^\s*critic_fail_closed\s*=", src, re.MULTILINE)


@pytest.mark.parametrize("persist", [True, False])
@pytest.mark.asyncio
async def test_generate_suppresses_on_critic_outage_both_paths(persist) -> None:
    """persist=True (the old fail-open path) now suppresses too."""
    router = MagicMock()
    usage = SimpleNamespace(cost=0.01)

    async def _aroute(task, prompt, **kwargs):
        if getattr(task, "agent", "") == "patch_critic":
            raise RuntimeError("critic outage")
        return SimpleNamespace(content=_GOOD_DIFF, usage=usage, model="m")

    router.aroute = AsyncMock(side_effect=_aroute)
    gen = PatchGenerator(router=router)

    with (
        patch(
            "eden.improvement.sweep_budget.try_consume_llm_call",
            return_value=True,
        ),
        patch(
            "eden.patches.patch_generator._is_similar_to_recent_patch",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.patches.patch_generator._has_llm_credentials",
            return_value=True,
        ),
    ):
        result = await gen.generate(
            org_id="org",
            rca_id="iss-1",
            trace_id="trc-1",
            repo_id="repo-1",
            linked_files=_LINKED,
            rca_summary="null deref",
            persist=persist,
        )

    data = result["data"]
    assert data["status"] == "low_quality"
    assert data["reason"] == "critic_error"
    assert data["diff"] == ""
