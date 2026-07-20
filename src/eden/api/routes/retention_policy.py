"""API routes for per-tenant retention policy (Phase 7.3b).

GET /orgs/{org_id}/retention-policy — list all per-tenant overrides.
PUT /orgs/{org_id}/retention-policy — replace the override for a
table.

Gated by the ``retention:override`` permission (owner-only).
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field

from eden.api.deps import (
    _try_resolve_token_payload,
    get_current_user,
    require_org_permission,
    require_path_org_access,
)
from eden.api.utils.redact import redact_all
from eden.api.utils.safe_error import safe_detail
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/retention-policy", tags=["retention-policy"])


class RetentionPolicyIn(BaseModel):
    table_name: str = Field(..., description="e.g. 'telemetry_events', 'audit_log'")
    hot_days: int = Field(..., ge=0)
    warm_days: int = Field(..., ge=0)
    cold_days: int = Field(..., ge=0)
    delete_days: int = Field(..., ge=0)
    pii_scrub_after_days: int | None = Field(default=None, ge=0)
    notes: str | None = None


class RetentionPolicyOut(BaseModel):
    policy_id: str
    tenant_id: str
    table_name: str
    hot_days: int
    warm_days: int
    cold_days: int
    delete_days: int
    pii_scrub_after_days: int | None
    effective_from: str
    effective_until: str | None = None
    notes: str | None = None


@router.get("", response_model=list[RetentionPolicyOut])
async def list_retention_policies(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user)
) -> list[RetentionPolicyOut]:
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    rows = await client.fetch(
        """
        SELECT policy_id, tenant_id, table_name, hot_days, warm_days,
               cold_days, delete_days, pii_scrub_after_days,
               effective_from, effective_until, notes
        FROM org_retention_policies
        WHERE tenant_id = $1
          AND effective_until IS NULL
        ORDER BY table_name
        """,
        org_id,
    )
    return [
        RetentionPolicyOut(
            policy_id=str(r["policy_id"]),
            tenant_id=str(r["tenant_id"]),
            table_name=str(r["table_name"]),
            hot_days=int(r["hot_days"]),
            warm_days=int(r["warm_days"]),
            cold_days=int(r["cold_days"]),
            delete_days=int(r["delete_days"]),
            pii_scrub_after_days=int(r["pii_scrub_after_days"]) if r["pii_scrub_after_days"] is not None else None,
            effective_from=r["effective_from"].isoformat() if hasattr(r["effective_from"], "isoformat") else str(r["effective_from"]),
            effective_until=None,
            notes=r["notes"],
        )
        for r in rows
    ]


@router.put("", response_model=RetentionPolicyOut)
async def put_retention_policy(
    body: RetentionPolicyIn,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> RetentionPolicyOut:
    """Replace the active retention policy for a table. Owner-only."""
    # Pass path org_id + resolved JWT explicitly. A bare
    # ``await require_org_permission(..., x_org_id=org_id)`` leaves
    # ``payload`` as an unresolved ``Depends(...)`` sentinel → 500.
    await require_org_permission("retention:override", org_id, payload)

    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    new_id = str(uuid.uuid4())
    now = datetime.now(UTC)
    try:
        await client.execute(
            """
            UPDATE org_retention_policies
            SET effective_until = $1
            WHERE tenant_id = $2 AND table_name = $3 AND effective_until IS NULL
            """,
            now, org_id, body.table_name,
        )
        await client.execute(
            """
            INSERT INTO org_retention_policies (
                policy_id, tenant_id, table_name, hot_days, warm_days,
                cold_days, delete_days, pii_scrub_after_days,
                created_by, notes, effective_from
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            """,
            new_id, org_id, body.table_name, body.hot_days, body.warm_days,
            body.cold_days, body.delete_days, body.pii_scrub_after_days,
            str(user.get("user_id") or "system"), body.notes, now,
        )
    except Exception as exc:
        msg = str(exc).lower()
        if "unique" in msg or "duplicate" in msg:
            raise HTTPException(
                status_code=409,
                detail="Retention policy already exists for this table",
            ) from exc
        if "invalid input syntax for type uuid" in msg:
            raise HTTPException(
                status_code=400,
                detail="Invalid organization id",
            ) from exc
        if "foreign key" in msg:
            raise HTTPException(
                status_code=404,
                detail="Organization not found",
            ) from exc
        logger.warning("put_retention_policy failed: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail=safe_detail(exc, fallback="Failed to save retention policy"),
        ) from exc

    try:
        from eden.api.deps import log_audit_event
        await log_audit_event(
            client=client,
            org_id=org_id,
            user_id=str(user.get("user_id") or "system"),
            action="retention_policy.updated",
            target_type="retention_policy",
            target_id=new_id,
            metadata={
                "table_name": body.table_name,
                "hot_days": body.hot_days,
                "warm_days": body.warm_days,
                "cold_days": body.cold_days,
                "delete_days": body.delete_days,
            },
        )
    except Exception as exc:
        # Audit-log failure is non-fatal (the policy is already persisted),
        # but we still want a trace so missing audit rows are not invisible.
        logger.warning("retention_policy.audit_log_failed: %s", redact_all(str(exc)))

    return RetentionPolicyOut(
        policy_id=new_id,
        tenant_id=org_id,
        table_name=body.table_name,
        hot_days=body.hot_days,
        warm_days=body.warm_days,
        cold_days=body.cold_days,
        delete_days=body.delete_days,
        pii_scrub_after_days=body.pii_scrub_after_days,
        effective_from=now.isoformat(),
        effective_until=None,
        notes=body.notes,
    )
