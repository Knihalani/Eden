"""F56 tests — ``WebhookDeliveryService.process_pending_deliveries``.

The worker entrypoint ``eden.workers.main._webhook_drain_loop``
ticks every 30 s and calls
``svc.process_pending_deliveries()`` on each tick to pick up
rows from ``webhook_deliveries`` whose ``next_attempt_at`` is
due and schedule an ``_attempt_delivery`` task for each.

Pre-fix the method did not exist on the service. The
``except Exception`` handler in the drain loop silently logged
the ``AttributeError`` and the worker kept running while the
outbox grew without bound. These tests pin the post-fix shape.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect
import logging
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


@pytest.fixture(autouse=True)
def _reset_outbox_cooldown():
    """Clear the shared empty-outbox cooldown around every test.

    The cooldown is module-level state by design (one drain loop per
    process). In tests that makes it leak between cases: any test whose
    fake outbox comes back empty arms a multi-minute backoff, and every
    later test then short-circuits before its mocked query is ever
    reached, failing for reasons unrelated to what it asserts.
    """
    from eden.services.webhook_delivery import _clear_outbox_empty_cooldown

    _clear_outbox_empty_cooldown()
    yield
    _clear_outbox_empty_cooldown()


def _make_row(delivery_id: str, *, url: str = "https://x.test/hook",
              secret: str = "whsec_test",
              payload: object | None = None) -> dict[str, object]:
    """Shape one row as ``asyncpg`` would return it."""
    return {
        "delivery_id": delivery_id,
        "webhook_id": "wh-1",
        "webhook_url": url,
        "webhook_secret": secret,
        "event_type": "test.event",
        "payload": payload,
    }


class TestProcessPendingDeliveriesSignature:
    """The method must exist, be async, and return int."""

    def test_method_exists(self) -> None:
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )
        svc = WebhookDeliveryService()
        assert hasattr(svc, "process_pending_deliveries")
        assert asyncio.iscoroutinefunction(
            svc.process_pending_deliveries
        )


class TestProcessPendingDeliveriesSqlContract:
    """Source-level SQL contract: catch column/table typos that
    mocked-DB tests would miss. The query must:

    * join ``webhooks`` for URL + secret (URL/secret live on the
      webhook, not on the delivery row — the original code
      contained a latent bug where ``url``/``secret`` were read
      off the delivery row).
    * filter to ``pending`` and ``retrying`` only.
    * respect ``next_attempt_at``.
    * bind ``LIMIT`` via ``$1`` (never format into the string).
    """

    def test_query_targets_webhook_deliveries(self) -> None:
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        src = inspect.getsource(
            WebhookDeliveryService.process_pending_deliveries
        )
        # Outbox table is ``webhook_deliveries``.
        assert "FROM webhook_deliveries d" in src
        # Must join ``webhooks`` to pick up url/secret.
        assert "JOIN webhooks w" in src
        # url/secret columns are aliased off the join, not the delivery row.
        assert "w.url AS webhook_url" in src
        assert "w.secret AS webhook_secret" in src
        # CAS — terminal rows must be excluded.
        assert "status IN ('pending', 'retrying')" in src
        # Backoff schedule enforced in SQL.
        assert "next_attempt_at IS NULL" in src
        assert "next_attempt_at <= NOW()" in src
        # LIMIT must use bound parameter.
        assert "LIMIT $1" in src
        # Never format the limit into the string.
        assert "LIMIT {limit" not in src
        assert "LIMIT " + "%" not in src


class TestProcessPendingDeliveriesEmptyOutbox:
    """If the outbox has no due rows, return 0 and do nothing."""

    @pytest.mark.asyncio
    async def test_returns_zero_when_no_rows(self) -> None:
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()
        mock_pg = MagicMock()
        mock_pg.fetch = AsyncMock(return_value=[])
        with patch(
            "eden.services.webhook_delivery.get_postgres_client",
            new=AsyncMock(return_value=mock_pg),
        ):
            n = await service.process_pending_deliveries()

        assert n == 0
        # No tasks were scheduled.
        assert service._in_flight == set()


class TestProcessPendingDeliveriesSchedulesOnePerRow:
    """Each due row becomes one ``_schedule_delivery`` call."""

    @pytest.mark.asyncio
    async def test_schedules_each_row_once(self) -> None:
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()

        rows = [
            _make_row("d-1", payload={"event_type": "a"}),
            _make_row("d-2", payload={"event_type": "b"}),
            _make_row("d-3", payload={"event_type": "c"}),
        ]
        mock_pg = MagicMock()
        mock_pg.fetch = AsyncMock(return_value=rows)

        scheduled: list[tuple[str, str, str, object]] = []

        def fake_schedule(*, delivery_id, url, secret, payload):
            scheduled.append(
                (delivery_id, url, secret, payload)
            )
            task = asyncio.create_task(asyncio.sleep(0))
            # Track + auto-clean.
            service._in_flight.add(task)
            task.add_done_callback(service._in_flight.discard)
            return task

        try:
            with patch(
                "eden.services.webhook_delivery.get_postgres_client",
                new=AsyncMock(return_value=mock_pg),
            ), patch.object(
                service,
                "_schedule_delivery",
                side_effect=fake_schedule,
            ):
                n = await service.process_pending_deliveries()

            assert n == 3
            assert [row[0] for row in scheduled] == [
                "d-1", "d-2", "d-3",
            ]
            # URL and secret were pulled from the webhook row,
            # not the delivery row.
            assert all(row[1] == "https://x.test/hook" for row in scheduled)
            assert all(row[2] == "whsec_test" for row in scheduled)
        finally:
            for t in list(service._in_flight):
                if not t.done():
                    t.cancel()
            with contextlib.suppress(Exception):
                await asyncio.gather(
                    *service._in_flight, return_exceptions=True
                )


class TestProcessPendingDeliveriesLimit:
    """The ``limit`` kwarg is bounded so a flood cannot wedge a tick."""

    @pytest.mark.asyncio
    async def test_limit_is_bounded_to_min(self) -> None:
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()
        mock_pg = MagicMock()
        captured: dict[str, int] = {}

        async def capturing_fetch(query, *args, **kwargs):
            captured["limit"] = args[0]
            return []

        mock_pg.fetch = capturing_fetch

        with patch(
            "eden.services.webhook_delivery.get_postgres_client",
            new=AsyncMock(return_value=mock_pg),
        ):
            # ``limit=0`` must be clamped up to ``1``.
            await service.process_pending_deliveries(limit=0)
            assert captured["limit"] == 1

    @pytest.mark.asyncio
    async def test_limit_is_bounded_to_max(self) -> None:
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()
        mock_pg = MagicMock()
        captured: dict[str, int] = {}

        async def capturing_fetch(query, *args, **kwargs):
            captured["limit"] = args[0]
            return []

        mock_pg.fetch = capturing_fetch

        with patch(
            "eden.services.webhook_delivery.get_postgres_client",
            new=AsyncMock(return_value=mock_pg),
        ):
            # ``limit=10_000`` must be clamped down to ``500``.
            await service.process_pending_deliveries(limit=10_000)
            assert captured["limit"] == 500


class TestProcessPendingDeliveriesDbDownIsStable:
    """If the DB is unreachable the worker must keep ticking.

    Pre-fix the method did not exist; the worker logged an
    ``AttributeError`` every 30 s. Post-fix the method
    catches DB errors and returns ``0`` so ``delivered`` logs
    remain meaningful and the worker keeps running.
    """

    @pytest.mark.asyncio
    async def test_returns_zero_on_pg_unreachable(self) -> None:
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()

        with patch(
            "eden.services.webhook_delivery.get_postgres_client",
            new=AsyncMock(
                side_effect=RuntimeError("pg unreachable"),
            ),
        ), patch(
            "eden.services.webhook_delivery.logger",
        ) as mock_logger:
            n = await service.process_pending_deliveries()

        assert n == 0
        # Logged at WARNING so on-call sees it.
        warning_calls = list(mock_logger.warning.call_args_list)
        assert warning_calls, "expected a WARNING log on pg failure"

    @pytest.mark.asyncio
    async def test_returns_zero_on_query_error(self) -> None:
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()
        mock_pg = MagicMock()
        mock_pg.fetch = AsyncMock(
            side_effect=RuntimeError("query failed"),
        )

        with patch(
            "eden.services.webhook_delivery.get_postgres_client",
            new=AsyncMock(return_value=mock_pg),
        ):
            # Must NOT raise — drain loop assumes stable return.
            n = await service.process_pending_deliveries()

        assert n == 0


class TestProcessPendingDeliveriesScheduleFailureIsolated:
    """A failure scheduling one row must not block the rest of the tick."""

    @pytest.mark.asyncio
    async def test_other_rows_still_processed(self) -> None:
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()
        rows = [
            _make_row("d-bad", payload={"event_type": "bad"}),
            _make_row("d-good", payload={"event_type": "good"}),
        ]
        mock_pg = MagicMock()
        mock_pg.fetch = AsyncMock(return_value=rows)

        def flaky_schedule(*, delivery_id, url, secret, payload):
            if delivery_id == "d-bad":
                raise RuntimeError("schedule blew up")
            task = asyncio.create_task(asyncio.sleep(0))
            service._in_flight.add(task)
            task.add_done_callback(service._in_flight.discard)
            return task

        try:
            with patch(
                "eden.services.webhook_delivery.get_postgres_client",
                new=AsyncMock(return_value=mock_pg),
            ), patch.object(
                service,
                "_schedule_delivery",
                side_effect=flaky_schedule,
            ):
                n = await service.process_pending_deliveries()

            # Only the good row succeeded.
            assert n == 1
        finally:
            for t in list(service._in_flight):
                if not t.done():
                    t.cancel()
            with contextlib.suppress(Exception):
                await asyncio.gather(
                    *service._in_flight, return_exceptions=True
                )


class TestProcessPendingDeliveriesPayloadDecoding:
    """``webhook_deliveries.payload`` is JSONB; in some legacy
    paths the value may arrive as a JSON-encoded string. Both
    forms must reach the scheduler as a dict."""

    @pytest.mark.asyncio
    async def test_dict_payload_passes_through(self) -> None:
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()
        captured: list[object] = []

        def capture(*, delivery_id, url, secret, payload):
            captured.append(payload)
            task = asyncio.create_task(asyncio.sleep(0))
            service._in_flight.add(task)
            task.add_done_callback(service._in_flight.discard)
            return task

        try:
            row = _make_row("d-1", payload={"event_type": "ok"})
            mock_pg = MagicMock()
            mock_pg.fetch = AsyncMock(return_value=[row])

            with patch(
                "eden.services.webhook_delivery.get_postgres_client",
                new=AsyncMock(return_value=mock_pg),
            ), patch.object(
                service, "_schedule_delivery", side_effect=capture,
            ):
                n = await service.process_pending_deliveries()

            assert n == 1
            assert captured == [{"event_type": "ok"}]
        finally:
            for t in list(service._in_flight):
                if not t.done():
                    t.cancel()
            with contextlib.suppress(Exception):
                await asyncio.gather(
                    *service._in_flight, return_exceptions=True
                )

    @pytest.mark.asyncio
    async def test_string_payload_is_decoded(self) -> None:
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()
        captured: list[object] = []

        def capture(*, delivery_id, url, secret, payload):
            captured.append(payload)
            task = asyncio.create_task(asyncio.sleep(0))
            service._in_flight.add(task)
            task.add_done_callback(service._in_flight.discard)
            return task

        try:
            row = _make_row("d-1", payload='{"event_type":"late"}')
            mock_pg = MagicMock()
            mock_pg.fetch = AsyncMock(return_value=[row])

            with patch(
                "eden.services.webhook_delivery.get_postgres_client",
                new=AsyncMock(return_value=mock_pg),
            ), patch.object(
                service, "_schedule_delivery", side_effect=capture,
            ):
                n = await service.process_pending_deliveries()

            assert n == 1
            assert captured == [{"event_type": "late"}]
        finally:
            for t in list(service._in_flight):
                if not t.done():
                    t.cancel()
            with contextlib.suppress(Exception):
                await asyncio.gather(
                    *service._in_flight, return_exceptions=True
                )


class TestWorkerDrainLoopFindsTheMethod:
    """The worker module imports ``WebhookDeliveryService``
    and calls ``process_pending_deliveries``. Pin that the
    reference still exists so a refactor that drops the method
    again is caught at test time.
    """

    def test_worker_drain_loop_calls_process_pending(self) -> None:
        import inspect

        from eden.workers import main as worker_main

        src = inspect.getsource(worker_main)
        assert "process_pending_deliveries" in src
        assert "_webhook_drain_loop" in src
        # The bug was that the call existed in the worker
        # before the method did — pin the call shape.
        assert "svc.process_pending_deliveries" in src


class TestF57AppShutdownReleasesWebhookPool:
    """F57 — ``eden.api.app.lifespan`` must call
    ``aclose()`` on the ``WebhookDeliveryService`` singleton
    so the keep-alive socket pool is released on pod restart.
    The previous behaviour leaked the pool across restarts and
    cost a TCP/TLS handshake on the first request after every
    redeploy.
    """

    def test_lifespan_closes_singleton_webhook_pool(self) -> None:
        import inspect

        from eden.api import app as app_module

        src = inspect.getsource(app_module.lifespan)
        # Lifespan calls aclose() on the singleton accessor.
        assert "get_webhook_delivery_service" in src
        assert ".aclose()" in src

    def test_singleton_aclose_is_idempotent(self) -> None:
        """Calling aclose() before any HTTP client is created
        (and again after) must be a no-op. The FastAPI lifespan
        runs in many test paths and must not raise if the pool
        was never created.
        """
        import asyncio

        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
            reset_webhook_delivery_service,
        )

        reset_webhook_delivery_service()
        svc = WebhookDeliveryService()

        async def twice():
            await svc.aclose()
            await svc.aclose()

        # MUST NOT raise.
        asyncio.run(twice())

    def test_singleton_accessor_returns_same_instance(self) -> None:
        """The accessor is a true singleton — repeated calls
        return the same instance so its ``_http_client`` can
        be released once at shutdown instead of N times.
        """
        from eden.services.webhook_delivery import (
            get_webhook_delivery_service,
            reset_webhook_delivery_service,
        )

        reset_webhook_delivery_service()
        a = get_webhook_delivery_service()
        b = get_webhook_delivery_service()
        assert a is b
