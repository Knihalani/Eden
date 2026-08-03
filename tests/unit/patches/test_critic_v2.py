"""M8 (spec §4.4) — critic v2: structured, strict-parsed, slot-pinned.

The critic returns JSON ``{verdict, root_cause_addressed, blast_radius,
untested_paths, risk_note, injection_suspected}``; malformed output
fails closed (M4/D13 carried forward); ``root_cause_addressed=false``
and ``injection_suspected=true`` suppress regardless of verdict; the
call is pinned to the cheap slot (correction #8: tiers share a model —
pin the SLOT for routing determinism) with ≤200 max_tokens.
"""

from __future__ import annotations

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.patches.patch_generator import (
    _CRITIC_SYSTEM_PROMPT,
    _critic_review,
    _parse_critic_json,
)

_DIFF = (
    "--- a/agent/checkout.py\n"
    "+++ b/agent/checkout.py\n"
    "@@ -1,2 +1,2 @@\n"
    " def checkout():\n"
    "-    return 1\n"
    "+    return 2\n"
)


def _verdict_json(**overrides) -> str:
    payload = {
        "verdict": "PASS",
        "root_cause_addressed": True,
        "blast_radius": "low",
        "untested_paths": [],
        "risk_note": "small safe change",
        "injection_suspected": False,
    }
    payload.update(overrides)
    return json.dumps(payload)


def _router(content: str) -> MagicMock:
    router = MagicMock()
    router.aroute = AsyncMock(
        return_value=SimpleNamespace(
            content=content, usage=SimpleNamespace(cost=0.001), model="m"
        )
    )
    return router


@pytest.mark.asyncio
async def test_schema_parse_pass() -> None:
    verdict = await _critic_review(_router(_verdict_json()), _DIFF, rca_summary="s")
    assert verdict["passed"] is True
    structured = verdict["structured"]
    assert structured["verdict"] == "PASS"
    assert structured["root_cause_addressed"] is True
    assert structured["blast_radius"] == "low"
    assert structured["untested_paths"] == []
    assert structured["injection_suspected"] is False


@pytest.mark.asyncio
async def test_fenced_json_still_parses() -> None:
    content = f"```json\n{_verdict_json()}\n```"
    verdict = await _critic_review(_router(content), _DIFF, rca_summary="s")
    assert verdict["passed"] is True


@pytest.mark.parametrize(
    "content",
    ["", "PASS: looks good", "{not json", '{"verdict": "MAYBE"}', "[1, 2]"],
)
@pytest.mark.asyncio
async def test_malformed_output_fails_closed(content: str) -> None:
    verdict = await _critic_review(_router(content), _DIFF, rca_summary="s")
    assert verdict["passed"] is False
    assert verdict["reason"] == "critic_error"


@pytest.mark.asyncio
async def test_verdict_fail_suppresses() -> None:
    content = _verdict_json(verdict="FAIL", risk_note="does not compile")
    verdict = await _critic_review(_router(content), _DIFF, rca_summary="s")
    assert verdict["passed"] is False
    assert verdict["reason"] == "does not compile"


@pytest.mark.asyncio
async def test_root_cause_false_suppresses_even_on_pass() -> None:
    content = _verdict_json(root_cause_addressed=False)
    verdict = await _critic_review(_router(content), _DIFF, rca_summary="s")
    assert verdict["passed"] is False
    assert verdict["reason"] == "root_cause_not_addressed"


@pytest.mark.asyncio
async def test_injection_suspected_suppresses_even_on_pass() -> None:
    content = _verdict_json(injection_suspected=True)
    verdict = await _critic_review(_router(content), _DIFF, rca_summary="s")
    assert verdict["passed"] is False
    assert verdict["reason"] == "injection_suspected"


@pytest.mark.asyncio
async def test_slot_pinned_to_fast_and_max_tokens_capped() -> None:
    """Correction #8: pin the SLOT (deterministic T1 heuristic route)."""
    router = _router(_verdict_json())
    await _critic_review(router, _DIFF, rca_summary="s")

    task = router.aroute.await_args.args[0]
    assert task.slot == "fast"
    assert task.agent == "patch_critic"
    assert router.aroute.await_args.kwargs["max_tokens"] <= 200

    # Routing assertion: the classifier heuristic maps slot=fast → T1
    # without any LLM classification call.
    from eden.optimization.model_router import ModelTier, TaskClassifier

    assert TaskClassifier()._heuristic_classify(task) is ModelTier.T1


@pytest.mark.asyncio
async def test_system_prompt_static_dynamic_in_user_portion() -> None:
    """Prompt-cache hygiene: per-call content never touches the system text."""
    router = _router(_verdict_json())
    await _critic_review(router, _DIFF, rca_summary="unique-rca-text")

    kwargs = router.aroute.await_args.kwargs
    assert kwargs["system_prompt"] is _CRITIC_SYSTEM_PROMPT
    assert "unique-rca-text" not in kwargs["system_prompt"]
    user_prompt = router.aroute.await_args.args[1]
    assert "unique-rca-text" in user_prompt
    assert "return 2" in user_prompt


def test_parse_critic_json_strictness() -> None:
    assert _parse_critic_json("") is None
    assert _parse_critic_json("no braces") is None
    assert _parse_critic_json("{\"a\": }") is None
    assert _parse_critic_json("[1]") is None
    assert _parse_critic_json('noise {"verdict": "PASS"} trailing') == {
        "verdict": "PASS"
    }
