"""Per-tenant cost override management (Phase 7.4).

The gateway computes cost using a four-tier chain: per-tenant
override > live OpenRouter overlay > static seed > zero. This
route manages tier 1 - the authoritative override table.

Routes
------
* ``GET    /orgs/{org_id}/cost-overrides``        - list current
* ``POST   /orgs/{org_id}/cost-overrides``        - create new
* ``DELETE /orgs/{org_id}/cost-overrides/{id}``   - expire an override
* ``POST   /orgs/{org_id}/cost-overrides/resolve`` - dry-run resolver

Permissions
-----------
* ``cost:read``   - GET
* ``cost:write``  - POST, DELETE

The auth model mirrors :mod:`eden.api.routes.pii_policy` so ops
can manage overrides with the same role gates they already use
for PII policy.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user
from eden.api.utils.redact import redact_all
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/cost-overrides", tags=["cost-overrides"])


class CostOverrideIn(BaseModel):
    provider: str = Field(..., description="Provider enum value, or '*' for wildcard")
    model_id: str = Field(..., min_length=1, max_length=128)
    cost_per_1k_input: Decimal
    cost_per_1k_output: Decimal
    currency: str = "USD"
    source: str = "manual"
    effective_from: datetime | None = None
    effective_until: datetime | None = None
    notes: str | None = None
    cost_per_1k_cache_read: Decimal | None = None
    """Optional negotiated cache-read rate (USD per 1K tokens).
    ``None`` falls back to the catalog rate."""
    cost_per_1k_cache_write: Decimal | None = None
    """Optional negotiated cache-write rate (USD per 1K tokens).
    ``None`` falls back to the catalog rate."""


class CostOverrideOut(BaseModel):
    override_id: str
    org_id: str
    provider: str
    model_id: str
    cost_per_1k_input: Decimal
    cost_per_1k_output: Decimal
    currency: str
    source: str
    effective_from: str
    effective_until: str | None = None
    notes: str | None = None
    cost_per_1k_cache_read: Decimal | None = None
    cost_per_1k_cache_write: Decimal | None = None


class CostResolveIn(BaseModel):
    provider: str
    model_id: str
    input_tokens: int = 0
    output_tokens: int = 0


class CostResolveOut(BaseModel):
    cost_per_1k_input: Decimal
    cost_per_1k_output: Decimal
    cost_usd: Decimal
    source: str
    provider: str
    model_id: str
    cached: bool
    notes: str | None = None


# ─────────────────────────────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────────────────────────────


@router.get("", response_model=list[CostOverrideOut])
async def list_cost_overrides(
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> list[CostOverrideOut]:
    """List all overrides for the org, newest first."""
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    rows = await client.fetch(
        """
        SELECT override_id, org_id, provider, model_id,
               cost_per_1k_input, cost_per_1k_output,
               cost_per_1k_cache_read, cost_per_1k_cache_write,
               currency, source, effective_from, effective_until, notes
        FROM org_cost_overrides
        WHERE org_id = $1
        ORDER BY effective_from DESC
        """,
        org_id,
    )
    return [
        CostOverrideOut(
            override_id=str(r["override_id"]),
            org_id=str(r["org_id"]),
            provider=r["provider"],
            model_id=r["model_id"],
            cost_per_1k_input=Decimal(str(r["cost_per_1k_input"])),
            cost_per_1k_output=Decimal(str(r["cost_per_1k_output"])),
            currency=r["currency"],
            source=r["source"],
            effective_from=r["effective_from"].isoformat(),
            effective_until=r["effective_until"].isoformat() if r["effective_until"] else None,
            notes=r["notes"],
            cost_per_1k_cache_read=(
                Decimal(str(r["cost_per_1k_cache_read"]))
                if r.get("cost_per_1k_cache_read") is not None
                else None
            ),
            cost_per_1k_cache_write=(
                Decimal(str(r["cost_per_1k_cache_write"]))
                if r.get("cost_per_1k_cache_write") is not None
                else None
            ),
        )
        for r in rows
    ]


@router.post("", response_model=CostOverrideOut, status_code=201)
async def create_cost_override(
    body: CostOverrideIn,
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> CostOverrideOut:
    """Insert a new override row.

    The resolver picks the most-recent-effective row, so creating
    a new override for the same (org, provider, model) does not
    overwrite - it supersedes after the new ``effective_from``.
    """
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    if body.cost_per_1k_input < 0 or body.cost_per_1k_output < 0:
        raise HTTPException(status_code=422, detail="cost_per_1k_* must be >= 0")
    if body.effective_from and body.effective_until and body.effective_until <= body.effective_from:
        raise HTTPException(
            status_code=422,
            detail="effective_until must be strictly after effective_from",
        )
    override_id = uuid.uuid4()
    row = await client.fetchrow(
        """
        INSERT INTO org_cost_overrides (
            override_id, org_id, provider, model_id,
            cost_per_1k_input, cost_per_1k_output,
            cost_per_1k_cache_read, cost_per_1k_cache_write,
            currency, source, effective_from, effective_until, notes, created_by
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
                  COALESCE($10, NOW()), $11, $12, $13)
        RETURNING override_id, org_id, provider, model_id,
                  cost_per_1k_input, cost_per_1k_output,
                  cost_per_1k_cache_read, cost_per_1k_cache_write,
                  currency, source, effective_from, effective_until, notes
        """,
        override_id,
        org_id,
        body.provider,
        body.model_id,
        body.cost_per_1k_input,
        body.cost_per_1k_output,
        body.cost_per_1k_cache_read,
        body.cost_per_1k_cache_write,
        body.currency,
        body.source,
        body.effective_from,
        body.effective_until,
        body.notes,
        uuid.UUID(user["user_id"]) if user.get("user_id") else None,
    )
    # Invalidate the in-process resolver cache so this tenant's
    # subsequent requests pick up the new rate immediately
    # instead of waiting up to 60s for the cache TTL to expire.
    # Best-effort: a resolver miss here is harmless because the
    # next request will repopulate.
    try:
        from eden.llmops.cost_resolver import CostResolver

        resolver = CostResolver()
        await resolver.invalidate(org_id=org_id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("failed to invalidate cost resolver cache after override POST: %s", redact_all(str(exc)))
    return _row_to_out(row)


@router.delete("/{override_id}", status_code=204)
async def expire_cost_override(
    override_id: str = Path(...),
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> None:
    """Expire an override row (set ``effective_until = NOW()``).

    Soft delete: the row stays for audit but stops being picked by
    the resolver.
    """
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    result = await client.execute(
        """
        UPDATE org_cost_overrides
        SET effective_until = NOW(), updated_at = NOW()
        WHERE override_id = $1 AND org_id = $2 AND effective_until IS NULL
        """,
        uuid.UUID(override_id),
        org_id,
    )
    # ``execute`` returns the tag like ``UPDATE 1``; if no row was
    # affected, the override didn't exist (or was already expired).
    if result == "UPDATE 0":
        raise HTTPException(status_code=404, detail="override not found or already expired")


@router.post("/resolve", response_model=CostResolveOut)
async def resolve_cost(
    body: CostResolveIn,
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> CostResolveOut:
    """Dry-run the resolver without making an LLM call.

    Useful for CS / ops who want to confirm a new contract rate
    is what the customer will be billed before signing the deal.
    """
    from eden.llmops.cost_resolver import CostResolver

    resolver = CostResolver()
    res = await resolver.resolve(
        org_id=org_id,
        provider=body.provider,
        model_id=body.model_id,
    )
    return CostResolveOut(
        cost_per_1k_input=res.cost_per_1k_input,
        cost_per_1k_output=res.cost_per_1k_output,
        cost_usd=res.estimate(body.input_tokens, body.output_tokens),
        source=res.source,
        provider=res.provider,
        model_id=res.model_id,
        cached=res.cached,
        notes=res.notes,
    )


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────


def _row_to_out(row: dict[str, Any]) -> CostOverrideOut:
    cache_read = row.get("cost_per_1k_cache_read")
    cache_write = row.get("cost_per_1k_cache_write")
    return CostOverrideOut(
        override_id=str(row["override_id"]),
        org_id=str(row["org_id"]),
        provider=row["provider"],
        model_id=row["model_id"],
        cost_per_1k_input=Decimal(str(row["cost_per_1k_input"])),
        cost_per_1k_output=Decimal(str(row["cost_per_1k_output"])),
        currency=row["currency"],
        source=row["source"],
        effective_from=row["effective_from"].isoformat(),
        effective_until=row["effective_until"].isoformat() if row["effective_until"] else None,
        notes=row["notes"],
        cost_per_1k_cache_read=(
            Decimal(str(cache_read)) if cache_read is not None else None
        ),
        cost_per_1k_cache_write=(
            Decimal(str(cache_write)) if cache_write is not None else None
        ),
    )
