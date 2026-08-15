"""Tests for the one-time RTBF Typesense ``user_id`` backfill script.

Covers ``_extract_user_id`` (mirrors ``typesense_client._SPAN_USER_KEYS``),
the keyset-paginated Postgres scan in ``_fetch_batch``, and ``run``'s
dry-run vs live behaviour — all against mocked Postgres / Typesense
clients (no live infra needed). See
``eden.scripts.typesense_backfill_user_id`` for the operational runbook.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.scripts.typesense_backfill_user_id import (
    _extract_user_id,
    _fetch_batch,
    run,
)


class TestExtractUserId:
    def test_none_attrs_returns_empty(self) -> None:
        assert _extract_user_id(None) == ""

    def test_plain_user_id_key(self) -> None:
        assert _extract_user_id({"user_id": "u-1"}) == "u-1"

    def test_langfuse_key(self) -> None:
        assert _extract_user_id({"langfuse.user_id": "u-2"}) == "u-2"

    def test_helicone_key(self) -> None:
        assert _extract_user_id({"helicone.user_id": "u-3"}) == "u-3"

    def test_otel_enduser_key(self) -> None:
        assert _extract_user_id({"enduser.id": "u-4"}) == "u-4"

    def test_blank_string_ignored(self) -> None:
        assert _extract_user_id({"user_id": "   "}) == ""

    def test_no_known_key_returns_empty(self) -> None:
        assert _extract_user_id({"model": "gpt-4"}) == ""


class TestFetchBatch:
    @pytest.mark.asyncio
    async def test_first_page_has_no_after_cursor(self) -> None:
        client = AsyncMock()
        client.fetch.return_value = [
            {"event_id": "e1", "tenant_id": "t1", "attributes": {}}
        ]
        rows = await _fetch_batch(client, after_event_id=None, limit=10)
        assert rows == [{"event_id": "e1", "tenant_id": "t1", "attributes": {}}]
        sql, *params = client.fetch.call_args.args
        assert "WHERE" not in sql
        assert params == [10]

    @pytest.mark.asyncio
    async def test_subsequent_page_scopes_by_after_cursor(self) -> None:
        client = AsyncMock()
        client.fetch.return_value = []
        await _fetch_batch(client, after_event_id="e1", limit=10)
        sql, *params = client.fetch.call_args.args
        assert "event_id > $1" in sql
        assert params == ["e1", 10]


class TestRun:
    @pytest.mark.asyncio
    async def test_dry_run_never_calls_backfill_user_ids(self) -> None:
        pg = AsyncMock()
        pg.fetch.side_effect = [
            [
                {
                    "event_id": "e1",
                    "tenant_id": "t1",
                    "attributes": {"user_id": "u-1"},
                }
            ],
            [],
        ]
        ts = AsyncMock()

        with patch(
            "eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)
        ), patch(
            "eden.observability.typesense_client.get_typesense_client",
            return_value=ts,
        ):
            rc = await run(dry_run=True, limit=None, batch_size=500)

        assert rc == 0
        ts.backfill_user_ids.assert_not_called()

    @pytest.mark.asyncio
    async def test_live_run_patches_only_rows_with_a_known_user_id(self) -> None:
        pg = AsyncMock()
        pg.fetch.side_effect = [
            [
                {
                    "event_id": "e1",
                    "tenant_id": "t1",
                    "attributes": {"user_id": "u-1"},
                },
                {
                    "event_id": "e2",
                    "tenant_id": "t1",
                    "attributes": {"model": "gpt-4"},  # no identity -> skipped
                },
            ],
            [],
        ]
        ts = AsyncMock()
        ts.backfill_user_ids.return_value = 1

        with patch(
            "eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)
        ), patch(
            "eden.observability.typesense_client.get_typesense_client",
            return_value=ts,
        ):
            rc = await run(dry_run=False, limit=None, batch_size=500)

        assert rc == 0
        ts.backfill_user_ids.assert_awaited_once_with([("t1:e1", "u-1")])

    @pytest.mark.asyncio
    async def test_live_run_errors_when_typesense_not_configured(self) -> None:
        pg = AsyncMock()
        pg.fetch.return_value = []

        with patch(
            "eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)
        ), patch(
            "eden.observability.typesense_client.get_typesense_client",
            return_value=None,
        ):
            rc = await run(dry_run=False, limit=None, batch_size=500)

        assert rc == 2
