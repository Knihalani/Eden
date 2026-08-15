"""Customer FinOps API — cost explorer, export, kill-switches (SOTA W8).

No Eden COGS / internal unit-economics admin UI.
"""

from __future__ import annotations

import csv
import io
import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, Query, Response
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_org_owner, require_path_org_access
from eden.api.utils.redact import redact_all

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/finops",
    tags=["finops"],
    dependencies=[Depends(get_current_user),
        Depends(require_path_org_access),
    ],
)

# Customer-facing feature kills (not Eden internal COGS).
CUSTOMER_FEATURE_KILLS: tuple[str, ...] = (
    "chat_sidebar",
    "triage",
    "evolution",
    "promote",
    "online_slm",
    "online_llm",
    "judges",
    "gateway",
    "patches",
    "embeddings",
    "nudge_author",
)


@router.get("/explorer")
async def cost_explorer(
    org_id: str = Depends(require_path_org_access),
    window_hours: int = Query(24, ge=1, le=720),
) -> dict[str, Any]:
    """Cost explorer: model/agent/session/feature/day + compare_previous."""
    from eden.llmops.cost_ledger import explorer_summary

    summary = await explorer_summary(org_id, window_hours=window_hours)
    cache_savings = await _gateway_cache_savings(org_id, window_hours)
    return {
        "status": "ok",
        "feature": "f60",
        "live": True,
        "data": {
            **summary,
            "window_hours": window_hours,
            "cache_savings_usd": cache_savings,
            "classifier_savings_usd": float(
                summary.get("classifier_savings_usd") or 0
            ),
        },
    }


@router.get("/export")
async def export_cost_report(
    org_id: str = Depends(require_path_org_access),
    window_hours: int = Query(168, ge=1, le=2160),
    fmt: str = Query("csv", pattern="^(csv|jsonl)$"),
) -> Response:
    """Self-serve CSV/JSONL cost report export."""
    rows = await _list_events(org_id, window_hours=window_hours, limit=10_000)
    if fmt == "jsonl":
        body = "\n".join(json.dumps(r, default=str) for r in rows) + (
            "\n" if rows else ""
        )
        return Response(
            content=body,
            media_type="application/x-ndjson",
            headers={
                "Content-Disposition": (
                    f'attachment; filename="eden-cost-{org_id}.jsonl"'
                )
            },
        )

    buf = io.StringIO()
    writer = csv.DictWriter(
        buf,
        fieldnames=[
            "recorded_at",
            "feature",
            "model",
            "cost_usd",
            "input_tokens",
            "output_tokens",
            "total_tokens",
            "agent_id",
            "session_id",
            "trace_id",
            "request_id",
            "user_id",
        ],
    )
    writer.writeheader()
    for r in rows:
        writer.writerow({k: r.get(k, "") for k in writer.fieldnames})
    return Response(
        content=buf.getvalue(),
        media_type="text/csv",
        headers={
            "Content-Disposition": (
                f'attachment; filename="eden-cost-{org_id}.csv"'
            )
        },
    )


@router.get("/kill-switches")
async def list_kill_switches(org_id: str = Depends(require_path_org_access)) -> dict[str, Any]:
    """Customer feature kill-switch matrix (fail-closed unknown)."""
    from eden.llmops.feature_kills import list_feature_kills

    matrix = await list_feature_kills(org_id)
    return {
        "status": "ok",
        "feature": "feature_kills",
        "live": True,
        "data": {"matrix": matrix, "keys": list(CUSTOMER_FEATURE_KILLS)},
    }


class KillSwitchBody(BaseModel):
    feature_key: str = Field(..., min_length=1, max_length=64)
    enabled: bool


@router.post("/kill-switches")
async def upsert_kill_switch(
    org_id: str = Depends(require_path_org_access),
    body: KillSwitchBody = ...,
    user: dict = Depends(require_org_owner),
) -> dict[str, Any]:
    from eden.llmops.feature_kills import set_feature_kill

    key = body.feature_key.strip().lower()
    if key not in CUSTOMER_FEATURE_KILLS:
        return {
            "status": "error",
            "error": "unknown_feature",
            "detail": f"Unknown feature_key; allowed: {list(CUSTOMER_FEATURE_KILLS)}",
        }
    await set_feature_kill(
        org_id,
        key,
        enabled=body.enabled,
        updated_by=str(user.get("id") or user.get("user_id") or ""),
    )
    return {
        "status": "ok",
        "feature": "feature_kills",
        "live": True,
        "data": {"feature_key": key, "enabled": body.enabled},
    }


async def _gateway_cache_savings(org_id: str, window_hours: int) -> float:
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
              AND cache_hit = TRUE
              AND timestamp > NOW() - ($2 || ' hours')::interval
            """,
            org_id,
            str(window_hours),
        )
        return float(row["saved"] or 0) if row else 0.0
    except Exception as exc:
        logger.debug("finops: cache savings failed: %s", redact_all(str(exc)))
        return 0.0


async def _list_events(
    org_id: str, *, window_hours: int, limit: int
) -> list[dict[str, Any]]:
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            return []
        rows = await client.fetch(
            """
            SELECT recorded_at, feature, model, cost_usd,
                   input_tokens, output_tokens, total_tokens,
                   agent_id, session_id, trace_id, request_id, user_id
            FROM customer_cost_events
            WHERE org_id = $1
              AND recorded_at > NOW() - ($2 || ' hours')::interval
            ORDER BY recorded_at DESC
            LIMIT $3
            """,
            org_id,
            str(window_hours),
            limit,
        )
        out: list[dict[str, Any]] = []
        for r in rows:
            out.append(
                {
                    "recorded_at": r["recorded_at"].isoformat()
                    if r["recorded_at"]
                    else "",
                    "feature": r["feature"],
                    "model": r["model"],
                    "cost_usd": float(r["cost_usd"] or 0),
                    "input_tokens": int(r["input_tokens"] or 0),
                    "output_tokens": int(r["output_tokens"] or 0),
                    "total_tokens": int(r["total_tokens"] or 0),
                    "agent_id": r["agent_id"] or "",
                    "session_id": r["session_id"] or "",
                    "trace_id": r["trace_id"] or "",
                    "request_id": r["request_id"] or "",
                    "user_id": r["user_id"] or "",
                }
            )
        return out
    except Exception as exc:
        logger.debug("finops: list events failed: %s", redact_all(str(exc)))
        return []
