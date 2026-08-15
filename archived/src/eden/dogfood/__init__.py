"""Bootstrap the public Eden Python SDK inside this deployment.

When ``EDEN_API_KEY`` + ``EDEN_ORG_ID`` are set, Eden instruments itself
exactly like any other customer agent: ``configure`` + ``instrument()``.
Internal OpenAI-compatible clients (OpenRouter) then emit traces into
that org.

Never hard-code keys here — read env only.
"""

from __future__ import annotations

import logging
import os
import sys
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_BOOTSTRAPPED = False


def _ensure_eden_sdk_on_path() -> None:
    """Prefer installed ``eden_sdk``; fall back to repo / image layout."""
    try:
        import eden_sdk  # noqa: F401

        return
    except ImportError:
        pass
    candidates = [
        Path(__file__).resolve().parents[3] / "sdk" / "python",  # repo
        Path("/app/sdk/python"),  # Docker
        Path("/app"),  # Docker flat copy of eden_sdk/
    ]
    for root in candidates:
        if (root / "eden_sdk").is_dir():
            path = str(root)
            if path not in sys.path:
                sys.path.insert(0, path)
            return


def dogfood_credentials() -> tuple[str, str]:
    """Return (api_key, org_id) from env, or empty strings."""
    api_key = (
        os.environ.get("EDEN_API_KEY") or os.environ.get("EDEN_ORG_API_KEY") or ""
    ).strip()
    org_id = (
        os.environ.get("EDEN_ORG_ID") or os.environ.get("EDEN_DEFAULT_ORG") or ""
    ).strip()
    return api_key, org_id


def bootstrap_dogfood_sdk(*, force: bool = False) -> bool:
    """Configure + instrument the Eden SDK for this process.

    Returns True when instrumentation is active.
    """
    global _BOOTSTRAPPED
    if _BOOTSTRAPPED and not force:
        return True

    if os.environ.get("EDEN_DISABLED", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }:
        logger.info("dogfood SDK: EDEN_DISABLED set — skipping")
        return False

    api_key, org_id = dogfood_credentials()
    if not api_key or not org_id:
        logger.info(
            "dogfood SDK: EDEN_API_KEY/EDEN_ORG_ID unset — skipping (normal for "
            "non-dogfood deploys)"
        )
        return False

    _ensure_eden_sdk_on_path()
    try:
        import eden_sdk
        from eden_sdk import configure, instrument
    except ImportError as exc:
        logger.warning("dogfood SDK: eden_sdk not importable: %s", exc)
        return False

    base_url = (
        os.environ.get("EDEN_BASE_URL") or "https://api.edenobservability.com"
    ).rstrip("/")
    agent_id = (os.environ.get("EDEN_AGENT_ID") or "eden-platform").strip()

    configure(
        api_key=api_key,
        org_id=org_id,
        base_url=base_url,
        agent_id=agent_id,
        project_id=os.environ.get("EDEN_PROJECT_ID") or "eden-platform",
    )
    # OpenAI + Anthropic cover OpenRouterClient / Insights chat. Skip
    # heavy optional frameworks to keep boot cheap.
    instrument("openai", "anthropic")
    _BOOTSTRAPPED = True
    logger.info(
        "dogfood SDK: configured org=%s agent=%s base=%s sdk=%s",
        org_id,
        agent_id,
        base_url,
        getattr(eden_sdk, "__version__", "unknown"),
    )
    return True


async def flush_dogfood_sdk() -> None:
    """Best-effort flush on shutdown."""
    if not _BOOTSTRAPPED:
        return
    try:
        from eden_sdk import get_default_client

        client = get_default_client()
        flush = getattr(client, "flush", None)
        if flush is None:
            return
        result = flush()
        if hasattr(result, "__await__"):
            await result
    except Exception as exc:  # noqa: BLE001
        logger.debug("dogfood SDK flush failed: %s", exc)


def dogfood_status() -> dict[str, Any]:
    api_key, org_id = dogfood_credentials()
    return {
        "bootstrapped": _BOOTSTRAPPED,
        "has_api_key": bool(api_key),
        "org_id": org_id or None,
        "agent_id": (os.environ.get("EDEN_AGENT_ID") or "eden-platform")
        if _BOOTSTRAPPED
        else None,
        "base_url": (os.environ.get("EDEN_BASE_URL") or "https://api.edenobservability.com")
        if _BOOTSTRAPPED
        else None,
    }
