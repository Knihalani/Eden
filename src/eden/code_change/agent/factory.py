"""Factory — pick the right PR-agent implementation.

Selection priority (highest first):

1. **EdenPatchAgent** (the production default when an LLM
   provider is configured). Real patch generation via
   Eden's existing :class:`eden.code_change.patch_generator.
   PatchGenerator` + :class:`eden.optimization.model_router.
   ModelRouter`. In-process, bounded (timeout + cost cap),
   cost-effective (T2 tier selection is reused from the
   existing pipeline).
2. **LocalCodingAgent** (bulletproof fallback). Tries the
   OpenHands Python SDK / CLI locally first (when installed),
   then the deterministic :class:`ScriptedCodingAgent`, then
   a structured ``report_only`` payload. Never returns
   ``None`` — bulletproof by design.
3. **OpenHandsPRAgent** (optional hosted upgrade) —
   activated only when ``OPENHANDS_API_KEY`` is set.
4. **LocalPRAgent** (last-resort no-LLM fallback) —
   always returns ``report_only``; never fabricates a diff.

The factory is intentionally lazy — no client is constructed
until it's first used, so a missing / invalid hosted key
never crashes import.

Cost: EdenPatchAgent reuses Eden's tiered ModelRouter
(T2 for code gen per the v1.6 ship plan), so the per-call
cost is bounded by Eden's tier selection + the agent's
own ``max_call_cost_usd`` cap (default $0.50). The
LocalCodingAgent costs $0 for scripted edits, your
marginal LLM cost for OpenHands-local.
"""

from __future__ import annotations

import logging
import os
from typing import Any

logger = logging.getLogger(__name__)


def get_default_pr_agent() -> Any:
    """Return the best available :class:`PRAgent` implementation.

    Selection rule: pick the first agent that successfully
    initialises. EdenPatchAgent (LLM-backed) is preferred
    for actual code-fix capability; LocalCodingAgent is the
    bulletproof fallback when the LLM is unreachable; the
    OpenHands hosted API is the optional upgrade; LocalPRAgent
    is the legacy last-resort.
    """
    # Production default: EdenPatchAgent (real LLM-backed).
    try:
        from .eden_patch_agent import EdenPatchAgent
        return EdenPatchAgent()
    except Exception as exc:
        logger.debug(
            "agent factory: EdenPatchAgent init failed (%s); "
            "trying LocalCodingAgent fallback",
            exc,
        )

    # Bulletproof fallback: LocalCodingAgent (OpenHands-local →
    # scripted → report_only). Always returns a PRResult.
    try:
        from .local_coder import LocalCodingAgent
        return LocalCodingAgent()
    except Exception as exc:
        logger.debug(
            "agent factory: LocalCodingAgent init failed (%s); "
            "trying OpenHands cloud",
            exc,
        )

    # Optional hosted upgrade.
    api_key = os.getenv("OPENHANDS_API_KEY", "").strip()
    if api_key:
        try:
            from .openhands import OpenHandsPRAgent
            return OpenHandsPRAgent(api_key=api_key)
        except Exception as exc:
            logger.debug(
                "agent factory: OpenHands init failed (%s); "
                "falling back to LocalPRAgent",
                exc,
            )

    # Last-resort fallback: report-only.
    from .local import LocalPRAgent
    return LocalPRAgent()
