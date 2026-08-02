"""Single source of truth for Eden-owned internal chat models.

Every Eden product chat/completions call (triage, annotator, patch
generation, AI Insights, novelty review, nudge authoring, compile-signal,
playground slots) resolves through this module. Do not hardcode model
ids in feature code — import :data:`INTERNAL_CHAT_MODEL`.

Rollback: set ``EDEN_INTERNAL_CHAT_MODEL`` to the previous model id and
restart; the env override wins over the constant.
"""

from __future__ import annotations

import os

#: Primary internal chat model for ALL Eden-owned chat calls.
#: deepseek-v4-flash via OpenRouter (DeepInfra): ~$0.09/1M in, $0.18/1M out,
#: 1M context. Chosen 2026-08-01 as the universal internal model (T1=T2=T3).
INTERNAL_CHAT_MODEL: str = (
    os.getenv("EDEN_INTERNAL_CHAT_MODEL") or "deepseek/deepseek-v4-flash-0731"
)

#: Fallback chain after the primary. Empty by design: a single internal
#: model keeps cost + behaviour predictable. Add ids here only behind a
#: deliberate rollback/DR decision.
INTERNAL_CHAT_FALLBACKS: list[str] = []


def internal_chat_chain() -> list[str]:
    """Return [primary, *fallbacks] — the full internal chat model chain."""
    return [INTERNAL_CHAT_MODEL, *INTERNAL_CHAT_FALLBACKS]
