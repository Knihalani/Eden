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

Gated by ``require_path_org_access`` (any org member can persist their
own UI prefs; no admin permission needed).
"""

from __future__ import annotations

import json
import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from eden.api.deps import eden_user_id_from_auth, get_current_user, require_path_org_access
from eden.api.utils.redact import redact_all
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/orgs/{org_id}/sidebar-prefs",
    tags=["sidebar-prefs"],
    dependencies=[Depends(get_current_user), Depends(require_path_org_access)],
)


class SidebarPrefs(BaseModel):
    pinned: list[str] = Field(default_factory=list)
    hidden: list[str] = Field(default_factory=list)
    group_order: list[str] = Field(default_factory=list)
    density: str = "comfortable"

    model_config = {"extra": "ignore"}


async def _resolve_user_id(user: dict) -> str | None:
    try:
        return await eden_user_id_from_auth(user)
    except Exception as exc:  # noqa: BLE001
        logger.warning("sidebar_prefs: user resolve failed: %s", redact_all(str(exc)))
        return None


@router.get("")
async def get_sidebar_prefs(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
) -> SidebarPrefs | None:
    """Return the calling user's saved prefs, or ``null`` if unset.

    Missing table soft-returns ``None`` (defaults). Resolve Clerk
    ``user_…`` → Eden ``users.id`` and compare via ``::text`` so
    UUID/TEXT column drift (063 vs 117) does not 500. Alembic 127
    ALTERs the columns to match live ``users.id`` / ``organizations.id``.

    LP-03: never return a bare ``{}`` — unset is JSON ``null``.
    """
    user_id = await _resolve_user_id(user)
    if not user_id:
        return None

    try:
        client = await get_postgres_client()
    except Exception as exc:
        logger.warning("sidebar_prefs: postgres unavailable: %s", redact_all(str(exc)))
        return None
    if client is None:
        return None

    try:
        row = await client.fetchrow(
            """
            SELECT prefs FROM sidebar_prefs
            WHERE user_id::text = $1 AND org_id::text = $2
            """,
            user_id,
            org_id,
        )
    except Exception as exc:
        msg = str(exc).lower()
        if "does not exist" in msg or "undefinedtable" in msg or "undefined column" in msg:
            logger.warning(
                "sidebar_prefs: table missing for user=%s org=%s: %s",
                user_id,
                org_id,
                redact_all(str(exc)),
            )
            return None
        logger.warning(
            "sidebar_prefs: fetchrow failed for user=%s org=%s: %s",
            user_id,
            org_id,
            redact_all(str(exc)),
        )
        return None
    if row is None:
        return None
    raw = row["prefs"]
    if isinstance(raw, dict):
        if not raw:
            return None
        try:
            return SidebarPrefs(**raw)
        except Exception as exc:
            logger.warning("sidebar_prefs: invalid prefs shape, ignoring: %s", redact_all(str(exc)))
            return None
    return None


@router.put("")
async def set_sidebar_prefs(
    prefs: SidebarPrefs,
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    """Upsert the calling user's sidebar prefs row."""
    user_id = await _resolve_user_id(user)
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid token payload")

    client = await get_postgres_client()
    if client is None:
        raise HTTPException(status_code=503, detail="Postgres unavailable")

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
        logger.warning(
            "sidebar_prefs: upsert failed for user=%s org=%s: %s",
            user_id,
            org_id,
            redact_all(str(exc)),
        )
        raise HTTPException(
            status_code=503,
            detail="Sidebar prefs storage unavailable",
        ) from exc
    return {"ok": True}
