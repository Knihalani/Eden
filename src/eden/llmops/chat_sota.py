"""Wave 23 — ChatSidebar SOTA helpers (tier routing, cost, cite, TTFT).

Pure / lightly-coupled helpers used by ChatService + ai-insights routes.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from eden.optimization.model_router import TIER_MODELS, ModelTier

ChatTier = Literal["t1", "t2", "t3"]

# Operator-facing model picker (Loop-class). Values are OpenRouter model ids.
MODEL_PICKER: list[dict[str, str]] = [
    {
        "id": "auto",
        "label": "Auto (T1/T3)",
        "tier": "auto",
        "description": "SLM for simple asks; T3 for tools / deep reasoning",
    },
    {
        "id": TIER_MODELS[ModelTier.T1][0],
        "label": "Fast (T1/SLM)",
        "tier": "t1",
        "description": "Cheapest / lowest TTFT",
    },
    {
        "id": TIER_MODELS[ModelTier.T3][0],
        "label": "Expert (T3)",
        "tier": "t3",
        "description": "Multi-tool observability copilot",
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

_COMPLEX_HINTS = (
    "compare",
    "investigate",
    "root cause",
    "why did",
    "correlate",
    "export",
    "alert",
    "signal",
    "sql",
    "dataset",
    "experiment",
    "playground",
    "filter",
    "similar",
    "navigate",
    "create ",
    "promote",
)


def resolve_picker_model(
    *,
    preferred_model: str | None = None,
    preferred_tier: str | None = None,
) -> tuple[str | None, str]:
    """Return (explicit_model_or_None, tier_key).

    ``auto`` / empty → model None (caller classifies), tier ``auto``.
    """
    model = (preferred_model or "").strip() or None
    tier = (preferred_tier or "").strip().lower() or "auto"
    if model and model.lower() == "auto":
        model = None
        tier = "auto"
    if model:
        for row in MODEL_PICKER:
            if row["id"] == model:
                tier = row.get("tier") or tier
                break
        if tier == "auto":
            tier = "t3"
    if tier not in ("t1", "t2", "t3", "auto"):
        tier = "auto"
    return model, tier


def classify_chat_tier(message: str, *, preferred_tier: str = "auto") -> ModelTier:
    """T1/SLM for short factual asks; T3 for tool-heavy / complex turns."""
    if preferred_tier == "t1":
        return ModelTier.T1
    if preferred_tier == "t2":
        return ModelTier.T2
    if preferred_tier == "t3":
        return ModelTier.T3

    text = (message or "").strip().lower()
    if not text:
        return ModelTier.T1
    if len(text) > 280:
        return ModelTier.T3
    if any(h in text for h in _COMPLEX_HINTS):
        return ModelTier.T3
    if text.startswith("/"):
        return ModelTier.T3
    # Short Q&A → SLM
    if len(text) < 120 and "?" in text:
        return ModelTier.T1
    if len(text) < 80:
        return ModelTier.T1
    return ModelTier.T3


def model_for_tier(tier: ModelTier) -> str:
    models = TIER_MODELS.get(tier) or TIER_MODELS[ModelTier.T3]
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
        from eden.llmops.pricing import PricingCatalog

        row = PricingCatalog.default().lookup(model)
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
    return TTFT_BUDGET_MS.get((tier or "auto").lower(), TTFT_BUDGET_MS["auto"])


def ttft_warning(ttft_ms: int | None, tier: str) -> str | None:
    if ttft_ms is None or ttft_ms <= 0:
        return None
    budget = ttft_budget_ms(tier)
    if ttft_ms > budget:
        return (
            f"TTFT {ttft_ms}ms exceeded {tier.upper()} budget {budget}ms "
            "(consider Fast/T1 for simple asks)."
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
