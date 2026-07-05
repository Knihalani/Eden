"""Session 12 tests — Live trace tail + dead intel (DL-1, DL-2, DL-3, DL-9, DL-10).

Five audit items:

* **DL-1** — ``telemetry_collector._route_redis`` wrote to the Redis
  stream but never fanned out to the per-tenant SSE pub/sub channel.
  SSE subscribers (``GET /orgs/{org}/observability/sse/stream``)
  waited the full poll interval for new events. Fix: call
  ``publish_trace_event`` after every successful Redis write.

* **DL-2** — When ``_tenant_event_counts[tenant] >= MAX_EVENTS_PER_TENANT``
  the collector returned ``False`` (drop). A noisy tenant lost
  EVERY subsequent event until process restart. Fix: reset the
  counter on cap (graceful shedding).

* **DL-3** — ``record_stream_chunks`` returned 200/accepted when
  Postgres was unavailable. SDKs treated that as success and chunks
  vanished on every DB blip. Fix: raise ``IngestionUnavailable``;
  route catches → 503 + ``Retry-After: 5``.

* **DL-9** — ``memory_intel._common:_fetch_trace_response_text``
  queried ``WHERE org_id = $1`` against ``telemetry_events`` which
  has a ``tenant_id`` column. MemoryAttributor returned 0 rows.
  Fix: ``WHERE tenant_id = $1``.

* **DL-10** — ``behavioural._fetch_signal_cohort`` queried the
  v0 ``signal_type``/``payload->>`` shape against the v1 table
  (flat columns ``regenerated``/``abandoned_after_one``/
  ``edit_distance``/``time_to_first_action_ms``). BehaviouralDashboard
  saw zero counts. Fix: rewrite SQL to the v1 shape, default the
  removed ``returned_yes`` / ``returned_no`` keys to 0 for
  backwards compat.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ─── DL-1: publish_trace_event invoked after successful Redis write ─
class TestDl1PublishTraceEvent:
    """The audit bug: SSE live-tail subscribers waited for the
    Postgres poll cycle (1s) for every new event because nothing
    published to ``observability:stream:{org_id}``. The fix wires
    ``publish_trace_event`` into ``_route_redis`` so events appear
    within ~10ms of write.
    """

    @pytest.mark.asyncio
    async def test_route_redis_calls_publish_trace_event(self) -> None:
        from eden.observability.telemetry_collector import (
            TelemetryCollector,
            TelemetryEvent,
        )

        collector = TelemetryCollector()
        # Stub Redis to return a fake xadd-able client.
        fake_redis = MagicMock()
        fake_redis.xadd = AsyncMock(return_value=b"1-0")
        collector._redis = fake_redis  # short-circuit _get_redis

        event = TelemetryEvent(
            event_id="evt-1",
            tenant_id="org-1",
            project_id="proj-1",
            trace_id="trace-1",
            realm="eden",
            event_type="llm.call",
            timestamp="2026-06-27T00:00:00Z",
            agent_id="agent-1",
        )

        with patch(
            "eden.api.routes.observability_stream.publish_trace_event",
            new=AsyncMock(),
        ) as mock_publish:
            await collector._route_redis(event)

        # xadd was called.
        fake_redis.xadd.assert_awaited_once()
        # AND publish_trace_event fired with the event payload.
        mock_publish.assert_awaited_once()
        kwargs = mock_publish.await_args.kwargs
        assert kwargs["org_id"] == "org-1"
        assert kwargs["payload"]["trace_id"] == "trace-1"

    @pytest.mark.asyncio
    async def test_route_redis_does_not_publish_on_xadd_failure(
        self,
    ) -> None:
        """If Redis xadd fails, we MUST NOT publish — the event
        wasn't durably stored, so the SSE channel shouldn't
        advertise it."""
        from eden.observability.telemetry_collector import (
            TelemetryCollector,
            TelemetryEvent,
        )

        collector = TelemetryCollector()
        fake_redis = MagicMock()
        fake_redis.xadd = AsyncMock(
            side_effect=RuntimeError("redis down"),
        )
        collector._redis = fake_redis

        event = TelemetryEvent(
            event_id="evt-2",
            tenant_id="org-2",
            project_id="proj-2",
            trace_id="trace-2",
            realm="eden",
            event_type="llm.call",
            timestamp="2026-06-27T00:00:00Z",
            agent_id="agent-2",
        )

        with patch(
            "eden.api.routes.observability_stream.publish_trace_event",
            new=AsyncMock(),
        ) as mock_publish:
            await collector._route_redis(event)

        fake_redis.xadd.assert_awaited_once()
        mock_publish.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_route_redis_swallows_publish_failure(self) -> None:
        """A failing publish_trace_event MUST NOT break the
        hot-path ingest — Redis stream is the source of truth.
        The publish is best-effort."""
        from eden.observability.telemetry_collector import (
            TelemetryCollector,
            TelemetryEvent,
        )

        collector = TelemetryCollector()
        fake_redis = MagicMock()
        fake_redis.xadd = AsyncMock(return_value=b"1-0")
        collector._redis = fake_redis

        event = TelemetryEvent(
            event_id="evt-3",
            tenant_id="org-3",
            project_id="proj-3",
            trace_id="trace-3",
            realm="eden",
            event_type="llm.call",
            timestamp="2026-06-27T00:00:00Z",
            agent_id="agent-3",
        )

        with patch(
            "eden.api.routes.observability_stream.publish_trace_event",
            new=AsyncMock(
                side_effect=RuntimeError("pubsub broken"),
            ),
        ):
            # MUST NOT raise — the publish is best-effort.
            await collector._route_redis(event)

        fake_redis.xadd.assert_awaited_once()


# ─── DL-2: tenant counter resets on cap ────────────────────────────
class TestDl2TenantCounterReset:
    """Pre-fix: hitting MAX_EVENTS_PER_TENANT rejected every
    subsequent event until restart. Post-fix: the counter
    resets to 0 and ingestion continues."""

    @pytest.mark.asyncio
    async def test_tenant_counter_resets_on_cap(self) -> None:
        from eden.observability.telemetry_collector import (
            TelemetryCollector,
            TelemetryEvent,
        )

        collector = TelemetryCollector()

        def _evt(idx: int) -> TelemetryEvent:
            return TelemetryEvent(
                event_id=f"evt-{idx}",
                tenant_id="org-1",
                project_id="proj-1",
                trace_id=f"trace-{idx}",
                realm="eden",
                event_type="llm.call",
                timestamp="2026-06-27T00:00:00Z",
                agent_id="agent-1",
            )

        # Force the counter to the cap.
        collector._tenant_event_counts["org-1"] = TelemetryCollector.MAX_EVENTS_PER_TENANT

        # Stub the entire route path so ingest() returns true
        # without needing real sinks.
        collector._route = AsyncMock()  # type: ignore[method-assign]
        collector._is_duplicate = MagicMock(return_value=False)  # type: ignore[method-assign]
        collector._validate = MagicMock(return_value=True)  # type: ignore[method-assign]
        collector._enrich = MagicMock()  # type: ignore[method-assign]

        ok = await collector.ingest(_evt(1))

        # Post-fix: True (accepted, not dropped).
        assert ok is True, "DL-2 regression: event dropped on cap"
        # Counter wrapped back to 1 (was reset to 0, then ++).
        assert collector._tenant_event_counts["org-1"] == 1

    @pytest.mark.asyncio
    async def test_ingest_batch_resets_on_cap(self) -> None:
        """Same reset behaviour in the batch path."""
        from eden.observability.telemetry_collector import (
            TelemetryCollector,
            TelemetryEvent,
        )

        collector = TelemetryCollector()
        collector._tenant_event_counts["org-1"] = TelemetryCollector.MAX_EVENTS_PER_TENANT

        def _evt(idx: int) -> TelemetryEvent:
            return TelemetryEvent(
                event_id=f"evt-{idx}",
                tenant_id="org-1",
                project_id="proj-1",
                trace_id=f"trace-{idx}",
                realm="eden",
                event_type="llm.call",
                timestamp="2026-06-27T00:00:00Z",
                agent_id="agent-1",
            )

        collector._route = AsyncMock()  # type: ignore[method-assign]
        collector._is_duplicate = MagicMock(return_value=False)  # type: ignore[method-assign]
        collector._validate = MagicMock(return_value=True)  # type: ignore[method-assign]
        collector._enrich = MagicMock()  # type: ignore[method-assign]

        result = await collector.ingest_batch([_evt(1), _evt(2)])

        # Both events accepted (counter reset then incremented twice).
        assert result["accepted"] == 2
        assert result["rejected"] == 0


# ─── DL-3: PG blip → IngestionUnavailable → HTTP 503 ───────────────
class TestDl3PgBlipReturns503:
    """Pre-fix: record_stream_chunks returned 200/accepted when
    Postgres was unavailable. SDKs treated that as success and
    chunks vanished. Post-fix: it raises IngestionUnavailable and
    the route returns 503 + Retry-After."""

    @pytest.mark.asyncio
    async def test_record_stream_chunks_raises_when_no_pg(self) -> None:
        from eden.observability.errors import IngestionUnavailable
        from eden.observability.telemetry_collector import (
            TelemetryCollector,
        )

        collector = TelemetryCollector()

        # Patch _get_postgres to return None — simulates PG blip.
        with patch.object(
            collector, "_get_postgres", new=AsyncMock(return_value=None)
        ):
            with pytest.raises(IngestionUnavailable):
                await collector.record_stream_chunks(
                    "org-1",
                    [
                        {
                            "event_id": "evt-1",
                            "trace_id": "trace-1",
                            "chunk_index": 0,
                            "delta_text": "hello",
                        }
                    ],
                )

    @pytest.mark.asyncio
    async def test_record_stream_chunks_empty_chunks_no_raise(self) -> None:
        """Empty chunk list short-circuits BEFORE the PG check —
        no 503 for a no-op call."""
        from eden.observability.telemetry_collector import (
            TelemetryCollector,
        )

        collector = TelemetryCollector()
        result = await collector.record_stream_chunks("org-1", [])
        assert result == {
            "accepted": 0, "rejected": 0,
            "deduplicated": 0, "total": 0,
        }

    @pytest.mark.asyncio
    async def test_ingest_chunks_returns_503_when_pg_unavailable(
        self,
    ) -> None:
        """End-to-end: route returns 503 + Retry-After: 5 when
        the collector raises IngestionUnavailable."""
        from fastapi import HTTPException

        from eden.observability.telemetry_collector import (
            get_telemetry_collector,
        )

        # Force PG blip on the singleton collector.
        collector = await get_telemetry_collector()
        collector._get_postgres = AsyncMock(  # type: ignore[method-assign]
            return_value=None,
        )

        # Build a minimal mock Request with the JSON body.
        body = json.dumps(
            {
                "chunks": [
                    {
                        "event_id": "evt-1",
                        "trace_id": "trace-1",
                        "chunk_index": 0,
                        "delta_text": "hello",
                    }
                ]
            }
        ).encode()

        mock_request = MagicMock()
        mock_request.body = AsyncMock(return_value=body)

        async def _fake_auth():
            return {"org_id": "org-1"}

        with patch(
            "eden.api.routes.ingestion.get_ingestion_auth",
            _fake_auth,
        ):
            with patch(
                "eden.api.routes.ingestion.get_settings"
            ) as mock_settings:
                mock_settings.return_value = MagicMock(
                    ingestion_max_body_bytes=1_000_000,
                    ingestion_chunks_max_per_request=10_000,
                )
                with patch(
                    "eden.api.routes.ingestion._check_rate_limit"
                ):
                    from eden.api.routes.ingestion import ingest_chunks
                    with pytest.raises(HTTPException) as exc_info:
                        await ingest_chunks(
                            request=mock_request,
                            org_id="org-1",
                            auth_ctx={"org_id": "org-1"},
                        )

        assert exc_info.value.status_code == 503
        assert exc_info.value.headers["Retry-After"] == "5"
        assert "temporarily unavailable" in exc_info.value.detail


# ─── DL-9: MemoryAttributor WHERE tenant_id ────────────────────────
class TestDl9MemoryAttributorColumn:
    """Pre-fix: ``_fetch_trace_response_text`` queried
    ``WHERE org_id = $1`` against a ``tenant_id`` column →
    0 rows. Post-fix: ``WHERE tenant_id = $1``.
    """

    @pytest.mark.asyncio
    async def test_sql_uses_tenant_id_column(
        self, mock_postgres_client: MagicMock,
    ) -> None:
        """Static + behavioural check: the SQL emitted MUST
        filter on ``tenant_id``, NOT ``org_id``. If the
        DL-9 regression returns, the SQL falls back to
        org_id and the fetchrow returns nothing."""
        from eden.kb.episodic.memory_intel._common import (
            _fetch_trace_response_text,
        )

        captured_sql: list[str] = []

        async def _fetch(sql, *args):
            captured_sql.append(sql)
            return [
                {
                    "response_body": {"text": "the answer"},
                }
            ]

        mock_postgres_client.fetch = AsyncMock(side_effect=_fetch)

        result = await _fetch_trace_response_text("org-1", "trace-1")

        # Exactly one fetch with a tenant_id filter.
        assert len(captured_sql) == 1
        sql_text = " ".join(captured_sql[0].split())
        assert "tenant_id = $1" in sql_text, (
            "DL-9 regression: SQL still uses org_id, "
            "MemoryAttributor returns 0 rows"
        )
        assert "org_id = $1" not in sql_text, (
            "DL-9 regression: SQL contains org_id = $1 "
            "against the tenant_id column"
        )
        # Result is the parsed answer.
        assert result == "the answer"

    @pytest.mark.asyncio
    async def test_no_rows_returns_none(
        self, mock_postgres_client: MagicMock,
    ) -> None:
        """Empty result set → None (mirrors pre-fix behaviour
        on the dead query)."""
        from eden.kb.episodic.memory_intel._common import (
            _fetch_trace_response_text,
        )

        mock_postgres_client.fetch = AsyncMock(return_value=[])
        result = await _fetch_trace_response_text("org-1", "trace-x")
        assert result is None


# ─── DL-10: behavioural _fetch_signal_cohort SQL ──────────────────
class TestDl10BehaviouralSignalCohort:
    """Pre-fix: the SQL queried the v0 ``signal_type`` /
    ``payload->>'edit_distance'`` shape against a v1 table
    with flat columns → 0 rows / null means. Post-fix: the
    SQL uses the v1 columns and the result carries the
    real means."""

    @pytest.mark.asyncio
    async def test_signal_cohort_uses_v1_columns(
        self, mock_postgres_client: MagicMock,
    ) -> None:
        from eden.services.user_intel.behavioural import (
            _fetch_signal_cohort,
        )

        captured_sql: list[str] = []

        async def _fetchrow(sql, *args):
            captured_sql.append(sql)
            return {
                "total": 50,
                "regen_count": 7,
                "abandon_count": 4,
                "edit_distance_mean": 12.5,
                "ttfa_mean": 850.0,
            }

        mock_postgres_client.fetchrow = AsyncMock(side_effect=_fetchrow)

        result = await _fetch_signal_cohort("org-1", "7 days")

        # SQL must NOT reference the v0 shape.
        sql_text = " ".join(captured_sql[0].split())
        assert "signal_type" not in sql_text, (
            "DL-10 regression: SQL still uses signal_type "
            "(v0 shape, dead against the v1 table)"
        )
        assert "payload->>" not in sql_text, (
            "DL-10 regression: SQL still digs into payload JSONB "
            "instead of the flat v1 columns"
        )
        # SQL must use the v1 columns.
        assert "regenerated" in sql_text
        assert "abandoned_after_one" in sql_text
        assert "edit_distance" in sql_text
        assert "time_to_first_action_ms" in sql_text

        # Result surfaces the right keys + values.
        assert result["total"] == 50
        assert result["regen_count"] == 7
        assert result["abandon_count"] == 4
        assert result["edit_distance_mean"] == 12.5
        assert result["ttfa_mean"] == 850.0

    @pytest.mark.asyncio
    async def test_signal_cohort_defaults_returned_keys(
        self, mock_postgres_client: MagicMock,
    ) -> None:
        """The caller (BehaviouralDashboard) references
        ``returned_yes`` / ``returned_no`` — those signals
        were deferred per upgradespec §D.2. Surface 0 so
        downstream math doesn't raise KeyError."""
        from eden.services.user_intel.behavioural import (
            _fetch_signal_cohort,
        )

        mock_postgres_client.fetchrow = AsyncMock(
            return_value={
                "total": 10,
                "regen_count": 1,
                "abandon_count": 0,
                "edit_distance_mean": 5.0,
                "ttfa_mean": 200.0,
            }
        )

        result = await _fetch_signal_cohort("org-1", "1 day")

        assert result["returned_yes"] == 0
        assert result["returned_no"] == 0

    @pytest.mark.asyncio
    async def test_signal_cohort_no_client_returns_empty(
        self,
    ) -> None:
        """No PG client → empty dict (matches the docstring
        contract)."""
        from eden.services.user_intel.behavioural import (
            _fetch_signal_cohort,
        )

        with patch(
            "eden.services.user_intel.behavioural._get_client",
            AsyncMock(return_value=None),
        ):
            result = await _fetch_signal_cohort("org-1", "7 days")
        assert result == {}

    @pytest.mark.asyncio
    async def test_signal_cohort_pg_failure_returns_empty(
        self, mock_postgres_client: MagicMock,
    ) -> None:
        """PG blip → empty dict (defensive)."""
        from eden.services.user_intel.behavioural import (
            _fetch_signal_cohort,
        )

        mock_postgres_client.fetchrow = AsyncMock(
            side_effect=RuntimeError("connection lost"),
        )
        result = await _fetch_signal_cohort("org-1", "7 days")
        assert result == {}
