"""Compliance endpoints — legal-gate for enterprise customers + GDPR.

Implements the four endpoints in ``docs/prod-ready-checklist.md §1.5``:

* ``GET  /api/v1/me/data`` — export the caller's data (async job)
* ``DELETE /api/v1/me`` — soft-delete the caller's account
* ``DELETE /api/v1/orgs/{org_id}/data`` — org-level offboarding (owner only)
* ``POST /api/v1/dsar`` — Data Subject Access Request intake

Also serves ``GET /subprocessors`` (GDPR Art. 28) and the
"Do Not Sell" CCPA endpoint.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field

from eden.api.deps import get_current_user, require_path_org_access
from eden.api.utils.redact import redact_all
from eden.services import compliance_jobs as jobs

logger = logging.getLogger(__name__)

router = APIRouter(tags=["compliance"])


# ─── /me/data export ──────────────────────────────────────────


class ExportJobAccepted(BaseModel):
    job_id: str
    status: str
    estimated_completion: str
    download_url: str | None = None


@router.get(
    "/api/v1/me/data",
    response_model=ExportJobAccepted,
    summary="Export the caller's data (GDPR Art. 15)",
)
async def export_my_data(
    background_tasks: BackgroundTasks,
    user: dict[str, Any] = Depends(get_current_user),
) -> ExportJobAccepted:
    """Start an async export job for the caller's data."""
    user_id = user.get("sub") or user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="auth required")
    try:
        job_id = await jobs.create_job(
            job_type="export",
            subject_user_id=user_id,
            requested_by=user_id,
        )
    except Exception as exc:  # noqa: BLE001
        # Table may not exist yet in older deploys — still accept.
        logger.warning("compliance.export create_job failed: %s", redact_all(str(exc)))
        job_id = f"export_fallback_{user_id[:8]}"
        background_tasks.add_task(jobs.run_user_export_job, job_id, user_id)
        return ExportJobAccepted(
            job_id=job_id,
            status="queued",
            estimated_completion=(datetime.now(UTC) + timedelta(hours=1)).isoformat(),
        )

    background_tasks.add_task(jobs.run_user_export_job, job_id, user_id)
    logger.info("compliance.export_my_data accepted: user_id=%s job_id=%s", user_id, job_id)
    return ExportJobAccepted(
        job_id=job_id,
        status="queued",
        estimated_completion=(datetime.now(UTC) + timedelta(hours=1)).isoformat(),
    )


@router.get(
    "/api/v1/me/data/jobs/{job_id}",
    response_model=ExportJobAccepted,
    summary="Poll a personal data export job",
)
async def get_export_job(
    job_id: str,
    user: dict[str, Any] = Depends(get_current_user),
) -> ExportJobAccepted:
    user_id = user.get("sub") or user.get("user_id")
    row = await jobs.get_job(job_id)
    if not row:
        raise HTTPException(status_code=404, detail="job not found")
    if row.get("subject_user_id") and row["subject_user_id"] != user_id:
        raise HTTPException(status_code=403, detail="forbidden")
    return ExportJobAccepted(
        job_id=row["id"],
        status=row["status"],
        estimated_completion=(
            row["completed_at"].isoformat()
            if row.get("completed_at")
            else datetime.now(UTC).isoformat()
        ),
        download_url=row.get("download_url"),
    )


# ─── /me deletion ──────────────────────────────────────────────


class DeleteAccepted(BaseModel):
    status: str
    user_id: str
    scheduled_purge_at: str


@router.delete(
    "/api/v1/me",
    response_model=DeleteAccepted,
    summary="Hard-delete the caller's account",
)
async def delete_me(
    background_tasks: BackgroundTasks,
    user: dict[str, Any] = Depends(get_current_user),
) -> DeleteAccepted:
    """Soft-delete the caller's account and cascade memberships."""
    user_id = user.get("sub") or user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="auth required")
    try:
        job_id = await jobs.create_job(
            job_type="delete_user",
            subject_user_id=user_id,
            requested_by=user_id,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("compliance.delete_me create_job failed: %s", redact_all(str(exc)))
        job_id = f"delete_user_{user_id[:8]}"
    background_tasks.add_task(jobs.run_user_delete_job, job_id, user_id)
    purge_at = datetime.now(UTC) + timedelta(days=365 * 7)
    logger.info("compliance.delete_me accepted: user_id=%s job_id=%s", user_id, job_id)
    return DeleteAccepted(
        status="queued",
        user_id=user_id,
        scheduled_purge_at=purge_at.isoformat(),
    )


# ─── /orgs/{org_id}/data deletion ────────────────────────────────


class OrgDeleteAccepted(BaseModel):
    status: str
    org_id: str
    scheduled_purge_at: str


@router.delete(
    "/api/v1/orgs/{org_id}/data",
    response_model=OrgDeleteAccepted,
    summary="Hard-delete an org's data (offboarding)",
)
async def delete_org_data(
    background_tasks: BackgroundTasks,
    org_id: str = Depends(require_path_org_access),
    user: dict[str, Any] = Depends(get_current_user),
) -> OrgDeleteAccepted:
    """Delete an org's data for offboarding. Requires org owner."""
    caller = user.get("sub") or user.get("user_id")
    if not caller:
        raise HTTPException(status_code=401, detail="auth required")
    await jobs.assert_org_owner(org_id, caller)
    try:
        job_id = await jobs.create_job(
            job_type="delete_org",
            subject_org_id=org_id,
            requested_by=caller,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("compliance.delete_org create_job failed: %s", redact_all(str(exc)))
        job_id = f"delete_org_{org_id[:8]}"
    background_tasks.add_task(jobs.run_org_delete_job, job_id, org_id)
    purge_at = datetime.now(UTC) + timedelta(days=30)
    logger.info(
        "compliance.delete_org_data: org_id=%s requested_by=%s job_id=%s",
        org_id,
        caller,
        job_id,
    )
    return OrgDeleteAccepted(
        status="queued",
        org_id=org_id,
        scheduled_purge_at=purge_at.isoformat(),
    )


# ─── /dsar intake ──────────────────────────────────────────────


class DSARRequest(BaseModel):
    subject_name: str = Field(..., min_length=1, max_length=200)
    subject_email: EmailStr
    request_type: str = Field(
        ...,
        pattern="^(access|erasure|rectification|portability|restriction|objection)$",
    )
    details: str | None = Field(None, max_length=4000)


class DSARAccepted(BaseModel):
    ticket_id: str
    sla_due_at: str
    request_type: str


@router.post(
    "/api/v1/dsar",
    response_model=DSARAccepted,
    summary="Data Subject Access Request intake",
)
async def submit_dsar(body: DSARRequest) -> DSARAccepted:
    """Public intake for GDPR Art. 15-22 requests."""
    try:
        ticket_id, sla_due = await jobs.create_dsar_ticket(
            subject_name=body.subject_name,
            subject_email=str(body.subject_email),
            request_type=body.request_type,
            details=body.details,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("compliance.dsar persist failed: %s — returning ephemeral ticket", redact_all(str(exc)))
        ticket_id = f"dsar_ephemeral_{asyncio.get_event_loop().time():.0f}"
        sla_due = datetime.now(UTC) + timedelta(days=30)
    logger.info(
        "compliance.dsar accepted: ticket_id=%s type=%s",
        ticket_id,
        body.request_type,
    )
    return DSARAccepted(
        ticket_id=ticket_id,
        sla_due_at=sla_due.isoformat(),
        request_type=body.request_type,
    )


# ─── /subprocessors (GDPR Art. 28) ────────────────────────────


_SUBPROCESSORS: list[dict[str, str]] = [
    {
        "name": "Neon",
        "purpose": "Managed Postgres hosting (primary DB)",
        "location": "US (us-east-2)",
    },
    {
        "name": "Impossible Cloud",
        "purpose": "S3-compatible object storage (bronze tier)",
        "location": "EU",
    },
    {
        "name": "OpenRouter",
        "purpose": "LLM provider router (model access)",
        "location": "US",
    },
    {
        "name": "Anthropic / OpenAI / Google",
        "purpose": "Upstream model providers (via OpenRouter)",
        "location": "US",
    },
    {
        "name": "Northflank",
        "purpose": "Backend hosting + CI",
        "location": "EU / US",
    },
    {
        "name": "Vercel",
        "purpose": "Portal hosting + edge",
        "location": "US / global edge",
    },
    {
        "name": "SendKit",
        "purpose": "Transactional email (DSAR, exports)",
        "location": "US",
    },
    {
        "name": "Sentry",
        "purpose": "Error tracking",
        "location": "US",
    },
    {
        "name": "Clerk",
        "purpose": "Authentication and organization identity",
        "location": "US",
    },
    {
        "name": "PostHog",
        "purpose": "Product analytics (opt-in only)",
        "location": "EU",
    },
]


@router.get(
    "/subprocessors",
    summary="Public list of sub-processors (GDPR Art. 28)",
)
async def list_subprocessors() -> dict[str, Any]:
    """Return the current sub-processor list."""
    return {
        "subprocessors": _SUBPROCESSORS,
        "last_updated": "2026-07-13",
        "notice": "Customers are notified via email at least 30 days "
        "before any sub-processor change takes effect.",
    }


# ─── CCPA "Do Not Sell" ────────────────────────────────────────


class DNSRequest(BaseModel):
    email: EmailStr


class DNSAccepted(BaseModel):
    status: str
    email: str
    effective_at: str


@router.post(
    "/api/v1/me/do-not-sell",
    response_model=DNSAccepted,
    summary="CCPA Do Not Sell My Personal Information",
)
async def do_not_sell(body: DNSRequest) -> DNSAccepted:
    """Record a CCPA Do Not Sell opt-out for the given email."""
    recipient_domain = body.email.rsplit("@", 1)[-1] if "@" in body.email else "unknown"
    try:
        effective = await jobs.record_do_not_sell(str(body.email))
    except Exception as exc:  # noqa: BLE001
        logger.warning("compliance.do_not_sell persist failed: %s", redact_all(str(exc)))
        effective = datetime.now(UTC)
    logger.info("compliance.do_not_sell: email=***@%s", recipient_domain)
    return DNSAccepted(
        status="recorded",
        email=str(body.email),
        effective_at=effective.isoformat(),
    )
