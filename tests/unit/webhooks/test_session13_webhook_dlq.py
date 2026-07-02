"""Session 13 tests — Webhook DLQ hardening (DL-4, DL-5, DL-6, DL-7, DL-8).

Five audit items:

* **DL-4** — ``webhook_delivery._move_to_dlq`` logged failures
  at DEBUG. On-call never saw them when a delivery
  silently dropped into limbo. Fix: promote to ERROR and
  include ``delivery_id`` for correlation.

* **DL-5** — ``_attempt_delivery`` scheduled retries with
  ``await asyncio.sleep(delay)`` in the same task. The
  longest retry delay is 1h — that single task pinned a
  worker for up to 75 minutes (initial + 6 retries).
  Fix: use ``loop.call_later`` so the current task ends
  and a fresh task is created when the timer fires.

* **DL-6** — All delivery tasks were fire-and-forget
  ``asyncio.create_task(...)`` calls — never tracked.
  On shutdown, half-dispatched HTTP requests were
  abandoned. Fix: track in ``self._in_flight`` + provide
  a ``drain()`` method the FastAPI lifespan handler can
  call.

* **DL-7** — ``_attempt_delivery`` did
  ``fetchrow`` → ``UPDATE`` — a race window let two
  workers claim the same row and double-dispatch.
  Fix: atomic CAS via ``UPDATE … RETURNING`` that only
  matches ``status IN ('pending','retrying')``. A row
  not returned means another worker already claimed it.

* **DL-8** — ``replay_dlq`` had no upper bound on
  ``replay_count`` and no minimum gap between replays.
  A broken consumer endpoint could be hammered.
  Fix: cap ``replay_count`` at 3; require 60s between
  replays.
"""

from __future__ import annotations

import asyncio
import logging
from unittest.mock import AsyncMock, MagicMock, patch

import pytest


# ─── DL-4: _move_to_dlq logs at ERROR with delivery_id ────────────
class TestDl4MoveToDlqLogging:
    """Pre-fix: _move_to_dlq swallowed exceptions at DEBUG.
    A delivery that couldn't be archived vanished without
    a trace. Post-fix: ERROR + delivery_id in the log."""

    @pytest.mark.asyncio
    async def test_move_to_dlq_logs_error_on_failure(
        self, caplog,
    ) -> None:
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()

        # Patch get_postgres_client to raise on first call.
        with patch(
            "eden.services.webhook_delivery.get_postgres_client",
            new=AsyncMock(
                side_effect=RuntimeError("pg unreachable"),
            ),
        ):
            with caplog.at_level(
                logging.ERROR, logger="eden.services.webhook_delivery",
            ):
                # MUST NOT raise — _move_to_dlq swallows.
                await service._move_to_dlq(
                    "delivery-123",
                    webhook_id="wh-1",
                )

        # Find the error-level log.
        error_logs = [
            r for r in caplog.records if r.levelno == logging.ERROR
        ]
        assert error_logs, (
            "DL-4 regression: _move_to_dlq did not log at ERROR"
        )
        assert any(
            "delivery-123" in r.getMessage()
            for r in error_logs
        ), (
            "DL-4 regression: log missing delivery_id "
            "(needed for on-call correlation)"
        )

    @pytest.mark.asyncio
    async def test_move_to_dlq_logs_no_error_on_success(
        self, caplog,
    ) -> None:
        """Happy path: no ERROR log emitted."""
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()

        fake_client = MagicMock()
        fake_client.fetchrow = AsyncMock(
            return_value={
                "id": "delivery-ok",
                "webhook_id": "wh-1",
                "event_type": "job.completed",
                "payload": "{}",
                "response_status": 500,
                "error_message": "boom",
                "attempt_count": 7,
                "max_attempts": 7,
                "created_at": "2026-06-27T00:00:00Z",
                "signature_v1": "t=1,v1=x",
                "webhook_org_id": "org-1",
            }
        )
        fake_client.execute = AsyncMock()

        with patch(
            "eden.services.webhook_delivery.get_postgres_client",
            new=AsyncMock(return_value=fake_client),
        ):
            with caplog.at_level(
                logging.ERROR,
                logger="eden.services.webhook_delivery",
            ):
                await service._move_to_dlq(
                    "delivery-ok", webhook_id="wh-1",
                )

        error_logs = [
            r for r in caplog.records if r.levelno == logging.ERROR
        ]
        assert not error_logs


# ─── DL-5: retry uses loop.call_later, not asyncio.sleep ───────────
class TestDl5RetryScheduling:
    """Pre-fix: the retry tail did ``await asyncio.sleep(delay)``
    in the same task — pinned a worker for up to 1h.
    Post-fix: ``loop.call_later`` ends the current task and
    schedules a fresh one."""

    @pytest.mark.asyncio
    async def test_retry_uses_call_later(
        self, mock_postgres_client: MagicMock,
    ) -> None:
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
            _RETRY_DELAYS,
        )

        service = WebhookDeliveryService()

        # CAS succeeds (DL-7 path) → attempt 1 → 503 → retry.
        mock_postgres_client.fetchrow = AsyncMock(
            return_value={
                "attempt_count": 0,
                "max_attempts": len(_RETRY_DELAYS),
                "webhook_id": "wh-1",
            }
        )

        # Fake httpx that returns 503.
        fake_response = MagicMock()
        fake_response.status_code = 503
        fake_response.text = "service unavailable"

        fake_http = MagicMock()
        fake_http.post = AsyncMock(return_value=fake_response)

        class _FakeAsyncClient:
            """Mock of httpx.AsyncClient — exposes post() directly.

            Real httpx.AsyncClient.post() is callable without an
            ``async with`` (the context manager only manages
            cleanup). The previous fake required ``async with`` to
            reach ``.post``, which the production code never does.
            """

            def post(self, *args, **kwargs):
                return fake_http.post(*args, **kwargs)

        fake_httpx = MagicMock()
        fake_httpx.AsyncClient = MagicMock(return_value=_FakeAsyncClient())

        # Capture call_later invocations.
        call_later_calls: list[tuple] = []

        real_loop = asyncio.get_running_loop()

        def _capture_call_later(delay, callback, *args):
            call_later_calls.append((delay, callback, args))
            # Return a no-op handle so the test doesn't leak timers.
            return MagicMock()

        with patch(
            "eden.services.webhook_delivery._get_httpx",
            return_value=fake_httpx,
        ):
            with patch.object(
                real_loop, "call_later",
                side_effect=_capture_call_later,
            ):
                with patch(
                    "eden.services.webhook_delivery."
                    "_assert_public_ip",
                ):
                    await service._attempt_delivery(
                        delivery_id="d-1",
                        url="https://example.com/hook",
                        secret="secret",
                        payload={"event": "job.completed"},
                    )

        # DL-5: at least one call_later was made for the retry.
        assert call_later_calls, (
            "DL-5 regression: retry path did not use loop.call_later "
            "(worker would be pinned for the full retry delay)"
        )
        # The first retry delay after attempt 1 is _RETRY_DELAYS[1] = 1s.
        delay, _cb, _args = call_later_calls[0]
        assert delay == _RETRY_DELAYS[1]

    @pytest.mark.asyncio
    async def test_retry_does_not_await_sleep(
        self, mock_postgres_client: MagicMock,
    ) -> None:
        """Static check: the post-fix code MUST NOT contain
        ``await asyncio.sleep(delay)`` as executable code in
        ``_attempt_delivery``. (Comments referencing the bug
        are fine — we strip comment lines before matching.)
        """
        from pathlib import Path

        src = Path(
            "src/eden/services/webhook_delivery.py"
        ).read_text()
        # Find the body of _attempt_delivery (between its def
        # line and the next top-level method).
        start = src.find("async def _attempt_delivery")
        body_start = src.find(":\n", start)
        rest = src[body_start:]
        next_method = rest.find("\n    async def ")
        next_def = rest.find("\n    def ")
        end = min(
            x for x in (next_method, next_def) if x > 0
        )
        # Strip comment-only lines so the audit comment about
        # the old bug doesn't trip the static check.
        executable = "\n".join(
            ln for ln in rest[:end].splitlines()
            if not ln.lstrip().startswith("#")
        )
        assert "await asyncio.sleep" not in executable, (
            "DL-5 regression: _attempt_delivery contains "
            "'await asyncio.sleep' as executable code — "
            "worker pinning bug is back"
        )
        assert "loop.call_later" in executable, (
            "DL-5 regression: _attempt_delivery does not call "
            "loop.call_later for retry scheduling"
        )


# ─── DL-6: in-flight task tracking + drain ─────────────────────────
class TestDl6InFlightTracking:
    """Pre-fix: delivery tasks were
    ``asyncio.create_task(...)`` fire-and-forget. On
    shutdown, half-dispatched HTTP requests were lost.
    Post-fix: tasks are tracked in ``self._in_flight`` and
    ``drain()`` waits for them on shutdown."""

    @pytest.mark.asyncio
    async def test_in_flight_set_starts_empty(self) -> None:
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()
        assert service._in_flight == set()

    @pytest.mark.asyncio
    async def test_schedule_delivery_adds_to_in_flight(
        self, mock_postgres_client: MagicMock,
    ) -> None:
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()

        # CAS succeeds → 200 → task completes → set drains.
        mock_postgres_client.fetchrow = AsyncMock(
            return_value={
                "attempt_count": 0,
                "max_attempts": 7,
                "webhook_id": "wh-1",
            }
        )

        fake_response = MagicMock()
        fake_response.status_code = 200
        fake_response.text = "ok"

        fake_http = MagicMock()
        fake_http.post = AsyncMock(return_value=fake_response)

        class _FakeAsyncClient:
            """Mock of httpx.AsyncClient — exposes post() directly.

            Real httpx.AsyncClient.post() is callable without an
            ``async with`` (the context manager only manages
            cleanup). The previous fake required ``async with`` to
            reach ``.post``, which the production code never does.
            """

            def post(self, *args, **kwargs):
                return fake_http.post(*args, **kwargs)

        fake_httpx = MagicMock()
        fake_httpx.AsyncClient = MagicMock(return_value=_FakeAsyncClient())

        with patch(
            "eden.services.webhook_delivery._get_httpx",
            return_value=fake_httpx,
        ):
            with patch(
                "eden.services.webhook_delivery._assert_public_ip",
            ):
                task = service._schedule_delivery(
                    delivery_id="d-track",
                    url="https://example.com/hook",
                    secret="secret",
                    payload={"event": "job.completed"},
                )

        # Yield once so the task runs and removes itself.
        await asyncio.sleep(0)
        await task

        # Task drained itself via done_callback.
        assert len(service._in_flight) == 0

    @pytest.mark.asyncio
    async def test_drain_returns_zero_when_no_tasks(self) -> None:
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()
        drained = await service.drain(timeout=1.0)
        assert drained == 0

    @pytest.mark.asyncio
    async def test_drain_returns_zero_after_tasks_complete(
        self,
    ) -> None:
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()

        # Add a finished task — done_callback already fired.
        async def _noop():
            return None

        t = asyncio.create_task(_noop())
        service._in_flight.add(t)
        await t  # ensure done

        # Give the done_callback a tick to run.
        await asyncio.sleep(0)

        drained = await service.drain(timeout=1.0)
        assert drained == 0

    @pytest.mark.asyncio
    async def test_drain_returns_count_on_timeout(self) -> None:
        """If a task is still running past the timeout,
        ``drain`` returns the count and warns. The task
        stays in the set for the next process."""
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()

        # A task that hangs forever. Wrap with create_task
        # so we can cancel it ourselves at the end of the
        # test.
        hang_started = asyncio.Event()

        async def _hang():
            hang_started.set()
            await asyncio.sleep(60)

        t = asyncio.create_task(_hang())
        service._in_flight.add(t)
        # Wait until the hang task is actually scheduled
        # so the drain sees a running task, not a pending
        # one (asyncio.wait_for only races once the inner
        # future is awaiting).
        await hang_started.wait()

        try:
            # Short timeout — drain should catch the
            # TimeoutError and count the still-running task.
            drained = await service.drain(timeout=0.1)
            assert drained == 1, (
                f"expected drain to return 1 (one still-"
                f"running task), got {drained}"
            )
            # Task is still in the set (will be cleaned up
            # by the GC after the test).
            assert t in service._in_flight
        finally:
            t.cancel()
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass


# ─── DL-7: atomic compare-and-set for _attempt_delivery ─────────────
class TestDl7AtomicCas:
    """Pre-fix: fetchrow then UPDATE — a race window let
    two workers double-dispatch. Post-fix: UPDATE returns
    the row only if status is still pending/retrying."""

    @pytest.mark.asyncio
    async def test_attempt_delivery_skips_when_already_claimed(
        self, mock_postgres_client: MagicMock,
    ) -> None:
        """If the CAS UPDATE returns nothing (row already in
        a terminal state, or another worker claimed it),
        _attempt_delivery silently returns — no HTTP POST."""
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()

        # fetchrow returns None — CAS didn't match.
        mock_postgres_client.fetchrow = AsyncMock(return_value=None)

        fake_httpx = MagicMock()
        fake_httpx.AsyncClient = MagicMock()

        with patch(
            "eden.services.webhook_delivery._get_httpx",
            return_value=fake_httpx,
        ):
            await service._attempt_delivery(
                delivery_id="d-cas",
                url="https://example.com/hook",
                secret="secret",
                payload={"event": "job.completed"},
            )

        # CRITICAL: no HTTP client was instantiated.
        fake_httpx.AsyncClient.assert_not_called()

    @pytest.mark.asyncio
    async def test_attempt_delivery_cas_sql_includes_status_filter(
        self, mock_postgres_client: MagicMock,
    ) -> None:
        """Static + behavioural check: the SQL emitted is an
        UPDATE ... SET status='in_flight' WHERE id=$1 AND
        status IN ('pending','retrying') RETURNING ... — not
        a SELECT followed by a separate UPDATE (which would
        leave a race window)."""
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()

        captured_sql: list[str] = []

        async def _capture(sql, *args):
            captured_sql.append(sql)
            # CAS succeeded — return a row.
            return {
                "attempt_count": 0,
                "max_attempts": 7,
                "webhook_id": "wh-1",
            }

        mock_postgres_client.fetchrow = AsyncMock(side_effect=_capture)

        # Fake 200 to make _attempt_delivery exit cleanly
        # without needing more mock setup.
        fake_response = MagicMock()
        fake_response.status_code = 200
        fake_response.text = "ok"
        fake_http = MagicMock()
        fake_http.post = AsyncMock(return_value=fake_response)

        class _CM:
            async def __aenter__(self):
                return fake_http

            async def __aexit__(self, *a):
                return None

        fake_httpx = MagicMock()
        fake_httpx.AsyncClient = MagicMock(return_value=_CM())

        with patch(
            "eden.services.webhook_delivery._get_httpx",
            return_value=fake_httpx,
        ):
            with patch(
                "eden.services.webhook_delivery._assert_public_ip",
            ):
                await service._attempt_delivery(
                    delivery_id="d-cas2",
                    url="https://example.com/hook",
                    secret="secret",
                    payload={"event": "job.completed"},
                )

        assert len(captured_sql) == 1, (
            "DL-7 regression: expected ONE CAS query, not the "
            "old fetchrow + UPDATE pair"
        )
        sql = " ".join(captured_sql[0].split())
        assert "UPDATE webhook_deliveries" in sql, (
            "DL-7 regression: first query is not an UPDATE"
        )
        assert "status = 'in_flight'" in sql
        assert "status IN ('pending', 'retrying')" in sql
        assert "RETURNING" in sql


# ─── DL-8: replay cap + rate limit ──────────────────────────────────
class TestDl8ReplayCap:
    """Pre-fix: replay_dlq had no upper bound on
    replay_count and no minimum gap between replays.
    Post-fix: cap at 3, require 60s between."""

    @pytest.mark.asyncio
    async def test_replay_refused_when_count_at_cap(
        self, mock_postgres_client: MagicMock,
    ) -> None:
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()

        # replay_count = 3 (already at the cap).
        mock_postgres_client.fetchrow = AsyncMock(
            return_value={
                "id": "dlq-1",
                "webhook_id": "wh-1",
                "event_type": "job.completed",
                "payload": "{}",
                "replay_count": 3,
                "signature_v1": "t=1,v1=x",
                "last_replayed_at": None,
                "seconds_since_last_replay": None,
            }
        )

        result = await service.replay_dlq("dlq-1")

        assert result["status"] == "replay_cap_reached"
        assert result["replay_count"] == 3
        assert result["max_replay_count"] == 3

    @pytest.mark.asyncio
    async def test_replay_refused_when_too_soon(
        self, mock_postgres_client: MagicMock,
    ) -> None:
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()

        # replay_count = 1, only 5s since last replay (under 60s).
        mock_postgres_client.fetchrow = AsyncMock(
            return_value={
                "id": "dlq-2",
                "webhook_id": "wh-1",
                "event_type": "job.completed",
                "payload": "{}",
                "replay_count": 1,
                "signature_v1": "t=1,v1=x",
                "last_replayed_at": "2026-06-27T00:00:00Z",
                "seconds_since_last_replay": 5.0,
            }
        )

        result = await service.replay_dlq("dlq-2")

        assert result["status"] == "replay_rate_limited"
        assert result["seconds_since_last_replay"] == 5.0
        assert result["min_replay_gap_seconds"] == 60

    @pytest.mark.asyncio
    async def test_replay_proceeds_when_under_cap_and_gap_ok(
        self, mock_postgres_client: MagicMock,
    ) -> None:
        """Happy path: count below cap + gap above 60s."""
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()

        # First fetchrow returns the DLQ row.
        # Second fetchrow returns the webhook.
        call_count = {"n": 0}

        async def _fetchrow(sql, *args):
            call_count["n"] += 1
            if call_count["n"] == 1:
                return {
                    "id": "dlq-3",
                    "webhook_id": "wh-1",
                    "event_type": "job.completed",
                    "payload": "{}",
                    "replay_count": 0,
                    "signature_v1": "t=1,v1=x",
                    "last_replayed_at": None,
                    "seconds_since_last_replay": None,
                }
            return {
                "url": "https://example.com/hook",
                "secret": "secret",
            }

        mock_postgres_client.fetchrow = AsyncMock(side_effect=_fetchrow)
        mock_postgres_client.execute = AsyncMock()

        result = await service.replay_dlq("dlq-3")

        assert result["status"] == "ok"
        assert result["dlq_id"] == "dlq-3"
        assert result["replay_count"] == 1

    @pytest.mark.asyncio
    async def test_replay_not_found_returns_not_found(
        self, mock_postgres_client: MagicMock,
    ) -> None:
        from eden.services.webhook_delivery import (
            WebhookDeliveryService,
        )

        service = WebhookDeliveryService()
        mock_postgres_client.fetchrow = AsyncMock(return_value=None)

        result = await service.replay_dlq("dlq-missing")
        assert result["status"] == "not_found"
        assert result["dlq_id"] == "dlq-missing"
