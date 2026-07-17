"""Wave 18 — Evaluate depth: playgrounds, IAA, char-diff grades."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.evaluation.iaa import cohen_kappa, iaa_from_annotation_pairs
from eden.evaluation.labeling_leases import (
    build_pairwise_payload,
    claim_lease,
    pairwise_winner_from_label,
    release_lease,
)
from eden.playground.diff import char_diff, grade_outputs
from eden.playground.llm_handler import playground_llm_handler
from eden.playground.service import PlaygroundService
from eden.prompts.pg_store import OrgPromptStore
from eden.prompts.registry import PromptTemplate


@pytest.mark.asyncio
async def test_playground_persists_in_memory_and_runs_matrix() -> None:
    svc = PlaygroundService(memory_only=True)
    pg = await svc.create(
        "org_w18",
        name="demo",
        config={
            "tasks": [
                {
                    "id": "a",
                    "label": "A",
                    "system": "",
                    "user": "{{user}}",
                    "model": "t1",
                    "tools": [],
                },
                {
                    "id": "b",
                    "label": "B",
                    "system": "",
                    "user": "{{user}}",
                    "model": "t2",
                    "tools": [],
                },
            ],
            "scorers": [{"name": "exact_match"}],
        },
    )
    assert pg.id
    listed = await svc.list("org_w18")
    assert any(p.id == pg.id for p in listed)

    result = await svc.run(
        "org_w18",
        pg.id,
        params={"user": "hello"},
        dataset_rows=[{"id": "r1", "input": "hello", "expected_output": "x"}],
    )
    assert result["status"] == "completed"
    assert "cost_usd" in result
    assert len(result["matrix"]) == 1
    assert len(result["matrix"][0]["tasks"]) == 2


@pytest.mark.asyncio
async def test_playground_llm_handler_routes_when_keyed() -> None:
    fake = MagicMock()
    fake.content = "hello from router"
    fake.model = "openai/gpt-test"
    fake.usage = MagicMock(prompt_tokens=3, completion_tokens=4, cost=0.0012)

    with (
        patch(
            "eden.playground.llm_handler._has_api_key",
            return_value=True,
        ),
        patch(
            "eden.playground.llm_handler._offline_forced",
            return_value=False,
        ),
        patch(
            "eden.llmops.feature_kills.is_feature_enabled",
            new=AsyncMock(return_value=True),
        ),
        patch(
            "eden.llmops.cost_ledger.sum_feature_spend_today",
            new=AsyncMock(return_value=0.0),
        ),
        patch(
            "eden.llm.internal_router.route_async",
            new=AsyncMock(return_value=fake),
        ) as route,
    ):
        out = await playground_llm_handler(
            {"user": "ping", "model": "t1", "system": "sys"},
            org_id="org_w18",
        )
    assert out.response == "hello from router"
    assert out.cost_usd == 0.0012
    assert out.model == "openai/gpt-test"
    route.assert_awaited_once()
    kwargs = route.await_args.kwargs
    assert kwargs.get("feature") == "playground"
    assert kwargs.get("org_id") == "org_w18"


@pytest.mark.asyncio
async def test_playground_llm_handler_respects_kill_switch() -> None:
    with (
        patch(
            "eden.llmops.feature_kills.is_feature_enabled",
            new=AsyncMock(return_value=False),
        ),
        patch(
            "eden.playground.llm_handler._has_api_key",
            return_value=True,
        ),
    ):
        out = await playground_llm_handler(
            {"user": "x", "model": "t1"},
            org_id="org_kill",
        )
    assert "kill_switch" in out.model
    assert out.cost_usd == 0.0


@pytest.mark.asyncio
async def test_labeling_lease_exclusive_and_pairwise() -> None:
    with patch(
        "eden.storage.redis.get_redis_client",
        new=AsyncMock(return_value=None),
    ):
        ok1 = await claim_lease("org_a", "item_1", "ann_1")
        ok2 = await claim_lease("org_a", "item_1", "ann_2")
        assert ok1 is True
        assert ok2 is False
        await release_lease("org_a", "item_1", "ann_1")
        ok3 = await claim_lease("org_a", "item_1", "ann_2")
        assert ok3 is True
    payload = build_pairwise_payload(
        left={"text": "A"},
        right={"text": "B"},
    )
    assert payload["type"] == "pairwise"
    assert pairwise_winner_from_label({"winner": "left"}) == "left"


@pytest.mark.asyncio
async def test_playground_from_span_and_promote_requires_dataset() -> None:
    svc = PlaygroundService(memory_only=True)
    pg = await svc.from_span(
        "org_w18",
        trace_id="tr_1",
        span_id="sp_1",
        messages=[{"role": "user", "content": "span text"}],
    )
    assert pg.config.get("source", {}).get("trace_id") == "tr_1"
    with pytest.raises(ValueError, match="dataset_id"):
        await svc.promote_experiment("org_w18", pg.id)


@pytest.mark.asyncio
async def test_org_prompt_store_memory_roundtrip() -> None:
    store = OrgPromptStore(memory_only=True)
    t = PromptTemplate(name="greet", user="Hello {{user}}", required_params=["user"])
    await store.register("org_a", t)
    got = await store.get("org_a", "greet")
    assert got is not None
    assert got.user == "Hello {{user}}"
    names = await store.list_names("org_a")
    assert "greet" in names
    # org isolation
    assert await store.get("org_b", "greet") is None


def test_char_diff_and_grades() -> None:
    d = char_diff("abcXYZ", "abcUVW")
    assert d["equal"] is False
    assert d["common_prefix"] == "abc"
    assert grade_outputs("a", "a")[0] == "tie"
    assert grade_outputs("a", "b", control_score=0.2, treatment_score=0.9)[0] == "improvement"
    assert grade_outputs("a", "b", control_score=0.9, treatment_score=0.2)[0] == "regression"


def test_cohen_kappa_perfect_and_iaa() -> None:
    assert cohen_kappa(["a", "b", "a"], ["a", "b", "a"]) == 1.0
    out = iaa_from_annotation_pairs([("good", "good"), ("bad", "good")])
    assert out["n"] == 2
    assert 0.0 <= out["kappa"] <= 1.0
