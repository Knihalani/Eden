"""A forked child must not re-send the parent's buffered events.

``os.fork()`` copies the address space but only the calling thread survives. A
child therefore inherited the parent's ``_queue`` contents — and its own worker
then sent them again. Measured before the fix, with a parent holding three
buffered events:

    child  : queue size inherited = 3
    parent : queue size = 0          (its worker had drained and sent them)

So every event buffered at fork time was delivered once per forked worker.
Silent, and multiplied by the worker count — which is 4, 8 or 16 in any
``gunicorn --preload`` / Celery-prefork / ``multiprocessing`` deployment that
builds the client before forking. Duplicate telemetry is worse than missing
telemetry here, because it corrupts counts rather than merely thinning them.

The counters and the offline SQLite handle were inherited too: per-process stats
started non-zero, and a sqlite3 connection used across a fork risks corrupting
the durable queue.

These tests fork for real. Simulating it by calling ``_reset_after_fork``
directly would pass even if the ``os.register_at_fork`` registration were
deleted, which is the most likely way for this to regress.
"""

from __future__ import annotations

import json
import os
import sys

import pytest

from eden_sdk.client import EdenClient
from eden_sdk.config import EdenConfig
from eden_sdk.trace import TraceEvent

pytestmark = pytest.mark.skipif(
    not hasattr(os, "register_at_fork") or sys.platform == "win32",
    reason="fork is POSIX-only",
)


def _client(**overrides: object) -> EdenClient:
    cfg = dict(
        org_id="o",
        api_key="k",
        base_url="http://test.invalid",
        dry_run=False,
        max_queue=100,
        flush_interval_ms=50,
    )
    cfg.update(overrides)
    return EdenClient(EdenConfig(**cfg))  # type: ignore[arg-type]


def _in_child(client: EdenClient, probe) -> dict:
    """Fork, run ``probe(client)`` in the child, return its dict over a pipe.

    The child always writes a JSON object, even when ``probe`` raises — an
    earlier version wrote nothing on failure, so the parent hit
    ``json.loads("")`` and reported ``JSONDecodeError`` instead of the child's
    actual error.
    """
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:  # pragma: no cover — child process
        try:
            os.close(read_fd)
            try:
                result = probe(client)
            except BaseException as exc:  # noqa: BLE001 — report, never hang
                result = {"_child_error": f"{type(exc).__name__}: {exc}"}
            try:
                os.write(write_fd, json.dumps(result).encode())
            except BaseException:  # noqa: BLE001
                os.write(write_fd, b'{"_child_error": "unserialisable result"}')
            os.close(write_fd)
        finally:
            os._exit(0)
    os.close(write_fd)
    chunks = b""
    while chunk := os.read(read_fd, 4096):
        chunks += chunk
    os.close(read_fd)
    os.waitpid(pid, 0)
    if not chunks:
        raise AssertionError("the child wrote nothing — it died before reporting")
    got = json.loads(chunks.decode())
    assert "_child_error" not in got, f"child failed: {got['_child_error']}"
    return got


class TestQueueIsNotInherited:
    def test_child_does_not_inherit_queued_events(self) -> None:
        """The regression: these are the parent's to send, not the child's."""
        client = _client()
        for i in range(3):
            client.enqueue(
                TraceEvent(payload={"event_id": f"p{i}"}, source_format="openai")
            )
        assert client._queue.qsize() == 3, "parent should be holding them"

        got = _in_child(client, lambda c: {"qsize": c._queue.qsize()})

        assert got["qsize"] == 0, (
            "the child inherited the parent's queued events and will send them "
            "again — one duplicate per forked worker"
        )

    def test_parent_keeps_its_own_queue(self) -> None:
        """The handler runs ``after_in_child`` only; the parent is untouched."""
        client = _client()
        for i in range(3):
            client.enqueue(
                TraceEvent(payload={"event_id": f"p{i}"}, source_format="openai")
            )
        _in_child(client, lambda c: {"qsize": c._queue.qsize()})
        assert client._queue.qsize() == 3, "the fork handler ran in the parent"


class TestCountersAreReset:
    def test_child_starts_from_zero(self) -> None:
        client = _client(dry_run=True)
        for i in range(4):
            client.enqueue(
                TraceEvent(payload={"event_id": f"p{i}"}, source_format="openai")
            )
        assert client.sent == 4

        got = _in_child(
            client, lambda c: {"sent": c.sent, "dropped": c.dropped}
        )
        assert got == {"sent": 0, "dropped": 0}


class TestThreadHandle:
    def test_child_has_no_stale_thread(self) -> None:
        client = _client()
        client.start()
        try:
            got = _in_child(client, lambda c: {"thread_is_none": c._thread is None})
        finally:
            client.shutdown(timeout=2.0)
        assert got["thread_is_none"] is True

    def test_child_is_left_in_a_startable_state(self) -> None:
        """The point of resetting: ``start()`` must be able to succeed.

        Asserts the reset's postconditions rather than actually starting a
        thread. Forking a multi-threaded process and then spawning a thread in
        the child is hazardous by design — CPython emits a DeprecationWarning for
        exactly this — and a version of this test that did so passed alone and
        failed under the full suite, where more threads are live. The
        preconditions ``start()`` checks are the honest, deterministic thing to
        assert here.
        """
        client = _client()
        client.start()

        def _probe(c: EdenClient) -> dict:
            return {
                "thread_is_none": c._thread is None,
                "stop_clear": not c._stop.is_set(),
                "loop_started_clear": not c._loop_started.is_set(),
                "http_is_none": c._http is None,
                "loop_failed": bool(c._loop_failed),
            }

        try:
            got = _in_child(client, _probe)
        finally:
            client.shutdown(timeout=2.0)

        assert got == {
            "thread_is_none": True,
            "stop_clear": True,
            "loop_started_clear": True,
            "http_is_none": True,
            "loop_failed": False,
        }


class TestRegistration:
    def test_the_hook_is_registered_not_just_defined(self) -> None:
        """A defined-but-unregistered handler is the likeliest regression."""
        import inspect

        from eden_sdk import client as mod

        src = inspect.getsource(mod)
        assert "os.register_at_fork(after_in_child=" in src, (
            "the reset exists but nothing wires it to fork()"
        )

    def test_clients_are_tracked_weakly(self) -> None:
        """A strong registry would leak every client ever constructed."""
        import weakref

        from eden_sdk import client as mod

        assert isinstance(mod._LIVE_CLIENTS, weakref.WeakSet)

    def test_a_collected_client_leaves_the_registry(self) -> None:
        """Tracked by identity, not by set size.

        A size comparison is order-dependent: with another test's client still
        alive, ``before`` is non-zero and a ``gc.collect()`` can reap both, so
        the count lands below ``before`` rather than back at it. (Passed alone,
        failed in the full suite.)
        """
        import gc
        import weakref

        from eden_sdk import client as mod

        c = _client()
        ref = weakref.ref(c)
        assert c in mod._LIVE_CLIENTS
        del c
        gc.collect()
        assert ref() is None, "the client was not collected"
        assert not any(x is ref() for x in mod._LIVE_CLIENTS)

    def test_one_failing_client_does_not_block_the_others(self) -> None:
        """The hook isolates each reset; a fork handler must never raise."""

        class _Boom:
            def _reset_after_fork(self) -> None:
                raise RuntimeError("nope")

        from eden_sdk import client as mod

        good = _client()
        mod._LIVE_CLIENTS.add(_Boom())  # type: ignore[arg-type]
        try:
            mod._reset_all_after_fork()  # must not raise
        finally:
            mod._LIVE_CLIENTS.discard(good)
