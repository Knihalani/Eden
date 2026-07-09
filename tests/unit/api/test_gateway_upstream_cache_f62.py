"""F62 — Cap the LLM gateway ``_upstream_client_cache``.

Pre-F62 the per-``(base_url, api_key)`` cache of
``AsyncOpenAI`` clients was a plain ``dict`` that grew
unbounded against BYOK traffic. Every unique
``X-Upstream-Api-Key`` header added an entry, each
holding its own ``httpx.AsyncClient`` connection pool.
A malicious caller spamming unique keys could multiply
the API's RSS by tens of KB per entry. F62 keeps the
cache as an ``OrderedDict`` capped at
``_MAX_UPSTREAM_CLIENT_CACHE`` (1024) with FIFO
eviction. Insertion order is bumped on every hit so an
active provider is never dropped while a stale provider
with one historical request gets evicted.

We test the cache mechanics in isolation by monkey-
patching ``_get_openai_api_error`` etc., as the real
``AsyncOpenAI`` import is gated by the test-stub
path.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from unittest.mock import MagicMock


def _reset_cache():
    """Reset the module-level cache between tests so each
    one starts with an empty LRU."""
    from eden.api.routes import gateway
    gateway._upstream_client_cache = OrderedDict()
    return gateway


class TestF62UpstreamClientCacheCap:
    """``_get_or_build_upstream_client`` must enforce the
    hard cap with FIFO eviction."""

    def test_cache_is_ordered_dict(self) -> None:
        gateway = _reset_cache()
        assert isinstance(
            gateway._upstream_client_cache, OrderedDict
        ), (
            "F62 regression: cache is no longer an "
            "OrderedDict — FIFO eviction cannot work."
        )

    def test_cap_is_1024(self) -> None:
        gateway = _reset_cache()
        assert gateway._MAX_UPSTREAM_CLIENT_CACHE == 1024

    def test_cap_constant_is_sane(self) -> None:
        """Defence-in-depth: cap shouldn't be tiny (would
        evict active entries) or unbounded (defeats the
        purpose). Reasonable range: 64..4096."""
        from eden.api.routes import gateway
        assert 64 <= gateway._MAX_UPSTREAM_CLIENT_CACHE <= 4096, (
            f"F62 cap {gateway._MAX_UPSTREAM_CLIENT_CACHE} outside "
            "sane range"
        )

    def test_unique_keys_insert_without_eviction(self) -> None:
        """Below the cap, every unique (base_url, api_key)
        adds an entry."""
        gateway = _reset_cache()
        fake_openai = MagicMock()
        fake_openai.api_key = "k"
        fake_openai.base_url = "u"

        # Bypass the AsyncOpenAI real class via the
        # ``__getattr__``-resolved lookup the function
        # does at call time.
        def fake_client_factory(*, api_key, base_url):
            client = MagicMock()
            client.api_key = api_key
            client.base_url = base_url
            return client

        with _patch_async_openai(gateway, fake_client_factory):
            for i in range(10):
                gateway._get_or_build_upstream_client(
                    f"https://provider-{i}.test/v1",
                    f"key-{i}",
                )
        assert len(gateway._upstream_client_cache) == 10

    def test_cap_evicts_oldest_when_exceeded(self) -> None:
        """Insert N+10 entries (where N is the cap). The
        10 oldest entries must have been dropped, leaving
        the 10 freshest."""
        gateway = _reset_cache()
        # Shrink the cap for the test (avoid spamming the
        # real OrderedDict with 1024 entries).
        gateway._MAX_UPSTREAM_CLIENT_CACHE = 5

        counter = {"n": 0}

        def fake_client_factory(*, api_key, base_url):
            counter["n"] += 1
            client = MagicMock()
            client.api_key = api_key
            client.base_url = base_url
            # Tag the client so we can identify which
            # key maps to it.
            client._id = counter["n"]
            return client

        with _patch_async_openai(gateway, fake_client_factory):
            for i in range(15):
                gateway._get_or_build_upstream_client(
                    f"https://p-{i}.test/v1", f"k{i}",
                )

        # Exactly cap entries.
        assert len(gateway._upstream_client_cache) == 5

        # The OLDEST 5 keys (k0..k4) must have been
        # evicted; k5..k14 survive.
        surviving_keys = list(
            gateway._upstream_client_cache.keys()
        )
        for k in surviving_keys:
            assert int(k[1].lstrip("k")) >= 10, (
                f"F62 FIFO regression: oldest key {k} "
                "survived when newer keys were evicted"
            )

    def test_hit_bumps_to_end(self) -> None:
        """A re-hit on the same key moves it to the end so
        a subsequent eviction doesn't drop an active
        provider."""
        gateway = _reset_cache()
        gateway._MAX_UPSTREAM_CLIENT_CACHE = 3

        counter = {"n": 0}

        def fake_client_factory(*, api_key, base_url):
            counter["n"] += 1
            client = MagicMock()
            client._id = counter["n"]
            return client

        with _patch_async_openai(gateway, fake_client_factory):
            gateway._get_or_build_upstream_client(
                "https://p-1.test/v1", "k1"
            )
            gateway._get_or_build_upstream_client(
                "https://p-2.test/v1", "k2"
            )
            gateway._get_or_build_upstream_client(
                "https://p-3.test/v1", "k3"
            )
            # Hit k1 again — must move it to the end of
            # the OrderedDict.
            gateway._get_or_build_upstream_client(
                "https://p-1.test/v1", "k1"
            )
            keys = list(gateway._upstream_client_cache.keys())
            assert keys[-1][1] == "k1", (
                "F62 regression: hit should bump the key "
                "to the end of the OrderedDict"
            )

            # Add a new key — k2 (oldest untouched) gets
            # evicted, NOT k1.
            gateway._get_or_build_upstream_client(
                "https://p-4.test/v1", "k4"
            )
            keys_now = list(gateway._upstream_client_cache.keys())
            assert "k2" not in [
                k[1] for k in keys_now
            ], "F62 regression: k2 should have been evicted"
            assert "k1" in [
                k[1] for k in keys_now
            ], "F62 regression: k1 should survive (it was bumped)"
            assert "k3" in [k[1] for k in keys_now]
            assert "k4" in [k[1] for k in keys_now]


class TestF62SourceLevel:
    """Source-level pin: each F62 helper / constant /
    pattern appears in the gateway module so a future
    refactor doesn't quietly delete the cap."""

    def test_ordereddict_used_in_cache_type(self) -> None:
        import inspect

        from eden.api.routes import gateway

        src = inspect.getsource(gateway)
        assert "OrderedDict" in src
        # Specifically the cache declaration.
        assert "_upstream_client_cache" in src

    def test_cap_constant_in_source(self) -> None:
        import inspect

        from eden.api.routes import gateway

        src = inspect.getsource(gateway)
        assert "_MAX_UPSTREAM_CLIENT_CACHE" in src

    def test_eviction_loop_in_source(self) -> None:
        """Pin that the cap-enforcement loop exists in
        ``_get_or_build_upstream_client``. Without the
        ``while len(...) > cap`` loop the cache can
        exceed the cap (test-mode bug or regression)."""
        import inspect

        from eden.api.routes import gateway

        src = inspect.getsource(
            gateway._get_or_build_upstream_client
        )
        assert "popitem" in src, (
            "F62 regression: cache eviction loop is "
            "missing from _get_or_build_upstream_client"
        )
        assert (
            "_MAX_UPSTREAM_CLIENT_CACHE" in src
        ), (
            "F62 regression: cap constant not referenced "
            "inside the helper"
        )


class TestF62ExistingKeysUnchanged:
    """The first call still returns the cached client
    (regression guard for F54 + F62)."""

    def test_repeated_calls_return_same_instance(self) -> None:
        gateway = _reset_cache()
        counter = {"n": 0}

        def fake_client_factory(*, api_key, base_url):
            counter["n"] += 1
            client = MagicMock()
            client._id = counter["n"]
            return client

        with _patch_async_openai(gateway, fake_client_factory):
            c1 = gateway._get_or_build_upstream_client(
                "https://p-1.test/v1", "k1"
            )
            c2 = gateway._get_or_build_upstream_client(
                "https://p-1.test/v1", "k1"
            )
        assert c1 is c2, (
            "F62 regression: repeated calls with the same "
            "(url, key) must return the same AsyncOpenAI "
            "instance"
        )
        # And only ONE factory call was made (the second
        # call was a cache hit).
        assert counter["n"] == 1


# ─── Module patch helpers ──────────────────────────────────────────
#
# The function reads ``AsyncOpenAI`` from the module's
# PEP 562 ``__getattr__``. To test the cap logic without
# importing the real openai SDK we patch that lookup
# to return a MagicMock factory.


def _patch_async_openai(gateway, factory):
    """Monkey-patch the ``__getattr__``-resolved ``AsyncOpenAI``
    symbol on the gateway module for the duration of the
    test."""
    # The module uses ``getattr(_sys.modules[__name__],
    # "AsyncOpenAI")`` inside the function. We patch the
    # module attribute ``AsyncOpenAI`` itself.
    from contextlib import contextmanager

    import eden.api.routes.gateway as gw_mod

    @contextmanager
    def _ctx():
        real_attr = getattr(gw_mod, "AsyncOpenAI", None)
        gw_mod.AsyncOpenAI = factory
        try:
            yield
        finally:
            if real_attr is not None:
                gw_mod.AsyncOpenAI = real_attr
            else:
                delattr(gw_mod, "AsyncOpenAI")

    return _ctx()
