"""API routes for per-tenant PII policy (Phase 7.3a).

PUT /orgs/{org_id}/pii-policy replaces the active policy (or
creates a new effective row). GET returns the current policy.

The route is gated by the ``pii:edit`` permission (added in
Phase 7.3d) — owners and admins can change the policy; viewers
can only read it.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from eden.api.deps import (
    _try_resolve_token_payload,
    get_current_user,
    require_org_permission,
    require_path_org_access,
)
from eden.api.utils.redact import redact_all
from eden.api.utils.safe_error import safe_detail
from eden.data_platform.pii import _DEFAULT_CATEGORIES
from eden.observability.ingestion.pii_policy import invalidate_policy
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/pii-policy", tags=["pii-policy"])


class PIIPolicyIn(BaseModel):
    # Top-level ``mode`` is the preferred knob — it subsumes the
    # boolean + category fields below. Accepted values:
    #   * "off"          — never mask (the system is designed to
    #                       use the raw values)
    #   * "redact"       — mask per the active category set (default)
    #   * "fail_closed"  — redact + raise on credential detection
    mode: str = "redact"
    enabled_categories: list[str] = Field(default_factory=list)
    disabled_categories: list[str] = Field(default_factory=list)
    fail_closed_on_credentials: bool = False
    redact_keys_extra: list[str] = Field(default_factory=list)
    notes: str | None = None


class PIIPolicyOut(BaseModel):
    policy_id: str
    tenant_id: str
    mode: str
    enabled_categories: list[str]
    disabled_categories: list[str]
    fail_closed_on_credentials: bool
    redact_keys_extra: list[str]
    effective_from: str
    effective_until: str | None = None
    created_by: str | None = None
    notes: str | None = None


@router.get("", response_model=PIIPolicyOut)
async def get_pii_policy(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user)
) -> PIIPolicyOut:
    """Return the current PII policy for the org, or the default
    policy if no override is set."""
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    row = await client.fetchrow(
        """
        SELECT policy_id, tenant_id, enabled_categories, disabled_categories,
               fail_closed_on_credentials, redact_keys_extra,
               effective_from, effective_until, created_by, notes
        FROM org_pii_policies
        WHERE tenant_id = $1
          AND effective_from <= NOW()
          AND (effective_until IS NULL OR effective_until > NOW())
        ORDER BY effective_from DESC
        LIMIT 1
        """,
        org_id,
    )
    if not row:
        return PIIPolicyOut(
            policy_id="default",
            tenant_id=org_id,
            mode="redact",
            # Source of truth: ``eden.data_platform.pii._DEFAULT_CATEGORIES``.
            # Adding a new PII category there surfaces here automatically.
            enabled_categories=list(_DEFAULT_CATEGORIES),
            disabled_categories=[],
            fail_closed_on_credentials=False,
            redact_keys_extra=[],
            effective_from=datetime.now(UTC).isoformat(),
            effective_until=None,
            created_by=None,
            notes="default policy",
        )
    return PIIPolicyOut(
        policy_id=str(row["policy_id"]),
        tenant_id=str(row["tenant_id"]),
        mode=str(row.get("mode") or _derive_mode_from_row(dict(row))),
        enabled_categories=list(row["enabled_categories"] or []),
        disabled_categories=list(row["disabled_categories"] or []),
        fail_closed_on_credentials=bool(row["fail_closed_on_credentials"]),
        redact_keys_extra=list(row["redact_keys_extra"] or []),
        effective_from=row["effective_from"].isoformat() if hasattr(row["effective_from"], "isoformat") else str(row["effective_from"]),
        effective_until=row["effective_until"].isoformat() if row["effective_until"] and hasattr(row["effective_until"], "isoformat") else None,
        created_by=row["created_by"],
        notes=row["notes"],
    )


def _derive_mode_from_row(row: dict[str, Any]) -> str:
    """Derive ``mode`` from a row that's missing the explicit column
    (pre-migration rows). Mirrors the fallback in
    :meth:`PIIPolicy.from_db_row`."""
    explicit = row.get("mode")
    if explicit in ("off", "redact", "fail_closed"):
        return explicit
    if row.get("fail_closed_on_credentials"):
        return "fail_closed"
    enabled = row.get("enabled_categories") or []
    if enabled == []:
        return "off"
    return "redact"


@router.put("", response_model=PIIPolicyOut)
async def put_pii_policy(
    body: PIIPolicyIn,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
    payload: dict | None = Depends(_try_resolve_token_payload),
) -> PIIPolicyOut:
    """Replace the active PII policy. The previous policy row is
    closed (effective_until = NOW()) and a new one is inserted.

    Gated by the ``pii:edit`` permission. Owners and admins can
    change the policy; viewers and members get 403.
    """
    # Pass path org_id + resolved JWT explicitly. A bare
    # ``await require_org_permission(..., x_org_id=org_id)`` leaves
    # ``payload`` as an unresolved ``Depends(...)`` sentinel → 500.
    await require_org_permission("pii:edit", org_id, payload)
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    new_id = str(uuid.uuid4())
    now = datetime.now(UTC)
    try:
        await client.execute(
            """
            UPDATE org_pii_policies
            SET effective_until = $1
            WHERE tenant_id = $2 AND effective_until IS NULL
            """,
            now, org_id,
        )
        # ``mode`` column added in migration 028; older deployments
        # don't have it. Attempt the full insert first, fall back
        # to the pre-028 shape if the column is missing so the
        # route keeps working during a rolling upgrade.
        try:
            await client.execute(
                """
                INSERT INTO org_pii_policies (
                    policy_id, tenant_id, mode, enabled_categories,
                    disabled_categories, fail_closed_on_credentials,
                    redact_keys_extra, created_by, notes, effective_from
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                """,
                new_id,
                org_id,
                body.mode,
                body.enabled_categories,
                body.disabled_categories,
                body.fail_closed_on_credentials,
                body.redact_keys_extra,
                str(user.get("user_id") or "system"),
                body.notes,
                now,
            )
        except Exception as exc:
            # ``undefined_column`` / ``42703`` (Postgres): the
            # ``mode`` column doesn't exist on this deployment yet.
            # Fall back to the pre-028 insert so the policy still
            # gets saved (just without an explicit mode).
            if "mode" in str(exc) or "42703" in str(exc):
                logger.info(
                    "org_pii_policies.mode column missing; "
                    "falling back to pre-028 insert for tenant=%s",
                    org_id,
                )
                await client.execute(
                    """
                    INSERT INTO org_pii_policies (
                        policy_id, tenant_id, enabled_categories,
                        disabled_categories, fail_closed_on_credentials,
                        redact_keys_extra, created_by, notes, effective_from
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    """,
                    new_id,
                    org_id,
                    body.enabled_categories,
                    body.disabled_categories,
                    body.fail_closed_on_credentials,
                    body.redact_keys_extra,
                    str(user.get("user_id") or "system"),
                    body.notes,
                    now,
                )
            else:
                raise
    except Exception as exc:
        msg = str(exc).lower()
        if "unique" in msg or "duplicate" in msg:
            raise HTTPException(
                status_code=409,
                detail="PII policy already exists for this organization",
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
        logger.warning("put_pii_policy failed: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail=safe_detail(exc, fallback="Failed to save PII policy"),
        ) from exc

    # Drop the in-process cache so the new policy takes effect
    # immediately on the next ingest event.
    invalidate_policy(org_id)

    # Audit log
    try:
        from eden.api.deps import log_audit_event
        await log_audit_event(
            client=client,
            org_id=org_id,
            user_id=str(user.get("user_id") or "system"),
            action="pii_policy.updated",
            target_type="pii_policy",
            target_id=new_id,
            metadata={
                "enabled_categories": body.enabled_categories,
                "disabled_categories": body.disabled_categories,
                "fail_closed_on_credentials": body.fail_closed_on_credentials,
            },
        )
    except Exception:
        pass

    return PIIPolicyOut(
        policy_id=new_id,
        tenant_id=org_id,
        mode=body.mode,
        enabled_categories=body.enabled_categories,
        disabled_categories=body.disabled_categories,
        fail_closed_on_credentials=body.fail_closed_on_credentials,
        redact_keys_extra=body.redact_keys_extra,
        effective_from=now.isoformat(),
        effective_until=None,
        created_by=str(user.get("user_id") or "system"),
        notes=body.notes,
    )
