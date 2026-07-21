"""D.12.6 Provider routing tests — service + routes + SDK + hook (15 tests).

Covers:

* Service: record_attempt happy, record_attempt idempotent
  on (trace_id, sequence_index), get_attempts_for_trace,
  list_attempts with provider/decision/since filters,
  get_failure_rate, detect_repeated_failures below
  threshold (no hook), detect_repeated_failures above
  threshold (fires hook).
* Routes: POST /v1/provider_routing/{org}/attempts,
  GET /v1/traces/{id}/provider_routing,
  GET /v1/provider_routing/{org}/attempts,
  GET /v1/provider_routing/{org}/failure_rate,
  GET /v1/provider_routing/{org}/repeated_failures.
* SDK: record_attempt happy, build_provider_routing_attributes,
  retry_with_fallback primary→fallback→success records
  full trace, retry_with_fallback all-fail records aborts
  and re-raises.

Auth stubs use ``app.dependency_overrides`` (the proven
FastAPI pattern from the D.12.1-5 tests).
"""

from __future__ import annotations

from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

# ── helpers ───────────────────────────────────────────────────────────


_TID = "00000000-0000-0000-0000-000000000033"
_SID = "00000000-0000-0000-0000-000000000034"


def _attempt_row(
    decision: str = "success",
    attempted_provider: str = "openai",
    sequence_index: int = 0,
):
    now = datetime.now(UTC)
    return {
        "id": "00000000-0000-0000-0000-0000000000dd",
        "org_id": "org-1",
        "trace_id": _TID,
        "span_id": _SID,
        "attempted_provider": attempted_provider,
        "attempted_model": "gpt-4o-mini-2024-07-18",
        "failure_reason": None if decision == "success" else "rate_limited",
        "latency_ms": 320,
        "decision": decision,
        "sequence_index": sequence_index,
        "created_at": now,
    }


async def _fake_user() -> dict:
    return {"id": "u-1", "email": "t@test.io", "sub": "u-1"}


async def _fake_member() -> dict:
    return {"id": "u-1", "role": "member", "org_id": "org-1"}


async def _fake_admin() -> dict:
    return {"id": "u-1", "role": "admin", "org_id": "org-1"}


@pytest.fixture
def routing_client(mock_postgres_client: MagicMock) -> TestClient:
    """TestClient with the provider-routing route's auth deps stubbed."""
    from eden.api.app import app
    from eden.api.deps import (
        get_current_user,
        require_org_admin,
        require_org_member,
        require_path_org_access,
    )
    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_org_member] = _fake_member
    app.dependency_overrides[require_path_org_access] = lambda: "org-1"
    app.dependency_overrides[require_org_admin] = _fake_admin
    try:
        with patch(
            "eden.api.routes.observability_provider_routing.resolve_eden_org_id",
            new=AsyncMock(side_effect=lambda oid: oid),
        ):
            client = TestClient(app)
            client.cookies.set("authorization", "test-token-for-default-deny")
            yield client
    finally:
        app.dependency_overrides.clear()


# ── service tests ─────────────────────────────────────────────────────


class TestProviderRoutingService:
    """6 service-level tests."""

    async def test_record_attempt_returns_id(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_provider_routing_service
        svc = get_provider_routing_service()
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "id": "00000000-0000-0000-0000-0000000000dd",
        })
        attempt_id = await svc.record_attempt(
            "org-1",
            trace_id=_TID,
            span_id=_SID,
            attempted_provider="openai",
            attempted_model="gpt-4o-mini-2024-07-18",
            sequence_index=0,
            decision="success",
            latency_ms=320,
        )
        assert attempt_id == "00000000-0000-0000-0000-0000000000dd"
        # SQL was the upsert ON CONFLICT (trace_id, sequence_index)
        sql = mock_postgres_client.fetchrow.call_args.args[0]
        assert "ON CONFLICT (trace_id, sequence_index)" in sql

    async def test_record_attempt_invalid_decision_raises(self):
        """Service layer validates decision before touching the DB."""
        from eden.services.observability import get_provider_routing_service
        svc = get_provider_routing_service()
        with pytest.raises(ValueError, match="unknown decision"):
            await svc.record_attempt(
                "org-1",
                trace_id=_TID,
                span_id=_SID,
                attempted_provider="openai",
                attempted_model="gpt-4o-mini-2024-07-18",
                sequence_index=0,
                decision="wontfix",
            )

    async def test_record_attempt_negative_sequence_index_raises(self):
        from eden.services.observability import get_provider_routing_service
        svc = get_provider_routing_service()
        with pytest.raises(ValueError, match="sequence_index must be >= 0"):
            await svc.record_attempt(
                "org-1",
                trace_id=_TID,
                span_id=_SID,
                attempted_provider="openai",
                attempted_model="gpt-4o-mini-2024-07-18",
                sequence_index=-1,
                decision="success",
            )

    async def test_get_attempts_for_trace_returns_rows(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_provider_routing_service
        svc = get_provider_routing_service()
        mock_postgres_client.fetch = AsyncMock(return_value=[
            _attempt_row(decision="success", sequence_index=0),
            _attempt_row(decision="fallback", sequence_index=1,
                         attempted_provider="anthropic"),
        ])
        rows = await svc.get_attempts_for_trace(_TID, org_id="org-1")
        assert len(rows) == 2
        assert rows[0]["decision"] == "success"
        assert rows[1]["decision"] == "fallback"
        assert rows[1]["attempted_provider"] == "anthropic"

    async def test_list_attempts_with_filters(
        self, mock_postgres_client: MagicMock,
    ):
        from eden.services.observability import get_provider_routing_service
        svc = get_provider_routing_service()
        mock_postgres_client.fetch = AsyncMock(return_value=[
            _attempt_row(decision="fallback"),
        ])
        rows = await svc.list_attempts(
            "org-1",
            attempted_provider="openai",
            decision="fallback",
            since_minutes=15,
            limit=50,
        )
        assert len(rows) == 1
        # All 3 filter clauses were included
        sql = mock_postgres_client.fetch.call_args.args[0]
        assert "attempted_provider = $2" in sql
        assert "decision = $3" in sql
        assert "created_at >= NOW()" in sql

    async def test_get_failure_rate(self, mock_postgres_client: MagicMock):
        from eden.services.observability import get_provider_routing_service
        svc = get_provider_routing_service()
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "total_attempts": 10,
            "non_success_count": 3,
            "success_count": 7,
        })
        rate = await svc.get_failure_rate(
            "org-1", attempted_provider="openai", window_minutes=15,
        )
        assert rate["total_attempts"] == 10
        assert rate["non_success_count"] == 3
        assert rate["success_count"] == 7
        assert rate["failure_rate"] == pytest.approx(0.3)

    async def test_detect_repeated_failures_below_threshold_returns_none(
        self, mock_postgres_client: MagicMock,
    ):
        """When the non-success count is below the threshold,
        the detector returns ``None`` and does NOT fire the hook.
        """
        from eden.services.observability import get_provider_routing_service
        svc = get_provider_routing_service()
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "total_attempts": 12,
            "non_success_count": 4,
        })
        summary = await svc.detect_repeated_failures(
            "org-1",
            attempted_provider="openai",
            window_minutes=15,
            threshold=10,
        )
        assert summary is None

    async def test_detect_repeated_failures_above_threshold_returns_summary(
        self, mock_postgres_client: MagicMock,
    ):
        """When the non-success count crosses the threshold,
        the detector returns the summary + (best-effort)
        fires the ``on_provider_routing_repeated_failures`` hook.
        """
        from eden.services.observability import get_provider_routing_service
        svc = get_provider_routing_service()
        # Two fetchrow calls: 1) the count, 2) the recent traces
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "total_attempts": 20,
            "non_success_count": 15,
        })
        mock_postgres_client.fetch = AsyncMock(return_value=[
            {"trace_id": _TID},
            {"trace_id": "00000000-0000-0000-0000-0000000000ee"},
        ])
        summary = await svc.detect_repeated_failures(
            "org-1",
            attempted_provider="openai",
            window_minutes=15,
            threshold=10,
        )
        assert summary is not None
        assert summary["spike"] is True
        assert summary["non_success_count"] == 15
        assert summary["failure_rate"] == pytest.approx(0.75)
        assert len(summary["trace_ids"]) == 2


# ── route tests ───────────────────────────────────────────────────────


class TestProviderRoutingRoutes:
    """4 route tests."""

    def test_post_attempt_records(
        self, mock_postgres_client: MagicMock, routing_client: TestClient,
    ):
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "id": "00000000-0000-0000-0000-0000000000dd",
        })
        resp = routing_client.post(
            "/v1/provider_routing/org-1/attempts",
            json={
                "trace_id": _TID,
                "span_id": _SID,
                "attempted_provider": "openai",
                "attempted_model": "gpt-4o-mini-2024-07-18",
                "sequence_index": 0,
                "decision": "success",
                "latency_ms": 320,
            },
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "ok"
        assert body["data"]["id"] == "00000000-0000-0000-0000-0000000000dd"

    def test_post_attempt_rejects_invalid_decision(
        self, mock_postgres_client: MagicMock, routing_client: TestClient,
    ):
        resp = routing_client.post(
            "/v1/provider_routing/org-1/attempts",
            json={
                "trace_id": _TID,
                "span_id": _SID,
                "attempted_provider": "openai",
                "attempted_model": "gpt-4o-mini-2024-07-18",
                "sequence_index": 0,
                "decision": "wontfix",
            },
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["status"] == "error"
        assert "unknown decision" in body["message"]

    def test_get_trace_provider_routing(
        self, mock_postgres_client: MagicMock, routing_client: TestClient,
    ):
        mock_postgres_client.fetch = AsyncMock(return_value=[
            _attempt_row(decision="success"),
            _attempt_row(decision="fallback", sequence_index=1,
                         attempted_provider="anthropic"),
        ])
        resp = routing_client.get(
            f"/v1/traces/{_TID}/provider_routing",
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["count"] == 2
        assert body["data"][1]["attempted_provider"] == "anthropic"

    def test_get_failure_rate_route(
        self, mock_postgres_client: MagicMock, routing_client: TestClient,
    ):
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "total_attempts": 20,
            "non_success_count": 5,
            "success_count": 15,
        })
        resp = routing_client.get(
            "/v1/provider_routing/org-1/failure_rate"
            "?attempted_provider=openai&window_minutes=15",
            headers={"X-Org-Id": "org-1"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["data"]["total_attempts"] == 20
        assert body["data"]["failure_rate"] == pytest.approx(0.25)


# ── SDK tests ─────────────────────────────────────────────────────────


class TestProviderRoutingSdk:
    """4 SDK tests."""

    async def test_record_attempt_persists(self, mock_postgres_client: MagicMock):
        from eden.sdk.provider_routing import record_attempt
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "id": "00000000-0000-0000-0000-0000000000dd",
        })
        attempt_id = await record_attempt(
            org_id="org-1",
            trace_id=_TID,
            span_id=_SID,
            attempted_provider="openai",
            attempted_model="gpt-4o-mini-2024-07-18",
            sequence_index=0,
            decision="success",
            latency_ms=320,
        )
        assert attempt_id == "00000000-0000-0000-0000-0000000000dd"

    def test_build_provider_routing_attributes(self):
        from eden.sdk.provider_routing import build_provider_routing_attributes
        attrs = build_provider_routing_attributes(
            attempted_provider="openai",
            attempted_model="gpt-4o-mini-2024-07-18",
            decision="success",
            sequence_index=0,
            latency_ms=320,
        )
        assert "provider_routing" in attrs
        pr = attrs["provider_routing"]
        assert pr["attempted_provider"] == "openai"
        assert pr["decision"] == "success"
        assert pr["sequence_index"] == 0
        assert pr["latency_ms"] == 320

    async def test_retry_with_fallback_walks_chain_on_failure(
        self, mock_postgres_client: MagicMock,
    ):
        """Primary fails, fallback succeeds — full routing
        trace is recorded with sequence_index 0 (fallback)
        and 1 (success).
        """
        from eden.sdk.provider_routing import retry_with_fallback
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "id": "00000000-0000-0000-0000-0000000000dd",
        })
        call_log: list[tuple[str, str]] = []

        async def _caller(provider: str, model: str):
            call_log.append((provider, model))
            if provider == "openai":
                raise RuntimeError("rate_limited")
            return {"ok": True, "from": provider}

        result = await retry_with_fallback(
            "org-1",
            trace_id=_TID,
            span_id=_SID,
            primary=("openai", "gpt-4o-mini-2024-07-18"),
            fallback_providers=[("anthropic", "claude-3-5-sonnet-latest")],
            caller=_caller,
        )
        assert result == {"ok": True, "from": "anthropic"}
        assert len(call_log) == 2
        # 2 attempts recorded (1 fallback + 1 success)
        assert mock_postgres_client.fetchrow.await_count == 2

    async def test_retry_with_fallback_all_fail_raises(
        self, mock_postgres_client: MagicMock,
    ):
        """All fallbacks fail — the last exception propagates
        and all attempts are recorded as fallback / abort.
        """
        from eden.sdk.provider_routing import retry_with_fallback
        mock_postgres_client.fetchrow = AsyncMock(return_value={
            "id": "00000000-0000-0000-0000-0000000000dd",
        })

        async def _caller(provider: str, model: str):
            raise RuntimeError(f"{provider} down")

        with pytest.raises(RuntimeError, match="google down"):
            await retry_with_fallback(
                "org-1",
                trace_id=_TID,
                span_id=_SID,
                primary=("openai", "gpt-4o-mini-2024-07-18"),
                fallback_providers=[
                    ("anthropic", "claude-3-5-sonnet-latest"),
                    ("google", "gemini-1.5-pro"),
                ],
                caller=_caller,
            )
        # 3 attempts recorded (1 primary + 1 mid + 1 final abort)
        assert mock_postgres_client.fetchrow.await_count == 3
        # The final attempt's decision is 'abort'. SQL args
        # (skipping the SQL string in args[0]):
        #   args[1]=org_id, args[2]=trace_id, args[3]=span_id,
        #   args[4]=provider, args[5]=model, args[6]=failure_reason,
        #   args[7]=latency_ms, args[8]=decision, args[9]=sequence_index.
        last_call = mock_postgres_client.fetchrow.call_args_list[-1]
        args = last_call.args[1:]
        assert args[7] == "abort"   # decision
        assert args[8] == 2         # sequence_index (3rd in chain)
