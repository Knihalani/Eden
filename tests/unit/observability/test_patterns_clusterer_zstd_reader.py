"""Phase 4 storage: PatternsClusterer must read request_body via its
zstd shadow when the plaintext column is NULL — the previous query
required ``request_body IS NOT NULL`` and read only the plaintext
column, which would silently stop finding any rows once
``telemetry_plaintext_jsonb_write_enabled`` flips to False.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.observability.patterns_clusterer import PatternsClusterer
from eden.storage.compression import compress_jsonb

TENANT = "org-1"


def _fake_settings():
    s = MagicMock()
    s.patterns_clusterer_enabled = True
    s.patterns_clusterer_lookback_days = 7
    # Low threshold so a couple of test rows clear the "enough topics
    # to bother clustering" gate without needing 20 fixture rows.
    s.patterns_clusterer_min_cluster_size = 1
    return s


class _StopAfterCaptureError(RuntimeError):
    """Raised deliberately once the embedder sees the extracted topics,
    so the test can assert on them without needing hdbscan/sklearn."""


@pytest.mark.asyncio
async def test_run_for_tenant_extracts_topic_from_zstd_when_plaintext_null():
    zstd_body = compress_jsonb(
        {"messages": [{"role": "user", "content": "how do I reset my password"}]}
    )
    rows = [
        {
            "event_id": "evt-1",
            "trace_id": "trace-1",
            "name": "llm.completion",
            "request_body": None,
            "request_body_zstd": zstd_body,
            "metrics": {},
            "attributes": {},
        },
    ]
    fake_client = MagicMock()
    fake_client.fetch = AsyncMock(return_value=rows)

    captured: dict[str, list[str]] = {}

    def _capture_and_stop(topics):
        captured["topics"] = list(topics)
        raise _StopAfterCaptureError("stop before real clustering")

    clusterer = PatternsClusterer()
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ),
        patch(
            "eden.observability.patterns_clusterer.get_settings",
            return_value=_fake_settings(),
        ),
        patch.object(
            clusterer, "_embed_topics", AsyncMock(side_effect=_capture_and_stop)
        ),
    ):
        created = await clusterer._run_for_tenant(TENANT)

    assert created == 0  # short-circuited by the deliberate raise
    assert captured["topics"] == ["how do I reset my password"]


@pytest.mark.asyncio
async def test_run_for_tenant_prefers_zstd_over_stale_plaintext():
    zstd_body = compress_jsonb(
        {"messages": [{"role": "user", "content": "fresh topic"}]}
    )
    rows = [
        {
            "event_id": "evt-1",
            "trace_id": "trace-1",
            "name": "llm.completion",
            "request_body": {"messages": [{"role": "user", "content": "stale topic"}]},
            "request_body_zstd": zstd_body,
            "metrics": {},
            "attributes": {},
        },
    ]
    fake_client = MagicMock()
    fake_client.fetch = AsyncMock(return_value=rows)
    captured: dict[str, list[str]] = {}

    def _capture_and_stop(topics):
        captured["topics"] = list(topics)
        raise _StopAfterCaptureError()

    clusterer = PatternsClusterer()
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ),
        patch(
            "eden.observability.patterns_clusterer.get_settings",
            return_value=_fake_settings(),
        ),
        patch.object(
            clusterer, "_embed_topics", AsyncMock(side_effect=_capture_and_stop)
        ),
    ):
        await clusterer._run_for_tenant(TENANT)

    assert captured["topics"] == ["fresh topic"]


@pytest.mark.asyncio
async def test_run_for_tenant_query_matches_zstd_only_rows():
    """The SQL WHERE clause must not exclude rows that only have
    request_body_zstd populated (plaintext write disabled)."""
    fake_client = MagicMock()
    fake_client.fetch = AsyncMock(return_value=[])

    clusterer = PatternsClusterer()
    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ),
        patch(
            "eden.observability.patterns_clusterer.get_settings",
            return_value=_fake_settings(),
        ),
    ):
        await clusterer._run_for_tenant(TENANT)

    sql = fake_client.fetch.await_args.args[0]
    assert "request_body_zstd" in sql
    assert "request_body_zstd IS NOT NULL" in sql
