"""W1 Agent 1.2 — telemetry ingest auth status codes.

``POST /orgs/{org}/observability/telemetry/ingest`` must use
``get_ingest_auth`` (not ``require_path_org_access``):

* bad / missing org API key → **401**
* auth succeeded but path org ≠ key org → **403**

Evidence: ``clients/portal/e2e/golden/w2-08-live-ingest-matrix.json``
(``telemetry_ingest_bad_key`` previously returned 403 Not a member).
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

_ORG = "00000000-0000-0000-0000-000000000099"
_OTHER_ORG = "00000000-0000-0000-0000-000000000088"

_EVENT = {
    "event_id": "evt-w1-12",
    "project_id": "default",
    "trace_id": "trace-w1-12",
    "realm": "environment",
    "event_type": "llm.completion",
    "timestamp": "2026-07-20T00:00:00Z",
}


@pytest.fixture
def mock_collector() -> AsyncMock:
    collector = AsyncMock()
    collector.ingest_one = AsyncMock(
        return_value={"accepted": 1, "rejected": 0, "deduplicated": 0, "sampled_out": 0, "total": 1}
    )
    collector.ingest = AsyncMock(return_value=True)
    collector.ingest_batch = AsyncMock(
        return_value={"accepted": 1, "rejected": 0, "deduplicated": 0, "total": 1}
    )
    return collector


def _patch_collector(monkeypatch, mock_collector: AsyncMock) -> None:
    from eden.api.routes import observability as obs_module
    from eden.observability import telemetry_collector as tc_module

    async def _get():
        return mock_collector

    monkeypatch.setattr(tc_module, "get_telemetry_collector", _get)
    monkeypatch.setattr(obs_module, "get_telemetry_collector", _get)
    monkeypatch.setattr(obs_module, "_get_collector", _get)


class TestTelemetryIngestBadKeyIs401:
    """Bad/missing key must be 401, never 403 Not a member."""

    def test_invalid_key_with_org_is_401(
        self, api_client: TestClient, mock_collector, monkeypatch
    ) -> None:
        _patch_collector(monkeypatch, mock_collector)
        api_client.cookies.clear()
        response = api_client.post(
            f"/orgs/{_ORG}/observability/telemetry/ingest",
            json=_EVENT,
            headers={
                "X-Org-Id": _ORG,
                "X-Org-Api-Key": "sk_bad_key_0000",
            },
        )
        assert response.status_code == 401, response.text
        assert mock_collector.ingest.await_count == 0
        detail = response.json().get("detail", "")
        assert "member" not in str(detail).lower()

    def test_missing_key_and_cookie_is_401(
        self, api_client: TestClient, mock_collector, monkeypatch
    ) -> None:
        _patch_collector(monkeypatch, mock_collector)
        api_client.cookies.clear()
        response = api_client.post(
            f"/orgs/{_ORG}/observability/telemetry/ingest",
            json=_EVENT,
            headers={"X-Org-Id": _ORG},
        )
        assert response.status_code == 401, response.text
        assert mock_collector.ingest.await_count == 0

    def test_batch_invalid_key_is_401(
        self, api_client: TestClient, mock_collector, monkeypatch
    ) -> None:
        _patch_collector(monkeypatch, mock_collector)
        api_client.cookies.clear()
        response = api_client.post(
            f"/orgs/{_ORG}/observability/telemetry/ingest/batch",
            json={"events": [_EVENT]},
            headers={
                "X-Org-Id": _ORG,
                "X-Org-Api-Key": "sk_bad_key_0000",
            },
        )
        assert response.status_code == 401, response.text
        assert mock_collector.ingest_batch.await_count == 0


class TestTelemetryIngestWrongOrgIs403:
    """Valid auth for org A posting to path org B → 403 only."""

    def test_path_org_mismatch_is_403(
        self, api_client: TestClient, mock_collector, monkeypatch
    ) -> None:
        from eden.api.app import app
        from eden.api.deps import get_ingest_auth

        _patch_collector(monkeypatch, mock_collector)
        fake_auth = {
            "org_id": _ORG,
            "scopes": ["ingest:write"],
            "key_id": "key-abc",
        }
        app.dependency_overrides[get_ingest_auth] = lambda: fake_auth
        api_client.cookies.clear()
        try:
            response = api_client.post(
                f"/orgs/{_OTHER_ORG}/observability/telemetry/ingest",
                json=_EVENT,
                headers={
                    "X-Org-Id": _ORG,
                    "X-Org-Api-Key": "test-key-not-verified-by-override",
                },
            )
            assert response.status_code == 403, response.text
            assert mock_collector.ingest.await_count == 0
        finally:
            app.dependency_overrides.pop(get_ingest_auth, None)

    def test_matching_org_succeeds(
        self, api_client: TestClient, mock_collector, monkeypatch
    ) -> None:
        from eden.api.app import app
        from eden.api.deps import get_ingest_auth

        _patch_collector(monkeypatch, mock_collector)
        fake_auth = {
            "org_id": _ORG,
            "scopes": ["ingest:write"],
            "key_id": "key-abc",
        }
        app.dependency_overrides[get_ingest_auth] = lambda: fake_auth
        api_client.cookies.clear()
        try:
            response = api_client.post(
                f"/orgs/{_ORG}/observability/telemetry/ingest",
                json=_EVENT,
                headers={
                    "X-Org-Id": _ORG,
                    "X-Org-Api-Key": "test-key-not-verified-by-override",
                },
            )
            assert response.status_code == 200, response.text
            assert mock_collector.ingest_one.await_count == 1
        finally:
            app.dependency_overrides.pop(get_ingest_auth, None)


class TestTelemetryIngestClientErrorIs4xx:
    """Collector ValueError must not become a bare 500."""

    def test_value_error_maps_to_400(
        self, api_client: TestClient, mock_collector, monkeypatch
    ) -> None:
        from eden.api.app import app
        from eden.api.deps import get_ingest_auth

        _patch_collector(monkeypatch, mock_collector)
        mock_collector.ingest_one = AsyncMock(side_effect=ValueError("bad event shape"))
        fake_auth = {
            "org_id": _ORG,
            "scopes": ["ingest:write"],
            "key_id": "key-abc",
        }
        app.dependency_overrides[get_ingest_auth] = lambda: fake_auth
        api_client.cookies.clear()
        try:
            response = api_client.post(
                f"/orgs/{_ORG}/observability/telemetry/ingest",
                json=_EVENT,
                headers={
                    "X-Org-Id": _ORG,
                    "X-Org-Api-Key": "test-key",
                },
            )
            assert response.status_code == 400, response.text
        finally:
            app.dependency_overrides.pop(get_ingest_auth, None)


class TestTelemetryIngestNonUuidOrgIs401:
    """Non-UUID X-Org-Id must be 401, never asyncpg 500 (mirrors multi-format)."""

    def test_invalid_key_non_uuid_org_is_401_not_500(
        self, api_client: TestClient, mock_collector, monkeypatch
    ) -> None:
        _patch_collector(monkeypatch, mock_collector)
        api_client.cookies.clear()
        response = api_client.post(
            "/orgs/org_clerk_style_placeholder/observability/telemetry/ingest",
            json=_EVENT,
            headers={
                "X-Org-Id": "org_clerk_style_placeholder",
                "X-Org-Api-Key": "sk_bad_key_0000",
            },
        )
        assert response.status_code == 401, response.text
        assert response.status_code != 500
        assert mock_collector.ingest.await_count == 0
        detail = response.json().get("detail", "")
        assert "member" not in str(detail).lower()

    def test_uuid_syntax_fault_is_401_not_500(
        self, api_client: TestClient, mock_collector, mock_postgres_client, monkeypatch
    ) -> None:
        _patch_collector(monkeypatch, mock_collector)

        async def _boom(*_a, **_k):
            raise RuntimeError("invalid input syntax for type uuid")

        mock_postgres_client.fetchrow = AsyncMock(side_effect=_boom)
        api_client.cookies.clear()
        response = api_client.post(
            "/orgs/org_not_a_uuid/observability/telemetry/ingest",
            json=_EVENT,
            headers={
                "X-Org-Id": "org_not_a_uuid",
                "X-Org-Api-Key": "sk_bad_key_0000",
            },
        )
        assert response.status_code == 401, response.text
        assert response.status_code != 500
        assert mock_collector.ingest.await_count == 0
