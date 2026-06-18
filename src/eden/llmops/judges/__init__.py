"""Phase 7.1b — LLM-as-judge infrastructure.

Public surface:

- ``Judge`` / ``JudgeContext`` / ``JudgeScore`` — the abstraction
  every scorer implements. See ``base.py``.
- ``JudgeRegistry`` — process-wide store of registered judges, with
  a ``for_event(event)`` filter. Singleton via ``get_judge_registry()``.
- ``HallucinationJudge`` / ``CorrectnessJudge`` / ``ToneJudge`` —
  built-in judges shipped here. Custom judges are added via
  ``registry.register(MyJudge())``.
- ``JudgeRunner`` — runs judges on an event and persists results to
  the ``judge_scores`` table. ``run_judges_for_event`` is a
  convenience wrapper.
- ``RedisTailer`` — async background worker that tails the
  ``telemetry:{tenant_id}:{trace_id}:events`` Redis stream and
  runs judges per event. Started from ``app.py`` lifespan.
- ``schema`` — Pydantic models for the API surface.

Defaults are registered lazily on first ``get_judge_registry()`` call
so cold-path cost is low. Tests can call ``reset_judge_registry()``
to start clean.
"""

from __future__ import annotations

import logging

from .base import Judge, JudgeContext, JudgeScore
from .redis_tailer import RedisTailer
from .registry import (
    JudgeRegistry,
    get_judge_registry,
    reset_judge_registry,
)
from .runner import JudgeRunner, run_judges_for_event

__all__ = [
    "Judge",
    "JudgeContext",
    "JudgeScore",
    "JudgeRegistry",
    "get_judge_registry",
    "reset_judge_registry",
    "JudgeRunner",
    "run_judges_for_event",
    "RedisTailer",
    "register_default_judges",
]


logger = logging.getLogger(__name__)


def register_default_judges(registry: JudgeRegistry) -> None:
    """Register the built-in judge set on a registry.

    Imports are deferred so the cold-path cost is zero for callers
    that don't need the built-ins. Idempotent — re-registering
    overwrites existing entries.
    """
    from .correctness import CorrectnessJudge
    from .hallucination import HallucinationJudge
    from .tone import ToneJudge

    registry.register(HallucinationJudge())
    registry.register(CorrectnessJudge())
    registry.register(ToneJudge())


# Module-level alias for the registry's local import. Defined here to
# avoid a circular import at module load.
def _register_defaults(registry: JudgeRegistry) -> None:
    register_default_judges(registry)
