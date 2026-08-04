"""F06 — per-trace signal investigator ON-path endpoint.

Covers:
* Flag OFF (default) -> honest ``disabled`` envelope, never a silent empty run.
* Flag ON + budget available -> runs the investigator, returns structured findings.
* Flag ON + budget exhausted -> HTTP 402 honest error, investigator NOT invoked.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from eden.api.deps import get_current_user, require_path_org_access
from eden.config import get_settings


class _FakePg:
    """Minimal asyncpg stand-in for ``investigate_trace``."""

    def __init__(self, definitions: list[dict[str, Any]]) -> None:
        self._definitions = definitions
        self.inserts: list[tuple[Any, ...]] = []

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        if "FROM signal_definitions" in sql:
            return self._definitions
        return []

    async def execute(self, sql: str, *args: Any) -> str:
        self.inserts.append((sql, args))
        return "INSERT 0 1"


def _loop_definition() -> dict[str, Any]:
    return {
        "id": "sig-loop",
        "name": "Looping",
        "description": "agent is looping / repeating tool calls",
        "output_schema": None,
        "template_id": "looping",
        "statgate_rule": "tool_call_rate > 0.05",
        "investigator_prompt": None,
    }


def _loop_events() -> list[dict[str, Any]]:
    return [
        {"event_type": "tool.call", "name": "search", "span_id": "s1", "outcome": "ok"},
        {"event_type": "tool.call", "name": "search", "span_id": "s2", "outcome": "ok"},
        {"event_type": "tool.call", "name": "search", "span_id": "s3", "outcome": "ok"},
    ]


def _pin_flag(monkeypatch: pytest.MonkeyPatch, value: bool) -> None:
    """Pin ``signal_investigator_llm_v1`` so the route (which resolves
    ``get_settings()`` at request time inside a TestClient worker) sees it.

    The suite-wide ``patch_settings`` autouse fixture swaps
    ``eden.config.get_settings`` for a MagicMock, so we set the flag on the
    live settings object *and* re-pin ``get_settings`` to return it.
    """
    settings = get_settings()
    monkeypatch.setattr(
        settings, "signal_investigator_llm_v1", value, raising=False
    )
    monkeypatch.setattr("eden.config.get_settings", lambda: settings)


def _app() -> FastAPI:
    from eden.api.routes import signal_investigator as sig_routes

    app = FastAPI()

    async def _fake_user() -> dict[str, Any]:
        return {"id": "u1", "email": "t@example.com"}

    async def _path_org(org_id: str = "org_1") -> str:
        return org_id

    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_path_org_access] = _path_org
    app.include_router(sig_routes.router)
    return app


def test_investigate_disabled_returns_honest_envelope(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _pin_flag(monkeypatch, False)
    client = TestClient(_app())
    resp = client.post(
        "/orgs/org_1/traces/trace-1/investigate",
        json={"events": _loop_events()},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "disabled"
    assert body["feature"] == "signal_investigator_llm_v1"
    assert body["findings"] == []
    assert "disabled" in body["note"]


def test_investigate_returns_structured_findings(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _pin_flag(monkeypatch, True)
    pg = _FakePg([_loop_definition()])
    with (
        patch(
            "eden.signals.investigator.get_postgres_client",
            AsyncMock(return_value=pg),
        ),
        patch(
            "eden.signals.investigator._maybe_write_stumble",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.signals.clusterer.cluster_after_match",
            AsyncMock(return_value=None),
        ),
        patch(
            "eden.closed_loop.autonomy_policy.check_budget",
            AsyncMock(return_value=(True, 0.0, 5.0)),
        ),
        patch(
            "eden.closed_loop.autonomy_policy.record_spend",
            AsyncMock(return_value=0.0),
        ),
    ):
        client = TestClient(_app())
        resp = client.post(
            "/orgs/org_1/traces/trace-1/investigate",
            json={"events": _loop_events()},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["evaluated_count"] == 1
    assert body["matched_count"] == 1
    assert len(body["findings"]) == 1
    finding = body["findings"][0]
    assert finding["matched"] is True
    assert finding["signal_id"] == "sig-loop"
    assert finding["trace_id"] == "trace-1"
    assert "confidence" in finding
    # A signal_events row was written (not a silent no-op).
    assert pg.inserts


def test_investigate_budget_exhausted_is_honest_error(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _pin_flag(monkeypatch, True)
    inv_mock = AsyncMock(return_value=[])
    with (
        patch(
            "eden.closed_loop.autonomy_policy.check_budget",
            AsyncMock(return_value=(False, 5.0, 5.0)),
        ),
        patch("eden.signals.investigator.investigate_trace", inv_mock),
    ):
        client = TestClient(_app())
        resp = client.post(
            "/orgs/org_1/traces/trace-1/investigate",
            json={"events": _loop_events()},
        )
    assert resp.status_code == 402
    detail = resp.json()["detail"]
    assert detail["status"] == "budget_exhausted"
    assert detail["limit_usd"] == 5.0
    # Honest failure: we never ran the investigator on an exhausted budget.
    inv_mock.assert_not_awaited()
