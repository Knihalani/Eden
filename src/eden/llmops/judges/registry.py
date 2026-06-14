"""JudgeRegistry — singleton store of registered Judge instances.

Mirrors the ``DetectorRegistry`` at
``src/eden/insights/detectors.py:625``. Customers register their own
judges (or use the built-in set from this package); the runner
asks ``for_event(event)`` for the judges that apply to one event.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from eden.observability.telemetry_collector import TelemetryEvent

    from .base import Judge

logger = logging.getLogger(__name__)


class JudgeRegistry:
    """Process-wide registry of Judge instances."""

    def __init__(self) -> None:
        self._judges: dict[str, Judge] = {}

    def register(self, judge: Judge) -> None:
        """Register (or overwrite) a judge by its ``name``.

        Idempotent — re-registering the same name replaces the
        previous instance. Used by tests to swap in fakes.
        """
        if not getattr(judge, "name", ""):
            raise ValueError("Judge must declare a non-empty `name`")
        self._judges[judge.name] = judge
        logger.debug(f"registered judge: {judge.name} v{judge.version}")

    def unregister(self, name: str) -> None:
        self._judges.pop(name, None)

    def get(self, name: str) -> Judge | None:
        return self._judges.get(name)

    def list(self) -> list[str]:
        return sorted(self._judges.keys())

    def all(self) -> list[Judge]:
        return list(self._judges.values())

    def for_event(self, event: TelemetryEvent) -> list[Judge]:
        """Return every registered judge whose ``matches(event)`` is True.

        The runner calls this per event to decide which judges to
        invoke. Returning a list (not a generator) lets the caller
        decide the parallelism strategy.
        """
        return [j for j in self._judges.values() if j.matches(event)]


# ── Singleton accessor ──────────────────────────────────────────────

_registry: JudgeRegistry | None = None


def get_judge_registry() -> JudgeRegistry:
    """Get the process-wide registry, lazily registering the
    built-in judge set on first call.
    """
    global _registry
    if _registry is None:
        _registry = JudgeRegistry()
        from . import _register_defaults  # local to avoid cycle
        _register_defaults(_registry)
    return _registry


def reset_judge_registry() -> None:
    """Drop the singleton — for tests that need a clean registry."""
    global _registry
    _registry = None
