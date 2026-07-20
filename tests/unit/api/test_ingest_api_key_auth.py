"""W2 — API-key ingest must succeed without a Clerk session.

``POST /orgs/{org}/ingest/{format}`` authenticates via ``get_ingest_auth``
(``X-Org-Id`` + ``X-Org-Api-Key``). It must NOT gate on
``require_path_org_access`` / ``get_current_user``, which would 401
Clerk-less SDK callers before ingest auth runs.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def mock_collector() -> AsyncMock:
    collector = AsyncMock()
    collector.ingest_batch = AsyncMock(
        return_value={"accepted": 1, "rejected": 0, "deduplicated": 0, "total": 1}
    )
    return collector


@pytest.fixture
def ingest_client(api_client: TestClient, mock_collector, monkeypatch):
    """Override only ``get_ingest_auth`` — deliberately leave Clerk deps alone."""
    from eden.api.app import app
    from eden.api.deps import get_ingest_auth
    from eden.api.routes import ingestion as ingestion_module
    from eden.observability import telemetry_collector as tc_module

    fake_auth = {
        "org_id": "org-123",
        "user_id": None,
        "api_key_id": "key-abc",
        "auth_method": "api_key",
        "scopes": ["ingest:write"],
    }
    app.dependency_overrides[get_ingest_auth] = lambda: fake_auth

    async def _get():
        return mock_collector

    monkeypatch.setattr(tc_module, "get_telemetry_collector", _get)
    monkeypatch.setattr(ingestion_module, "get_telemetry_collector", _get)

    # Ensure no Clerk session cookie is present.
    api_client.cookies.clear()
    try:
        yield api_client, fake_auth, mock_collector
    finally:
        app.dependency_overrides.pop(get_ingest_auth, None)


class TestApiKeyIngestNoClerk:
    def test_openai_ingest_succeeds_without_clerk_session(
        self, ingest_client
    ) -> None:
        client, _auth, mock_collector = ingest_client
        body = json.dumps(
            {
                "id": "chatcmpl-w2",
                "model": "gpt-4o",
                "choices": [{"message": {"role": "assistant", "content": "ok"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            }
        ).encode()
        response = client.post(
            "/orgs/org-123/ingest/openai",
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-Org-Id": "org-123",
                "X-Org-Api-Key": "test-key-not-verified-by-override",
            },
        )
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["source_format"] == "openai"
        assert data["accepted"] >= 1 or data["total"] >= 1
        assert mock_collector.ingest_batch.await_count == 1

    def test_path_org_mismatch_is_403(self, ingest_client) -> None:
        client, _auth, mock_collector = ingest_client
        body = json.dumps(
            {
                "id": "chatcmpl-w2-mismatch",
                "model": "gpt-4o",
                "choices": [{"message": {"role": "assistant", "content": "x"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            }
        ).encode()
        response = client.post(
            "/orgs/other-org/ingest/openai",
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-Org-Id": "org-123",
                "X-Org-Api-Key": "test-key",
            },
        )
        assert response.status_code == 403, response.text
        assert mock_collector.ingest_batch.await_count == 0

    def test_missing_api_key_and_cookie_is_401(
        self, api_client: TestClient, mock_collector, monkeypatch
    ) -> None:
        """Without get_ingest_auth override, Clerk-less + keyless → 401."""
        from eden.api.routes import ingestion as ingestion_module
        from eden.observability import telemetry_collector as tc_module

        async def _get():
            return mock_collector

        monkeypatch.setattr(tc_module, "get_telemetry_collector", _get)
        monkeypatch.setattr(ingestion_module, "get_telemetry_collector", _get)
        api_client.cookies.clear()
        response = api_client.post(
            "/orgs/org-123/ingest/openai",
            content=b'{"id":"x","model":"m","choices":[],"usage":{}}',
            headers={"Content-Type": "application/json", "X-Org-Id": "org-123"},
        )
        assert response.status_code == 401, response.text
        assert mock_collector.ingest_batch.await_count == 0


class TestIngestBatchUnavailableMapsTo503:
    """Multi-format ``ingest_batch`` must mirror /chunks: 503 + Retry-After."""

    def test_ingestion_unavailable_returns_503_retry_after(
        self, ingest_client
    ) -> None:
        from eden.observability.errors import IngestionUnavailable

        client, _auth, mock_collector = ingest_client
        mock_collector.ingest_batch = AsyncMock(
            side_effect=IngestionUnavailable("Postgres unavailable for telemetry")
        )
        body = json.dumps(
            {
                "id": "chatcmpl-w3-503",
                "model": "gpt-4o",
                "choices": [{"message": {"role": "assistant", "content": "x"}}],
                "usage": {"prompt_tokens": 1, "completion_tokens": 1},
            }
        ).encode()
        response = client.post(
            "/orgs/org-123/ingest/openai",
            content=body,
            headers={
                "Content-Type": "application/json",
                "X-Org-Id": "org-123",
                "X-Org-Api-Key": "test-key",
            },
        )
        assert response.status_code == 503, response.text
        assert response.headers.get("Retry-After") == "5"
        assert mock_collector.ingest_batch.await_count == 1


class TestBadApiKeyWithOrgIs401:
    """W2-08 / Wave 1.1: bad/malformed/missing key must be 401, never 500.

    Evidence: ``clients/portal/e2e/golden/w2-08-live-ingest-matrix.json``
    (``openai_bad_key_with_org``, ``openai_malformed_key_with_org``,
    ``framework_bad_key``).
    """

    @staticmethod
    def _patch_collector(monkeypatch, mock_collector) -> None:
        from eden.api.routes import ingestion as ingestion_module
        from eden.observability import telemetry_collector as tc_module

        async def _get():
            return mock_collector

        monkeypatch.setattr(tc_module, "get_telemetry_collector", _get)
        monkeypatch.setattr(ingestion_module, "get_telemetry_collector", _get)

    def test_invalid_key_uuid_org_is_401(
        self, api_client: TestClient, mock_collector, monkeypatch
    ) -> None:
        self._patch_collector(monkeypatch, mock_collector)
        # No auth override — exercise real get_ingest_auth → get_current_org_api_key.
        # patch_postgres autouse fixture returns None for unknown keys → 401.
        api_client.cookies.clear()
        response = api_client.post(
            "/orgs/00000000-0000-0000-0000-000000000099/ingest/openai",
            content=b'{"id":"x","model":"m","choices":[],"usage":{}}',
            headers={
                "Content-Type": "application/json",
                "X-Org-Id": "00000000-0000-0000-0000-000000000099",
                "X-Org-Api-Key": "sk_bad_key_0000",
            },
        )
        assert response.status_code == 401, response.text
        assert response.status_code != 500
        assert mock_collector.ingest_batch.await_count == 0

    def test_invalid_key_non_uuid_org_is_401_not_500(
        self, api_client: TestClient, mock_collector, monkeypatch
    ) -> None:
        """Non-UUID X-Org-Id used to crash asyncpg → 500; must be 401."""
        self._patch_collector(monkeypatch, mock_collector)
        api_client.cookies.clear()
        response = api_client.post(
            "/orgs/org_clerk_style_placeholder/ingest/openai",
            content=b'{"id":"x","model":"m","choices":[],"usage":{}}',
            headers={
                "Content-Type": "application/json",
                "X-Org-Id": "org_clerk_style_placeholder",
                "X-Org-Api-Key": "sk_bad_key_0000",
            },
        )
        assert response.status_code == 401, response.text
        assert response.status_code != 500
        assert mock_collector.ingest_batch.await_count == 0

    def test_malformed_key_with_org_is_401(
        self, api_client: TestClient, mock_collector, monkeypatch
    ) -> None:
        """W2-08 ``openai_malformed_key_with_org`` — expect 401, never 500."""
        self._patch_collector(monkeypatch, mock_collector)
        api_client.cookies.clear()
        response = api_client.post(
            "/orgs/00000000-0000-0000-0000-000000000099/ingest/openai",
            content=b'{"id":"x","model":"m","choices":[],"usage":{}}',
            headers={
                "Content-Type": "application/json",
                "X-Org-Id": "00000000-0000-0000-0000-000000000099",
                "X-Org-Api-Key": "!!!not-a-valid-key@@@###garbage",
            },
        )
        assert response.status_code == 401, response.text
        assert response.status_code != 500
        assert response.json().get("error") == "unauthorized"
        assert mock_collector.ingest_batch.await_count == 0

    def test_missing_key_with_org_is_401(
        self, api_client: TestClient, mock_collector, monkeypatch
    ) -> None:
        """W2-08 ``openai_missing_key`` — X-Org-Id alone is still 401."""
        self._patch_collector(monkeypatch, mock_collector)
        api_client.cookies.clear()
        response = api_client.post(
            "/orgs/00000000-0000-0000-0000-000000000099/ingest/openai",
            content=b'{"id":"x","model":"m","choices":[],"usage":{}}',
            headers={
                "Content-Type": "application/json",
                "X-Org-Id": "00000000-0000-0000-0000-000000000099",
            },
        )
        assert response.status_code == 401, response.text
        assert response.status_code != 500
        assert mock_collector.ingest_batch.await_count == 0

    def test_framework_bad_key_with_org_is_401(
        self, api_client: TestClient, mock_collector, monkeypatch
    ) -> None:
        """W2-08 ``framework_bad_key`` — sibling ingest path must match openai."""
        self._patch_collector(monkeypatch, mock_collector)
        api_client.cookies.clear()
        response = api_client.post(
            "/orgs/00000000-0000-0000-0000-000000000099/ingest/framework",
            content=b'{"events":[]}',
            headers={
                "Content-Type": "application/json",
                "X-Org-Id": "00000000-0000-0000-0000-000000000099",
                "X-Org-Api-Key": "sk_bad_key_0000",
                "X-Source-Framework": "langchain",
            },
        )
        assert response.status_code == 401, response.text
        assert response.status_code != 500
        assert mock_collector.ingest_batch.await_count == 0

    def test_uuid_syntax_fault_is_401_not_500(
        self, api_client: TestClient, mock_collector, mock_postgres_client, monkeypatch
    ) -> None:
        """Leftover asyncpg UUID cast faults must be 401, never bare 500."""
        self._patch_collector(monkeypatch, mock_collector)

        async def _boom(*_a, **_k):
            raise RuntimeError("invalid input syntax for type uuid")

        mock_postgres_client.fetchrow = AsyncMock(side_effect=_boom)
        api_client.cookies.clear()
        response = api_client.post(
            "/orgs/org_not_a_uuid/ingest/openai",
            content=b'{"id":"x","model":"m","choices":[],"usage":{}}',
            headers={
                "Content-Type": "application/json",
                "X-Org-Id": "org_not_a_uuid",
                "X-Org-Api-Key": "sk_bad_key_0000",
            },
        )
        assert response.status_code == 401, response.text
        assert response.status_code != 500
        assert mock_collector.ingest_batch.await_count == 0

    def test_lookup_outage_is_503_not_500(
        self, api_client: TestClient, mock_collector, mock_postgres_client, monkeypatch
    ) -> None:
        """True DB outages during key lookup must be 503, never bare 500."""
        self._patch_collector(monkeypatch, mock_collector)

        async def _boom(*_a, **_k):
            raise RuntimeError("connection refused")

        mock_postgres_client.fetchrow = AsyncMock(side_effect=_boom)
        api_client.cookies.clear()
        response = api_client.post(
            "/orgs/org_not_a_uuid/ingest/openai",
            content=b'{"id":"x","model":"m","choices":[],"usage":{}}',
            headers={
                "Content-Type": "application/json",
                "X-Org-Id": "org_not_a_uuid",
                "X-Org-Api-Key": "sk_bad_key_0000",
            },
        )
        assert response.status_code == 503, response.text
        assert response.status_code != 500
        assert response.headers.get("Retry-After") == "5"
        assert mock_collector.ingest_batch.await_count == 0


class TestIngestAttributionUsesKeyId:
    """Auth returns ``key_id``; Attribution must still receive api_key_id."""

    def test_key_id_from_auth_reaches_attribution(
        self, api_client: TestClient, mock_collector, monkeypatch
    ) -> None:
        from eden.api.app import app
        from eden.api.deps import get_ingest_auth
        from eden.api.routes import ingestion as ingestion_module
        from eden.observability import telemetry_collector as tc_module
        from eden.observability.ingestion.attribution import Attribution

        async def _get():
            return mock_collector

        monkeypatch.setattr(tc_module, "get_telemetry_collector", _get)
        monkeypatch.setattr(ingestion_module, "get_telemetry_collector", _get)

        captured: list[Attribution] = []
        real_attribution = Attribution

        def _capture(*args, **kwargs):
            attr = real_attribution(*args, **kwargs)
            captured.append(attr)
            return attr

        monkeypatch.setattr(ingestion_module, "Attribution", _capture)

        # Real auth shape: ``key_id`` only (no ``api_key_id``).
        fake_auth = {
            "org_id": "org-123",
            "scopes": ["ingest:write"],
            "key_id": "key-from-auth",
            "auth_method": "api_key",
        }
        app.dependency_overrides[get_ingest_auth] = lambda: fake_auth
        api_client.cookies.clear()
        try:
            body = (
                b'{"id":"chatcmpl-attr","model":"gpt-4o",'
                b'"choices":[{"message":{"role":"assistant","content":"ok"}}],'
                b'"usage":{"prompt_tokens":1,"completion_tokens":1}}'
            )
            response = api_client.post(
                "/orgs/org-123/ingest/openai",
                content=body,
                headers={
                    "Content-Type": "application/json",
                    "X-Org-Id": "org-123",
                    "X-Org-Api-Key": "test-key",
                },
            )
            assert response.status_code == 200, response.text
            assert captured, "Attribution was never constructed"
            assert any(a.api_key_id == "key-from-auth" for a in captured)
        finally:
            app.dependency_overrides.pop(get_ingest_auth, None)