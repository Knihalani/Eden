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
    """Verify Redis responds to PING.

    Vocabulary (aligned with ``/health``):
      * ``ok`` — PING succeeded
      * ``not_configured`` — no Redis URL
      * ``quota_exhausted`` — Upstash max-requests circuit open
      * ``error: …`` — probe failed
    """
    from eden.storage.redis import (
        get_redis_client,
        redis_quota_exhausted,
        redis_url_configured,
    )

    if redis_quota_exhausted():
        return "quota_exhausted"
    if not redis_url_configured():
        return "not_configured"
    client = await get_redis_client()
    if client is None:
        # Race: circuit may have opened between the checks above.
        if redis_quota_exhausted():
            return "quota_exhausted"
        return "not_configured"
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


async def check_typesense() -> str:
    """Verify Typesense health when enabled (soft dep).

    Disabled / unconfigured Typesense is ``ok`` — not an outage.
    When enabled, an unreachable node soft-fails like Redis/Qdrant
    (Wave 1.3 / 8.5): never gates ``/ready``; feature search uses
    Postgres fallback with ``fallback=True`` for the unavailable banner.
    """
    from eden.observability.typesense_client import get_typesense_client

    client = get_typesense_client()
    if client is None:
        return "ok"
    ok = await client.health()
    if not ok:
        return "error: typesense unreachable"
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


def health_probe_http_status(overall: str, mode: str = "auto") -> int:
    """Map `/health` body status → HTTP status code.

    Probe contract (Wave 1.3 / July 2026):
      * ``/live``  — process up (LB liveness).
      * ``/ready`` — Postgres only; soft deps never gate ingress.
      * ``/health``— detailed report for monitors. Soft-dep degradation
        (Qdrant Errno 99, quality worker, etc.) keeps
        ``status: "degraded"`` and HTTP **503** so status pages that
        key off the status code still page. Ingress / Railway / Helm
        MUST probe ``/ready`` or ``/live`` — never ``/health`` — or a
        Qdrant blip removes every pod (``no healthy upstream``).
      * Portal UX parses the JSON body and treats ``degraded`` as a
        soft warning even when HTTP is 503.
    """
    if mode == "200":
        return 200
    if mode == "503":
        return 503
    return 200 if overall == "healthy" else 503


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
        "typesense": check_typesense,
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
            if name == "redis":
                try:
                    from eden.storage.redis import note_redis_quota_exhausted

                    note_redis_quota_exhausted(results[name])
                except Exception:  # noqa: BLE001
                    pass
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
