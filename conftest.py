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
