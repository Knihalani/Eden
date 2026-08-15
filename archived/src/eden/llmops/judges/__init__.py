"""Phase 7.1b — LLM-as-judge infrastructure.

Public surface:

- ``Judge`` / ``JudgeContext`` / ``JudgeScore`` — the abstraction
  every scorer implements. See ``base.py``.
- ``JudgeRegistry`` — process-wide store of registered judges.
- ``UnifiedJudge`` — opt-in multi-axis LLM judge (``judges_llm_v1``).
  Production float scores come from Layer A. ``SatisfactionJudge`` is
  the only always-on built-in (SQL / feedback, no LLM).
- ``JudgeRunner`` — runs judges on an event and persists results.
- ``RedisTailer`` — async background worker (opt-in).
"""

from __future__ import annotations

import logging

from .base import Judge, JudgeContext, JudgeScore
from .redis_tailer import RedisTailer, start_judge_tailer, stop_judge_tailer
from .registry import (
    JudgeRegistry,
    get_judge_registry,
    reset_judge_registry,
)
from .runner import JudgeRunner, run_judges_for_event
from .unified import UNIFIED_AXES, UnifiedJudge

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
    "start_judge_tailer",
    "stop_judge_tailer",
    "register_default_judges",
    "UnifiedJudge",
    "UNIFIED_AXES",
]


logger = logging.getLogger(__name__)


def register_default_judges(registry: JudgeRegistry) -> None:
    """Register built-in judges.

    Production scores come from Layer A ($0 floats). UnifiedJudge is
    opt-in via ``judges_llm_v1`` for calibration / on-demand re-score.
    SatisfactionJudge (SQL / feedback, no LLM) always registers.
    """
    from .satisfaction import SatisfactionJudge

    registry.register(SatisfactionJudge())

    llm_on = False
    try:
        from eden.config import get_settings

        llm_on = bool(getattr(get_settings(), "judges_llm_v1", False))
    except Exception:
        llm_on = False
    if not llm_on:
        return

    from .unified import UNIFIED_AXES, UnifiedJudge

    unified = UnifiedJudge()
    registry.register(unified)
    for axis in UNIFIED_AXES:
        registry.register_alias(axis, unified)


def _register_defaults(registry: JudgeRegistry) -> None:
    register_default_judges(registry)
