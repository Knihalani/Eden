"""Gateway analytics — single-shot overview for the portal Gateway page.

Collapses the previous 6-fanout client pattern (finops explorer + token
usage + models + cache + health + top agents) into one Neon-friendly
response driven by ``customer_cost_events``.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Query

from eden.api.deps import get_current_user, require_path_org_access
from eden.api.utils.redact import redact_all

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/gateway",
    tags=["gateway-analytics"],
    dependencies=[
        Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)


@router.get("/overview")
async def gateway_overview(
    org_id: str = Depends(require_path_org_access),
    window_hours: int = Query(24, ge=1, le=720),
) -> dict[str, Any]:
    """Durable spend + tokens + model registry + soft live cache/health."""
    import asyncio

    from eden.llmops.cost_ledger import gateway_ledger_overview

    ledger, models, cache_savings, cache_stats, providers = await asyncio.gather(
        gateway_ledger_overview(
            org_id,
            window_hours=window_hours,
            include_sessions=False,
            include_classifier=False,
        ),
        _list_models_safe(org_id),
        _gateway_cache_savings(org_id, window_hours),
        _cache_stats_safe(),
        _provider_health_safe(),
    )

    return {
        "status": "ok",
        "feature": "gateway_overview",
        "live": True,
        "data": {
            **ledger,
            "window_hours": window_hours,
            "cache_savings_usd": cache_savings,
            "models": models,
            "cache": cache_stats,
            "providers": providers,
        },
    }


async def _list_models_safe(org_id: str) -> list[dict[str, Any]]:
    try:
        from eden.llmops import registry_store

        configs = await registry_store.list_models(org_id)
        out: list[dict[str, Any]] = []
        for c in configs:
            out.append(
                {
                    "model_id": c.model_id,
                    "name": c.name,
                    "provider": c.provider,
                    "upstream_model": c.upstream_model,
                    "upstream_key_prefix": c.upstream_key_prefix,
                    "endpoint": c.endpoint,
                    "enabled": c.enabled,
                    "routing_priority": c.routing_priority,
                    "created_at": c.created_at.isoformat() if c.created_at else None,
                    "updated_at": c.updated_at.isoformat() if c.updated_at else None,
                }
            )
        return out
    except Exception as exc:
        logger.debug("gateway overview models failed: %s", redact_all(str(exc)))
        return []


async def _gateway_cache_savings(org_id: str, window_hours: int) -> float:
    """Best-effort prompt-cache $ saved from telemetry (may be sparse)."""
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return 0.0
        row = await client.fetchrow(
            """
            SELECT COALESCE(SUM(prompt_cache_savings_usd), 0) AS saved
            FROM telemetry_events
            WHERE tenant_id = $1
              AND cache_hit IS TRUE
              AND timestamp > NOW() - ($2 || ' hours')::interval
            """,
            org_id,
            str(window_hours),
        )
        return float(row["saved"] or 0) if row else 0.0
    except Exception as exc:
        logger.debug("gateway overview cache savings failed: %s", redact_all(str(exc)))
        return 0.0


async def _cache_stats_safe() -> dict[str, Any] | None:
    try:
        from eden.api.routes.llmops import _semantic_cache

        stats = _semantic_cache.get_stats()
        return stats if isinstance(stats, dict) else None
    except Exception as exc:
        logger.debug("gateway overview cache stats failed: %s", redact_all(str(exc)))
        return None


async def _provider_health_safe() -> list[dict[str, Any]]:
    try:
        from eden.api.routes.llmops import _ai_gateway

        health = _ai_gateway.get_provider_health()
        out: list[dict[str, Any]] = []
        for h in health or []:
            if hasattr(h, "to_dict"):
                out.append(h.to_dict())
            else:
                out.append(
                    {
                        "provider": str(getattr(h, "provider", h)),
                        "healthy": bool(getattr(h, "healthy", False)),
                        "avg_latency_ms": float(
                            getattr(h, "avg_latency_ms", 0) or 0
                        ),
                        "error_rate": float(getattr(h, "error_rate", 0) or 0),
                    }
                )
        return out
    except Exception as exc:
        logger.debug("gateway overview health failed: %s", redact_all(str(exc)))
        return []
