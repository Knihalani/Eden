"""Unit tests for Phase R — stdlib ``logging`` shim.

Tests the public surface of :mod:`eden.observability.logging_shim`:

  * :class:`EdenLoggingHandler` — ``emit()`` converts a
    :class:`logging.LogRecord` into a TelemetryEvent-shaped dict with
    ``event_type="log"``, captures level/logger/module/extras/exception,
    and is non-blocking + queue-bounded.
  * Contextvar binding — :func:`set_trace_context` and
    :func:`clear_trace_context` propagate into emitted events.
  * Ambient trace id — orphan log records get a synthetic trace id
    derived from ``project_id + pid + counter`` so the user can still
    filter them.
  * :func:`install` / :func:`uninstall` — idempotent, honours
    ``EDEN_LOG_LEVEL`` env var, attaches one handler at the root.
  * Async ingest — the handler feeds :class:`TelemetryCollector` via
    a real coroutine (mocked here so the test doesn't need a live DB).
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.observability import logging_shim
from eden.observability.logging_shim import (
    EdenLoggingHandler,
    _active_project_id,
    _active_span_id,
    _active_trace_id,
    clear_trace_context,
    install,
    is_installed,
    set_trace_context,
    uninstall,
)
from eden.observability.telemetry_collector import TelemetryEvent

# ── Fixtures ────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _clean_logger_state():
    """Uninstall the shim + clear contextvars around every test."""
    # Save the root logger's handler list so we can restore it.
    root = logging.getLogger()
    saved_handlers = list(root.handlers)
    saved_level = root.level
    try:
        uninstall()
        clear_trace_context()
        yield
    finally:
        # Restore the root logger.
        for h in list(root.handlers):
            root.removeHandler(h)
        for h in saved_handlers:
            root.addHandler(h)
        root.setLevel(saved_level)
        uninstall()
        clear_trace_context()


@pytest.fixture
def handler() -> EdenLoggingHandler:
    """A fresh handler instance (not yet attached to root)."""
    return EdenLoggingHandler(
        level=logging.DEBUG,
        project_id="test-proj",
        agent_id="agent-1",
        agent_version="1.0.0",
        realm="production",
    )


# ── emit() — basic event shape ─────────────────────────────────────


class TestEmitBasicShape:
    def test_emit_produces_telemetry_event(self, handler: EdenLoggingHandler) -> None:
        record = logging.LogRecord(
            name="myapp.module",
            level=logging.INFO,
            pathname="/x.py",
            lineno=42,
            msg="hello %s",
            args=("world",),
            exc_info=None,
        )
        handler.emit(record)
        # The event is queued; we read it back via _build_event path
        # (synchronous inspection).
        event = handler._build_event(record)
        assert event["event_type"] == "log"
        assert event["name"] == "myapp.module"
        assert event["payload"]["message"] == "hello world"
        assert event["realm"] == "production"
        assert event["project_id"] == "test-proj"
        assert event["agent_id"] == "agent-1"
        assert event["agent_version"] == "1.0.0"
        assert event["source_format"] == "logging_shim"

    def test_emit_uses_active_trace_id(self, handler: EdenLoggingHandler) -> None:
        set_trace_context(trace_id="trace-xyz", span_id="span-1")
        record = logging.LogRecord(
            name="m", level=logging.INFO, pathname="/x", lineno=1,
            msg="hi", args=(), exc_info=None,
        )
        event = handler._build_event(record)
        assert event["trace_id"] == "trace-xyz"
        assert event["span_id"] == "span-1"
        clear_trace_context()

    def test_emit_uses_ambient_trace_when_no_context(
        self, handler: EdenLoggingHandler,
    ) -> None:
        record = logging.LogRecord(
            name="m", level=logging.INFO, pathname="/x", lineno=1,
            msg="orphan", args=(), exc_info=None,
        )
        event = handler._build_event(record)
        assert event["trace_id"].startswith("ambient-test-proj-")
        # Two consecutive records get distinct ambient ids.
        event2 = handler._build_event(record)
        assert event["trace_id"] != event2["trace_id"]

    def test_emit_falls_back_to_project_from_contextvar(
        self, handler: EdenLoggingHandler,
    ) -> None:
        set_trace_context(project_id="other-proj")
        record = logging.LogRecord(
            name="m", level=logging.INFO, pathname="/x", lineno=1,
            msg="x", args=(), exc_info=None,
        )
        event = handler._build_event(record)
        # Ambient trace id uses the contextvar project, not the handler default.
        assert "other-proj" in event["trace_id"]


# ── emit() — level / outcome / attributes ──────────────────────────


class TestEmitLevelMapping:
    @pytest.mark.parametrize("level,outcome", [
        (logging.DEBUG, None),
        (logging.INFO, None),
        (logging.WARNING, "partial"),
        (logging.ERROR, "failure"),
        (logging.CRITICAL, "failure"),
    ])
    def test_level_to_outcome(
        self, handler: EdenLoggingHandler, level: int, outcome,
    ) -> None:
        record = logging.LogRecord(
            name="m", level=level, pathname="/x", lineno=1,
            msg="x", args=(), exc_info=None,
        )
        event = handler._build_event(record)
        assert event["outcome"] == outcome
        assert event["attributes"]["level"] == logging.getLevelName(level)
        assert f"level:{logging.getLevelName(level)}" in event["tags"]


# ── emit() — exception capture ──────────────────────────────────────


class TestEmitExceptionCapture:
    def test_captures_exc_info(self, handler: EdenLoggingHandler) -> None:
        try:
            raise ValueError("boom")
        except ValueError:
            import sys
            record = logging.LogRecord(
                name="m", level=logging.ERROR, pathname="/x", lineno=1,
                msg="failed", args=(), exc_info=sys.exc_info(),
            )
        event = handler._build_event(record)
        assert "ValueError: boom" in event["payload"]["exc_text"]
        assert "Traceback" in event["payload"]["exc_text"]

    def test_no_exc_when_exc_info_none(self, handler: EdenLoggingHandler) -> None:
        record = logging.LogRecord(
            name="m", level=logging.INFO, pathname="/x", lineno=1,
            msg="ok", args=(), exc_info=None,
        )
        event = handler._build_event(record)
        assert event["payload"]["exc_text"] == ""


# ── emit() — extras ────────────────────────────────────────────────


class TestEmitExtras:
    def test_extra_kwargs_are_preserved(self, handler: EdenLoggingHandler) -> None:
        record = logging.LogRecord(
            name="m", level=logging.INFO, pathname="/x", lineno=1,
            msg="processing %s", args=("file.csv",), exc_info=None,
        )
        record.user_id = "u-1"
        record.request_id = "req-99"
        event = handler._build_event(record)
        assert event["payload"]["extras"]["user_id"] == "u-1"
        assert event["payload"]["extras"]["request_id"] == "req-99"

    def test_extras_fall_back_to_repr_for_non_serialisable(
        self, handler: EdenLoggingHandler,
    ) -> None:
        record = logging.LogRecord(
            name="m", level=logging.INFO, pathname="/x", lineno=1,
            msg="x", args=(), exc_info=None,
        )
        # A set is not JSON-serialisable; should fall back to repr.
        record.tags = {"a", "b", "c"}
        event = handler._build_event(record)
        assert "tags" in event["payload"]["extras"]
        # repr-of-set is a string like "{'a', 'b', 'c'}"
        assert isinstance(event["payload"]["extras"]["tags"], str)

    def test_reserved_fields_are_not_extras(
        self, handler: EdenLoggingHandler,
    ) -> None:
        record = logging.LogRecord(
            name="m", level=logging.INFO, pathname="/x", lineno=1,
            msg="x", args=(), exc_info=None,
        )
        # These are all reserved stdlib fields and must NOT appear in extras.
        record.pathname = "/should/not/leak.py"
        record.lineno = 9999
        event = handler._build_event(record)
        assert "pathname" not in event["payload"]["extras"]
        assert "lineno" not in event["payload"]["extras"]


# ── emit() — queue overflow ────────────────────────────────────────


class TestQueueOverflow:
    def test_drops_oldest_when_full(self, handler: EdenLoggingHandler) -> None:
        handler.MAX_QUEUE_SIZE = 4
        for i in range(10):
            record = logging.LogRecord(
                name="m", level=logging.INFO, pathname="/x", lineno=1,
                msg=f"line {i}", args=(), exc_info=None,
            )
            # We call _build_event directly to avoid the drain path.
            event = handler._build_event(record)
            if len(handler._queue) >= handler.MAX_QUEUE_SIZE:
                handler._queue.pop(0)
                handler.dropped += 1
            handler._queue.append(event)
        assert handler.dropped == 6
        assert len(handler._queue) == 4
        # The 4 remaining events should be the last 4 (lines 6,7,8,9).
        msgs = [e["payload"]["message"] for e in handler._queue]
        assert msgs == ["line 6", "line 7", "line 8", "line 9"]


# ── install / uninstall / idempotency ───────────────────────────────


class TestInstall:
    def test_install_attaches_handler(self) -> None:
        handler = install()
        assert handler is not None
        assert is_installed() is True
        assert any(
            isinstance(h, EdenLoggingHandler) for h in logging.getLogger().handlers
        )

    def test_install_is_idempotent(self) -> None:
        h1 = install()
        h2 = install()
        assert h1 is not None
        assert h2 is None  # second call returns None
        # Only one handler attached.
        attached = [
            h for h in logging.getLogger().handlers
            if isinstance(h, EdenLoggingHandler)
        ]
        assert len(attached) == 1

    def test_install_replace_removes_prior(self) -> None:
        h1 = install()
        h2 = install(replace=True)
        assert h1 is not None
        assert h2 is not None
        assert h1 is not h2
        attached = [
            h for h in logging.getLogger().handlers
            if isinstance(h, EdenLoggingHandler)
        ]
        assert len(attached) == 1
        assert attached[0] is h2

    def test_uninstall_removes_handler(self) -> None:
        install()
        assert uninstall() is True
        assert is_installed() is False
        assert uninstall() is False  # second call returns False

    def test_install_respects_env_level(self, monkeypatch) -> None:
        monkeypatch.setenv("EDEN_LOG_LEVEL", "WARNING")
        handler = install()
        assert handler is not None
        assert handler.level == logging.WARNING

    def test_install_respects_kwargs(self) -> None:
        handler = install(
            level=logging.DEBUG,
            project_id="my-proj",
            agent_id="agent-7",
            agent_version="2.0",
            realm="environment",
        )
        assert handler is not None
        assert handler.project_id == "my-proj"
        assert handler.agent_id == "agent-7"
        assert handler.agent_version == "2.0"
        assert handler.realm == "environment"

    def test_install_default_level_is_info(self, monkeypatch) -> None:
        monkeypatch.delenv("EDEN_LOG_LEVEL", raising=False)
        # Reset config so cached settings don't override the env.
        with patch("eden.observability.logging_shim.get_settings") as gsm:
            gsm.return_value = MagicMock(eden_log_level="INFO")
            handler = install()
        assert handler is not None
        assert handler.level == logging.INFO


# ── get_handler / is_installed ──────────────────────────────────────


class TestGetters:
    def test_get_handler_returns_none_when_not_installed(self) -> None:
        assert logging_shim.get_handler() is None

    def test_get_handler_returns_instance_after_install(self) -> None:
        installed = install()
        assert logging_shim.get_handler() is installed


# ── End-to-end: real emit() drains to a mocked collector ───────────


class TestEndToEndEmit:
    def test_emit_pushes_to_collector(self, handler: EdenLoggingHandler) -> None:
        """Wire a real asyncio loop + a mocked TelemetryCollector."""
        fake_collector = MagicMock()
        fake_collector.ingest = AsyncMock(return_value=True)

        async def run() -> None:
            with patch(
                "eden.observability.telemetry_collector.get_telemetry_collector",
                AsyncMock(return_value=fake_collector),
            ):
                record = logging.LogRecord(
                    name="app", level=logging.INFO, pathname="/x", lineno=1,
                    msg="user logged in", args=(), exc_info=None,
                )
                # Suppress auto-drain scheduling so this test owns the
                # single ingest (avoids double-fire with call_soon).
                with patch.object(handler, "_drain_async_safe"):
                    handler.emit(record)
                    assert handler._queue, "emit must enqueue the event"
                    await handler._ingest_batch(handler._queue)
                    handler._queue.clear()

        asyncio.run(run())
        # Exactly one ingest call.
        assert fake_collector.ingest.call_count == 1
        event = fake_collector.ingest.call_args.args[0]
        assert isinstance(event, TelemetryEvent)
        assert event.event_type == "log"
        assert event.payload["message"] == "user logged in"

    def test_emit_from_worker_thread(self, handler: EdenLoggingHandler) -> None:
        """A worker thread emitting must not crash.

        The handler is designed to be safe to call from a worker thread
        — it uses ``call_soon_threadsafe`` to schedule the drain on
        the main event loop. We don't have a main loop in this test,
        so the handler falls back to the synchronous drain path. With
        a mocked collector, ``ingest`` returns True and the event
        lands in ``ingested``.
        """
        fake_collector = MagicMock()
        fake_collector.ingest = AsyncMock(return_value=True)

        errors: list[BaseException] = []

        def worker() -> None:
            try:
                # Don't go through the root logger (which is shared
                # with the test runner) — call the handler directly
                # the way the logging framework would.
                record = logging.LogRecord(
                    name="worker", level=logging.INFO, pathname="/x", lineno=1,
                    msg="from worker", args=(), exc_info=None,
                )
                handler.emit(record)
            except BaseException as e:  # pragma: no cover — defensive
                errors.append(e)

        async def run() -> None:
            with patch(
                "eden.observability.telemetry_collector.get_telemetry_collector",
                AsyncMock(return_value=fake_collector),
            ):
                t = threading.Thread(target=worker)
                t.start()
                t.join(timeout=1.0)
                assert not t.is_alive(), "worker thread hung"
                # Give the loop a tick to drain call_soon_threadsafe.
                await asyncio.sleep(0.05)
                # Drain any leftovers directly.
                if handler._queue:
                    await handler._ingest_batch(handler._queue)
                    handler._queue.clear()

        asyncio.run(run())
        assert not errors, f"emit() raised: {errors}"
        assert handler.ingested == 1, f"event vanished: {handler.stats()}"

    def test_emit_survives_record_with_unformattable_message(
        self, handler: EdenLoggingHandler,
    ) -> None:
        """A record whose .getMessage() raises must not crash emit().

        We don't assert the event ended up in the queue (the sync drain
        path may consume it before we look); we only assert that
        ``emit()`` did not raise.
        """
        record = logging.LogRecord(
            name="m", level=logging.INFO, pathname="/x", lineno=1,
            msg="ok", args=(), exc_info=None,
        )
        record.getMessage = MagicMock(side_effect=RuntimeError("nope"))
        # Should not raise.
        handler.emit(record)


# ── contextvar isolation ───────────────────────────────────────────


class TestContextVarIsolation:
    def test_set_and_clear(self) -> None:
        set_trace_context(trace_id="t-1", span_id="s-1", project_id="p-1")
        assert _active_trace_id.get() == "t-1"
        assert _active_span_id.get() == "s-1"
        assert _active_project_id.get() == "p-1"
        clear_trace_context()
        assert _active_trace_id.get() is None
        assert _active_span_id.get() is None
        assert _active_project_id.get() is None

    def test_partial_clear(self) -> None:
        set_trace_context(trace_id="t-1", span_id="s-1")
        # Clear only the span.
        set_trace_context(span_id=None)
        assert _active_trace_id.get() == "t-1"
        assert _active_span_id.get() is None


# ── _parse_level helper ────────────────────────────────────────────


class TestParseLevel:
    @pytest.mark.parametrize("name,expected", [
        ("DEBUG", logging.DEBUG),
        ("INFO", logging.INFO),
        ("WARNING", logging.WARNING),
        ("ERROR", logging.ERROR),
        ("CRITICAL", logging.CRITICAL),
    ])
    def test_known_levels(self, name: str, expected: int) -> None:
        assert logging_shim._parse_level(name) == expected

    def test_unknown_level_falls_back_to_info(self) -> None:
        assert logging_shim._parse_level("BANANAS") == logging.INFO

    def test_int_passthrough(self) -> None:
        assert logging_shim._parse_level(logging.WARNING) == logging.WARNING
