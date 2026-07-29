"""Compliance job runners — GDPR export/delete + CCPA persistence.

Implements the async work behind ``compliance.py`` routes:
export user data to object storage (or local fallback), soft-delete
users/orgs, persist DSAR tickets, and record Do-Not-Sell requests.
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

logger = logging.getLogger(__name__)

_LOCAL_EXPORT_DIR = "/tmp/eden-compliance-exports"


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def _email_hash(email: str) -> str:
    return hashlib.sha256(email.strip().lower().encode("utf-8")).hexdigest()


async def _pg():
    from eden.storage.postgres import get_postgres_client

    return await get_postgres_client()


async def create_job(
    *,
    job_type: str,
    subject_user_id: str | None = None,
    subject_org_id: str | None = None,
    requested_by: str | None = None,
    payload: dict[str, Any] | None = None,
) -> str:
    job_id = _new_id(job_type)
    client = await _pg()
    await client.execute(
        """
        INSERT INTO compliance_jobs
            (id, job_type, status, subject_user_id, subject_org_id,
             requested_by, payload)
        VALUES ($1, $2, 'queued', $3, $4, $5, $6::jsonb)
        """,
        job_id,
        job_type,
        subject_user_id,
        subject_org_id,
        requested_by,
        json.dumps(payload or {}),
    )
    return job_id


async def get_job(job_id: str) -> dict[str, Any] | None:
    client = await _pg()
    row = await client.fetchrow(
        "SELECT * FROM compliance_jobs WHERE id = $1",
        job_id,
    )
    return dict(row) if row else None


async def _mark_job(
    job_id: str,
    *,
    status: str,
    download_url: str | None = None,
    error_message: str | None = None,
) -> None:
    client = await _pg()
    completed = datetime.now(UTC) if status in ("completed", "failed") else None
    await client.execute(
        """
        UPDATE compliance_jobs SET
            status = $2,
            download_url = COALESCE($3, download_url),
            error_message = $4,
            updated_at = NOW(),
            completed_at = COALESCE($5, completed_at)
        WHERE id = $1
        """,
        job_id,
        status,
        download_url,
        error_message,
        completed,
    )


def _s3_client():
    import boto3

    from eden.config import get_settings

    settings = get_settings()
    kwargs: dict[str, Any] = {}
    if settings.eden_storage_access_key and settings.eden_storage_secret_key:
        kwargs["aws_access_key_id"] = settings.eden_storage_access_key
        kwargs["aws_secret_access_key"] = settings.eden_storage_secret_key
    if settings.eden_storage_endpoint:
        kwargs["endpoint_url"] = settings.eden_storage_endpoint
    return boto3.client("s3", **kwargs)


async def _upload_bytes(key: str, payload: bytes) -> str:
    """Upload to S3 when configured; otherwise write local fallback."""
    from eden.config import get_settings

    settings = get_settings()
    bucket = settings.bronze_s3_bucket
    if bucket and (
        settings.eden_storage_access_key or os.environ.get("AWS_ACCESS_KEY_ID")
    ):
        import asyncio

        s3 = _s3_client()
        await asyncio.to_thread(
            lambda: s3.put_object(
                Bucket=bucket,
                Key=key,
                Body=payload,
                ContentType="application/json",
            )
        )
        try:
            url = await asyncio.to_thread(
                lambda: s3.generate_presigned_url(
                    "get_object",
                    Params={"Bucket": bucket, "Key": key},
                    ExpiresIn=7 * 24 * 3600,
                )
            )
            return url
        except Exception:
            return f"s3://{bucket}/{key}"

    os.makedirs(_LOCAL_EXPORT_DIR, exist_ok=True)
    path = os.path.join(_LOCAL_EXPORT_DIR, key.replace("/", "_"))
    with open(path, "wb") as fh:
        fh.write(payload)
    return f"file://{path}"


async def _collect_user_export(user_id: str) -> dict[str, Any]:
    client = await _pg()
    user = await client.fetchrow(
        """
        SELECT id, email, name, clerk_id, created_at, deleted_at
        FROM users WHERE id = $1
        """,
        user_id,
    )
    memberships = await client.fetch(
        """
        SELECT om.org_id, om.role, o.name AS org_name, o.slug
        FROM org_members om
        LEFT JOIN organizations o ON o.id = om.org_id
        WHERE om.user_id = $1
        """,
        user_id,
    )
    api_keys: list[dict[str, Any]] = []
    try:
        api_keys_rows = await client.fetch(
            """
            -- Canonical table is ``org_api_keys`` with a ``key_prefix``
            -- column (alembic 001 + 114/115). This read named a table and
            -- a column that no migration creates, so the GDPR subject-data
            -- export silently reported zero API keys for every user.
            SELECT id, name, key_prefix AS prefix, created_at,
                   last_used_at, revoked_at
            FROM org_api_keys
            WHERE org_id IN (
                SELECT org_id FROM org_members WHERE user_id = $1
            )
            LIMIT 500
            """,
            user_id,
        )
        api_keys = [dict(r) for r in api_keys_rows]
    except Exception as exc:  # noqa: BLE001
        logger.warning("compliance.export api_keys skip: %s", exc)
    return {
        "exported_at": datetime.now(UTC).isoformat(),
        "user": dict(user) if user else {"id": user_id},
        "memberships": [dict(r) for r in memberships],
        "api_keys": api_keys,
    }


async def run_user_export_job(job_id: str, user_id: str) -> None:
    try:
        await _mark_job(job_id, status="running")
        data = await _collect_user_export(user_id)
        payload = json.dumps(data, default=str, indent=2).encode("utf-8")
        key = f"compliance/exports/{user_id}/{job_id}.json"
        url = await _upload_bytes(key, payload)
        await _mark_job(job_id, status="completed", download_url=url)

        # Best-effort email notification
        try:
            client = await _pg()
            row = await client.fetchrow(
                "SELECT email FROM users WHERE id = $1", user_id
            )
            email = row["email"] if row else None
            if email:
                from eden.services.email_service import get_email_service

                svc = get_email_service()
                await svc.send_email(
                    to_email=email,
                    subject="Your Eden data export is ready",
                    html_content=(
                        f"<p>Your data export is ready.</p>"
                        f"<p><a href=\"{url}\">Download export</a></p>"
                        f"<p>This link may expire. Job id: {job_id}</p>"
                    ),
                    text_content=f"Your Eden data export is ready: {url}\nJob: {job_id}",
                    purpose="transactional",
                )
        except Exception as exc:  # noqa: BLE001
            logger.warning("compliance.export email failed job_id=%s: %s", job_id, exc)
    except Exception as exc:  # noqa: BLE001
        logger.exception("compliance.export failed job_id=%s", job_id)
        await _mark_job(job_id, status="failed", error_message=str(exc)[:500])


async def run_user_delete_job(job_id: str, user_id: str) -> None:
    try:
        await _mark_job(job_id, status="running")
        client = await _pg()
        await client.execute(
            "DELETE FROM org_members WHERE user_id = $1",
            user_id,
        )
        await client.execute(
            """
            UPDATE users SET
                deleted_at = NOW(),
                email = CONCAT('deleted+', id, '@eden.invalid'),
                name = 'Deleted User',
                token_version = COALESCE(token_version, 0) + 1,
                password_hash = NULL
            WHERE id = $1 AND deleted_at IS NULL
            """,
            user_id,
        )
        await _mark_job(job_id, status="completed")
    except Exception as exc:  # noqa: BLE001
        logger.exception("compliance.delete_me failed job_id=%s", job_id)
        await _mark_job(job_id, status="failed", error_message=str(exc)[:500])


async def assert_org_owner(org_id: str, user_id: str) -> None:
    from fastapi import HTTPException

    client = await _pg()
    row = await client.fetchrow(
        """
        SELECT role FROM org_members
        WHERE org_id = $1 AND user_id = $2
        """,
        org_id,
        user_id,
    )
    if not row or row["role"] not in ("owner", "admin"):
        # Prefer strict owner for destructive org delete
        owner = await client.fetchrow(
            "SELECT owner_id FROM organizations WHERE id = $1",
            org_id,
        )
        if not owner or owner["owner_id"] != user_id:
            raise HTTPException(status_code=403, detail="Org owner role required")


async def run_org_delete_job(job_id: str, org_id: str) -> None:
    try:
        await _mark_job(job_id, status="running")
        client = await _pg()
        # Soft-archive org and detach members; keep audit rows.
        await client.execute(
            """
            UPDATE organizations SET
                archived_at = COALESCE(archived_at, NOW()),
                name = CONCAT(name, ' (deleted)')
            WHERE id = $1
            """,
            org_id,
        )
        await client.execute(
            "DELETE FROM org_members WHERE org_id = $1",
            org_id,
        )
        await _mark_job(job_id, status="completed")
    except Exception as exc:  # noqa: BLE001
        logger.exception("compliance.delete_org failed job_id=%s", job_id)
        await _mark_job(job_id, status="failed", error_message=str(exc)[:500])


async def create_dsar_ticket(
    *,
    subject_name: str,
    subject_email: str,
    request_type: str,
    details: str | None,
) -> tuple[str, datetime]:
    ticket_id = _new_id("dsar")
    sla_due = datetime.now(UTC) + timedelta(days=30)
    client = await _pg()
    await client.execute(
        """
        INSERT INTO dsar_tickets
            (id, subject_name, subject_email, request_type, details, sla_due_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        """,
        ticket_id,
        subject_name,
        subject_email,
        request_type,
        details,
        sla_due,
    )
    return ticket_id, sla_due


async def record_do_not_sell(email: str) -> datetime:
    req_id = _new_id("dns")
    now = datetime.now(UTC)
    client = await _pg()
    await client.execute(
        """
        INSERT INTO do_not_sell_requests (id, email, email_hash, effective_at)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (email_hash) DO UPDATE SET effective_at = EXCLUDED.effective_at
        """,
        req_id,
        email.strip().lower(),
        _email_hash(email),
        now,
    )
    return now
