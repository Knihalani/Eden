"""F63 — Cap the per-tenant rate limiters in ``app_events``.

Pre-F63 the module-level ``_rate_buckets`` dict in
``eden.api.routes.app_events`` was a plain ``dict``
(backed by a ``defaultdict``) that grew unbounded
against unique-tenant browser-SDK traffic. A single
malicious page could register under a fresh
``X-Org-Id`` on every request, creating a new dict
entry with each call and never freeing the old one.

F63 keeps the bucket as an ``OrderedDict`` with the
same F63 mitigation as the agent-telemetry ingest path
(``eden.api.routes.ingestion._rate_buckets``). The two
rate limiters are otherwise identical in shape — they
share the cap constant, the window, and the helper
names (``_touch_bucket`` / ``_evict_idle_buckets`` /
``_enforce_rate_buckets_cap``) — so this test file
mirrors ``test_ingestion_rate_limit_cap_f63.py``.

We test the helpers in isolation by reloading the
module and poking the module-level ``_rate_buckets`` /
``_MAX_RATE_BUCKETS`` directly — no request plumbing
needed.
"""

from __future__ import annotations

from collections import OrderedDict, deque

import pytest


def _reload_helpers():
    """Re-import the helpers so module state resets per test."""
    import importlib

    import eden.api.routes.app_events as mod
    importlib.reload(mod)
    return mod


class TestF63RateBucketsIsOrderedDict:
    """``_rate_buckets`` is an ``OrderedDict`` (not a
    plain ``dict`` / ``defaultdict``) so the F63 FIFO
    cap and LRU bump can work."""

    def test_rate_buckets_is_ordered_dict(self) -> None:
        mod = _reload_helpers()
        assert isinstance(mod._rate_buckets, OrderedDict), (
            "F63 regression: app_events _rate_buckets is "
            "no longer an OrderedDict — FIFO eviction "
            "cannot work."
        )

    def test_no_defaultdict_factory(self) -> None:
        """A ``defaultdict`` would silently create empty
        buckets on every ``__getitem__`` call, defeating
        the cap. F63 uses explicit ``.get(org_id)``."""
        mod = _reload_helpers()
        from collections import defaultdict

        assert not isinstance(mod._rate_buckets, defaultdict), (
            "F63 regression: app_events _rate_buckets is "
            "a defaultdict — implicit bucket creation "
            "bypasses the cap."
        )


class TestF63CapAndTtlConstants:
    """Pin the production constants so a future refactor
    doesn't accidentally shrink the cap to something
    absurd (e.g. 10) or extend the TTL to forever."""

    def test_cap_is_non_trivial(self) -> None:
        mod = _reload_helpers()
        assert mod._MAX_RATE_BUCKETS >= 256, (
            "F63 cap shrunk too small — at least 256 is "
            "needed for realistic concurrent multi-tenant use"
        )

    def test_window_is_60_seconds(self) -> None:
        mod = _reload_helpers()
        assert mod._RATE_WINDOW_SECONDS == 60.0, (
            "F63 regression: rate window drifted away "
            "from 60s — would break the documented "
            "X-RPM contract"
        )

    def test_cap_matches_ingestion(self) -> None:
        """Defence-in-depth: both rate limiters are
        independent code paths but they should be tuned
        to the same cap. If a future PR tunes one, it
        should tune both — this test catches the
        asymmetric tuning case."""
        from eden.api.routes import ingestion

        mod = _reload_helpers()
        assert mod._MAX_RATE_BUCKETS == ingestion._MAX_RATE_BUCKETS, (
            "F63 cap diverged between app_events and "
            "ingestion — operators tune via one constant "
            "but expect both paths to share the cap."
        )


class TestF63TouchBucketBumpsLru:
    """``_touch_bucket`` moves the active org to the end
    of the OrderedDict so a subsequent eviction pass
    doesn't drop an active tenant."""

    def test_touch_moves_existing_key_to_end(self) -> None:
        mod = _reload_helpers()
        mod._rate_buckets["env_a"] = deque()
        mod._rate_buckets["env_b"] = deque()
        mod._touch_bucket("env_a")
        keys = list(mod._rate_buckets.keys())
        assert keys[-1] == "env_a"
        assert keys[0] == "env_b"

    def test_touch_missing_key_is_noop(self) -> None:
        """Touching a brand-new org must NOT create an
        entry. The OrderedDict should only grow via the
        check_rate_limit path, not via the touch helper.
        This is what stops the F63 cap from being
        bypassed by careless calls."""
        mod = _reload_helpers()
        mod._touch_bucket("env_brand_new")
        assert "env_brand_new" not in mod._rate_buckets, (
            "F63 regression: app_events _touch_bucket "
            "inserted a missing key — the cap is bypassable"
        )

    def test_touch_is_silent_on_exception(self) -> None:
        """Best-effort housekeeping: a transient
        bookkeeping error must NOT propagate out of
        ``_touch_bucket`` (it's called on every API
        hit)."""
        mod = _reload_helpers()
        orig = mod._rate_buckets.move_to_end

        def boom(*a, **k):
            raise RuntimeError("simulated OrderedDict failure")

        mod._rate_buckets.move_to_end = boom
        try:
            mod._rate_buckets["env_x"] = deque()
            mod._touch_bucket("env_x")  # must not raise
        finally:
            mod._rate_buckets.move_to_end = orig


class TestF63EvictIdleBucketsDropsStale:
    """``_evict_idle_buckets`` drops orgs whose sliding
    window is empty AND whose last access predates
    ``now - window``. Without it, idle tenants pinned
    keys in the dict for the pod lifetime."""

    def test_drops_empty_buckets(self) -> None:
        mod = _reload_helpers()
        mod._rate_buckets["env_empty"] = deque()
        mod._rate_buckets["env_empty2"] = deque()
        mod._evict_idle_buckets(mod.time.monotonic())
        assert "env_empty" not in mod._rate_buckets
        assert "env_empty2" not in mod._rate_buckets

    def test_drops_buckets_with_all_entries_outside_window(self) -> None:
        mod = _reload_helpers()
        old_time = mod.time.monotonic() - mod._RATE_WINDOW_SECONDS - 5.0
        mod._rate_buckets["env_stale"] = deque([old_time, old_time])
        mod._evict_idle_buckets(mod.time.monotonic())
        assert "env_stale" not in mod._rate_buckets

    def test_keeps_active_buckets(self) -> None:
        mod = _reload_helpers()
        now = mod.time.monotonic()
        mod._rate_buckets["env_active"] = deque([now - 5.0, now - 1.0])
        mod._evict_idle_buckets(now)
        assert "env_active" in mod._rate_buckets


class TestF63CapEnforcedOnInsert:
    """``_enforce_rate_buckets_cap`` keeps
    ``len(_rate_buckets) < _MAX_RATE_BUCKETS`` by
    evicting the least-recently-touched entry (the head
    of the OrderedDict)."""

    def test_drops_oldest_when_cap_exceeded(self) -> None:
        mod = _reload_helpers()
        mod._MAX_RATE_BUCKETS = 3
        mod._rate_buckets["env_a"] = deque()
        mod._rate_buckets["env_b"] = deque()
        mod._rate_buckets["env_d"] = deque()
        mod._enforce_rate_buckets_cap("env_e")
        mod._rate_buckets["env_e"] = deque()
        assert "env_a" not in mod._rate_buckets
        assert "env_b" in mod._rate_buckets
        assert "env_d" in mod._rate_buckets
        assert "env_e" in mod._rate_buckets
        assert len(mod._rate_buckets) == 3

    def test_cap_loop_terminates_when_empty(self) -> None:
        """If the cap is 0 (or another degenerate value)
        and the dict is empty, the eviction loop must
        break out instead of raising or looping
        forever."""
        mod = _reload_helpers()
        mod._MAX_RATE_BUCKETS = 0
        mod._rate_buckets["env_x"] = deque()  # exceeds cap
        mod._enforce_rate_buckets_cap("env_x")
        assert len(mod._rate_buckets) == 0


class TestF63CheckRateLimitTouchesLru:
    """The hot path (``_check_rate_limit``) must bump
    the LRU position of the active org so it survives a
    subsequent cap-eviction triggered by a churning
    one-shot tenant."""

    def test_check_rate_limit_bumps_lru(self) -> None:
        mod = _reload_helpers()
        mod._rate_buckets["env_first"] = deque()
        mod._rate_buckets["env_second"] = deque()
        mod._check_rate_limit("env_first")
        keys = list(mod._rate_buckets.keys())
        assert keys[-1] == "env_first"

    def test_check_rate_limit_inserts_new_org(self) -> None:
        mod = _reload_helpers()
        mod._check_rate_limit("env_brand_new")
        assert "env_brand_new" in mod._rate_buckets
        bucket = mod._rate_buckets["env_brand_new"]
        assert len(bucket) == 1  # one timestamp recorded

    def test_check_rate_limit_does_not_use_defaultdict(self) -> None:
        """F63 replaced the ``defaultdict`` factory with
        explicit ``.get`` + ``if None`` so the OrderedDict
        doesn't grow via implicit ``[org_id]`` reads
        (which bypass the cap). This test pins the
        discipline by simulating a cap-exceeded state and
        checking the cap was enforced."""
        mod = _reload_helpers()
        mod._MAX_RATE_BUCKETS = 1
        mod._rate_buckets["env_preexisting"] = deque()
        mod._check_rate_limit("env_newcomer")
        assert "env_newcomer" in mod._rate_buckets
        assert "env_preexisting" not in mod._rate_buckets


class TestF63SourceLevel:
    """Source-level pin: the F63 helpers / constants /
    patterns appear in the app_events module so a future
    refactor doesn't quietly delete the cap."""

    def test_helpers_defined(self) -> None:
        import inspect

        from eden.api.routes import app_events

        src = inspect.getsource(app_events)
        for name in (
            "_touch_bucket",
            "_evict_idle_buckets",
            "_enforce_rate_buckets_cap",
            "_MAX_RATE_BUCKETS",
            "_RATE_WINDOW_SECONDS",
        ):
            assert name in src, (
                f"F63 regression: {name} is missing from "
                "app_events.py"
            )

    def test_check_rate_limit_calls_housekeeping(self) -> None:
        """Pin that ``_check_rate_limit`` calls both
        ``_evict_idle_buckets`` and
        ``_enforce_rate_buckets_cap`` BEFORE recording
        the new request. The cap and the TTL sweep
        must precede the bucket append."""
        import inspect

        from eden.api.routes import app_events

        src = inspect.getsource(app_events._check_rate_limit)
        i_evict = src.find("_evict_idle_buckets")
        i_cap = src.find("_enforce_rate_buckets_cap")
        i_append = src.find("bucket.append")
        i_touch = src.find("_touch_bucket(org_id)")
        assert i_evict != -1 and i_cap != -1, (
            "F63 regression: housekeeping helpers are "
            "not wired into app_events _check_rate_limit"
        )
        assert i_append != -1 and i_touch != -1
        assert i_evict < i_append
        assert i_cap < i_append
        assert i_append < i_touch

    def test_ordereddict_used_in_cache_type(self) -> None:
        import inspect

        from eden.api.routes import app_events

        src = inspect.getsource(app_events)
        assert "OrderedDict" in src, (
            "F63 regression: OrderedDict is missing "
            "from app_events.py"
        )
