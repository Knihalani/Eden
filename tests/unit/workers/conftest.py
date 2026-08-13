"""Contain worker-suite side effects that leak into later tests.

Tests in this package start the real sidecar bundle, which includes the
closed-loop verify worker. That worker's first pass finds an empty queue
and sets ``eden.closed_loop.verify``'s process-global empty-poll cooldown
for up to two grid periods. Every later test that calls
``run_due_verifications`` then hits the cooldown early-return and sees
``checked == 0`` — which is why ``tests/unit/closed_loop`` and
``tests/intelligence/test_remediation_wave6.py`` failed whenever they ran
after this package rather than before it.

The cooldown is process-global on purpose (it is what keeps the fleet's
pollers on a single shared grid), so the fix belongs here: clear it once
this package's side effects are done.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest


@pytest.fixture(autouse=True)
def _clear_verify_cooldown():
    yield
    try:
        from eden.closed_loop.verify import _reset_state_for_tests

        _reset_state_for_tests()
    except Exception:
        pass


@pytest.fixture(autouse=True)
def _pg_lease_unavailable(monkeypatch):
    """Make pg_lease report as unavailable (returns None) for all worker tests.

    With Postgres now the primary election backend, ``pg_lease.acquire``
    is called before any Redis attempt. Tests in this package that only
    mock the Redis Lock path would otherwise see the autouse postgres mock
    (from ``tests/conftest.py``) return a MagicMock row whose subscript
    does not equal the holder, causing ``acquire`` to return ``False``
    (genuine contention) and the Redis fallback to be skipped entirely.

    Returning ``None`` signals "Postgres unavailable" — the correct signal
    to fall through to the Redis mock that each test already patches.

    Tests that need the Postgres-primary path explicitly patch
    ``eden.storage.pg_lease.acquire`` themselves, which takes precedence
    over this fixture's monkeypatch for the duration of the patch.
    """
    from eden.storage import pg_lease

    monkeypatch.setattr(pg_lease, "acquire", AsyncMock(return_value=None))
