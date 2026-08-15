"""FEAT-2 — Typesense RTBF user_id indexing and honest fanout."""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.observability.telemetry_collector import TelemetryEvent
from eden.observability.typesense_client import (
    _SPAN_USER_KEYS,
    SPAN_SCHEMA,
    TypesenseClient,
    _extract_user_id,
    build_span_doc,
)
from eden.scripts.typesense_backfill_user_id import _SPAN_USER_KEYS as _BACKFILL_KEYS


class TestSpanUserIdSchema:
    def test_span_schema_includes_user_id_facetable_optional(self) -> None:
        field = next(f for f in SPAN_SCHEMA["fields"] if f["name"] == "user_id")
        assert field["type"] == "string"
        assert field.get("facet") is True
        assert field.get("optional") is True

    def test_span_user_keys_match_backfill_script(self) -> None:
        assert _SPAN_USER_KEYS == _BACKFILL_KEYS


class TestExtractUserId:
    def test_plain_user_id(self) -> None:
        assert _extract_user_id({"user_id": "u-1"}) == "u-1"

    def test_langfuse_key(self) -> None:
        assert _extract_user_id({"langfuse.user_id": "u-2"}) == "u-2"

    def test_enduser_key(self) -> None:
        assert _extract_user_id({"enduser.id": "u-3"}) == "u-3"

    def test_missing_returns_empty(self) -> None:
        assert _extract_user_id({"model": "gpt-4"}) == ""


class TestBuildSpanDocUserId:
    def test_includes_user_id_when_present(self) -> None:
        ev = TelemetryEvent(
            event_id="e1",
            tenant_id="t-1",
            project_id="p-1",
            trace_id="tr-1",
            realm="production",
            event_type="llm.completion",
            timestamp="2026-06-17T12:00:00Z",
            attributes={"langfuse.user_id": "user-42"},
        )
        doc = build_span_doc(ev)
        assert doc["user_id"] == "user-42"

    def test_user_id_empty_when_missing(self) -> None:
        ev = TelemetryEvent(
            event_id="e1",
            tenant_id="t-1",
            project_id="p-1",
            trace_id="tr-1",
            realm="production",
            event_type="llm.completion",
            timestamp="2026-06-17T12:00:00Z",
            attributes={"model": "gpt-4"},
        )
        doc = build_span_doc(ev)
        assert doc["user_id"] == ""


class TestDeleteByUser:
    @pytest.mark.asyncio
    async def test_filter_includes_tenant_and_user_id(self) -> None:
        client = TypesenseClient(host="h", port=8108, api_key="k")
        client._schema_ready = True
        client.delete_by_filter = AsyncMock(return_value=3)  # type: ignore[method-assign]

        deleted = await client.delete_by_user("org-1", "user-9")

        assert deleted == 3
        client.delete_by_filter.assert_awaited_once_with(
            "tenant_id:=org-1 && user_id:=user-9"
        )

    @pytest.mark.asyncio
    async def test_count_by_user_uses_same_filter(self) -> None:
        client = TypesenseClient(host="h", port=8108, api_key="k")
        client._schema_ready = True
        client.count_by_filter = AsyncMock(return_value=0)  # type: ignore[method-assign]

        remaining = await client.count_by_user("org-1", "user-9")

        assert remaining == 0
        client.count_by_filter.assert_awaited_once_with(
            "tenant_id:=org-1 && user_id:=user-9"
        )


class TestSchemaMigration:
    @pytest.mark.asyncio
    async def test_ensure_collection_patches_missing_user_id(self) -> None:
        client = TypesenseClient(host="h", port=8108, api_key="k")
        existing = {
            "name": "eden_spans",
            "fields": [{"name": "tenant_id", "type": "string"}],
        }

        async def _fake_request(
            method: str, path: str, *, json_body: Any = None, params: Any = None
        ) -> tuple[int, Any]:
            if method == "GET" and path.endswith("/eden_spans"):
                return 200, existing
            if method == "PATCH" and path.endswith("/eden_spans"):
                assert json_body == {
                    "fields": [
                        {
                            "name": "user_id",
                            "type": "string",
                            "facet": True,
                            "optional": True,
                        }
                    ]
                }
                return 200, existing
            return 404, None

        client._request = _fake_request  # type: ignore[method-assign]
        assert await client.ensure_collection() is True
        assert client._schema_ready is True

    @pytest.mark.asyncio
    async def test_has_user_id_field_false_when_missing(self) -> None:
        client = TypesenseClient(host="h", port=8108, api_key="k")
        client._request = AsyncMock(  # type: ignore[method-assign]
            return_value=(200, {"fields": [{"name": "tenant_id", "type": "string"}]})
        )
        assert await client.has_user_id_field() is False

    @pytest.mark.asyncio
    async def test_has_user_id_field_true_when_present(self) -> None:
        client = TypesenseClient(host="h", port=8108, api_key="k")
        client._request = AsyncMock(  # type: ignore[method-assign]
            return_value=(
                200,
                {"fields": [{"name": "user_id", "type": "string", "facet": True}]},
            )
        )
        assert await client.has_user_id_field() is True


class TestRtbfFanoutTypesense:
    @pytest.mark.asyncio
    async def test_reports_unsupported_when_user_id_field_missing(self) -> None:
        from eden.services.governance_intel import rtbf_fanout

        client = MagicMock()
        client.ensure_collection = AsyncMock(return_value=True)
        client.has_user_id_field = AsyncMock(return_value=False)
        client.delete_by_user = AsyncMock()

        with patch(
            "eden.observability.typesense_client.get_typesense_client",
            return_value=client,
        ):
            result = await rtbf_fanout._fanout_typesense(
                "org-1", user_id="user-1", dry_run=False
            )

        assert result["status"] == "unsupported"
        assert result["store"] == "typesense"
        client.delete_by_user.assert_not_called()

    @pytest.mark.asyncio
    async def test_reports_ok_with_deleted_count_when_field_present(self) -> None:
        from eden.services.governance_intel import rtbf_fanout

        client = MagicMock()
        client.ensure_collection = AsyncMock(return_value=True)
        client.has_user_id_field = AsyncMock(return_value=True)
        client.delete_by_user = AsyncMock(return_value=5)

        with patch(
            "eden.observability.typesense_client.get_typesense_client",
            return_value=client,
        ):
            result = await rtbf_fanout._fanout_typesense(
                "org-1", user_id="user-1", dry_run=False
            )

        assert result == {"store": "typesense", "status": "ok", "deleted": 5}
        client.delete_by_user.assert_awaited_once_with("org-1", "user-1")
