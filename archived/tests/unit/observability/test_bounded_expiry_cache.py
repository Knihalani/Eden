"""The sparse-EXPIRE bookkeeping maps must be bounded.

Both ``checkpoint_hook._step_expire_at`` and
``TelemetryCollector._stream_expire_at`` are keyed by trace, and the
gateway mints a fresh ``trace_id`` per request — so an unevicted dict
there grows by one entry per request for the life of the process.
"""

from __future__ import annotations

from eden.observability.bounded_expiry_cache import (
    DEFAULT_MAX_ENTRIES,
    BoundedExpiryCache,
)


def test_cache_never_exceeds_its_cap_under_unique_keys():
    """The gateway's one-trace-id-per-request pattern."""
    cache = BoundedExpiryCache(max_entries=64)
    now = 1000.0
    for i in range(10_000):
        # Every entry is still "live" (deadline in the future), which is
        # the worst case: expiry sweeping cannot reclaim anything, so the
        # cap has to be enforced by outright eviction.
        cache.set(f"trace:{i}:llm_step", now + 3600.0, now=now)
    assert len(cache) <= 64


def test_expired_entries_are_reclaimed_before_live_ones():
    cache = BoundedExpiryCache(max_entries=10)
    now = 1000.0
    for i in range(10):
        cache.set(f"stale-{i}", now - 1.0, now=now)
    assert len(cache) == 10
    cache.set("fresh", now + 3600.0, now=now)
    # The stale entries were reclaimed, so the fresh one is retained
    # without evicting anything still in use.
    assert "fresh" in cache
    assert len(cache) <= 10


def test_eviction_is_insertion_ordered_when_all_entries_are_live():
    cache = BoundedExpiryCache(max_entries=3)
    now = 1000.0
    for key in ("a", "b", "c"):
        cache.set(key, now + 3600.0, now=now)
    cache.set("d", now + 3600.0, now=now)
    assert "a" not in cache, "oldest entry should be evicted first"
    assert "d" in cache


def test_is_due_is_true_for_unknown_and_expired_keys():
    cache = BoundedExpiryCache(max_entries=8)
    now = 1000.0
    assert cache.is_due("never-seen", now) is True
    cache.set("k", now + 100.0, now=now)
    assert cache.is_due("k", now) is False
    assert cache.is_due("k", now + 101.0) is True


def test_reinsert_refreshes_position_without_growing():
    cache = BoundedExpiryCache(max_entries=2)
    now = 1000.0
    cache.set("a", now + 10.0, now=now)
    cache.set("a", now + 20.0, now=now)
    assert len(cache) == 1


def test_checkpoint_hook_step_map_is_bounded():
    from eden.observability.ingestion import checkpoint_hook

    assert isinstance(checkpoint_hook._step_expire_at, BoundedExpiryCache)
    assert checkpoint_hook._step_expire_at.max_entries <= DEFAULT_MAX_ENTRIES


def test_telemetry_collector_stream_map_is_bounded():
    from eden.observability.telemetry_collector import TelemetryCollector

    collector = TelemetryCollector()
    assert isinstance(collector._stream_expire_at, BoundedExpiryCache)
    assert collector._stream_expire_at.max_entries <= DEFAULT_MAX_ENTRIES
