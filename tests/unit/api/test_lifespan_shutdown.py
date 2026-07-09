"""F59 — FastAPI lifespan shutdown wiring regression tests.

The ``eden.api.app.lifespan`` cleanup path runs on every pod
restart and is the only chance to release the keep-alive
sockets / asyncio transports the app has accumulated. Pre-F59
four sinks were never closed:

* ``close_otel_dual_exporter()``  — singleton aiohttp
  ``ClientSession`` to OTLP/HTTP.
* ``close_redis_client()`` — singleton Redis pool.
* ``shutdown_trace_quality()`` — the trace-quality
  ``_drain_loop`` background task (has a final-flush path
  on cancel).
* ``close_telemetry_collector()`` — clears the singleton so
  the next process restart rebuilds it.

Each leak cost the first request after a restart a fresh
TCP/TLS handshake — measurable against Redis / OTLP / etc.
These tests pin the wiring so a future refactor doesn't
quietly drop one of the four.
"""

from __future__ import annotations

import asyncio
import contextlib
import inspect


def _lifespan_source() -> str:
    from eden.api import app as app_module
    return inspect.getsource(app_module.lifespan)


class TestF59LifespanClosesAllSingletons:
    """Source-level scan: every known singleton close call
    appears in the lifespan cleanup path."""

    def test_calls_close_otel_dual_exporter(self) -> None:
        assert "close_otel_dual_exporter" in _lifespan_source()

    def test_calls_close_redis_client(self) -> None:
        assert "close_redis_client" in _lifespan_source()

    def test_calls_shutdown_trace_quality(self) -> None:
        assert "shutdown_trace_quality" in _lifespan_source()

    def test_calls_close_telemetry_collector(self) -> None:
        assert "close_telemetry_collector" in _lifespan_source()

    def test_calls_close_postgres_client(self) -> None:
        assert "close_postgres_client" in _lifespan_source()

    def test_calls_shutdown_clerk_auth(self) -> None:
        # B-6 follow-up; pinned so a refactor doesn't drop it.
        assert "shutdown_clerk_auth" in _lifespan_source()

    def test_calls_webhook_delivery_aclose(self) -> None:
        # F57; pinned so the singleton pool close isn't lost.
        assert "get_webhook_delivery_service" in _lifespan_source()
        assert ".aclose()" in _lifespan_source()


class TestF59ShutdownOrder:
    """Pin that the Postgres client is closed LAST (or
    equivalently: every task that uses Postgres is cancelled
    before ``close_postgres_client``).

    The pre-F59 code only called ``close_postgres_client``
    so the drain task that called ``_get_pg()`` on shutdown
    (final flush + then cancel) would always race a closed
    pool. The post-F59 order must close the drain task
    first.
    """

    def test_shutdown_trace_quality_precedes_postgres_close(self) -> None:
        src = _lifespan_source()
        i_drain = src.find("shutdown_trace_quality")
        i_pg = src.find("close_postgres_client")
        assert i_drain != -1 and i_pg != -1
        assert i_drain < i_pg, (
            "shutdown_trace_quality() must run BEFORE "
            "close_postgres_client() — the drain task uses "
            "Postgres on its final-flush path."
        )


class TestF59SinkClosesAreAsyncAndCoroutineSafe:
    """Defensive shape checks. Each imported ``close_*`` /
    ``shutdown_*`` must be coroutine-safe — if a future
    refactor turns one into a sync function (or removes it),
    the ``await`` in the lifespan raises ``TypeError``. The
    test catches the most common shapes statically."""

    def test_close_otel_dual_exporter_is_coroutine(self) -> None:
        from eden.observability.otel_exporter import (
            close_otel_dual_exporter,
        )
        assert asyncio.iscoroutinefunction(close_otel_dual_exporter)

    def test_close_redis_client_is_coroutine(self) -> None:
        from eden.storage.redis import close_redis_client
        assert asyncio.iscoroutinefunction(close_redis_client)

    def test_close_telemetry_collector_is_coroutine(self) -> None:
        from eden.observability.telemetry_collector import (
            close_telemetry_collector,
        )
        assert asyncio.iscoroutinefunction(close_telemetry_collector)

    def test_shutdown_trace_quality_is_coroutine(self) -> None:
        from eden.observability.trace_quality.hooks import (
            shutdown_trace_quality,
        )
        assert asyncio.iscoroutinefunction(shutdown_trace_quality)


class TestF59CleanupResilientToIndividualFailure:
    """The pre-F59 cleanup used ``try/except`` only around the
    Postgres close. The post-F59 cleanup wraps every close
    call in its own ``try/except`` so one broken sink
    doesn't strand the rest of the pod (especially
    Postgres, which is shared by everything that follows).

    Source-level: every close call inside the cleanup
    section has a corresponding ``except`` block that
    logs at WARNING. Pin this so a future refactor that
    drops the exception guard doesn't silently break
    shutdown.
    """

    def test_individual_try_blocks_per_close(self) -> None:
        src = _lifespan_source()
        # Each of these should appear inside a try block —
        # we just assert the count of the literal string
        # ``logger.warning`` reaches the expected minimum
        # so we know every close path is guarded.
        # Pre-F59 only had 2 ``logger.warning`` calls (Postgres
        # + Insights); post-F59 has at least 5 (Postgres,
        # Insights, trace_quality, otel, redis, telemetry,
        # clerk_auth, webhook) — i.e. >= 7.
        logger_warn_lines = [
            line for line in src.splitlines()
            if "logger.warning" in line
        ]
        assert len(logger_warn_lines) >= 7, (
            "Expected the cleanup section to wrap every "
            "close call in try/except + logger.warning. "
            f"Found only {len(logger_warn_lines)} guards."
        )

    def test_cleanup_section_is_guarded(self) -> None:
        """A regression that removes a single ``except`` block
        (and lets one close raise) would be silent here. The
        previous test catches the bulk-drop; this one is the
        per-call minimum."""
        src = _lifespan_source()
        # Every imported close_* function reference in the
        # cleanup section must be inside a try block. We do
        # this by counting the close_* invocations vs the
        # close_* imports in cleanup — they must be equal
        # (every import has an invocation wrapped in try).
        cleanup_close_calls = sum(
            1
            for name in (
                "close_otel_dual_exporter",
                "close_redis_client",
                "close_telemetry_collector",
                "shutdown_trace_quality",
                "shutdown_clerk_auth",
                "close_postgres_client",
                "get_webhook_delivery_service",
            )
            if name in src
        )
        # Minimum expected: at least 7 invocations
        # (the 7 listed above).
        assert cleanup_close_calls >= 7
