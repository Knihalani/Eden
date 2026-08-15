"""Integration tests for the periodic insights detector loop (A7).

These tests pin down the contract between the
``InsightsDetectorLoop`` background task and the rest of the
Insights Engine:

  * ``tick_once`` reads new ``judge_scores`` rows for each tenant
    that has any ahead of its watermark.
  * Each row is converted to an ``Insight`` (via the
    ``JudgeDetector`` virtual detector's conversion logic, kept
    in sync by the loop's local copy).
  * The resulting ``Insight`` objects are persisted via
    ``InsightsService.persist_insight_to_postgres``.
  * The watermark in ``judge_scores_processed`` is advanced to
    the highest ``judge_run_id`` we processed so the next tick
    doesn't re-emit the same insights.

We mock the Postgres client + ``InsightsService.persist_insight_to_postgres``
on a per-test basis.  No real DB is required.

The test uses ``app.dependency_overrides`` for the auth dep
(matching the pattern in ``test_ingestion.py``) and also patches
the ``get_postgres_client`` and ``InsightsService`` symbols
that the loop captured at import time.
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid
from datetime import UTC, datetime, timezone
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _clear_insights_empty_cooldown():
    """Reset the loop's empty-result cooldown between tests.

    ``detector_loop`` holds module-level cooldown closures
    (``make_empty_cooldown``): after a tick that finds nothing, it backs
    off to the next shared 10-minute grid boundary and short-circuits
    before touching Postgres. That is deliberate — it is what lets Neon
    reach scale-to-zero — but the state is per-process, so the first test
    here that ticks an empty queue used to silence every test after it in
    the file. Each of them then saw an empty result and failed, while
    passing in isolation.
    """
    from eden.insights import detector_loop

    detector_loop._insights_clear_cooldown()
    yield
    detector_loop._insights_clear_cooldown()

# Make sure the project root is importable when this test is
# collected from a worktree / CI runner.  Pinned to the absolute
# worktree root so the test can find ``eden.insights.detector_loop``
# whether pytest is invoked from the repo root or the tests dir.
_PROJECT_ROOT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), "..", "..", "src")
)
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)


# ── Module-level fixtures ──────────────────────────────────────────


@pytest.fixture
def mock_pg_client() -> AsyncMock:
    """A fake Postgres client with ``fetch``/``fetchrow``/``execute``
    set up as AsyncMocks.  Per-test code can override return values
    to simulate tenant lists, judge_scores rows, etc.
    """
    client = AsyncMock()
    client.fetch = AsyncMock(return_value=[])
    client.fetchrow = AsyncMock(return_value=None)
    client.execute = AsyncMock(return_value="OK")
    return client


@pytest.fixture
def persisted_insights() -> list[Any]:
    """List that captures every Insight passed to
    ``InsightsService.persist_insight_to_postgres``."""
    return []


@pytest.fixture
def mock_insights_service(persisted_insights: list[Any]) -> MagicMock:
    """Fake ``InsightsService`` whose ``persist_insight_to_postgres``
    appends the Insight to ``persisted_insights`` and returns a
    fake row id.  ``write_insight_to_kb`` and
    ``record_kb_insight_write`` are also stubbed so the loop
    doesn't blow up if it later expands to call them.
    """
    service = MagicMock()

    async def _persist(insight: Any, organization_id: str | None = None) -> str:
        persisted_insights.append(insight)
        return str(uuid.uuid4())

    async def _noop(*_args: Any, **_kwargs: Any) -> None:
        return None

    service.persist_insight_to_postgres = AsyncMock(side_effect=_persist)
    service.write_insight_to_kb = AsyncMock(side_effect=_noop)
    service.record_kb_insight_write = AsyncMock(side_effect=_noop)
    return service


# ── Helpers ────────────────────────────────────────────────────────


def _make_score_row(
    *,
    tenant_id: str = "org-123",
    judge_run_id: str | None = None,
    judge_name: str = "hallucination",
    score: float = 0.1,
    rationale: str = "model invented a number",
) -> dict[str, Any]:
    """Build a fake ``judge_scores`` row dict shaped like what
    ``asyncpg.Record`` would return via ``client.fetch``.

    Keys mirror the columns the loop SELECTs:
    ``judge_run_id, judge_name, judge_version, trace_id, span_id,
    score, rationale, model, scored_at, latency_ms, tenant_id``.
    """
    return {
        "judge_run_id": uuid.UUID(judge_run_id)
        if judge_run_id
        else uuid.uuid4(),
        "judge_name": judge_name,
        "judge_version": "2026-06-03",
        "trace_id": f"trace-{uuid.uuid4().hex[:8]}",
        "span_id": "span-1",
        "score": float(score),
        "rationale": rationale,
        "model": "anthropic/claude-sonnet-4.6",
        # Real datetime — asyncpg returns ``datetime`` for timestamptz,
        # and the loop's keyset cursor parses/compares it directly.
        "scored_at": datetime(2026, 6, 8, 10, 0, 0, tzinfo=UTC),
        "latency_ms": 120.0,
        "tenant_id": tenant_id,
    }


def _set_fetch_for_loop(
    pg: AsyncMock,
    *,
    tenant_ids: list[str],
    new_rows_by_tenant: dict[str, list[dict[str, Any]]],
    watermark: dict[str, str | None] | None = None,
) -> None:
    """Configure ``pg.fetch`` and ``pg.fetchrow`` to simulate the
    loop's I/O pattern.

    The first call (``_list_tenants_with_new_scores``) returns
    ``tenant_ids``; subsequent calls alternate between
    ``fetchrow`` (read watermark) and ``fetch`` (read new rows)
    per tenant.
    """
    watermark = watermark or {}
    calls = {"n": 0}

    async def _fetch(query: str, *args: Any) -> list[dict[str, Any]]:
        calls["n"] += 1
        # Tenant list query (the only one in this test that
        # touches ``judge_scores_processed`` from ``fetch``).
        if "DISTINCT j.tenant_id" in query:
            return [{"tenant_id": t} for t in tenant_ids]
        # New rows query — return the right batch for the
        # tenant we just asked about.
        tenant_id = args[0] if args else None
        return list(new_rows_by_tenant.get(tenant_id, []))

    async def _fetchrow(query: str, *args: Any) -> dict[str, Any] | None:
        tenant_id = args[0] if args else None
        if "last_processed_judge_score_id" in query:
            wm = watermark.get(tenant_id)
            return (
                {"last_processed_judge_score_id": uuid.UUID(wm)}
                if wm
                else None
            )
        return None

    pg.fetch.side_effect = _fetch
    pg.fetchrow.side_effect = _fetchrow


# ── Per-feature tests ──────────────────────────────────────────────


class TestTickOnceHappyPath:
    """Single tick: one tenant, one new score, one persisted Insight."""

    @pytest.mark.asyncio
    async def test_new_judge_score_persists_insight_and_advances_watermark(
        self,
        mock_pg_client: AsyncMock,
        mock_insights_service: MagicMock,
        persisted_insights: list[Any],
    ):
        from eden.config import get_settings
        from eden.insights import detector_loop as loop_module

        # Disable the loop's auto-start; we drive ``tick_once`` manually.
        settings = get_settings()
        assert settings.insights_loop_enabled is True

        new_row = _make_score_row(score=0.1, judge_name="hallucination")
        _set_fetch_for_loop(
            mock_pg_client,
            tenant_ids=["org-123"],
            new_rows_by_tenant={"org-123": [new_row]},
            watermark={"org-123": None},  # no prior watermark
        )

        # Patch the I/O the loop uses: postgres client and
        # InsightsService.
        with patch(
            "eden.insights.detector_loop.get_postgres_client",
            AsyncMock(return_value=mock_pg_client),
        ), patch(
            "eden.insights.insights_service.InsightsService",
            return_value=mock_insights_service,
        ):
            loop = loop_module.InsightsDetectorLoop(batch_size=10)
            per_tenant = await loop.tick_once()

        # One Insight persisted for the one new row.
        assert per_tenant == {"org-123": 1}
        assert len(persisted_insights) == 1
        insight = persisted_insights[0]
        assert insight.detector == "judge.hallucination"
        assert insight.severity == "critical"  # score 0.1 < 0.3
        assert insight.confidence == 0.1
        # Watermark upsert was called with the new row's judge_run_id.
        upsert_calls = [
            c for c in mock_pg_client.execute.await_args_list
            if "judge_scores_processed" in str(c.args[0])
        ]
        assert len(upsert_calls) == 1
        upsert_args = upsert_calls[0].args
        assert upsert_args[1] == "org-123"
        assert upsert_args[2] == new_row["judge_run_id"]


class TestTickOnceIdempotent:
    """Second tick with no new rows: no insights persisted, watermark
    upsert still called (so future ticks don't re-scan the tenant)."""

    @pytest.mark.asyncio
    async def test_no_new_rows_persists_zero_and_keeps_watermark(
        self,
        mock_pg_client: AsyncMock,
        mock_insights_service: MagicMock,
        persisted_insights: list[Any],
    ):
        from eden.insights import detector_loop as loop_module

        # Pre-existing watermark = the only row we ever saw.
        # The "tenant list" query is gated on rows-ahead-of-watermark,
        # so we report no tenants when nothing is new.
        async def _fetch(query: str, *args: Any) -> list[dict[str, Any]]:
            if "DISTINCT j.tenant_id" in query:
                return []
            return []

        mock_pg_client.fetch.side_effect = _fetch
        mock_pg_client.fetchrow.side_effect = AsyncMock(return_value=None)

        with patch(
            "eden.insights.detector_loop.get_postgres_client",
            AsyncMock(return_value=mock_pg_client),
        ), patch(
            "eden.insights.insights_service.InsightsService",
            return_value=mock_insights_service,
        ):
            loop = loop_module.InsightsDetectorLoop(batch_size=10)
            per_tenant = await loop.tick_once()

        assert per_tenant == {}
        assert persisted_insights == []
        # No watermark write because we never picked up a tenant.
        assert mock_pg_client.execute.await_count == 0


class TestTenantScope:
    """Two tenants with new rows: each gets its own watermark and
    its own insights, in stable alphabetical tenant_id order."""

    @pytest.mark.asyncio
    async def test_two_tenants_processed_independently(
        self,
        mock_pg_client: AsyncMock,
        mock_insights_service: MagicMock,
        persisted_insights: list[Any],
    ):
        from eden.insights import detector_loop as loop_module

        a_row = _make_score_row(tenant_id="org-a", score=0.2)
        b_row = _make_score_row(tenant_id="org-b", score=0.8)
        _set_fetch_for_loop(
            mock_pg_client,
            tenant_ids=["org-a", "org-b"],
            new_rows_by_tenant={"org-a": [a_row], "org-b": [b_row]},
            watermark={"org-a": None, "org-b": None},
        )

        with patch(
            "eden.insights.detector_loop.get_postgres_client",
            AsyncMock(return_value=mock_pg_client),
        ), patch(
            "eden.insights.insights_service.InsightsService",
            return_value=mock_insights_service,
        ):
            loop = loop_module.InsightsDetectorLoop(batch_size=10)
            per_tenant = await loop.tick_once()

        assert per_tenant == {"org-a": 1, "org-b": 1}
        detectors = sorted(i.detector for i in persisted_insights)
        assert detectors == [
            "judge.hallucination",
            "judge.hallucination",
        ]


class TestSeverityBuckets:
    """Score-to-severity mapping is shared with JudgeDetector and
    must not drift.  Pin every bucket here."""

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "score,expected_severity",
        [
            (0.0, "critical"),
            (0.29, "critical"),
            (0.3, "high"),
            (0.49, "high"),
            (0.5, "medium"),
            (0.69, "medium"),
            (0.7, "low"),
            (0.89, "low"),
            (0.9, "info"),
            (1.0, "info"),
        ],
    )
    async def test_score_to_severity_boundaries(
        self,
        mock_pg_client: AsyncMock,
        mock_insights_service: MagicMock,
        persisted_insights: list[Any],
        score: float,
        expected_severity: str,
    ):
        from eden.insights import detector_loop as loop_module

        row = _make_score_row(score=score)
        _set_fetch_for_loop(
            mock_pg_client,
            tenant_ids=["org-123"],
            new_rows_by_tenant={"org-123": [row]},
            watermark={"org-123": None},
        )
        with patch(
            "eden.insights.detector_loop.get_postgres_client",
            AsyncMock(return_value=mock_pg_client),
        ), patch(
            "eden.insights.insights_service.InsightsService",
            return_value=mock_insights_service,
        ):
            loop = loop_module.InsightsDetectorLoop(batch_size=10)
            await loop.tick_once()

        assert len(persisted_insights) == 1
        assert persisted_insights[0].severity == expected_severity


class TestStartupAndShutdown:
    """The lifespan wiring toggles the loop via
    ``start_insights_detector_loop`` / ``stop_insights_detector_loop``."""

    @pytest.mark.asyncio
    async def test_start_is_idempotent(self):
        from eden.insights import detector_loop as loop_module

        # Reset the module singleton for the test.
        loop_module._loop = None
        loop = MagicMock()
        loop.start = AsyncMock()
        loop.stop = AsyncMock()
        with patch.object(loop_module, "InsightsDetectorLoop", return_value=loop):
            await loop_module.start_insights_detector_loop()
            await loop_module.start_insights_detector_loop()  # idempotent
            assert loop.start.await_count == 1

    @pytest.mark.asyncio
    async def test_start_respects_settings(self):
        """If ``insights_loop_enabled=False`` the loop is never
        started, even if ``start()`` is called."""
        from eden.insights import detector_loop as loop_module

        loop_module._loop = None
        loop = MagicMock()
        loop.start = AsyncMock()

        with patch.object(loop_module, "InsightsDetectorLoop", return_value=loop), patch.object(
            loop_module, "get_settings", return_value=MagicMock(
                insights_loop_enabled=False,
                insights_loop_interval_seconds=60.0,
                insights_loop_batch_size=200,
                insights_loop_max_runtime_seconds=50.0,
            ),
        ):
            await loop_module.start_insights_detector_loop()

        assert loop.start.await_count == 0


class TestInsightsServiceUnavailable:
    """If ``InsightsService`` can't be imported (e.g. KB is broken),
    the loop must NOT crash.  It advances the watermark and returns
    zero — so a transient KB outage doesn't permanently block
    processing."""

    @pytest.mark.asyncio
    async def test_tick_survives_persist_failure(
        self,
        mock_pg_client: AsyncMock,
    ):
        from eden.insights import detector_loop as loop_module

        new_row = _make_score_row(score=0.1)
        _set_fetch_for_loop(
            mock_pg_client,
            tenant_ids=["org-123"],
            new_rows_by_tenant={"org-123": [new_row]},
            watermark={"org-123": None},
        )

        # Simulate an InsightsService import failure: patching the
        # module name that the loop imports on demand.
        with patch(
            "eden.insights.detector_loop.get_postgres_client",
            AsyncMock(return_value=mock_pg_client),
        ), patch.dict(
            sys.modules, {"eden.insights.insights_service": None}
        ):
            loop = loop_module.InsightsDetectorLoop(batch_size=10)
            per_tenant = await loop.tick_once()

        # Tick didn't crash; per_tenant records the failure as 0.
        assert per_tenant == {"org-123": 0}
        # Watermark still advanced — we don't want a transient
        # KB outage to permanently block processing.
        upsert_calls = [
            c for c in mock_pg_client.execute.await_args_list
            if "judge_scores_processed" in str(c.args[0])
        ]
        assert len(upsert_calls) == 1
        assert upsert_calls[0].args[1] == "org-123"
