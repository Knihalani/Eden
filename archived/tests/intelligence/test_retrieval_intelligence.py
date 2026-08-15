"""Behavioural tests for Cat 4 — Retrieval Intelligence.

Exercises the four real services
(:class:`RetrievalUtilizationScorer`,
:class:`KnowledgeGapDetector`, :class:`ChunkAttribution`,
:class:`RetrievalReorderer`) and the four routes that expose
them, plus the package-contract tests and the envelope helper
tests.

Mirrors the structure of
:mod:`tests.intelligence.test_cost_intelligence` and
:mod:`tests.intelligence.test_root_cause_incidents`:

* **Service-level unit tests** — call the service classes
  directly with a mocked Postgres client. The
  :func:`patch_postgres` autouse fixture in :mod:`tests.conftest`
  returns an empty ``fetch()`` by default, which gives the
  services a clean "no data" path. Tests that need data
  override the mock with a side-effect that matches the SQL
  fragment the service runs.

* **Route-level smoke tests** — a minimal :class:`FastAPI` app
  with the ``intelligence_retrieval`` router mounted and
  ``get_current_user`` overridden. We hit each of the 4 Cat 4
  routes and assert the response shape.
"""

from __future__ import annotations

import importlib
from datetime import UTC, datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

# ─── Sample row builders ─────────────────────────────────────────────


def _retrieval_log_row(
    *,
    job_id: str = "trace-1",
    agent_id: str = "agent-1",
    collection: str = "support_kb",
    query_hash: str = "qh-1",
    query_text: str = "shipping policy",
    retrieved_item_ids: list[str] | None = None,
    created_at: datetime | None = None,
) -> dict[str, Any]:
    """One row from the ``retrieval_logs`` table."""
    if retrieved_item_ids is None:
        retrieved_item_ids = ["c1", "c2", "c3"]
    if created_at is None:
        created_at = datetime(2026, 6, 1, 12, 0, 0, tzinfo=UTC)
    return {
        "id": f"rl-{job_id}-{query_hash}",
        "job_id": job_id,
        "agent_id": agent_id,
        "collection": collection,
        "query_hash": query_hash,
        "query_text": query_text,
        "retrieved_item_ids": list(retrieved_item_ids),
        "retrieval_method": "vector",
        "filter_conditions": None,
        "score_threshold": 0.7,
        "retrieval_latency_ms": 25.0,
        "created_at": created_at,
    }


def _response_body_row(
    *,
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """One row from the ``telemetry_events.response_body`` query."""
    if body is None:
        body = {"text": "Default answer text."}
    return {"response_body": body}


def _util_score_row(
    *,
    trace_id: str = "trace-1",
    chunk_id: str = "c1",
    utilized: bool = True,
    score: float = 0.9,
) -> dict[str, Any]:
    """One row from the ``retrieval_utilization_scores`` table."""
    return {
        "trace_id": trace_id,
        "chunk_id": chunk_id,
        "utilized": utilized,
        "score": score,
    }


def _util_agg_row(
    *,
    trace_id: str = "trace-1",
    util_rate: float = 0.8,
    n: int = 4,
) -> dict[str, Any]:
    """One row from the per-trace utilization aggregation."""
    return {
        "trace_id": trace_id,
        "util_rate": float(util_rate),
        "n": int(n),
    }


# ─── Postgres query-routing mock helper ──────────────────────────────


def _pg_router(
    *,
    retrieval_logs_by_job: list[dict[str, Any]] | None = None,
    retrieval_logs_fallback: list[dict[str, Any]] | None = None,
    retrieval_logs_in_window: list[dict[str, Any]] | None = None,
    response_body: dict[str, Any] | None = None,
    response_body_missing: bool = False,
    util_history: list[dict[str, Any]] | None = None,
    util_agg: list[dict[str, Any]] | None = None,
) -> MagicMock:
    """Build a MagicMock Postgres client whose ``fetch`` and
    ``fetchrow`` route to different returns based on the SQL
    fragment. Defaults to empty lists so a missing branch
    returns "no data"."""
    pg = MagicMock()
    pg.fetch = AsyncMock(
        side_effect=lambda sql, *a, **kw: _route_fetch(
            sql,
            retrieval_logs_by_job,
            retrieval_logs_fallback,
            retrieval_logs_in_window,
            response_body,
            response_body_missing,
            util_history,
            util_agg,
        )
    )
    pg.fetchrow = AsyncMock(return_value=None)
    pg.execute = AsyncMock(return_value="OK")
    return pg


def _route_fetch(
    sql: str,
    rl_by_job,
    rl_fallback,
    rl_in_window,
    response_body,
    response_body_missing,
    util_history,
    util_agg,
) -> list[dict[str, Any]]:
    # Response body query — has ``response_body`` and
    # ``telemetry_events`` and ``trace_id = $2`` and no GROUP BY
    if "telemetry_events" in sql and "response_body" in sql:
        if response_body_missing:
            return []
        return [_response_body_row(body=response_body)]
    # Utilization aggregation — has AVG(CASE WHEN utilized...)
    # and GROUP BY trace_id. Distinguished from util_history by
    # the AVG aggregate.
    if "AVG(CASE WHEN utilized" in sql:
        return list(util_agg or [])
    # Utilization history — has retrieval_utilization_scores
    # and no GROUP BY
    if "retrieval_utilization_scores" in sql and "GROUP BY" not in sql:
        return list(util_history or [])
    # Retrieval logs for collection — has collection = $2
    if "retrieval_logs" in sql and "collection = $2" in sql:
        return list(rl_in_window or [])
    # Retrieval logs by job_id — has job_id = $2 and no
    # collection = $2. ORDER BY created_at ASC
    if (
        "retrieval_logs" in sql
        and "job_id = $2" in sql
        and "ORDER BY created_at ASC" in sql
    ):
        return list(rl_by_job or [])
    # Retrieval logs fallback (recent 5 min) — has $2::text
    # || ' seconds'
    if "retrieval_logs" in sql and "|| ' seconds'" in sql:
        return list(rl_fallback or [])
    # Retrieval logs in window — has retrieval_logs and
    # $2::interval and no job_id = $2
    if "retrieval_logs" in sql and "$2::interval" in sql:
        return list(rl_in_window or [])
    return []


# ─── 1. RetrievalUtilizationScorer ───────────────────────────────────


class TestRetrievalUtilizationScorer:
    @pytest.mark.asyncio
    async def test_no_retrieval_logs_returns_empty_envelope(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel.utilization import RetrievalUtilizationScorer

        pg = _pg_router()
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.kb.retrieval_intel.utilization._delete_then_insert_utilization",
            new=AsyncMock(),
        ) as persist:
            result = await RetrievalUtilizationScorer().score(
                "org_test", "trace-empty"
            )
        assert result["status"] == "ok"
        assert result["data"]["retrieved"] == 0
        assert result["data"]["actually_used"] == 0
        assert result["data"]["by_chunk"] == []
        assert result["data"]["message"] == "no retrieval logs"
        persist.assert_not_called()

    @pytest.mark.asyncio
    async def test_chunk_id_in_answer_marked_used_with_high_score(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel.utilization import RetrievalUtilizationScorer

        # Use distinct synthetic ids with no shared tokens.
        # The "abc" id is mentioned verbatim in the answer;
        # the "qrs" id is not, and shares no tokens.
        logs = [
            _retrieval_log_row(
                retrieved_item_ids=["alpha123", "zulu999"],
            )
        ]
        # The answer mentions "alpha123" verbatim. "zulu999"
        # shares no tokens with the answer, so it stays
        # unused.
        body = {"text": "I used alpha123 to answer this."}
        pg = _pg_router(retrieval_logs_by_job=logs, response_body=body)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.kb.retrieval_intel.utilization._delete_then_insert_utilization",
            new=AsyncMock(),
        ) as persist:
            result = await RetrievalUtilizationScorer().score(
                "org_test", "trace-1"
            )
        assert result["status"] == "ok"
        by_chunk = result["data"]["by_chunk"]
        assert len(by_chunk) == 2
        a = next(c for c in by_chunk if c["chunk_id"] == "alpha123")
        z = next(c for c in by_chunk if c["chunk_id"] == "zulu999")
        assert a["used"] is True
        assert a["score"] == 0.9
        assert a["retrieved"] is True
        # z: no chunk-id substring match, no token overlap
        # → used=False with score 0.0.
        assert z["used"] is False
        assert z["score"] == 0.0
        assert result["data"]["actually_used"] == 1
        assert result["data"]["retrieved"] == 2
        # Utilization rate: 1/2
        assert result["data"]["utilization_rate"] == pytest.approx(0.5)
        # Persistence was called with 2 rows.
        persist.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_no_answer_text_returns_zero_confidence(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel.utilization import RetrievalUtilizationScorer

        logs = [_retrieval_log_row(retrieved_item_ids=["c1", "c2"])]
        pg = _pg_router(
            retrieval_logs_by_job=logs,
            response_body_missing=True,
        )
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.kb.retrieval_intel.utilization._delete_then_insert_utilization",
            new=AsyncMock(),
        ):
            result = await RetrievalUtilizationScorer().score(
                "org_test", "trace-1"
            )
        assert result["status"] == "ok"
        for c in result["data"]["by_chunk"]:
            assert c["used"] is False
            assert c["score"] == 0.0
        assert "no answer text" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_falls_back_to_recent_logs_when_no_job_id_match(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel.utilization import RetrievalUtilizationScorer

        fallback_logs = [
            _retrieval_log_row(
                job_id="job-other",
                retrieved_item_ids=["chunk-fb"],
            )
        ]
        pg = _pg_router(
            retrieval_logs_by_job=[],
            retrieval_logs_fallback=fallback_logs,
            response_body={"text": "fallback path"},
        )
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.kb.retrieval_intel.utilization._delete_then_insert_utilization",
            new=AsyncMock(),
        ):
            result = await RetrievalUtilizationScorer().score(
                "org_test", "trace-unknown"
            )
        assert result["status"] == "ok"
        by_chunk = result["data"]["by_chunk"]
        assert len(by_chunk) == 1
        assert by_chunk[0]["chunk_id"] == "chunk-fb"

    @pytest.mark.asyncio
    async def test_dedups_chunks_across_multiple_logs(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel.utilization import RetrievalUtilizationScorer

        logs = [
            _retrieval_log_row(
                job_id="trace-1",
                query_hash="qh-1",
                retrieved_item_ids=["c1", "c2"],
            ),
            _retrieval_log_row(
                job_id="trace-1",
                query_hash="qh-2",
                retrieved_item_ids=["c2", "c3"],
            ),
        ]
        pg = _pg_router(retrieval_logs_by_job=logs, response_body={"text": "x"})
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.kb.retrieval_intel.utilization._delete_then_insert_utilization",
            new=AsyncMock(),
        ):
            result = await RetrievalUtilizationScorer().score(
                "org_test", "trace-1"
            )
        ids = [c["chunk_id"] for c in result["data"]["by_chunk"]]
        # c2 appears in both → dedup'd
        assert ids == ["c1", "c2", "c3"]
        assert result["data"]["retrieved"] == 3


# ─── 2. KnowledgeGapDetector ─────────────────────────────────────────


class TestKnowledgeGapDetector:
    @pytest.mark.asyncio
    async def test_no_retrieval_logs_returns_empty(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel.utilization import KnowledgeGapDetector

        pg = _pg_router()
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.kb.retrieval_intel.utilization._delete_then_insert_gaps",
            new=AsyncMock(),
        ) as persist:
            result = await KnowledgeGapDetector().detect(
                "org_test", window="7d"
            )
        assert result["status"] == "ok"
        assert result["data"]["gaps"] == []
        assert result["data"]["patterns_observed"] == 0
        assert result["data"]["message"] == "no retrieval logs"
        persist.assert_not_called()

    @pytest.mark.asyncio
    async def test_groups_by_query_hash(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel.utilization import KnowledgeGapDetector

        # 2 distinct query patterns: shipping & returns. Both
        # below the utilization threshold (0.3) — both
        # should be flagged. The default ``_retrieval_log_row``
        # has ``job_id="trace-1"``; the utilization row is
        # keyed on the same trace_id so the per-pattern
        # lookup matches.
        logs = [
            _retrieval_log_row(query_hash="qh-shipping", query_text="shipping"),
            _retrieval_log_row(query_hash="qh-shipping", query_text="shipping"),
            _retrieval_log_row(query_hash="qh-shipping", query_text="shipping"),
            _retrieval_log_row(query_hash="qh-returns", query_text="returns"),
            _retrieval_log_row(query_hash="qh-returns", query_text="returns"),
            _retrieval_log_row(query_hash="qh-returns", query_text="returns"),
        ]
        util_agg = [
            _util_agg_row(trace_id="trace-1", util_rate=0.1, n=6),
        ]
        pg = _pg_router(retrieval_logs_in_window=logs, util_agg=util_agg)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.kb.retrieval_intel.utilization._delete_then_insert_gaps",
            new=AsyncMock(),
        ) as persist:
            result = await KnowledgeGapDetector().detect(
                "org_test", window="7d"
            )
        assert result["status"] == "ok"
        assert result["data"]["patterns_observed"] == 2
        assert result["data"]["gaps_flagged"] == 2
        gap_patterns = sorted(g["query_pattern"] for g in result["data"]["gaps"])
        assert gap_patterns == ["returns", "shipping"]
        # Each gap has the right shape.
        for g in result["data"]["gaps"]:
            assert g["hit_rate"] == 1.0
            assert g["utilization"] == pytest.approx(0.1)
            assert g["sample_size"] == 3
            assert g["suggested_action"] == "add_kb_entries"
        persist.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_skips_patterns_below_min_sample_size(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel.utilization import KnowledgeGapDetector

        # 1 query hash with only 1 sample — below MIN_GAP_SAMPLE_SIZE (3)
        logs = [_retrieval_log_row(query_hash="qh-rare", query_text="rare")]
        util_agg = [_util_agg_row(trace_id="trace-1", util_rate=0.1, n=1)]
        pg = _pg_router(retrieval_logs_in_window=logs, util_agg=util_agg)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.kb.retrieval_intel.utilization._delete_then_insert_gaps",
            new=AsyncMock(),
        ):
            result = await KnowledgeGapDetector().detect(
                "org_test", window="7d"
            )
        assert result["data"]["gaps"] == []
        assert result["data"]["gaps_flagged"] == 0

    @pytest.mark.asyncio
    async def test_does_not_flag_high_utilization(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel.utilization import KnowledgeGapDetector

        logs = [
            _retrieval_log_row(query_hash="qh-ok", query_text="ok")
            for _ in range(5)
        ]
        util_agg = [_util_agg_row(trace_id="trace-1", util_rate=0.95, n=5)]
        pg = _pg_router(retrieval_logs_in_window=logs, util_agg=util_agg)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.kb.retrieval_intel.utilization._delete_then_insert_gaps",
            new=AsyncMock(),
        ):
            result = await KnowledgeGapDetector().detect(
                "org_test", window="7d"
            )
        assert result["data"]["gaps"] == []
        assert result["data"]["gaps_flagged"] == 0

    @pytest.mark.asyncio
    async def test_invalid_window_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel.utilization import KnowledgeGapDetector

        result = await KnowledgeGapDetector().detect(
            "org_test", window="not-a-window"
        )
        assert result["status"] == "bad_request"
        assert "window" in result["data"]["message"]
        assert result["live"] is True

    @pytest.mark.asyncio
    async def test_sorts_gaps_by_sample_size_desc(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel.utilization import KnowledgeGapDetector

        # 10 of "shipping" (sample_size=10) and 4 of "returns"
        # (sample_size=4). Both have low utilization. shipping
        # should come first.
        logs = (
            [_retrieval_log_row(query_hash="qh-shipping", query_text="shipping")]
            * 10
            + [_retrieval_log_row(query_hash="qh-returns", query_text="returns")]
            * 4
        )
        util_agg = [_util_agg_row(trace_id="trace-1", util_rate=0.1, n=14)]
        pg = _pg_router(retrieval_logs_in_window=logs, util_agg=util_agg)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg), patch(
            "eden.kb.retrieval_intel.utilization._delete_then_insert_gaps",
            new=AsyncMock(),
        ):
            result = await KnowledgeGapDetector().detect(
                "org_test", window="7d"
            )
        gaps = result["data"]["gaps"]
        assert gaps[0]["query_pattern"] == "shipping"
        assert gaps[0]["sample_size"] == 10
        assert gaps[1]["query_pattern"] == "returns"
        assert gaps[1]["sample_size"] == 4


# ─── 3. ChunkAttribution ─────────────────────────────────────────────


class TestChunkAttribution:
    @pytest.mark.asyncio
    async def test_no_retrieval_logs_returns_empty(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel.utilization import ChunkAttribution

        pg = _pg_router()
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await ChunkAttribution().attribution("org_test", "trace-x")
        assert result["status"] == "ok"
        assert result["data"]["by_chunk"] == []
        assert result["data"]["message"] == "no retrieval logs"

    @pytest.mark.asyncio
    async def test_chunk_id_in_answer_gets_full_attribution(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel.utilization import ChunkAttribution

        logs = [_retrieval_log_row(retrieved_item_ids=["chunk-A", "chunk-B"])]
        body = {"text": "I used chunk-A extensively to answer."}
        pg = _pg_router(retrieval_logs_by_job=logs, response_body=body)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await ChunkAttribution().attribution("org_test", "trace-1")
        assert result["status"] == "ok"
        by_chunk = result["data"]["by_chunk"]
        assert len(by_chunk) == 2
        scores = {c["chunk_id"]: c["contribution_score"] for c in by_chunk}
        # Both raw scores are 1.0 (chunk-A: substring match;
        # chunk-B: token overlap of the surrogate text is > 0).
        # After normalisation they sum to 1.0.
        total = sum(scores.values())
        assert total == pytest.approx(1.0, abs=1e-4)
        # chunk-A wins because its raw contribution includes
        # the substring boost (1.0 vs 0.2 * overlap for
        # chunk-B).
        assert scores["chunk-A"] > scores["chunk-B"]

    @pytest.mark.asyncio
    async def test_attribution_is_deterministic(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel.utilization import ChunkAttribution

        logs = [_retrieval_log_row(retrieved_item_ids=["c1", "c2", "c3"])]
        body = {"text": "I used c1 and c2 to answer the user's question."}
        pg1 = _pg_router(retrieval_logs_by_job=logs, response_body=body)
        pg2 = _pg_router(retrieval_logs_by_job=logs, response_body=body)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg1):
            r1 = await ChunkAttribution().attribution("org_test", "trace-1")
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg2):
            r2 = await ChunkAttribution().attribution("org_test", "trace-1")
        s1 = [c["contribution_score"] for c in r1["data"]["by_chunk"]]
        s2 = [c["contribution_score"] for c in r2["data"]["by_chunk"]]
        assert s1 == s2

    @pytest.mark.asyncio
    async def test_single_chunk_attribution_is_one(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel.utilization import ChunkAttribution

        logs = [_retrieval_log_row(retrieved_item_ids=["only-chunk"])]
        pg = _pg_router(
            retrieval_logs_by_job=logs,
            response_body={"text": "no answer at all"},
        )
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await ChunkAttribution().attribution("org_test", "trace-1")
        by_chunk = result["data"]["by_chunk"]
        assert len(by_chunk) == 1
        # Single-chunk edge case: attribution is 1.0
        # regardless of the (missing) signal.
        assert by_chunk[0]["contribution_score"] == 1.0

    @pytest.mark.asyncio
    async def test_no_answer_text_uniform_split(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel.utilization import ChunkAttribution

        logs = [_retrieval_log_row(retrieved_item_ids=["a", "b", "c"])]
        pg = _pg_router(
            retrieval_logs_by_job=logs,
            response_body_missing=True,
        )
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await ChunkAttribution().attribution("org_test", "trace-1")
        by_chunk = result["data"]["by_chunk"]
        assert len(by_chunk) == 3
        for c in by_chunk:
            assert c["contribution_score"] == pytest.approx(1.0 / 3.0, abs=1e-4)
        assert "uniform" in result["data"]["message"]


# ─── 4. RetrievalReorderer ───────────────────────────────────────────


class TestRetrievalReorderer:
    @pytest.mark.asyncio
    async def test_no_retrieval_logs_returns_empty(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel.utilization import RetrievalReorderer

        pg = _pg_router()
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await RetrievalReorderer().suggest(
                "org_test", collection="support_kb"
            )
        assert result["status"] == "ok"
        assert result["data"]["suggested_order"] == []
        assert result["data"]["message"] == "no retrieval logs"

    @pytest.mark.asyncio
    async def test_orders_by_composite_score(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel.utilization import RetrievalReorderer

        # chunk-A: retrieved 5 times, util rate 1.0 → composite
        # 0.7*1.0 + 0.3*1.0 = 1.0 (top).
        # chunk-B: retrieved 5 times, util rate 0.0 → composite
        # 0.7*0.0 + 0.3*1.0 = 0.3.
        # chunk-C: retrieved 1 time, no util → composite
        # 0.7*0.0 + 0.3*0.2 = 0.06 (last).
        logs = (
            [_retrieval_log_row(retrieved_item_ids=["chunk-A", "chunk-B"])] * 5
            + [_retrieval_log_row(retrieved_item_ids=["chunk-C"])]
        )
        util_history = [
            _util_score_row(chunk_id="chunk-A", utilized=True, score=0.9),
            _util_score_row(chunk_id="chunk-A", utilized=True, score=0.9),
            _util_score_row(chunk_id="chunk-A", utilized=True, score=0.9),
            _util_score_row(chunk_id="chunk-A", utilized=True, score=0.9),
            _util_score_row(chunk_id="chunk-A", utilized=True, score=0.9),
            _util_score_row(chunk_id="chunk-B", utilized=False, score=0.0),
            _util_score_row(chunk_id="chunk-B", utilized=False, score=0.0),
            _util_score_row(chunk_id="chunk-B", utilized=False, score=0.0),
            _util_score_row(chunk_id="chunk-B", utilized=False, score=0.0),
            _util_score_row(chunk_id="chunk-B", utilized=False, score=0.0),
        ]
        pg = _pg_router(retrieval_logs_in_window=logs, util_history=util_history)
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await RetrievalReorderer().suggest(
                "org_test", collection="support_kb"
            )
        assert result["status"] == "ok"
        order = result["data"]["suggested_order"]
        # A is first; C is last; B is in the middle.
        assert order[0] == "chunk-A"
        assert order[-1] == "chunk-C"
        assert "chunk-B" in order

    @pytest.mark.asyncio
    async def test_tiebreak_by_chunk_id_asc(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel.utilization import RetrievalReorderer

        # All three chunks retrieved once, no util history →
        # composite = 0.0 + 0.3 * 1/N → tie. The deterministic
        # tiebreak is by chunk_id asc.
        logs = [_retrieval_log_row(retrieved_item_ids=["zzz", "aaa", "mmm"])]
        pg = _pg_router(retrieval_logs_in_window=logs, util_history=[])
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await RetrievalReorderer().suggest(
                "org_test", collection="support_kb"
            )
        order = result["data"]["suggested_order"]
        assert order == ["aaa", "mmm", "zzz"]

    @pytest.mark.asyncio
    async def test_empty_collection_returns_bad_request(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel.utilization import RetrievalReorderer

        result = await RetrievalReorderer().suggest(
            "org_test", collection="   "
        )
        assert result["status"] == "bad_request"
        assert "collection" in result["data"]["message"]

    @pytest.mark.asyncio
    async def test_caps_suggested_order(
        self, mock_postgres_client: MagicMock
    ) -> None:
        from eden.kb.retrieval_intel import _common
        from eden.kb.retrieval_intel.utilization import RetrievalReorderer

        # 250 unique chunks, all retrieved once.
        chunk_ids = [f"chunk-{i:04d}" for i in range(250)]
        logs = [_retrieval_log_row(retrieved_item_ids=chunk_ids)]
        pg = _pg_router(retrieval_logs_in_window=logs, util_history=[])
        # MAX_REORDER_ITEMS is module-level — assert it before
        # calling the service so a future change to the cap
        # doesn't silently invalidate the assertion.
        assert _common.MAX_REORDER_ITEMS == 200
        with patch("eden.storage.postgres.get_postgres_client", return_value=pg):
            result = await RetrievalReorderer().suggest(
                "org_test", collection="support_kb"
            )
        order = result["data"]["suggested_order"]
        assert len(order) == 200
        assert result["data"]["chunks_observed"] == 250


# ─── 5. Envelope helpers ─────────────────────────────────────────────


class TestEnvelopeHelpers:
    def test_ok_envelope_shape(self) -> None:
        from eden.kb.retrieval_intel._common import _ok_envelope

        env = _ok_envelope("retrieval_utilization", {"x": 1})
        assert env["status"] == "ok"
        assert env["feature"] == "retrieval_utilization"
        assert env["live"] is True
        assert env["trace_id"].startswith("ri_")
        assert env["data"] == {"x": 1}
        assert "timestamp" in env

    def test_bad_request_envelope_shape(self) -> None:
        from eden.kb.retrieval_intel._common import _bad_request_envelope

        env = _bad_request_envelope("retrieval_utilization", "bad input")
        assert env["status"] == "bad_request"
        assert env["feature"] == "retrieval_utilization"
        assert env["live"] is True
        assert env["data"]["message"] == "bad input"

    def test_real_response_never_has_live_false(self) -> None:
        """Sanity check: a real response never has ``live: false``."""
        from eden.kb.retrieval_intel._common import _bad_request_envelope, _ok_envelope

        for env in (
            _ok_envelope("retrieval_utilization", {}),
            _bad_request_envelope("retrieval_utilization", "x"),
        ):
            assert env["live"] is True

    def test_parse_window(self) -> None:
        from eden.kb.retrieval_intel._common import _parse_window

        assert _parse_window("7d") == "7 days"
        assert _parse_window("24h") == "24 hours"
        assert _parse_window("60m") == "60 minutes"
        assert _parse_window("30s") == "30 seconds"
        # Whitespace tolerated
        assert _parse_window("  5d  ") == "5 days"
        # None / empty → default
        assert _parse_window(None) == "7 days"
        assert _parse_window("") == "7 days"
        # Bad input → None
        assert _parse_window("not-a-window") is None
        assert _parse_window("7") is None


# ─── 6. Text heuristics ──────────────────────────────────────────────


class TestTextHeuristics:
    def test_tokenize_lowercases_and_dedupes(self) -> None:
        from eden.kb.retrieval_intel._common import _tokenize

        toks = _tokenize("The cat sat on the mat.")
        assert "the" in toks
        assert "cat" in toks
        assert "mat" in toks
        # Punctuation stripped
        assert "mat." not in toks
        # Case-folded
        assert "The" not in toks
        # Deduped
        assert toks == set(toks)

    def test_tokenize_empty(self) -> None:
        from eden.kb.retrieval_intel._common import _tokenize

        assert _tokenize("") == set()
        assert _tokenize("   !!!  ") == set()

    def test_token_overlap_jaccard(self) -> None:
        from eden.kb.retrieval_intel._common import _token_overlap

        # Identical → 1.0
        assert _token_overlap("hello world", "hello world") == 1.0
        # Disjoint → 0.0
        assert _token_overlap("hello", "world") == 0.0
        # Partial: {hello, world} ∩ {hello, there} = {hello} → 1/3
        assert _token_overlap("hello world", "hello there") == pytest.approx(
            1.0 / 3.0
        )
        # Empty → 0.0
        assert _token_overlap("", "hello") == 0.0
        assert _token_overlap("hello", "") == 0.0

    def test_normalise_attributions_sums_to_one(self) -> None:
        from eden.kb.retrieval_intel._common import _normalise_attributions

        out = _normalise_attributions([0.5, 0.3, 0.2])
        assert sum(out) == pytest.approx(1.0)
        # Order preserved
        assert out[0] > out[1] > out[2]

    def test_normalise_attributions_single_chunk(self) -> None:
        from eden.kb.retrieval_intel._common import _normalise_attributions

        assert _normalise_attributions([0.7]) == [1.0]
        assert _normalise_attributions([0.0]) == [1.0]
        assert _normalise_attributions([]) == []

    def test_normalise_attributions_all_zero_uniform(self) -> None:
        from eden.kb.retrieval_intel._common import _normalise_attributions

        out = _normalise_attributions([0.0, 0.0, 0.0])
        assert sum(out) == pytest.approx(1.0)
        for v in out:
            assert v == pytest.approx(1.0 / 3.0)

    def test_normalise_attributions_clips_negatives(self) -> None:
        from eden.kb.retrieval_intel._common import _normalise_attributions

        # Negative raw scores clip to 0 before normalisation.
        out = _normalise_attributions([0.5, -0.3, 0.2])
        assert sum(out) == pytest.approx(1.0)
        assert all(v >= 0 for v in out)


# ─── 7. Package contract ─────────────────────────────────────────────


class TestPackageContract:
    def test_lazy_re_exports(self) -> None:
        from eden.kb import retrieval_intel

        assert hasattr(retrieval_intel, "RetrievalUtilizationScorer")
        assert hasattr(retrieval_intel, "KnowledgeGapDetector")
        assert hasattr(retrieval_intel, "ChunkAttribution")
        assert hasattr(retrieval_intel, "RetrievalReorderer")

    def test_dir_shows_public_surface(self) -> None:
        from eden.kb import retrieval_intel

        names = dir(retrieval_intel)
        for expected in (
            "RetrievalUtilizationScorer",
            "KnowledgeGapDetector",
            "ChunkAttribution",
            "RetrievalReorderer",
        ):
            assert expected in names

    def test_attribute_error_on_unknown_name(self) -> None:
        from eden.kb import retrieval_intel

        with pytest.raises(AttributeError):
            retrieval_intel.NonExistentClass  # type: ignore[attr-defined]  # noqa: B018

    def test_chunks_from_log_row_handles_uuid_list(self) -> None:
        from eden.kb.retrieval_intel._common import _chunk_ids_from_log_row

        uuids = ["00000000-0000-0000-0000-000000000001"]
        out = _chunk_ids_from_log_row({"retrieved_item_ids": uuids})
        assert out == uuids

    def test_chunks_from_log_row_handles_missing(self) -> None:
        from eden.kb.retrieval_intel._common import _chunk_ids_from_log_row

        assert _chunk_ids_from_log_row({}) == []
        assert _chunk_ids_from_log_row({"retrieved_item_ids": None}) == []


# ─── 8. Route-level smoke tests ──────────────────────────────────────


def _fake_user() -> dict:
    return {"sub": "test-user", "org_id": "org_test"}


@pytest.fixture(scope="module")
def retrieval_app() -> FastAPI:
    from eden.api.deps import get_current_user, require_org_member, require_path_org_access
    from eden.config import get_settings

    settings = get_settings()
    settings.intelligence_gap_v0 = True
    app = FastAPI(title="eden-retrieval-test")
    app.dependency_overrides[get_current_user] = _fake_user
    app.dependency_overrides[require_org_member] = lambda: {"sub": "test-user", "org_id": "org_test"}
    app.dependency_overrides[require_path_org_access] = lambda: "org_x"
    mod = importlib.import_module("eden.api.routes.intelligence_retrieval")
    if hasattr(mod, "_require_path_org"):
        app.dependency_overrides[mod._require_path_org] = lambda: "org_x"
    app.include_router(mod.router)
    return app


@pytest.fixture(scope="module")
def retrieval_client(retrieval_app: FastAPI) -> TestClient:
    return TestClient(retrieval_app)


def test_utilization_route_returns_envelope(retrieval_client: TestClient) -> None:
    """POST /retrieval/{trace_id}/utilization returns the
    uniform envelope shape."""
    resp = retrieval_client.post(
        "/orgs/org_x/intelligence/retrieval/trace-1/utilization"
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "status" in data
    assert "feature" in data
    assert "live" in data
    assert "trace_id" in data
    assert data["feature"] == "retrieval_utilization"


def test_gaps_route_returns_envelope(retrieval_client: TestClient) -> None:
    """POST /retrieval/gaps returns the uniform envelope shape."""
    resp = retrieval_client.post(
        "/orgs/org_x/intelligence/retrieval/gaps",
        json={"window": "7d"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "status" in data
    assert data["feature"] == "knowledge_gap_detector"


def test_attribution_route_returns_envelope(retrieval_client: TestClient) -> None:
    """POST /retrieval/{trace_id}/attribution returns the
    uniform envelope shape."""
    resp = retrieval_client.post(
        "/orgs/org_x/intelligence/retrieval/trace-1/attribution"
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "status" in data
    assert data["feature"] == "chunk_attribution"


def test_reorder_route_returns_envelope(retrieval_client: TestClient) -> None:
    """POST /retrieval/reorder returns the uniform envelope shape."""
    resp = retrieval_client.post(
        "/orgs/org_x/intelligence/retrieval/reorder",
        json={"collection": "support_kb"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert "status" in data
    assert data["feature"] == "retrieval_reorderer"


def test_retrieval_routes_registered_under_intelligence_retrieval_tag() -> None:
    """The 4 Cat 4 routes are registered under the
    ``intelligence-retrieval`` OpenAPI tag, with the right
    methods and paths."""
    from eden.api.routes.intelligence_retrieval import router

    paths = sorted({(r.path, ",".join(r.methods or set())) for r in router.routes})
    expected = sorted(
        {
            (
                "/orgs/{org_id}/intelligence/retrieval/{trace_id}/utilization",
                "POST",
            ),
            ("/orgs/{org_id}/intelligence/retrieval/gaps", "POST"),
            (
                "/orgs/{org_id}/intelligence/retrieval/{trace_id}/attribution",
                "POST",
            ),
            ("/orgs/{org_id}/intelligence/retrieval/reorder", "POST"),
        }
    )
    assert paths == expected
