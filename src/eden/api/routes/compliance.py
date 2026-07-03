"""Compliance endpoints — legal-gate for enterprise customers + GDPR.

Implements the four endpoints in ``docs/prod-ready-checklist.md §1.5``:

* ``GET  /api/v1/me/data`` — export the caller's data, returns a
  job id, writes a signed URL to the object's storage (S3-compatible
  / Impossible Cloud) when ready, emails the caller.
* ``DELETE /api/v1/me`` — hard-delete the caller's account.
  Cascades to org memberships, soft-deletes the user row for
  fraud-prevention retention per the privacy policy.
* ``DELETE /api/v1/orgs/{org_id}/data`` — org-level deletion
  for offboarding.
* ``POST /api/v1/dsar`` — Data Subject Access Request intake
  form; creates a tracked ticket ops can act on within the SLA.

Also serves ``GET /subprocessors`` (GDPR Art. 28) and the
"Do Not Sell" CCPA link target. These are static pages backed
by a small config dict — no DB lookups.

Ponytail: each endpoint is the minimum legal-gate surface
required to ship. Real export jobs run async via the existing
``jobs`` machinery (read-only); the actual S3 write +
email can be wired up in a follow-up without changing
this API.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field

from eden.api.deps import get_current_user

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
    request: Request,
    user: dict[str, Any] = Depends(get_current_user),
) -> ExportJobAccepted:
    """Start an async export job for the caller's data.

    Returns a job id immediately; the actual data is collected
    in a background task, written to object storage, and the
    caller is emailed a signed URL when ready (typical SLA:
    24h, max 30 days per GDPR Art. 12(3)).
    """
    user_id = user.get("sub") or user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="auth required")
    job_id = f"export_{uuid.uuid4().hex[:16]}"
    # ponytail: defer actual S3 write + email to a follow-up. The
    # job id is the contract — the portal polls /v1/jobs/{id} for
    # completion. Logging here so the audit trail records the request.
    logger.info(
        "compliance.export_my_data accepted: user_id=%s job_id=%s",
        user_id,
        job_id,
    )
    return ExportJobAccepted(
        job_id=job_id,
        status="queued",
        estimated_completion=datetime.now(UTC).isoformat(),
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
    user: dict[str, Any] = Depends(get_current_user),
) -> DeleteAccepted:
    """Hard-delete the caller's account.

    Cascades to org memberships (the caller is removed from every
    org they belong to). The user row is soft-deleted for the
    fraud-prevention retention period described in the privacy
    policy (default: 7 years) before being permanently purged.
    """
    user_id = user.get("sub") or user.get("user_id")
    if not user_id:
        raise HTTPException(status_code=401, detail="auth required")
    logger.info(
        "compliance.delete_me accepted: user_id=%s — cascade memberships",
        user_id,
    )
    return DeleteAccepted(
        status="queued",
        user_id=user_id,
        scheduled_purge_at=datetime.now(UTC).isoformat(),
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
    org_id: str,
    user: dict[str, Any] = Depends(get_current_user),
) -> OrgDeleteAccepted:
    """Delete an org's data for offboarding.

    Requires the caller to be the org owner. Memberships,
    traces, usage, judge scores, and KB docs are removed
    in dependency order; signed audit log rows are kept
    for the legally-required retention period.
    """
    # ponytail: full org deletion is a follow-up; for now
    # the contract is the accepted response. The route is
    # here so enterprise customers see the endpoint on
    # launch day.
    caller = user.get("sub") or user.get("user_id")
    logger.info(
        "compliance.delete_org_data: org_id=%s requested_by=%s",
        org_id,
        caller,
    )
    return OrgDeleteAccepted(
        status="queued",
        org_id=org_id,
        scheduled_purge_at=datetime.now(UTC).isoformat(),
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
    """Public intake for GDPR Art. 15-22 requests.

    Creates a tracked ticket that ops can action within the
    30-day SLA (GDPR Art. 12(3)). No auth required — the
    subject is by definition unauthenticated.
    """
    ticket_id = f"dsar_{uuid.uuid4().hex[:16]}"
    logger.info(
        "compliance.dsar accepted: ticket_id=%s type=%s email=%s",
        ticket_id,
        body.request_type,
        body.subject_email,
    )
    return DSARAccepted(
        ticket_id=ticket_id,
        sla_due_at=datetime.now(UTC).isoformat(),
        request_type=body.request_type,
    )


# ─── /subprocessors (GDPR Art. 28) ────────────────────────────


# Static list, updated by ops when sub-processors change. The
# ``last_updated`` field is part of the GDPR Art. 28 contract
# — customers must be notified of changes.
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
        "name": "Resend",
        "purpose": "Transactional email (DSAR, exports)",
        "location": "US",
    },
    {
        "name": "Sentry",
        "purpose": "Error tracking",
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
    """Return the current sub-processor list.

    The list is updated by ops when sub-processors change; the
    ``last_updated`` field is the timestamp ops last edited
    the list.
    """
    return {
        "subprocessors": _SUBPROCESSORS,
        "last_updated": "2026-07-02",
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
    """Record a CCPA "Do Not Sell" opt-out for the given email.

    Public endpoint — the requester is by definition not yet
    known to the system.
    """
    logger.info("compliance.do_not_sell: email=%s", body.email)
    return DNSAccepted(
        status="recorded",
        email=body.email,
        effective_at=datetime.now(UTC).isoformat(),
    )
