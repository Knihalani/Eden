"""Sidebar preferences (per-user, per-org) — June 2026 Phase 1.

The portal's ``use-sidebar-prefs`` hook persists which sidebar groups
the user has pinned / hidden and the density preference. Until this
route shipped the calls were 404'ing silently and the hook fell back
to ``sessionStorage`` (lost on tab close) + ``DEFAULT_PREFS``.

Two endpoints:
  * ``GET /orgs/{org_id}/sidebar-prefs`` — return the calling user's
    prefs row, or ``null`` if none has been saved yet.
  * ``PUT /orgs/{org_id}/sidebar-prefs`` — upsert the row for the
    calling user.

Gated by ``require_org_member`` (any org member can persist their
own UI prefs; no admin permission needed).
"""
from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Path
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_org_member
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/sidebar-prefs",
    tags=["sidebar-prefs"],
)


class SidebarPrefs(BaseModel):
    pinned: list[str] = Field(default_factory=list)
    hidden: list[str] = Field(default_factory=list)
    group_order: list[str] = Field(default_factory=list)
    density: str = "comfortable"


@router.get("", response_model=SidebarPrefs | None)
async def get_sidebar_prefs(
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
    _member: dict = Depends(require_org_member),
) -> SidebarPrefs | None:
    """Return the calling user's saved prefs, or ``null`` if unset.

    Defensive: the migration creates the table with ``IF NOT
    EXISTS`` but if the live DB is one migration behind, the
    SELECT would 500 the whole route. Return ``None`` (which the
    client treats as "no prefs yet, use defaults") on any DB
    failure so the user still sees a working sidebar. June 2026
    hardening.
    """
    user_id = user.get("user_id")
    if not user_id:
        return None

    try:
        client = await get_postgres_client()
    except Exception as exc:
        logger.warning("sidebar_prefs: postgres unavailable: %s", exc)
        return None
    if client is None:
        return None

    try:
        row = await client.fetchrow(
            """
            SELECT prefs FROM sidebar_prefs
            WHERE user_id = $1 AND org_id = $2
            """,
            user_id,
            org_id,
        )
    except Exception as exc:
        logger.warning("sidebar_prefs: fetchrow failed for user=%s org=%s: %s", user_id, org_id, exc)
        return None
    if row is None:
        return None
    raw = row["prefs"]
    if isinstance(raw, dict):
        try:
            return SidebarPrefs(**raw)
        except Exception as exc:
            logger.warning("sidebar_prefs: invalid prefs shape, ignoring: %s", exc)
            return None
    return None


@router.put("", response_model=dict[str, Any])
async def set_sidebar_prefs(
    prefs: SidebarPrefs,
    org_id: str = Path(...),
    user: dict = Depends(get_current_user),
    _member: dict = Depends(require_org_member),
) -> dict[str, Any]:
    """Upsert the calling user's sidebar prefs row."""
    user_id = user.get("user_id")
    if not user_id:
        from fastapi import HTTPException

        raise HTTPException(status_code=401, detail="Invalid token payload")

    client = await get_postgres_client()
    if client is None:
        from fastapi import HTTPException

        raise HTTPException(status_code=503, detail="Postgres unavailable")

    import json

    payload = prefs.model_dump()
    try:
        await client.execute(
            """
            INSERT INTO sidebar_prefs (user_id, org_id, prefs, updated_at)
            VALUES ($1, $2, $3::jsonb, NOW())
            ON CONFLICT (user_id, org_id)
            DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = NOW()
            """,
            user_id,
            org_id,
            json.dumps(payload),
        )
    except Exception as exc:
        # Migration may not be applied yet on the live DB — surface
        # as 503 (the same code as "Postgres unavailable" above) so
        # the client treats it as transient and retries on the
        # next save tick. June 2026 hardening.
        logger.warning("sidebar_prefs: upsert failed for user=%s org=%s: %s", user_id, org_id, exc)
        from fastapi import HTTPException

        raise HTTPException(status_code=503, detail="Sidebar prefs storage unavailable")
    return {"ok": True}