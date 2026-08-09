"""Integration-test helpers.

``wait_until`` exists because the gateway's telemetry emit moved off the
response path. It used to be awaited at all fourteen call sites, which put a PII
scrub (~157us/KiB) and a Postgres write inside every request's latency even
though nothing in the response depends on either — the emit function's own
docstring says it never raises and that the response "has already been (or is
about to be) returned".

Tests that asserted ``mock_collector.ingest_batch.await_count == 1`` immediately
after ``client.post(...)`` were relying on that inline await. ``TestClient`` runs
the app on a background portal loop, so a fire-and-forget task created during
the request has usually not run by the time the call returns.

A ``time.sleep`` in their place would be a race dressed up as a fix: green on a
fast machine, red in CI. Polling with a deadline cannot pass before the effect
actually happens and cannot hang, which is the property that matters.
"""

from __future__ import annotations

import time
from collections.abc import Callable

import pytest


def _wait_until(
    predicate: Callable[[], bool],
    *,
    timeout: float = 5.0,
    interval: float = 0.01,
    message: str = "",
) -> None:
    deadline = time.monotonic() + timeout
    last = False
    while time.monotonic() < deadline:
        last = bool(predicate())
        if last:
            return
        time.sleep(interval)
    raise AssertionError(
        message
        or f"condition was still false after {timeout}s (last value: {last})"
    )


@pytest.fixture
def wait_until() -> Callable[..., None]:
    """Block until a predicate holds; fail with a deadline rather than sleep."""
    return _wait_until


@pytest.fixture
def awaited_once() -> Callable[..., None]:
    """Wait for an ``AsyncMock`` to have been awaited exactly ``n`` times.

    Sharper failure message than a bare predicate: reports the count it actually
    reached, which distinguishes "never ran" from "ran twice".
    """

    def _check(mock: object, n: int = 1, *, timeout: float = 5.0) -> None:
        def _hit() -> bool:
            return int(getattr(mock, "await_count", 0)) >= n

        _wait_until(
            _hit,
            timeout=timeout,
            message=(
                f"expected {n} await(s) within {timeout}s but saw "
                f"{getattr(mock, 'await_count', 'n/a')} — the background "
                "telemetry task may not have been scheduled at all"
            ),
        )
        assert int(mock.await_count) == n, (
            f"expected exactly {n} await(s), got "
            f"{mock.await_count}"
        )

    return _check
