"""Upstash max-requests circuit in eden.storage.redis."""

from __future__ import annotations

import pytest

import eden.storage.redis as redis_mod


@pytest.fixture(autouse=True)
def _reset_circuit_after():
    """Teardown the circuit so a trip here can't poison later tests
    (the health route reads ``redis_quota_exhausted()`` — a leak made
    ``test_health_redis_and_worker`` report ``quota_exhausted`` for
    every Redis probe depending on test order)."""
    yield
    redis_mod._redis_quota_blocked_until_mono = 0.0


def test_note_redis_quota_exhausted_trips_and_ignores_other_errors() -> None:
    redis_mod._redis_quota_blocked_until_mono = 0.0
    assert not redis_mod.redis_quota_exhausted()
    assert redis_mod.note_redis_quota_exhausted(
        Exception("max requests limit exceeded. Limit: 500000, Usage: 500000")
    )
    assert redis_mod.redis_quota_exhausted()
    # Non-quota errors must not refresh / falsely trip when already checking
    # a different message after forced reset.
    redis_mod._redis_quota_blocked_until_mono = 0.0
    assert not redis_mod.note_redis_quota_exhausted(Exception("connection reset by peer"))
    assert not redis_mod.redis_quota_exhausted()
    assert redis_mod.note_redis_quota_exhausted(None)  # unconditional trip
    assert redis_mod.redis_quota_exhausted()
