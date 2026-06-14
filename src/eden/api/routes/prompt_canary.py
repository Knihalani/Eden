"""API routes for prompt canary management.

Phase 7.2c/d: endpoints to create, list, promote, and rollback
prompt canary experiments. The ``PromotionLoop`` calls the promote
and rollback endpoints; humans can also use them directly via the
portal.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Body, Cookie, Header, HTTPException, Path
from pydantic import BaseModel, Field

from eden.api.deps import require_org_permission
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/prompts", tags=["prompts"])


class CanaryCreateRequest(BaseModel):
    candidate_version: int
    traffic_pct: int = Field(..., ge=0, le=100)
    expires_at: str | None = None  # ISO 8601
    notes: str | None = None


class CanaryPromoteRequest(BaseModel):
    pass  # No body; the experiment_id is in the path


@router.post("/{agent}/canary")
async def create_canary(
    org_id: str,
    agent: str = Path(..., description="Agent name, e.g. 'planner'"),
    body: CanaryCreateRequest = Body(...),
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    authorization: str | None = Cookie(None),
) -> dict[str, Any]:
    """Start a canary experiment for ``agent`` at the given traffic %.

    Creates a row in ``prompt_version_assignments`` with the candidate
    version and a new ``experiment_id``. The existing active version
    of the agent (the "control") continues to handle the remaining
    ``100 - traffic_pct`` percent of calls.
    """
    # Tenant + role guard: only members of ``org_id`` with
    # ``prompts:write`` (owner/admin) may create canaries. The previous
    # implementation used ``get_current_user`` which checked only that
    # the caller had *any* valid JWT, so a user in org A could create
    # canaries in org B by editing the URL.
    await require_org_permission(
        "prompts:write", org_id,
        x_org_id=x_org_id, authorization=authorization,
    )
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    experiment_id = str(uuid.uuid4())
    try:
        await client.execute(
            """
            INSERT INTO prompt_version_assignments (
                assignment_id, tenant_id, agent, version, traffic_pct,
                experiment_id, status, expires_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'active', $7)
            ON CONFLICT (tenant_id, agent, version, experiment_id)
            DO UPDATE SET traffic_pct = $5, expires_at = $7
            """,
            str(uuid.uuid4()),
            org_id,
            agent,
            body.candidate_version,
            body.traffic_pct,
            experiment_id,
            body.expires_at,
        )
        # Also create the experiment tracking row
        await client.execute(
            """
            INSERT INTO prompt_canary_experiments (
                experiment_id, tenant_id, agent, control_version,
                candidate_version, traffic_pct, expires_at, status, notes
            )
            VALUES ($1, $2, $3, 0, $4, $5, $6, 'active', $7)
            """,
            experiment_id,
            org_id,
            agent,
            body.candidate_version,
            body.traffic_pct,
            body.expires_at,
            body.notes,
        )
    except Exception as exc:
        logger.warning(f"canary create failed: {exc}")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    return {
        "experiment_id": experiment_id,
        "agent": agent,
        "candidate_version": body.candidate_version,
        "traffic_pct": body.traffic_pct,
        "expires_at": body.expires_at,
        "status": "active",
    }


@router.get("/{agent}/canary")
async def list_canaries(
    org_id: str,
    agent: str = Path(...),
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    authorization: str | None = Cookie(None),
) -> list[dict[str, Any]]:
    """List active canary experiments for the agent."""
    # Read operation — ``prompts:read`` (owner/admin/member) so
    # ``member`` role can monitor traffic splits without being
    # able to mutate them. The create / promote / rollback
    # routes still require ``prompts:write`` (owner/admin only).
    await require_org_permission(
        "prompts:read", org_id,
        x_org_id=x_org_id, authorization=authorization,
    )
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    rows = await client.fetch(
        """
        SELECT experiment_id, candidate_version, traffic_pct, started_at,
               expires_at, status, notes
        FROM prompt_canary_experiments
        WHERE tenant_id = $1 AND agent = $2
        ORDER BY started_at DESC
        LIMIT 100
        """,
        org_id,
        agent,
    )
    return [dict(r) for r in rows]


@router.post("/{agent}/canary/{experiment_id}/promote")
async def promote_canary(
    org_id: str,
    agent: str = Path(...),
    experiment_id: str = Path(...),
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    authorization: str | None = Cookie(None),
) -> dict[str, Any]:
    """Promote the canary candidate to 100% traffic.

    Sets the candidate's assignment traffic_pct to 100, ends the
    experiment, and audit-logs the action.
    """
    # Same tenant-isolation fix as create_canary above.
    user = await require_org_permission(
        "prompts:write", org_id,
        x_org_id=x_org_id, authorization=authorization,
    )
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    try:
        # Find the candidate version
        row = await client.fetchrow(
            """
            SELECT candidate_version FROM prompt_canary_experiments
            WHERE experiment_id = $1 AND tenant_id = $2 AND agent = $3
            """,
            experiment_id, org_id, agent,
        )
        if not row:
            raise HTTPException(status_code=404, detail="Experiment not found")
        candidate_version = row["candidate_version"]
        now = datetime.now(UTC)
        # Set the candidate to 100
        await client.execute(
            """
            UPDATE prompt_version_assignments
            SET traffic_pct = 100, promoted_at = $1
            WHERE experiment_id = $2 AND tenant_id = $3
            """,
            now, experiment_id, org_id,
        )
        # End other assignments for this (tenant, agent)
        await client.execute(
            """
            UPDATE prompt_version_assignments
            SET status = 'ended', ended_at = $1
            WHERE tenant_id = $2 AND agent = $3
              AND experiment_id != $4 AND status = 'active'
            """,
            now, org_id, experiment_id,
        )
        # Mark the experiment as promoted
        await client.execute(
            """
            UPDATE prompt_canary_experiments
            SET status = 'promoted', promoted_at = $1, ended_at = $1
            WHERE experiment_id = $2
            """,
            now, experiment_id,
        )
        # Activate the prompt version (if not already)
        try:
            from eden.kb.prompt_versions.client import get_prompt_versions_client
            pvc = await get_prompt_versions_client()
            await pvc.activate_prompt(agent, candidate_version)
        except Exception as exc:
            logger.warning(f"activate_prompt during promote failed: {exc}")
    except HTTPException:
        raise
    except Exception as exc:
        logger.warning(f"canary promote failed: {exc}")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    # Audit log
    try:
        from eden.api.deps import log_audit_event
        await log_audit_event(
            client=client,
            org_id=org_id,
            user_id=str(user.get("user_id") or "system"),
            action="prompt.promoted",
            target_type="prompt_canary",
            target_id=experiment_id,
            metadata={"agent": agent, "candidate_version": candidate_version},
        )
    except Exception as exc:
        logger.debug(f"audit log on promote failed: {exc}")

    return {
        "experiment_id": experiment_id,
        "agent": agent,
        "candidate_version": candidate_version,
        "status": "promoted",
    }


@router.post("/{agent}/canary/{experiment_id}/rollback")
async def rollback_canary(
    org_id: str,
    agent: str = Path(...),
    experiment_id: str = Path(...),
    x_org_id: str | None = Header(None, alias="X-Org-Id"),
    authorization: str | None = Cookie(None),
) -> dict[str, Any]:
    """Roll back the canary. The tenant's calls fall back to the
    global active version for this agent."""
    # Same tenant-isolation fix as create_canary above.
    user = await require_org_permission(
        "prompts:write", org_id,
        x_org_id=x_org_id, authorization=authorization,
    )
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    now = datetime.now(UTC)
    try:
        await client.execute(
            """
            UPDATE prompt_version_assignments
            SET status = 'rolled_back', ended_at = $1
            WHERE experiment_id = $2 AND tenant_id = $3
            """,
            now, experiment_id, org_id,
        )
        await client.execute(
            """
            UPDATE prompt_canary_experiments
            SET status = 'rolled_back', ended_at = $1
            WHERE experiment_id = $2
            """,
            now, experiment_id,
        )
    except Exception as exc:
        logger.warning(f"canary rollback failed: {exc}")
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    try:
        from eden.api.deps import log_audit_event
        await log_audit_event(
            client=client,
            org_id=org_id,
            user_id=str(user.get("user_id") or "system"),
            action="prompt.rolled_back",
            target_type="prompt_canary",
            target_id=experiment_id,
            metadata={"agent": agent},
        )
    except Exception as exc:
        logger.debug(f"audit log on rollback failed: {exc}")

    return {
        "experiment_id": experiment_id,
        "agent": agent,
        "status": "rolled_back",
    }
