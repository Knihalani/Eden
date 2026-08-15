"""Real playground LLM handler — ModelRouter + cost caps + kill switches (W18)."""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Any

from eden.prompts.registry import PlaygroundResult

logger = logging.getLogger(__name__)

LLMHandler = Callable[[dict[str, Any]], Awaitable[PlaygroundResult]]

_FEATURE = "playground"
_DEFAULT_DAILY_CAP_USD = 5.0


def _daily_cap_usd() -> float:
    raw = os.getenv("EDEN_PLAYGROUND_DAILY_CAP_USD", str(_DEFAULT_DAILY_CAP_USD))
    try:
        return max(0.0, float(raw))
    except ValueError:
        return _DEFAULT_DAILY_CAP_USD


def _offline_forced() -> bool:
    return os.getenv("EDEN_PLAYGROUND_OFFLINE", "").strip() in ("1", "true", "yes")


def _has_api_key() -> bool:
    try:
        from eden.config import get_settings

        key = (getattr(get_settings(), "openrouter_api_key", None) or "").strip()
        if key:
            return True
    except Exception:
        pass
    return bool((os.getenv("OPENROUTER_API_KEY") or os.getenv("EDEN_OPENROUTER_API_KEY") or "").strip())


def _slot_for_model(model: str) -> str:
    m = (model or "t1").strip().lower()
    if m in ("t1", "fast", "extraction"):
        return "fast"
    if m in ("t3", "t4", "reasoning"):
        return "reasoning"
    if m in ("t2", "code"):
        return "code"
    # Explicit provider/model id → reasoning slot with model override.
    if "/" in m:
        return "reasoning"
    return "fast"


def _model_override(model: str) -> str | None:
    m = (model or "").strip()
    if "/" in m:
        return m
    return None


def _offline_result(prompt_dict: dict[str, Any], *, reason: str) -> PlaygroundResult:
    text = str(prompt_dict.get("user") or "")
    model = str(prompt_dict.get("model") or "t1")
    return PlaygroundResult(
        template_name="",
        template_version=0,
        model=f"{model}+offline:{reason}",
        response=f"[offline:{reason}:{text[:50]}{'...' if len(text) > 50 else ''}]",
        latency_ms=0.5,
        prompt_tokens=len(text.split()),
        completion_tokens=5,
        cost_usd=0.0,
        created_at=datetime.now(UTC).isoformat(),
    )


async def playground_llm_handler(
    prompt_dict: dict[str, Any],
    *,
    org_id: str = "",
) -> PlaygroundResult:
    """Run a compiled playground prompt via ModelRouter when spend is allowed.

    Fail-closed on kill-switch / daily cap. Falls back to deterministic
    offline output when API keys are absent or ``EDEN_PLAYGROUND_OFFLINE=1``
    (unit tests / air-gapped).
    """
    oid = (org_id or str(prompt_dict.get("org_id") or "")).strip()
    model = str(prompt_dict.get("model") or "t1")
    user = str(prompt_dict.get("user") or "")
    system = str(prompt_dict.get("system") or "") or None
    max_tokens = int(prompt_dict.get("max_tokens") or 1024)

    if _offline_forced():
        return _offline_result(prompt_dict, reason="forced")

    if oid:
        try:
            from eden.llmops.feature_kills import is_feature_enabled

            if not await is_feature_enabled(oid, _FEATURE):
                return _offline_result(prompt_dict, reason="kill_switch")
        except Exception as exc:
            logger.debug("playground_llm: kill check failed: %s", exc)
            return _offline_result(prompt_dict, reason="kill_check_error")

        try:
            from eden.llmops.cost_ledger import sum_feature_spend_today

            spent = await sum_feature_spend_today(oid, features=(_FEATURE,))
            cap = _daily_cap_usd()
            if spent >= cap:
                logger.info(
                    "playground_llm: daily cap org=%s spent=%.4f cap=%.4f",
                    oid,
                    spent,
                    cap,
                )
                return _offline_result(prompt_dict, reason="daily_cap")
        except Exception as exc:
            logger.debug("playground_llm: spend check failed: %s", exc)

    if not _has_api_key():
        return _offline_result(prompt_dict, reason="no_api_key")

    started = time.perf_counter()
    try:
        from eden.llm.internal_router import route_async

        kwargs: dict[str, Any] = {
            "slot": _slot_for_model(model),
            "system_prompt": system,
            "output_type": "text",
            "org_id": oid or None,
            "feature": _FEATURE,
            "requires_quality_check": False,
            "max_tokens": max_tokens,
            "expected_min_length": 1,
        }
        override = _model_override(model)
        if override:
            kwargs["model"] = override

        resp = await route_async(
            "playground",
            user,
            **kwargs,
        )
        latency_ms = (time.perf_counter() - started) * 1000.0
        usage = getattr(resp, "usage", None)
        cost = float(getattr(usage, "cost", None) or 0.0) if usage else 0.0
        return PlaygroundResult(
            template_name="",
            template_version=0,
            model=str(getattr(resp, "model", None) or model),
            response=str(getattr(resp, "content", None) or ""),
            latency_ms=latency_ms,
            prompt_tokens=int(getattr(usage, "prompt_tokens", 0) or 0) if usage else 0,
            completion_tokens=int(getattr(usage, "completion_tokens", 0) or 0)
            if usage
            else 0,
            cost_usd=cost,
            created_at=datetime.now(UTC).isoformat(),
        )
    except Exception as exc:
        logger.warning("playground_llm: route failed: %s", exc)
        return _offline_result(prompt_dict, reason="route_error")


def make_playground_handler(org_id: str) -> LLMHandler:
    """Bind ``org_id`` into a Playground-compatible LLMHandler."""

    async def _bound(prompt_dict: dict[str, Any]) -> PlaygroundResult:
        return await playground_llm_handler(prompt_dict, org_id=org_id)

    return _bound


__all__ = [
    "LLMHandler",
    "make_playground_handler",
    "playground_llm_handler",
]
