"""PatchGenerator free static-preverify regenerate loop."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.patches.patch_generator import PatchGenerator, _run_static_preverify

_GOOD_DIFF = (
    "diff --git a/agent/checkout.py b/agent/checkout.py\n"
    "--- a/agent/checkout.py\n"
    "+++ b/agent/checkout.py\n"
    "@@ -1,2 +1,2 @@\n"
    " def checkout():\n"
    "-    return 1\n"
    "+    return 2\n"
)

_BAD_DIFF = (
    "diff --git a/agent/checkout.py b/agent/checkout.py\n"
    "--- a/agent/checkout.py\n"
    "+++ b/agent/checkout.py\n"
    "@@ -1,2 +1,2 @@\n"
    " def checkout():\n"
    "-    return 1\n"
    "+    return (\n"
)

_LINKED = [{"path": "agent/checkout.py", "content": "def checkout():\n    return 1\n"}]

# M8 (§4.4) critic v2 — structured JSON verdict.
_CRITIC_PASS_JSON = (
    '{"verdict": "PASS", "root_cause_addressed": true, '
    '"blast_radius": "low", "untested_paths": [], '
    '"risk_note": "ok", "injection_suspected": false}'
)


@pytest.mark.asyncio
async def test_run_static_preverify_passes_on_good_diff() -> None:
    result = await _run_static_preverify(_GOOD_DIFF, _LINKED)
    assert result["status"] == "passed"


@pytest.mark.asyncio
async def test_run_static_preverify_fails_on_syntax() -> None:
    result = await _run_static_preverify(_BAD_DIFF, _LINKED)
    assert result["status"] == "failed"
    assert "Static preverify failed" in (result.get("feedback") or "")


@pytest.mark.asyncio
async def test_generate_retries_on_static_fail_then_passes() -> None:
    router = MagicMock()
    usage = SimpleNamespace(cost=0.01)

    async def _aroute(task, prompt, **kwargs):
        # Critic path uses agent patch_critic.
        if getattr(task, "agent", "") == "patch_critic":
            return SimpleNamespace(content=_CRITIC_PASS_JSON, usage=usage, model="m")
        # First generate returns broken syntax; second is clean.
        if "Static preverify feedback" in prompt:
            return SimpleNamespace(content=_GOOD_DIFF, usage=usage, model="m")
        return SimpleNamespace(content=_BAD_DIFF, usage=usage, model="m")

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
            persist=False,
        )

    data = result["data"]
    assert data["status"] == "proposed"
    assert "return 2" in data["diff"]
    assert data["static_preverify"]["status"] == "passed"
    # generate + critic + generate + critic = 4
    assert router.aroute.await_count == 4


@pytest.mark.asyncio
async def test_generate_fail_closed_when_static_exhausted() -> None:
    router = MagicMock()
    usage = SimpleNamespace(cost=0.01)

    async def _aroute(task, prompt, **kwargs):
        if getattr(task, "agent", "") == "patch_critic":
            return SimpleNamespace(content=_CRITIC_PASS_JSON, usage=usage, model="m")
        return SimpleNamespace(content=_BAD_DIFF, usage=usage, model="m")

    router.aroute = AsyncMock(side_effect=_aroute)
    gen = PatchGenerator(router=router)

    with (
        patch(
            "eden.improvement.sweep_budget.try_consume_llm_call",
            return_value=True,
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
            persist=False,
        )

    data = result["data"]
    assert data["status"] == "low_quality"
    assert data["reason"] == "static_preverify_failed"
    assert data["diff"] == ""
    assert data["static_preverify"]["status"] == "failed"
