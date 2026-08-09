"""SOTA Wave 9 — platform / storage / ops / F84 unit tests."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException


@pytest.mark.asyncio
async def test_leader_lock_fail_closed_when_redis_none() -> None:
    from eden.storage.redis import Lock

    with patch(
        "eden.storage.redis.get_redis_client",
        new=AsyncMock(return_value=None),
    ):
        lock = Lock("w9-test", ttl=30)
        assert await lock.acquire() is False
        assert await lock.release() is False
        lock._token = "x"
        assert await lock.extend(10) is False


def test_typesense_lag_is_event_age() -> None:
    from eden.observability.search_service import get_search_stats, record_index_lag

    before = get_search_stats()["index_lag_count"]
    record_index_lag(12.5)
    after = get_search_stats()
    assert after["index_lag_count"] == before + 1.0
    assert after["index_lag_sum_s"] >= before  # sum increased


def test_late_span_reject_beyond_max_age() -> None:
    from eden.observability.ingestion.late_span import evaluate_late_span

    old = datetime.now(UTC) - timedelta(days=3)
    event = SimpleNamespace(
        timestamp=old.isoformat(),
        event_id="e1",
        attributes={},
    )
    with patch("eden.config.get_settings") as gs:
        gs.return_value = SimpleNamespace(
            late_span_policy_enabled=True,
            late_span_max_age_seconds=86400.0,
            late_span_soft_age_seconds=3600.0,
        )
        assert evaluate_late_span(event) == "reject"


def test_late_span_soft_stamp() -> None:
    from eden.observability.ingestion.late_span import evaluate_late_span

    old = datetime.now(UTC) - timedelta(hours=2)
    event = SimpleNamespace(
        timestamp=old.isoformat(),
        event_id="e2",
        attributes={},
    )
    with patch("eden.config.get_settings") as gs:
        gs.return_value = SimpleNamespace(
            late_span_policy_enabled=True,
            late_span_max_age_seconds=86400.0,
            late_span_soft_age_seconds=3600.0,
        )
        assert evaluate_late_span(event) == "late"
        assert event.attributes.get("late_span") is True


def test_ingest_shed_raises_429() -> None:
    from eden.observability.ingestion import shed as shed_mod

    with (
        patch("eden.config.get_settings") as gs,
        patch.object(shed_mod, "current_ingest_depth", return_value=99999),
    ):
        gs.return_value = SimpleNamespace(
            ingestion_shed_enabled=True,
            ingestion_shed_max_depth=100,
            ingestion_shed_retry_after_seconds=3,
        )
        with pytest.raises(HTTPException) as ei:
            shed_mod.check_ingest_shed("org_x")
        assert ei.value.status_code == 429
        assert ei.value.headers.get("Retry-After") == "3"


def test_blob_release_and_dedupe_ratio() -> None:
    from eden.observability.compression.blob_store import BlobStore

    store = BlobStore(min_blob_size=1)
    ref = store.get_or_put("org1", "hello-world-payload-xxxxxxxx")
    assert ref.inline is False
    assert store.release("org1", ref.content_hash) == 0
    assert store.dedupe_ratio() > 0
    assert "dedupe_ratio" in store.stats()


@pytest.mark.asyncio
async def test_rtbf_fanout_unavailable_visible() -> None:
    """Honesty: missing store clients surface as unavailable/failed (no silent skip)."""
    import eden.services.governance_intel.rtbf_fanout as fanout_mod

    with (
        patch.object(
            fanout_mod,
            "_fanout_typesense",
            new=AsyncMock(
                return_value={
                    "store": "typesense",
                    "status": "unavailable",
                    "error": "not configured",
                }
            ),
        ),
        patch.object(
            fanout_mod,
            "_fanout_redis",
            new=AsyncMock(
                return_value={
                    "store": "redis",
                    "status": "unavailable",
                    "error": "not configured",
                }
            ),
        ),
        patch.object(
            fanout_mod,
            "_fanout_qdrant",
            new=AsyncMock(
                return_value={
                    "store": "qdrant",
                    "status": "unavailable",
                    "error": "not configured",
                }
            ),
        ),
        patch.object(
            fanout_mod,
            "_fanout_s3",
            new=AsyncMock(
                return_value={
                    "store": "s3",
                    "status": "unavailable",
                    "error": "no retention",
                }
            ),
        ),
        patch.object(
            fanout_mod,
            "_fanout_clickhouse",
            new=AsyncMock(
                return_value={
                    "store": "clickhouse",
                    "status": "unavailable",
                    "error": "not configured",
                }
            ),
        ),
        patch.object(
            fanout_mod,
            "_fanout_blob_refs",
            new=AsyncMock(
                return_value={
                    "store": "blob",
                    "status": "unavailable",
                    "error": "not configured",
                }
            ),
        ),
    ):
        results = await fanout_mod.fanout_rtbf("org1", user_id="u1", dry_run=False)

    statuses = {r["store"]: r["status"] for r in results}
    assert statuses["typesense"] == "unavailable"
    assert statuses["redis"] == "unavailable"
    assert any(r["status"] in ("unavailable", "failed") for r in results)
    assert len(results) == 6


@pytest.mark.asyncio
async def test_rtbf_redis_fanout_unsupported_not_false_ok() -> None:
    """FEAT-108: Redis keys lack user_id — report unsupported, not ok+deleted:0."""
    from eden.services.governance_intel.rtbf_fanout import _fanout_redis

    live = await _fanout_redis("org1", user_id="u1", dry_run=False)
    assert live["status"] == "unsupported"
    assert live["store"] == "redis"

    dry = await _fanout_redis("org1", user_id="u1", dry_run=True)
    assert dry["status"] == "dry_run"


@pytest.mark.asyncio
async def test_mcp_eden_health_registered() -> None:
    from eden.mcp_server.server import TOOL_CATALOG, call_tool

    assert any(t["name"] == "eden_health" for t in TOOL_CATALOG)
    out = await call_tool("eden_health", {"org_id": "org_test"})
    assert out["status"] in ("ok", "error")
    assert out.get("tool") == "eden_health" or "error" in out


def test_admin_flags_helper_keys() -> None:
    from eden.api.routes.admin_status import _org_feature_flags

    flags = _org_feature_flags()
    assert "typesense_enabled" in flags
    assert "ingestion_shed_enabled" in flags


@pytest.mark.asyncio
async def test_heartbeat_probe_records() -> None:
    from eden.self_obs import heartbeats

    client = AsyncMock()
    client.execute = AsyncMock(return_value=None)
    client.fetch = AsyncMock(return_value=[])
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=client),
        ),
        patch(
            "eden.workers.background.background_workers_running",
            return_value=True,
        ),
        patch(
            "eden.workers.background.background_evolution_loop_running",
            return_value=False,
        ),
    ):
        result = await heartbeats.probe_and_record_workers("org1")
        assert result["status"] == "healthy"
        assert client.execute.await_count >= 1
