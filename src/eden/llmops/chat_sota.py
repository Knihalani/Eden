"""Wave 23 — ChatSidebar SOTA helpers (tier routing, cost, cite, TTFT).

Pure / lightly-coupled helpers used by ChatService + ai-insights routes.
Chat is locked to T2 — no operator model picker.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from eden.optimization.model_router import TIER_MODELS, ModelTier

ChatTier = Literal["t2"]

# Fixed T2 catalog entry (no Auto/T1/T3 operator picker).
MODEL_PICKER: list[dict[str, str]] = [
    {
        "id": TIER_MODELS[ModelTier.T2][0],
        "label": "Standard (T2)",
        "tier": "t2",
        "description": "Fixed chat tier — no operator picker",
    },
]

# Soft TTFT budgets (ms) — warn in SSE when exceeded; do not hard-fail.
TTFT_BUDGET_MS: dict[str, int] = {
    "t1": 1500,
    "t2": 3000,
    "t3": 5000,
    "auto": 4000,
}

_CLAIM_ID_RE = re.compile(
    r"\b(?:trace|span|issue|agent|session|artifact)[_-]?(?:id)?\s*[:=]?\s*"
    r"[`'\"]?([a-zA-Z0-9_-]{6,})[`'\"]?",
    re.IGNORECASE,
)
_BARE_TRACE_RE = re.compile(r"\b(?:trc_|trace_)[a-zA-Z0-9_-]{6,}\b", re.IGNORECASE)


def resolve_picker_model(
    *,
    preferred_model: str | None = None,
    preferred_tier: str | None = None,
) -> tuple[str | None, str]:
    """Always T2 — chat has no operator model picker.

    Returns ``(None, "t2")``; callers use :func:`model_for_tier`.
    """
    _ = preferred_model, preferred_tier
    return None, "t2"


def classify_chat_tier(message: str, *, preferred_tier: str = "auto") -> ModelTier:
    """Always T2 — chat has no Auto/T1/T3 routing."""
    _ = message, preferred_tier
    return ModelTier.T2


def model_for_tier(tier: ModelTier) -> str:
    models = TIER_MODELS.get(tier) or TIER_MODELS[ModelTier.T2]
    return models[0]


def estimate_turn_cost_usd(
    model: str,
    *,
    prompt_tokens: int = 2500,
    completion_tokens: int = 800,
) -> dict[str, Any]:
    """Preflight cost estimate from PricingCatalog (fallback heuristic)."""
    cost_usd = 0.0
    source = "heuristic"
    try:
        from eden.llmops.pricing import lookup_seed_row

        row = lookup_seed_row(model)
        if row is not None:
            cost_usd = float(
                row.cost_for_request(
                    input_tokens=max(0, int(prompt_tokens)),
                    output_tokens=max(0, int(completion_tokens)),
                )
            )
            source = getattr(row, "source", "catalog") or "catalog"
    except Exception:
        # ~$3/1M in + $15/1M out blended heuristic for unknown models
        cost_usd = (prompt_tokens / 1_000_000) * 3.0 + (
            completion_tokens / 1_000_000
        ) * 15.0
        source = "heuristic"

    return {
        "model": model,
        "prompt_tokens_est": int(prompt_tokens),
        "completion_tokens_est": int(completion_tokens),
        "estimated_usd": round(cost_usd, 6),
        "source": source,
    }


def ttft_budget_ms(tier: str) -> int:
    return TTFT_BUDGET_MS.get((tier or "t2").lower(), TTFT_BUDGET_MS["t2"])


def ttft_warning(ttft_ms: int | None, tier: str) -> str | None:
    if ttft_ms is None or ttft_ms <= 0:
        return None
    budget = ttft_budget_ms(tier)
    if ttft_ms > budget:
        return (
            f"TTFT {ttft_ms}ms exceeded {tier.upper()} budget {budget}ms."
        )
    return None


def claim_ids_in_text(text: str) -> list[str]:
    ids: list[str] = []
    for m in _CLAIM_ID_RE.finditer(text or ""):
        ids.append(m.group(1))
    for m in _BARE_TRACE_RE.finditer(text or ""):
        ids.append(m.group(0))
    # Dedupe preserve order
    seen: set[str] = set()
    out: list[str] = []
    for i in ids:
        key = i.lower()
        if key not in seen:
            seen.add(key)
            out.append(i)
    return out


def cite_before_claim(
    display_text: str,
    citations: list[dict[str, Any]] | None,
) -> dict[str, Any]:
    """Require ```cite blocks when the answer names concrete entity ids.

    Soft gate: returns ``ok`` + optional ``warning`` (never blocks the turn).
    """
    ids = claim_ids_in_text(display_text)
    cites = citations or []
    cite_ids = {
        str(c.get("id") or "").lower()
        for c in cites
        if isinstance(c, dict)
    }
    missing = [i for i in ids if i.lower() not in cite_ids]
    # Only flag when ≥1 concrete id appears and none are cited.
    if ids and not cites:
        return {
            "ok": False,
            "claim_ids": ids,
            "missing": missing,
            "warning": (
                "Cite-before-claim: named entity ids without ```cite blocks. "
                "Emit citations before asserting facts about them."
            ),
        }
    if missing and len(missing) == len(ids):
        return {
            "ok": False,
            "claim_ids": ids,
            "missing": missing,
            "warning": (
                "Cite-before-claim: entity ids in prose not covered by citations."
            ),
        }
    return {"ok": True, "claim_ids": ids, "missing": [], "warning": None}
