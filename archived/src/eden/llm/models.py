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

#: Fallback chain after the primary. FEAT-68 (2026-08 strategic review):
#: 100% of eden's own internal LLM traffic (evals, nudge generation, issue
#: extraction, etc.) went through OpenRouterClient with this list empty,
#: meaning a single upstream/provider outage on the primary model took
#: down every internal-LLM-dependent feature simultaneously with no
#: fallback. Deliberate DR decision: keep this short (one hop) so cost +
#: behaviour stay close to predictable, but not empty. The fallback is a
#: different upstream provider than the primary's DeepInfra route so a
#: DeepInfra-specific outage doesn't take out the fallback too.
#: Override via ``EDEN_INTERNAL_CHAT_FALLBACKS`` (comma-separated) for
#: rollback without a redeploy.
INTERNAL_CHAT_FALLBACKS: list[str] = [
    m.strip()
    for m in (os.getenv("EDEN_INTERNAL_CHAT_FALLBACKS") or "openai/gpt-4o-mini").split(",")
    if m.strip()
]


def internal_chat_chain() -> list[str]:
    """Return [primary, *fallbacks] — the full internal chat model chain."""
    return [INTERNAL_CHAT_MODEL, *INTERNAL_CHAT_FALLBACKS]
