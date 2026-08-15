"""F01 debugger live-rerun path — mutate + rerun + structured diff.

Distinct from the hermetic recorded-replay path: ``rerun_live`` actually
invokes an injected ``llm_fn`` (the real gateway in production) and returns an
outcome diff. Covers the honesty contract: no ``llm_fn`` => raise, never a
silent recorded response dressed up as a live re-run.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.api.deps import get_current_user, require_path_org_access
from eden.debugger.checkpoints import CheckpointStore, LivePrefixEngine
from tests.unit.test_debugger import FakePg, _checkpoint


async def _seed(store: CheckpointStore, n: int = 3, *, org_id: str | None = None) -> None:
    for i in range(n):
        await store.save(_checkpoint(i), org_id=org_id)


# ─- Engine: real live re-run ─────────────────────────────────────


@pytest.mark.asyncio
async def test_rerun_live_calls_model_and_returns_structured_diff() -> None:
    pg = FakePg()
    store = CheckpointStore(pg)
    await _seed(store, 3)

    seen: dict[str, Any] = {}

    async def fake_llm(messages: list[dict[str, Any]]) -> dict[str, Any]:
        seen["messages"] = messages
        return {"content": "FRESH MODEL OUTPUT"}

    engine = LivePrefixEngine(store, llm_fn=fake_llm)
    result = await engine.rerun_live(
        "trace-1", live_from_step=1, prompt_override="be terse",
    )

    # A real model call was made — honestly flagged.
    assert result.model_invoked is True
    assert result.mode == "live_gateway"
    assert seen["messages"], "llm_fn must receive the mutated messages"
    # prompt_override injected a system message the model actually saw.
    assert any(m.get("role") == "system" for m in seen["messages"])

    # Structured outcome diff over the boundary step.
    assert len(result.diff) == 1
    entry = result.diff[0]
    assert entry["step_number"] == 1
    assert entry["replayed_response"] == {"content": "FRESH MODEL OUTPUT"}
    assert entry["original_response"] == {"content": "response 1"}
    assert entry["input_messages_changed"] is True
    assert entry["outcome_diff"]["equal"] is False
    assert entry["outcome_diff"]["right"].startswith("FRESH")


@pytest.mark.asyncio
async def test_rerun_live_tool_result_override_reaches_model() -> None:
    pg = FakePg()
    store = CheckpointStore(pg)
    # Boundary step carries a tool message so the override can replace it.
    await store.save(_checkpoint(0))
    await store.save(
        _checkpoint(
            1,
            input_messages=[
                {"role": "user", "content": "call the tool"},
                {"role": "tool", "content": "OLD TOOL RESULT"},
            ],
        ),
    )

    captured: dict[str, Any] = {}

    async def fake_llm(messages: list[dict[str, Any]]) -> dict[str, Any]:
        captured["messages"] = messages
        return {"content": "answer using new tool result"}

    engine = LivePrefixEngine(store, llm_fn=fake_llm)
    result = await engine.rerun_live(
        "trace-1",
        live_from_step=1,
        tool_result_override={"content": "NEW TOOL RESULT"},
    )

    assert result.model_invoked is True
    tool_msgs = [m for m in captured["messages"] if m.get("role") == "tool"]
    assert tool_msgs and tool_msgs[-1]["content"] == "NEW TOOL RESULT"
    assert result.diff[0]["tool_results_changed"] is True


@pytest.mark.asyncio
async def test_rerun_live_without_llm_fn_raises_not_silent() -> None:
    pg = FakePg()
    store = CheckpointStore(pg)
    await _seed(store, 2)
    engine = LivePrefixEngine(store)  # no llm_fn wired
    with pytest.raises(RuntimeError, match="no llm_fn"):
        await engine.rerun_live("trace-1", live_from_step=0)


@pytest.mark.asyncio
async def test_rerun_live_no_tail_reports_no_model_call() -> None:
    pg = FakePg()
    store = CheckpointStore(pg)
    await _seed(store, 2)

    async def fake_llm(_: list[dict[str, Any]]) -> dict[str, Any]:
        raise AssertionError("must not be called when tail is empty")

    engine = LivePrefixEngine(store, llm_fn=fake_llm)
    result = await engine.rerun_live("trace-1", live_from_step=99)
    assert result.model_invoked is False
    assert result.live_tail_steps == 0
    assert result.diff == []


# ─- Route: flag gate ─────────────────────────────────────────────


def _app() -> FastAPI:
    from eden.api.routes import debugger as debugger_routes

    app = FastAPI()

    async def _fake_user() -> dict[str, Any]:
        return {"id": "u1", "email": "t@example.com"}

    async def _path_org(org_id: str = "org_1") -> str:
        return org_id

    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_path_org_access] = _path_org
    app.include_router(debugger_routes.router)
    return app


def test_route_live_rerun_disabled_returns_403(monkeypatch: pytest.MonkeyPatch) -> None:
    from eden.config import get_settings

    monkeypatch.setattr(get_settings(), "debugger_live_rerun_v1", False, raising=False)
    with patch(
        "eden.api.routes.debugger.get_postgres_client",
        AsyncMock(return_value=FakePg()),
    ):
        client = TestClient(_app())
        resp = client.post(
            "/orgs/org_1/debugger/rerun",
            json={"trace_id": "trace-1", "from_step": 0, "live": True},
        )
    assert resp.status_code == 403
    assert "debugger_live_rerun_v1" in resp.json()["detail"]


def test_route_live_rerun_enabled_invokes_model(monkeypatch: pytest.MonkeyPatch) -> None:
    from eden.config import get_settings

    monkeypatch.setattr(get_settings(), "debugger_live_rerun_v1", True, raising=False)

    import asyncio

    pg = FakePg()

    async def _seed_pg() -> None:
        await _seed(CheckpointStore(pg), 3, org_id="org_1")

    asyncio.run(_seed_pg())

    async def fake_handler(prompt_dict: dict[str, Any], *, org_id: str = "") -> Any:
        return SimpleNamespace(
            response="LIVE ROUTE OUTPUT",
            model="t1",
            cost_usd=0.0,
            latency_ms=1.0,
        )

    with (
        patch(
            "eden.api.routes.debugger.get_postgres_client",
            AsyncMock(return_value=pg),
        ),
        patch(
            "eden.playground.llm_handler.playground_llm_handler",
            fake_handler,
        ),
    ):
        client = TestClient(_app())
        resp = client.post(
            "/orgs/org_1/debugger/rerun",
            json={
                "trace_id": "trace-1",
                "from_step": 1,
                "live": True,
                "prompt_override": "be terse",
            },
        )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["mode"] == "live_gateway"
    assert body["model_invoked"] is True
    assert body["diff"], "expected a structured outcome diff"
    assert body["diff"][0]["replayed_response"]["content"] == "LIVE ROUTE OUTPUT"
