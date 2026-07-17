"""WS2 learn-in-production gateway filter registration."""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# Tracks gateways (by id()) that have already had the learn filters installed.
# Using a per-gateway set instead of a single bool allows the same filters to
# be registered on both the retired llmops gateway AND the real
# /gateway/v1 AIGateway without the first installation silently blocking the
# second. Engine/filter singletons are still created only once (see below).
_installed_gateways: set[int] = set()
_nudge_engine = None
_nudge_filter = None
_book_filter = None
_guardrail_filter = None
_prompt_deploy_filter = None


_LEARN_FILTER_NAMES = ("runtime_nudge", "agent_book", "judge_guardrail", "prompt_deploy")


def install_learn_filters(gateway: object | None = None) -> None:
    """Register F39/F40/N15 gateway filters on *gateway*. Idempotent per gateway.

    Can be called multiple times with different gateway instances (e.g. the
    retired llmops gateway AND the real /gateway/v1 AIGateway). The engine
    and filter singletons are created only on the first call and reused on
    subsequent calls so ``NudgeEngine`` is not instantiated more than once.
    """
    global _nudge_engine, _nudge_filter, _book_filter, _guardrail_filter, _prompt_deploy_filter

    from eden.llmops.filters.book import BookGatewayFilter
    from eden.llmops.filters.guardrail import get_guardrail_filter
    from eden.llmops.filters.nudge import NudgeGatewayFilter
    from eden.llmops.filters.prompt_deploy import get_prompt_deploy_filter
    from eden.nudges.engine import NudgeEngine

    if gateway is None:
        try:
            from eden.api.routes.llmops import _ai_gateway

            gateway = _ai_gateway
        except Exception:
            from eden.llmops.ai_gateway import AIGateway

            gateway = AIGateway()

    gateway_id = id(gateway)
    if gateway_id in _installed_gateways:
        return

    # Create engine and filters once; reuse on every subsequent gateway.
    if _nudge_engine is None:
        _nudge_engine = NudgeEngine()
        _nudge_filter = NudgeGatewayFilter(_nudge_engine)
        _book_filter = BookGatewayFilter()
        _guardrail_filter = get_guardrail_filter()
        _prompt_deploy_filter = get_prompt_deploy_filter()

    # Avoid double-registration if startup or eval_intel calls twice.
    for name in _LEARN_FILTER_NAMES:
        gateway.unregister_filter(name)

    gateway.register_filter(_nudge_filter)
    gateway.register_filter(_book_filter)
    gateway.register_filter(_guardrail_filter)
    gateway.register_filter(_prompt_deploy_filter)
    _installed_gateways.add(gateway_id)
    logger.info(
        "learn_wiring: F39 nudge + F40 book + N15 guardrail + F68 prompt_deploy "
        "filters installed on %s (order: after PII/trajectory)",
        type(gateway).__name__,
    )


def get_nudge_engine():
    return _nudge_engine


__all__ = ["install_learn_filters", "get_nudge_engine", "_installed_gateways"]
