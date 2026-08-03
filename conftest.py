"""Repo-root conftest: reset process-global state between tests.

``pyproject.toml`` sets ``testpaths = ["tests", "supplementaries"]``, and a
conftest under ``tests/`` does not apply to ``supplementaries/``. Several
modules keep process-global caches that are correct in production and
wrong to carry across tests — auth/API-key caches, leader-election
counters, and the sidecar bundle's "already started" flag.

When only ``tests/conftest.py`` reset them, a supplementaries test could
leave the sidecar bundle marked started and a later
``tests/unit/workers`` test would see it as already running: green on its
own, red in a full-suite run, for reasons unrelated to either test. This
file exists so the reset is session-wide.

Kept deliberately small — everything else stays in ``tests/conftest.py``.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _default_full_sampling_policy():
    """Pin the process-wide N16 sampling policy to ``full`` (100% keep).

    ``eden.observability.sampling.policy.get_sampling_policy()`` builds a
    process-global singleton from ``Settings.sampling_profile`` on first
    call and caches it. ``Settings.sampling_profile`` defaults to
    ``balanced`` in production (~15% probabilistic keep — see
    ``src/eden/config.py`` and
    ``docs/docs/explanation/sampling-and-retention.md``), so any test that
    exercises ingest without pinning sampling itself would otherwise
    randomly drop some of its fixture events — flaky by construction, and
    it would depend on which test in the run happens to build the
    singleton first.

    Tests of sampling behaviour itself (``tests/unit/observability/
    test_n16_sampling_e2e_signals.py``) patch ``eden.config.get_settings``
    and call ``reset_sampling_policy()`` inside their own test body, which
    runs *after* this fixture's setup and rebuilds the singleton from
    their patched settings — so they are unaffected by the default set
    here.
    """
    from eden.observability.sampling import policy as _sampling_policy

    _sampling_policy.reset_sampling_policy()
    _sampling_policy._policy = _sampling_policy.IntelligenceAwareSamplingPolicy(
        profile="full", enabled=True
    )
    yield
    _sampling_policy.reset_sampling_policy()


@pytest.fixture(autouse=True)
def _reset_process_globals():
    """Clear cross-test process state before and after every test."""

    def _clear() -> None:
        try:
            from eden.api import deps

            deps.invalidate_api_key_cache()
            deps._org_id_cache.clear()
            deps._user_id_cache.clear()
            deps._last_seen_bumped_at.clear()
        except Exception:
            pass
        try:
            from eden.workers.leader import reset_leader_failure_counts

            reset_leader_failure_counts()
        except Exception:
            pass
        try:
            from eden.workers import background as _bg

            _bg._acquire_outcomes.clear()
        except Exception:
            pass
        try:
            from eden.workers import sidecars as _sidecars

            task = getattr(_sidecars, "_guard_retry_task", None)
            if task is not None and not task.done():
                task.cancel()
            _sidecars._guard_retry_task = None
            _sidecars._started = False
            _sidecars._guard_lock = None
        except Exception:
            pass

    _clear()
    yield
    _clear()
