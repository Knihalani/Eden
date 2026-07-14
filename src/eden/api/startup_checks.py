"""Fail-closed startup dependency checks for production deploys.

When ``eden_production`` (or ``strict_startup_checks``) is enabled,
**required** check failures raise :class:`StartupCheckError` and prevent
the API from accepting traffic. Soft dependencies (Redis, Qdrant,
OpenRouter) are still probed and logged, but they no longer take the
process out of the load-balancer pool.

Why the split (July 2026): Northflank's ``httpHealthCheck`` hits
``/ready``. When Redis / Qdrant / OpenRouter blipped, every required
probe failed the ready gate → ingress returned plain-text
``no healthy upstream`` → the Vercel portal proxy forwarded 503s for
``/auth/me`` and ``/notifications`` even though Postgres (the only
dependency those routes need) was fine. Soft failures now degrade
``/health`` without black-holing traffic.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

from eden.config import Settings, get_settings

logger = logging.getLogger(__name__)

# Dependencies that must be up for the process to accept traffic.
# Everything else is "soft": logged + exposed on /health, but a blip
# must not remove the pod from the LB (that surfaces as the portal
# 503 storm: ``no healthy upstream``).
REQUIRED_FOR_READY: frozenset[str] = frozenset({"postgres"})


class StartupCheckError(RuntimeError):
    """One or more required dependencies failed their startup probe."""


async def check_postgres() -> str:
    """Verify Postgres accepts a trivial query."""
    from eden.storage.postgres import get_postgres_client

    client = await get_postgres_client()
    result = await client.fetchval("SELECT 1")
    if result != 1:
        return "error: unexpected SELECT 1 result"
    return "ok"


async def check_redis() -> str:
    """Verify Redis responds to PING."""
    from eden.storage.redis import get_redis_client

    client = await get_redis_client()
    if client is None:
        return "error: REDIS_URL not configured"
    pong = await client.ping()
    if pong not in (True, "PONG", b"PONG"):
        return f"error: unexpected PING response {pong!r}"
    return "ok"


async def check_qdrant() -> str:
    """Verify Qdrant lists collections."""
    from eden.storage.qdrant import get_qdrant_client

    client = get_qdrant_client()
    client._get_client().get_collections()
    return "ok"


async def check_openrouter(settings: Settings | None = None) -> str:
    """Verify OpenRouter credentials via the /models endpoint."""
    settings = settings or get_settings()
    api_key = (settings.openrouter_api_key or "").strip()
    if not api_key:
        return "error: OPENROUTER_API_KEY not configured"

    base = (settings.openrouter_base_url or "https://openrouter.ai/api/v1").rstrip("/")
    url = f"{base}/models"
    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url, headers=headers)
    except Exception as exc:
        return f"error: request failed ({exc})"

    if resp.status_code == 401:
        return "error: unauthorized (invalid OPENROUTER_API_KEY)"
    if resp.status_code >= 400:
        return f"error: HTTP {resp.status_code}"
    return "ok"


def is_ready(checks: dict[str, str] | None) -> bool:
    """Return True when every *required* dependency reports ``ok``.

    Soft failures (Redis / Qdrant / OpenRouter) do not flip readiness.
    Missing / empty checks → not ready (safe default for cold start).
    """
    if not checks:
        return False
    for name in REQUIRED_FOR_READY:
        if checks.get(name) != "ok":
            return False
    return True


async def run_startup_checks(
    *,
    settings: Settings | None = None,
    strict: bool | None = None,
) -> dict[str, str]:
    """Run all startup probes and return per-dependency status.

    Args:
        settings: Optional settings override (tests).
        strict: When True, raise on any *required* failure. Soft
            dependency failures are always logged but never raise.
            Defaults to ``settings.strict_startup_checks``.
    """
    settings = settings or get_settings()
    if strict is None:
        strict = bool(getattr(settings, "strict_startup_checks", False))

    probes: dict[str, Any] = {
        "postgres": check_postgres,
        "redis": check_redis,
        "qdrant": check_qdrant,
        "openrouter": lambda: check_openrouter(settings),
    }

    results: dict[str, str] = {}
    required_failures: list[str] = []
    soft_failures: list[str] = []

    for name, probe in probes.items():
        try:
            results[name] = await probe()
        except Exception as exc:
            results[name] = f"error: {exc}"
        if results[name] != "ok":
            entry = f"{name}={results[name]}"
            if name in REQUIRED_FOR_READY:
                required_failures.append(entry)
                logger.error("startup check failed (required): %s -> %s", name, results[name])
            else:
                soft_failures.append(entry)
                logger.warning(
                    "startup check failed (soft — traffic still accepted): %s -> %s",
                    name,
                    results[name],
                )
        else:
            logger.info("startup check passed: %s", name)

    if soft_failures and not required_failures:
        logger.warning(
            "Soft dependency degradation at startup: %s. "
            "/ready stays green so the LB keeps routing; /health reports degraded.",
            "; ".join(soft_failures),
        )

    if strict and required_failures:
        raise StartupCheckError(
            "Startup checks failed (fail-closed): " + "; ".join(required_failures)
        )

    return results
