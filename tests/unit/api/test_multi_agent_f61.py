"""F61 — multi_agent in-memory state leak fix.

Pre-F61 the four module-level dicts (``_environments``,
``_role_systems``, ``_memory_services``, ``_hitl_managers``)
in ``eden.api.routes.multi_agent`` were unbounded. The
only way to free memory was the explicit DELETE endpoint;
the only TTL was the pod lifetime. A long-running pod
could accumulate tens of thousands of environments
(attack vector: trivial looped POST). F61 added a hard
cap + LRU eviction + a TTL sweep.

The route is mounted at
``/orgs/{org_id}/multi-agent`` (gated by feature flag
``enable_eval_pipeline``) so it's the right shape to test
end-to-end via TestClient, but the helpers
(``_touch_env``, ``_purge_env``, ``_evict_stale``,
``_enforce_cap_on_insert``) are pure Python — they don't
need the route plumbing to test the cap / LRU / TTL
semantics.
"""

from __future__ import annotations

import pytest


def _reload_helpers():
    """Re-import the helpers so module state resets per test."""
    import importlib

    import eden.api.routes.multi_agent as mod
    importlib.reload(mod)
    return mod


class TestF61TouchEnvBumpsLastSeen:
    """``_touch_env`` records the current monotonic time so
    the cap/TTL logic can order entries. Pin the shape so
    the helper isn't accidentally removed in a refactor."""

    def test_touch_records_timestamp(self) -> None:
        mod = _reload_helpers()
        mod._touch_env("env_xyz")
        assert "env_xyz" in mod._env_last_seen

    def test_touch_replaces_timestamp(self) -> None:
        """A second touch must overwrite the prior timestamp,
        not stack it."""
        mod = _reload_helpers()
        mod._touch_env("env_xyz")
        first = mod._env_last_seen["env_xyz"]
        mod._touch_env("env_xyz")
        second = mod._env_last_seen["env_xyz"]
        assert second >= first

    def test_touch_is_silent_on_bad_input(self) -> None:
        """The helper is best-effort — a stray exception
        inside must not propagate (it runs on every API
        hit)."""
        mod = _reload_helpers()
        # No assertion needed — the contract is that it
        # doesn't raise. Touching a non-existent env id is
        # the normal case (creating new state), so just
        # make sure it works.
        mod._touch_env("env_a")
        mod._touch_env("env_b")
        assert "env_a" in mod._env_last_seen
        assert "env_b" in mod._env_last_seen


class TestF61EvictStaleDropsOldEntries:
    """``_evict_stale`` removes envs whose last access is
    older than ``_ENV_TTL_SECONDS``. Without it, idle
    tenants pinned memory until the pod restart."""

    def test_evicts_envs_older_than_ttl(self, monkeypatch) -> None:
        mod = _reload_helpers()
        # Seed two envs, mark one stale and one fresh.
        mod._env_last_seen["env_stale"] = (
            mod.time.monotonic() - mod._ENV_TTL_SECONDS - 60.0
        )
        mod._env_last_seen["env_fresh"] = mod.time.monotonic()
        mod._environments["env_stale"] = {"env_id": "env_stale"}
        mod._environments["env_fresh"] = {"env_id": "env_fresh"}
        mod._role_systems["env_stale"] = object()
        mod._role_systems["env_fresh"] = object()

        mod._evict_stale()

        assert "env_stale" not in mod._env_last_seen
        assert "env_fresh" in mod._env_last_seen
        # Auxiliary state for the stale env also dropped.
        assert "env_stale" not in mod._environments
        assert "env_stale" not in mod._role_systems
        # Fresh env survived everywhere.
        assert "env_fresh" in mod._env_last_seen
        assert "env_fresh" in mod._environments


class TestF61CapEnforcedOnInsert:
    """``_enforce_cap_on_insert`` keeps
    ``len(_environments) < _MAX_ENVIRONMENTS`` by
    evicting the least-recently-touched entry."""

    def test_drops_oldest_when_cap_exceeded(
        self, monkeypatch,
    ) -> None:
        mod = _reload_helpers()
        # Shrink the cap so the test is fast.
        monkeypatch.setattr(mod, "_MAX_ENVIRONMENTS", 3)
        # Seed three envs (already AT the cap).
        mod._env_last_seen["env_a"] = 100.0  # oldest
        mod._env_last_seen["env_b"] = 200.0
        mod._env_last_seen["env_d"] = 300.0  # also there
        mod._environments["env_a"] = {"env_id": "env_a"}
        mod._environments["env_b"] = {"env_id": "env_b"}
        mod._environments["env_d"] = {"env_id": "env_d"}
        # Inserting a fourth must trigger an eviction.
        # The victim is env_a (lowest timestamp).
        mod._touch_env("env_e")  # mark the would-be new one
        mod._enforce_cap_on_insert("env_e")
        mod._environments["env_e"] = {"env_id": "env_e"}
        # env_a is gone; env_b/d/e remain.
        assert "env_a" not in mod._environments
        assert "env_a" not in mod._env_last_seen
        assert "env_b" in mod._environments
        assert "env_d" in mod._environments
        # Size now equals cap (env_b, env_d, env_e).
        assert len(mod._environments) == 3

    def test_cap_loop_terminates_when_no_victim(self) -> None:
        """If the cap is 1 and the caller inserts with the
        same ``env_id`` repeatedly, the eviction loop
        must break out (defense-in-depth against an
        infinite loop)."""
        mod = _reload_helpers()
        mod._MAX_ENVIRONMENTS = 1  # impossible case
        mod._env_last_seen["env_x"] = 0.0
        mod._environments["env_x"] = {"env_id": "env_x"}
        # Should NOT hang.
        mod._enforce_cap_on_insert("env_x")


class TestF61PurgeEnvDropsAllState:
    """``_purge_env`` removes every per-env dict in one
    call so callers (delete, evict, cap-enforce) don't
    need to know about each dict individually."""

    def test_purge_drops_all_five_dicts(self) -> None:
        """F61.fix — ``_purge_env`` clears every per-env
        dict (env row, role system, memory service, HITL
        manager, test suite) plus the LRU timestamp. The
        earlier version missed ``_test_suites`` which
        would leak test-suite entries past every
        delete / eviction / cap path."""
        mod = _reload_helpers()
        mod._environments["env_a"] = {"env_id": "env_a"}
        mod._role_systems["env_a"] = object()
        mod._memory_services["env_a"] = object()
        mod._hitl_managers["env_a"] = object()
        mod._test_suites["env_a"] = {"results": []}
        mod._env_last_seen["env_a"] = 1.0

        mod._purge_env("env_a")

        assert "env_a" not in mod._environments
        assert "env_a" not in mod._role_systems
        assert "env_a" not in mod._memory_services
        assert "env_a" not in mod._hitl_managers
        assert "env_a" not in mod._test_suites
        assert "env_a" not in mod._env_last_seen

    def test_purge_unknown_env_is_noop(self) -> None:
        mod = _reload_helpers()
        # MUST NOT raise.
        mod._purge_env("env_nonexistent")


class TestF61TtlAndCapConstants:
    """Pin the production constants so a future refactor
    doesn't accidentally shrink the cap to something
    absurd (e.g. 10) or extend the TTL to forever."""

    def test_cap_is_non_trivial(self) -> None:
        mod = _reload_helpers()
        assert mod._MAX_ENVIRONMENTS >= 64, (
            "F61 cap shrunk too small — at least 64 is "
            "needed for realistic concurrent use"
        )

    def test_ttl_is_finite(self) -> None:
        mod = _reload_helpers()
        assert 60.0 <= mod._ENV_TTL_SECONDS <= (
            24 * 3600.0
        ), (
            "F61 TTL out of range — should be at least 1 "
            "minute and at most 1 day"
        )


class TestF61SourceLevel:
    """Source-level scan: pin the new helper functions
    appear in the module so a future refactor doesn't
    quietly delete them."""

    def test_helpers_defined(self) -> None:
        import inspect

        from eden.api.routes import multi_agent

        src = inspect.getsource(multi_agent)
        for name in (
            "_touch_env",
            "_evict_stale",
            "_purge_env",
            "_enforce_cap_on_insert",
            "_env_last_seen",
            "_ENV_TTL_SECONDS",
            "_MAX_ENVIRONMENTS",
        ):
            assert name in src, (
                f"F61 regression: {name} is missing from "
                "multi_agent.py"
            )

    def test_create_environment_calls_eviction(self) -> None:
        """Pin that ``create_environment`` calls both
        ``_evict_stale`` and ``_enforce_cap_on_insert``
        BEFORE allocating the new state (so a request
        can't push the size past the cap)."""
        import inspect

        from eden.api.routes import multi_agent

        src = inspect.getsource(multi_agent)
        # The two helpers must appear in the create endpoint.
        # Order between them doesn't matter — both must
        # precede the first ``_environments[env_id] =`` assignment.
        i_evict = src.find("_evict_stale()")
        i_cap = src.find("_enforce_cap_on_insert(env_id)")
        i_assign = src.find("_environments[env_id] =")
        assert i_evict != -1 and i_cap != -1 and i_assign != -1
        assert i_evict < i_assign, (
            "F61 regression: _evict_stale() runs AFTER "
            "_environments[env_id] assignment"
        )
        assert i_cap < i_assign, (
            "F61 regression: _enforce_cap_on_insert() "
            "runs AFTER _environments[env_id] assignment"
        )

    def test_delete_environment_uses_purge(self) -> None:
        """Pin that delete_environment uses the F61
        purge helper instead of repeating the per-dict
        ``pop`` calls (single source of truth for
        cleanup)."""
        import inspect

        from eden.api.routes import multi_agent

        src = inspect.getsource(multi_agent)
        assert "_purge_env(env_id)" in src, (
            "F61 regression: delete_environment doesn't "
            "call _purge_env(env_id) — partial cleanup "
            "risk for _env_last_seen"
        )
