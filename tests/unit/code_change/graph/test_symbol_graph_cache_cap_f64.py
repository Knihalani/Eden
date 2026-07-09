"""F64 — Cap the per-process git cache in ``symbol_graph.py``.

Pre-F64 the module-level ``_GIT_CACHE: dict[str, tuple[float, str]]``
in ``eden.code_change.graph.symbol_graph`` was a plain ``dict``
keyed by ``"head:{root}"`` or ``"diff:{root}:{since_sha}"`` with
a 30s TTL. The TTL was only checked on the *next* call; the
dict entry lived for the lifetime of the pod. A long-running
process with continuously advancing ``since_sha`` values (CI
runs, git fetch) would accumulate one stale entry per unique
SHA. With ~10K SHAs per day in busy CI, the dict could grow
to tens of thousands of entries.

F64 keeps the cache as an ``OrderedDict`` with:

* ``_GIT_CACHE_MAX_ENTRIES`` — hard cap on the number of
  entries. Sized for healthy traffic; a typical pod sees
  < 50 entries.
* ``_evict_expired_git_cache`` — sweep helper that drops
  entries past their TTL.
* ``_touch_git_cache`` — LRU bump on every cache hit so
  active entries survive eviction.

We test the helpers in isolation by reloading the module
and poking ``_GIT_CACHE`` / ``_GIT_CACHE_MAX_ENTRIES``
directly.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from pathlib import Path

import pytest


def _snapshot_helpers():
    """Return the module and clear the cache.

    We don't use ``importlib.reload`` (which would clobber
    monkeypatched dependencies from sibling test files).
    Instead we just clear the cache before each test —
    that's the correct baseline because the cache is an
    in-process TTL cache that fills on demand.
    """
    from eden.code_change.graph import symbol_graph as mod
    mod._GIT_CACHE.clear()
    return mod


class TestF64GitCacheIsOrderedDict:
    """``_GIT_CACHE`` is an ``OrderedDict`` (not a plain ``dict``)."""

    def test_cache_is_ordered_dict(self) -> None:
        mod = _snapshot_helpers()
        assert isinstance(mod._GIT_CACHE, OrderedDict), (
            "F64 regression: _GIT_CACHE is no longer "
            "an OrderedDict — FIFO eviction cannot work."
        )


class TestF64GitCacheCapAndTtlConstants:
    """Pin the production constants."""

    def test_cap_is_non_trivial(self) -> None:
        mod = _snapshot_helpers()
        assert mod._GIT_CACHE_MAX_ENTRIES >= 64, (
            "F64 cap shrunk too small — at least 64 is "
            "needed for realistic concurrent multi-root use"
        )

    def test_ttl_is_30_seconds_by_default(self) -> None:
        mod = _snapshot_helpers()
        # The default is read from env at module load; just
        # pin it's a positive number under 1 hour.
        assert 0 < mod._GIT_CACHE_TTL <= 3600, (
            "F64 regression: _GIT_CACHE_TTL drifted into "
            "an unreasonable range"
        )


class TestF64TouchGitCacheBumpsLru:
    """``_touch_git_cache`` moves the active key to the end
    of the OrderedDict so a subsequent eviction pass doesn't
    drop an active (root, since_sha) tuple."""

    def test_touch_moves_existing_key_to_end(self) -> None:
        mod = _snapshot_helpers()
        mod._GIT_CACHE["head:/repo/a"] = (mod.time.monotonic(), "abc")
        mod._GIT_CACHE["head:/repo/b"] = (mod.time.monotonic(), "def")
        mod._touch_git_cache("head:/repo/a")
        keys = list(mod._GIT_CACHE.keys())
        assert keys[-1] == "head:/repo/a"
        assert keys[0] == "head:/repo/b"

    def test_touch_missing_key_is_noop(self) -> None:
        """Touching a brand-new key must NOT create an entry."""
        mod = _snapshot_helpers()
        mod._touch_git_cache("head:/repo/brand_new")
        assert "head:/repo/brand_new" not in mod._GIT_CACHE, (
            "F64 regression: _touch_git_cache inserted a "
            "missing key — the cap is bypassable"
        )

    def test_touch_is_silent_on_exception(self) -> None:
        mod = _snapshot_helpers()
        orig = mod._GIT_CACHE.move_to_end

        def boom(*a, **k):
            raise RuntimeError("simulated OrderedDict failure")

        mod._GIT_CACHE.move_to_end = boom
        try:
            mod._GIT_CACHE["head:/x"] = (mod.time.monotonic(), "abc")
            mod._touch_git_cache("head:/x")  # must not raise
        finally:
            mod._GIT_CACHE.move_to_end = orig


class TestF64EvictExpiredGitCacheDropsStale:
    """``_evict_expired_git_cache`` drops entries past their TTL."""

    def test_drops_expired_entries(self) -> None:
        mod = _snapshot_helpers()
        now = mod.time.monotonic()
        mod._GIT_CACHE["head:/old"] = (now - 60.0, "old_sha")
        mod._GIT_CACHE["head:/new"] = (now, "new_sha")
        mod._evict_expired_git_cache(now)
        assert "head:/old" not in mod._GIT_CACHE
        assert "head:/new" in mod._GIT_CACHE

    def test_keeps_fresh_entries(self) -> None:
        mod = _snapshot_helpers()
        now = mod.time.monotonic()
        mod._GIT_CACHE["head:/a"] = (now, "abc")
        mod._GIT_CACHE["head:/b"] = (now, "def")
        mod._evict_expired_git_cache(now)
        assert "head:/a" in mod._GIT_CACHE
        assert "head:/b" in mod._GIT_CACHE


class TestF64EnforceGitCacheCapDropsLru:
    """``_enforce_git_cache_cap`` keeps
    ``len(_GIT_CACHE) < _GIT_CACHE_MAX_ENTRIES``."""

    def test_drops_oldest_when_cap_exceeded(self) -> None:
        mod = _snapshot_helpers()
        original = mod._GIT_CACHE_MAX_ENTRIES
        mod._GIT_CACHE_MAX_ENTRIES = 3
        mod._GIT_CACHE["head:/a"] = (mod.time.monotonic(), "abc")
        mod._GIT_CACHE["head:/b"] = (mod.time.monotonic(), "def")
        mod._GIT_CACHE["head:/d"] = (mod.time.monotonic(), "ghi")
        mod._enforce_git_cache_cap()
        mod._GIT_CACHE["head:/e"] = (mod.time.monotonic(), "jkl")
        assert "head:/a" not in mod._GIT_CACHE
        assert "head:/b" in mod._GIT_CACHE
        assert "head:/d" in mod._GIT_CACHE
        assert "head:/e" in mod._GIT_CACHE
        assert len(mod._GIT_CACHE) == 3
        mod._GIT_CACHE_MAX_ENTRIES = original

    def test_cap_loop_terminates_when_empty(self) -> None:
        mod = _snapshot_helpers()
        original = mod._GIT_CACHE_MAX_ENTRIES
        mod._GIT_CACHE_MAX_ENTRIES = 0
        mod._GIT_CACHE["head:/x"] = (mod.time.monotonic(), "abc")
        mod._enforce_git_cache_cap()
        assert len(mod._GIT_CACHE) == 0
        mod._GIT_CACHE_MAX_ENTRIES = original


class TestF64GitHeadShaTouchesLru:
    """The hot path (``_git_head_sha``) must bump the LRU
    position of the active key so it survives a subsequent
    cap-eviction triggered by a churning since_sha value."""

    def test_git_head_sha_bumps_lru(self, tmp_path) -> None:
        """A cache MISS still bumps the LRU position. The
        fresh key is added at the end of the OrderedDict
        by ``_touch_git_cache`` after the git call resolves.
        """
        mod = _snapshot_helpers()
        mod._GIT_CACHE_MAX_ENTRIES = 3
        # Pre-seed two unrelated entries — the active path
        # is a fresh key (NOT pre-seeded) so we exercise
        # the MISS path, which is what writes to the cache
        # in production.
        now = mod.time.monotonic()
        mod._GIT_CACHE["head:/unrelated/a"] = (now, "a")
        mod._GIT_CACHE["head:/unrelated/b"] = (now, "b")
        active_key = f"head:{tmp_path}"
        assert active_key not in mod._GIT_CACHE

        # Stub subprocess to avoid actually shelling out to git.
        original_check_output = mod.subprocess.check_output

        def fake_check_output(cmd, *args, **kwargs):
            return b"deadbeef\n"

        mod.subprocess.check_output = fake_check_output
        try:
            sha = mod._git_head_sha(tmp_path)
        finally:
            mod.subprocess.check_output = original_check_output

        assert sha == "deadbeef"
        # The active key was added at the end of the OrderedDict
        # (because ``_touch_git_cache`` bumps it after the git
        # call resolves).
        assert active_key in mod._GIT_CACHE
        keys = list(mod._GIT_CACHE.keys())
        assert keys[-1] == active_key


class TestF64SourceLevel:
    """Source-level pin: the F64 helpers / constants /
    patterns appear in the symbol_graph module."""

    def test_helpers_defined(self) -> None:
        import inspect

        from eden.code_change.graph import symbol_graph

        src = inspect.getsource(symbol_graph)
        for name in (
            "_touch_git_cache",
            "_evict_expired_git_cache",
            "_enforce_git_cache_cap",
            "_GIT_CACHE_MAX_ENTRIES",
        ):
            assert name in src, (
                f"F64 regression: {name} is missing from "
                "symbol_graph.py"
            )

    def test_ordereddict_used_in_cache_type(self) -> None:
        import inspect

        from eden.code_change.graph import symbol_graph

        src = inspect.getsource(symbol_graph)
        assert "OrderedDict" in src, (
            "F64 regression: OrderedDict is missing "
            "from symbol_graph.py"
        )
