"""FEAT-160 — RTBF post-delete technical re-verification."""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.services.governance_intel import rtbf_fanout
from eden.services.governance_intel.gdpr import RightToBeForgottenService


def _pg_zero_after_erase(
    *,
    pre_counts: dict[str, int] | None = None,
) -> MagicMock:
    """Postgres mock: pre-anonymise counts from ``pre_counts``, zero on re-verify."""
    pg = MagicMock()
    pg.execute = AsyncMock(return_value="OK")
    pg.fetchrow = AsyncMock(return_value=None)
    counts = dict(pre_counts or {})
    count_calls: dict[str, int] = {}

    async def _fetch(query: str, *args: Any) -> list[dict[str, Any]]:
        q = query.lower()
        if "count(*)" in q:
            for table in (
                "telemetry_events",
                "judge_scores",
                "user_feedback",
                "user_sessions",
                "conversation_messages",
                "conversations",
            ):
                if f"from {table}" in q:
                    count_calls[table] = count_calls.get(table, 0) + 1
                    if count_calls[table] > 1 and table in (
                        "telemetry_events",
                        "user_feedback",
                        "user_sessions",
                        "conversations",
                    ):
                        return [{"count": 0}]
                    return [{"count": counts.get(table, 0)}]
        if "distinct trace_id" in q:
            return [{"trace_id": "trace_1"}]
        if "select id from conversations" in q:
            return [{"id": "conv_1"}]
        return []

    pg.fetch = AsyncMock(side_effect=_fetch)
    return pg


class TestReverifyRtbfStores:
    @pytest.mark.asyncio
    async def test_reverify_typesense_called_after_ok_fanout(self) -> None:
        client = MagicMock()
        client.has_user_id_field = AsyncMock(return_value=True)
        client.count_by_user = AsyncMock(return_value=0)

        with patch(
            "eden.observability.typesense_client.get_typesense_client",
            return_value=client,
        ):
            results = await rtbf_fanout.reverify_rtbf_stores(
                "org-1",
                user_id="user-1",
                fanout_results=[
                    {"store": "typesense", "status": "ok", "deleted": 2},
                    {"store": "redis", "status": "unsupported"},
                ],
            )

        assert results == [{"store": "typesense", "status": "ok", "remaining": 0}]
        client.count_by_user.assert_awaited_once_with("org-1", "user-1")

    @pytest.mark.asyncio
    async def test_reverify_typesense_residual_fail_closed(self) -> None:
        client = MagicMock()
        client.has_user_id_field = AsyncMock(return_value=True)
        client.count_by_user = AsyncMock(return_value=3)

        with patch(
            "eden.observability.typesense_client.get_typesense_client",
            return_value=client,
        ):
            result = await rtbf_fanout._reverify_typesense(
                "org-1", user_id="user-1"
            )

        assert result["status"] == "residual"
        assert result["remaining"] == 3

    @pytest.mark.asyncio
    async def test_reverify_skips_non_ok_fanout_stores(self) -> None:
        results = await rtbf_fanout.reverify_rtbf_stores(
            "org-1",
            user_id="user-1",
            fanout_results=[
                {"store": "typesense", "status": "failed"},
                {"store": "qdrant", "status": "unavailable"},
            ],
        )
        assert results == []


class TestRtbfProcessRequestReverify:
    @pytest.mark.asyncio
    async def test_process_request_calls_reverify_and_succeeds(self) -> None:
        svc = RightToBeForgottenService()
        pg = _pg_zero_after_erase(
            pre_counts={
                "telemetry_events": 1,
                "judge_scores": 0,
                "user_feedback": 0,
                "user_sessions": 0,
                "conversation_messages": 0,
                "conversations": 0,
            },
        )
        reverify_pg = AsyncMock(
            return_value=[{"store": "postgres:telemetry_events", "status": "ok", "remaining": 0}]
        )
        reverify_stores = AsyncMock(return_value=[])

        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ), patch(
            "eden.services.governance_intel.rtbf_fanout.fanout_rtbf",
            new=AsyncMock(return_value=[{"store": "redis", "status": "ok"}]),
        ), patch.object(svc, "_reverify_postgres", reverify_pg), patch(
            "eden.services.governance_intel.rtbf_fanout.reverify_rtbf_stores",
            reverify_stores,
        ):
            out = await svc.process_request("org-1", user_id="user-1")

        assert out["status"] == "ok"
        assert out["data"]["reverify_complete"] is True
        reverify_pg.assert_awaited_once()
        reverify_stores.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_process_request_surfaces_residual_as_error(self) -> None:
        svc = RightToBeForgottenService()
        pg = _pg_zero_after_erase(pre_counts={"telemetry_events": 0})

        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ), patch(
            "eden.services.governance_intel.rtbf_fanout.fanout_rtbf",
            new=AsyncMock(return_value=[]),
        ), patch.object(
            svc,
            "_reverify_postgres",
            new=AsyncMock(
                return_value=[
                    {
                        "store": "postgres:user_sessions",
                        "status": "residual",
                        "remaining": 2,
                    },
                ],
            ),
        ), patch(
            "eden.services.governance_intel.rtbf_fanout.reverify_rtbf_stores",
            new=AsyncMock(return_value=[]),
        ):
            out = await svc.process_request("org-1", user_id="user-1")

        assert out["status"] == "error"
        assert out["data"]["complete"] is False
        assert out["data"]["reverify_complete"] is False
        assert len(out["data"]["reverify_residual"]) == 1
        assert "re-verification failed" in out["data"]["message"]

    @pytest.mark.asyncio
    async def test_process_request_surfaces_store_reverify_failure(self) -> None:
        svc = RightToBeForgottenService()
        pg = _pg_zero_after_erase(pre_counts={"telemetry_events": 0})

        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ), patch(
            "eden.services.governance_intel.rtbf_fanout.fanout_rtbf",
            new=AsyncMock(
                return_value=[{"store": "typesense", "status": "ok", "deleted": 1}],
            ),
        ), patch.object(
            svc,
            "_reverify_postgres",
            new=AsyncMock(return_value=[]),
        ), patch(
            "eden.services.governance_intel.rtbf_fanout.reverify_rtbf_stores",
            new=AsyncMock(
                return_value=[
                    {
                        "store": "typesense",
                        "status": "residual",
                        "remaining": 1,
                    },
                ],
            ),
        ):
            out = await svc.process_request("org-1", user_id="user-1")

        assert out["status"] == "error"
        assert "typesense" in out["data"]["message"]

    @pytest.mark.asyncio
    async def test_dry_run_skips_reverify(self) -> None:
        svc = RightToBeForgottenService()
        pg = _pg_zero_after_erase(pre_counts={"telemetry_events": 5})
        reverify_pg = AsyncMock()

        with patch(
            "eden.storage.postgres.get_postgres_client", return_value=pg
        ), patch.object(svc, "_reverify_postgres", reverify_pg), patch(
            "eden.services.governance_intel.rtbf_fanout.reverify_rtbf_stores",
            new=AsyncMock(),
        ) as reverify_stores:
            out = await svc.process_request(
                "org-1", user_id="user-1", dry_run=True,
            )

        assert out["status"] == "ok"
        assert out["data"]["reverify"] == []
        reverify_pg.assert_not_called()
        reverify_stores.assert_not_called()
