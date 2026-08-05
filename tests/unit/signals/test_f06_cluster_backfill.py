"""F06 — signal cluster + backfill tests."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from eden.signals import backfill as bf
from eden.signals import clusterer as cl


class _FakePg:
    def __init__(self) -> None:
        self.executed: list[tuple[str, tuple[Any, ...]]] = []
        self._events: list[dict[str, Any]] = []

    async def fetch(self, sql: str, *args: Any) -> list[dict[str, Any]]:
        if "FROM signal_events" in sql and "matched = TRUE" in sql:
            return self._events
        if "DISTINCT trace_id" in sql and "telemetry_events" in sql:
            return [{"trace_id": f"t{i}"} for i in range(3)]
        if "signal_backfill_jobs" in sql and "status IN" in sql:
            return []
        return []

    async def execute(self, sql: str, *args: Any) -> str:
        self.executed.append((sql, args))
        return "UPDATE 1"

    async def executemany(self, sql: str, args_iter: Any) -> str:
        for row_args in args_iter:
            self.executed.append((sql, row_args))
        return "INSERT 0 1"

    async def fetchrow(self, sql: str, *args: Any) -> dict[str, Any] | None:
        if "COUNT(DISTINCT trace_id)" in sql:
            return {"n": 42}
        return None


def test_estimate_backfill_cost() -> None:
    assert bf.estimate_backfill_cost(100) == 1.0
    assert bf.estimate_backfill_cost(0) == 0.0


@pytest.mark.asyncio
async def test_enqueue_backfill_creates_job() -> None:
    pg = _FakePg()
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        with patch.object(bf, "count_traces_in_window", AsyncMock(return_value=10)):
            job = await bf.enqueue_backfill("org-1", str(uuid.uuid4()), window_days=7)
    assert job["traces_total"] == 10
    assert job["estimated_cost_usd"] == 0.1
    assert any("INSERT INTO signal_backfill_jobs" in sql for sql, _ in pg.executed)


@pytest.mark.asyncio
async def test_clusterer_groups_similar_events() -> None:
    pg = _FakePg()
    now = datetime.now(UTC)
    pg._events = [
        {
            "id": uuid.uuid4(),
            "trace_id": "t1",
            "payload": {"evidence": "user frustrated wrong answer"},
            "detected_at": now,
        },
        {
            "id": uuid.uuid4(),
            "trace_id": "t2",
            "payload": {"evidence": "user frustrated wrong answer again"},
            "detected_at": now - timedelta(hours=1),
        },
    ]
    clusterer = cl.SignalEventClusterer()
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        with patch.object(clusterer, "_embed", AsyncMock(return_value=[[1.0, 0.0], [0.99, 0.01]])):
            created = await clusterer.cluster_signal("org", str(uuid.uuid4()))
    assert created == 1
    assert any("INSERT INTO signal_clusters" in sql for sql, _ in pg.executed)


@pytest.mark.asyncio
async def test_resolve_quiet_clusters() -> None:
    pg = _FakePg()
    clusterer = cl.SignalEventClusterer()
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        n = await clusterer.resolve_quiet_clusters("org-1")
    assert n == 1


def test_token_hash_vector_reflects_real_token_overlap() -> None:
    """OPT-2: the embed fallback must track real text similarity, not the
    old whole-text hash noise that collapsed 88.7% of rows into one
    mega-cluster."""
    v_a = cl._token_hash_vector("the quick brown fox jumps over stuff")
    v_b = cl._token_hash_vector("the quick brown fox leaps over stuff")  # 5/6 tokens shared
    v_c = cl._token_hash_vector("completely unrelated database migration topic")

    sim_similar = cl._cosine(v_a, v_b)
    sim_different = cl._cosine(v_a, v_c)

    assert sim_similar > sim_different
    assert sim_similar >= 0.6


@pytest.mark.asyncio
async def test_embed_real_embedder_unavailable_logs_error_not_debug(caplog) -> None:
    """OPT-2: eden.kb.embeddings.get_default_embedder never existed, so this
    path always failed silently at debug level. It must now be loud
    (error-level) and must not silently fall back to hash-noise vectors."""
    clusterer = cl.SignalEventClusterer()
    with patch(
        "supplementaries.phase_3_loops.real_embeddings.get_singleton",
        side_effect=ModuleNotFoundError("no sentence_transformers"),
    ):
        with caplog.at_level(logging.DEBUG, logger="eden.signals.clusterer"):
            vectors = await clusterer._embed(["user hit rate limit error", "user hit rate limit again"])

    assert len(vectors) == 2
    assert all(len(v) == cl._EMBED_DIM for v in vectors)
    clusterer_records = [r for r in caplog.records if r.name == "eden.signals.clusterer"]
    assert any(r.levelno == logging.ERROR for r in clusterer_records)
    assert not any(r.levelno == logging.DEBUG for r in clusterer_records)
    # And the fallback vectors are real token-overlap vectors, not noise:
    # near-duplicate texts should score above the clustering threshold.
    assert cl._cosine(vectors[0], vectors[1]) >= cl._COSINE_THRESHOLD


@pytest.mark.asyncio
async def test_grouping_offloaded_to_thread_not_event_loop() -> None:
    """OPT-2: the O(n^2) grouping pass must run via asyncio.to_thread, not
    inline on the event loop."""
    pg = _FakePg()
    now = datetime.now(UTC)
    pg._events = [
        {
            "id": uuid.uuid4(),
            "trace_id": f"t{i}",
            "payload": {"evidence": "same evidence text"},
            "detected_at": now - timedelta(minutes=i),
        }
        for i in range(6)
    ]
    clusterer = cl.SignalEventClusterer()
    to_thread_calls: list[Any] = []
    real_to_thread = cl.asyncio.to_thread

    async def _tracking_to_thread(fn, *args, **kwargs):
        to_thread_calls.append(fn)
        return await real_to_thread(fn, *args, **kwargs)

    vectors = [[1.0, 0.0]] * len(pg._events)
    with patch("eden.storage.postgres.get_postgres_client", AsyncMock(return_value=pg)):
        with patch.object(clusterer, "_embed", AsyncMock(return_value=vectors)):
            with patch.object(cl.asyncio, "to_thread", _tracking_to_thread):
                created = await clusterer.cluster_signal("org", str(uuid.uuid4()))

    assert created == 1
    assert cl._group_by_similarity in to_thread_calls


@pytest.mark.asyncio
async def test_cluster_after_match_debounces_rapid_reruns(monkeypatch) -> None:
    """OPT-2 step 7: rapid repeated matches for the same org/signal must not
    each re-trigger a full clustering pass."""
    calls: list[tuple[str, str]] = []

    async def _fake_cluster_signal(self, org_id, signal_id, *, lookback_days=cl._LOOKBACK_DAYS):
        calls.append((org_id, signal_id))
        return 1

    monkeypatch.setattr(cl.SignalEventClusterer, "cluster_signal", _fake_cluster_signal)
    cl._last_cluster_run.clear()

    await cl.cluster_after_match("org-debounce", "sig-debounce")
    await cl.cluster_after_match("org-debounce", "sig-debounce")
    assert calls == [("org-debounce", "sig-debounce")]

    # A different signal is not debounced by the first one's timestamp.
    await cl.cluster_after_match("org-debounce", "sig-other")
    assert calls == [
        ("org-debounce", "sig-debounce"),
        ("org-debounce", "sig-other"),
    ]
