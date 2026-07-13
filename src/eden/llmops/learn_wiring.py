"""WS2 learn-in-production gateway filter registration."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_installed = False
_nudge_engine = None
_nudge_filter = None
_book_filter = None


_LEARN_FILTER_NAMES = ("runtime_nudge", "agent_book", "judge_guardrail")


def install_learn_filters(gateway: object | None = None) -> None:
    """Register F39/F40/N15 gateway filters. Idempotent."""
    global _installed, _nudge_engine, _nudge_filter, _book_filter
    if _installed:
        return

    from eden.llmops.filters.book import BookGatewayFilter
    from eden.llmops.filters.guardrail import get_guardrail_filter
    from eden.llmops.filters.nudge import NudgeGatewayFilter
    from eden.nudges.engine import NudgeEngine

    _nudge_engine = NudgeEngine()
    _nudge_filter = NudgeGatewayFilter(_nudge_engine)
    _book_filter = BookGatewayFilter()
    guardrail = get_guardrail_filter()

    if gateway is None:
        try:
            from eden.api.routes.llmops import _ai_gateway

            gateway = _ai_gateway
        except Exception:
            from eden.llmops.ai_gateway import AIGateway

            gateway = AIGateway()

    # Avoid double-registration if startup or eval_intel calls twice.
    for name in _LEARN_FILTER_NAMES:
        gateway.unregister_filter(name)

    gateway.register_filter(_nudge_filter)
    gateway.register_filter(_book_filter)
    gateway.register_filter(guardrail)
    _installed = True
    logger.info(
        "learn_wiring: F39 nudge + F40 book + N15 guardrail filters installed "
        "(order: after PII/trajectory)"
    )


def get_nudge_engine():
    return _nudge_engine


__all__ = ["install_learn_filters", "get_nudge_engine"]
