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

from fastapi import APIRouter, Depends, HTTPException, Path
from pydantic import BaseModel, Field

from eden.api.deps import get_current_user, require_path_org_access
from eden.api.utils.redact import redact_all
from eden.api.utils.safe_error import safe_detail
from eden.storage.postgres import get_postgres_client

logger = logging.getLogger(__name__)


router = APIRouter(prefix="/orgs/{org_id}/prompts", tags=["prompts"], dependencies=[Depends(require_path_org_access)])


class CanaryCreateRequest(BaseModel):
    candidate_version: int
    traffic_pct: int = Field(..., ge=0, le=100)
    expires_at: str | None = None  # ISO 8601
    notes: str | None = None


class CanaryPromoteRequest(BaseModel):
    pass  # No body; the experiment_id is in the path


@router.get("/canaries")
async def list_org_canaries(
    org_id: str = Depends(require_path_org_access),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    """Wave 5 (5.1) — org-wide canary experiments across agents.

    The per-agent ``GET /{agent}/canary`` route drives one agent's tab;
    the canary cockpit needs every experiment in the org (agent, control
    vs candidate, traffic %, elapsed, status) on one surface.
    """
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    rows = await client.fetch(
        """
        SELECT experiment_id, agent, control_version, candidate_version,
               traffic_pct, started_at, expires_at, status, notes
        FROM prompt_canary_experiments
        WHERE tenant_id = $1
        ORDER BY started_at DESC
        LIMIT 100
        """,
        org_id,
    )
    return {"canaries": [dict(r) for r in rows or []]}


@router.post("/{agent}/canary")
async def create_canary(
    org_id: str = Depends(require_path_org_access),
    agent: str = Path(..., description="Agent name, e.g. 'planner'"),
    body: CanaryCreateRequest = ...,
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    """Start a canary experiment for ``agent`` at the given traffic %.

    Creates a row in ``prompt_version_assignments`` with the candidate
    version and a new ``experiment_id``. The existing active version
    of the agent (the "control") continues to handle the remaining
    ``100 - traffic_pct`` percent of calls.

    N01: traffic above 5% requires regression suite pass.
    """
    from eden.evaluation.regression_runner import RegressionRunner

    await RegressionRunner().require_pass_for_canary(
        org_id, agent_id=agent, traffic_pct=body.traffic_pct
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
        msg = str(exc).lower()
        if "unique" in msg or "duplicate" in msg:
            raise HTTPException(
                status_code=409,
                detail="Canary experiment already exists for this agent",
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
        logger.warning("canary create failed: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail=safe_detail(exc, fallback="Failed to persist canary experiment"),
        ) from exc

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
    org_id: str = Depends(require_path_org_access),
    agent: str = Path(...),
    user: dict = Depends(get_current_user),
) -> list[dict[str, Any]]:
    """List active canary experiments for the agent."""
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
    org_id: str = Depends(require_path_org_access),
    agent: str = Path(...),
    experiment_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    """Promote the canary candidate to 100% traffic.

    EvidenceGate is non-optional (W25): evaluate must pass before
    traffic is flipped to 100%.
    """
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

        from eden.promotion.evidence_gate import EvidenceGate

        gate = EvidenceGate()
        cid = await gate.enqueue(
            org_id,
            kind="prompt_version",
            ref_id=f"{agent}:{candidate_version}",
            status="shadow",
        )
        if not cid:
            raise HTTPException(
                status_code=503,
                detail="EvidenceGate enqueue failed — promote blocked",
            )
        report = await gate.evaluate(org_id, cid)
        if not report.passed:
            return {
                "experiment_id": experiment_id,
                "agent": agent,
                "candidate_version": candidate_version,
                "status": "held",
                "evidence_gate": {
                    "passed": False,
                    "recommendation": report.recommendation,
                    "min_sample_size": report.min_sample_size,
                    "explanation": report.explanation,
                    "metrics": report.metrics,
                },
            }

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
        # Mark the experiment as promoted. Already guarded by the
        # tenant-scoped lookup above, so the predicate is defence in depth —
        # but keeping every statement on this table uniformly scoped is what
        # stops the next one being written without it, which is exactly how
        # the rollback path ended up unscoped.
        await client.execute(
            """
            UPDATE prompt_canary_experiments
            SET status = 'promoted', promoted_at = $1, ended_at = $1
            WHERE experiment_id = $2 AND tenant_id = $3
            """,
            now, experiment_id, org_id,
        )
        await gate.promote_if_passed(org_id, cid)
        # Activate the prompt version (if not already)
        try:
            from eden.kb.prompt_versions.client import get_prompt_versions_client
            # v2-schema shim: the factory is sync (``_maybe_await`` compat
            # resolved in Wave 2) — awaiting it raised TypeError that the
            # broad except below swallowed, silently skipping activation.
            pvc = get_prompt_versions_client()
            await pvc.activate_prompt(agent, candidate_version)
        except Exception as exc:
            logger.warning(f"activate_prompt during promote failed: {exc}")
    except HTTPException:
        raise
    except Exception as exc:
        msg = str(exc).lower()
        if "unique" in msg or "duplicate" in msg:
            raise HTTPException(
                status_code=409,
                detail="Canary promote conflict",
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
        logger.warning("canary promote failed: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail=safe_detail(exc, fallback="Failed to promote canary experiment"),
        ) from exc

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
        "evidence_gate": {"passed": True},
    }


@router.post("/{agent}/canary/{experiment_id}/rollback")
async def rollback_canary(
    org_id: str = Depends(require_path_org_access),
    agent: str = Path(...),
    experiment_id: str = Path(...),
    user: dict = Depends(get_current_user),
) -> dict[str, Any]:
    """Roll back the canary. The tenant's calls fall back to the
    global active version for this agent."""
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
        # tenant_id is required here, not optional hardening: without it any
        # member of any org could roll back another tenant's experiment given
        # only its id. The sibling UPDATE above and promote_canary's lookup
        # both scope on it; this statement was the odd one out.
        await client.execute(
            """
            UPDATE prompt_canary_experiments
            SET status = 'rolled_back', ended_at = $1
            WHERE experiment_id = $2 AND tenant_id = $3
            """,
            now, experiment_id, org_id,
        )
    except Exception as exc:
        msg = str(exc).lower()
        if "unique" in msg or "duplicate" in msg:
            raise HTTPException(
                status_code=409,
                detail="Canary rollback conflict",
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
        logger.warning("canary rollback failed: %s", redact_all(str(exc)))
        raise HTTPException(
            status_code=503,
            detail=safe_detail(exc, fallback="Failed to roll back canary experiment"),
        ) from exc

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
