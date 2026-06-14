"""Export destinations & schedules — Phase 8 export management.

Exposes the CRUD the portal's "Exports" tab needs, plus a manual
``POST /export/run-now`` trigger so operators can validate a
schedule without waiting for cron.

Destinations store S3 / GCS credentials Fernet-encrypted at rest;
the plaintext never leaves the request handler that validated it.
Schedules are tiny metadata rows — the heavy lifting (querying
the catalog, serialising to CSV / Parquet / JSONL, pushing to S3
or GCS) lives in ``eden.exports.runner`` and is invoked via
``run_export_now``.

All routes require ``settings:edit`` permission (owner / admin
only) — exporting telemetry to a third-party bucket is a
sensitive operation.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Cookie, Depends, HTTPException, Path
from pydantic import BaseModel, Field, field_validator

from eden.api.deps import (
    get_current_user,
    log_audit_event,
    require_org_permission,
)
from eden.api.utils.encryption import decrypt_value, encrypt_value
from eden.storage.postgres import get_postgres_client


async def _require_export_admin(
    org_id: str,
    authorization: str | None = Cookie(None),
) -> dict:
    """Verify the caller is an org admin (settings:edit).

    ``require_org_permission`` reads the JWT cookie and the
    X-Org-Id header — the cookie is the portal's primary
    transport, so this just gates the route and returns the
    org context. The actual query uses the path ``org_id``
    because the portal always passes the current org.
    """
    return await require_org_permission("settings:edit", org_id, authorization)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/orgs/{org_id}/export", tags=["export-destinations"])


# ────────────────────────────────────────────────────────────────────
# Catalog (constant — the 6 exportable data types)
# ────────────────────────────────────────────────────────────────────

DATA_TYPES = (
    "traces",
    "judge_scores",
    "audit_log",
    "usage_events",
    "insights",
    "telemetry_events",
)
FORMATS = ("csv", "parquet", "jsonl")
DESTINATION_TYPES = ("s3", "gcs")


# ────────────────────────────────────────────────────────────────────
# Schemas
# ────────────────────────────────────────────────────────────────────

class DestinationIn(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    type: str = Field(..., description="One of: s3, gcs")
    # The bucket-only "shape" the user pasted. We accept any
    # extra keys (region, endpoint, prefix, etc.) and pass them
    # through unchanged so we don't need a schema bump every time
    # a cloud adds a knob. ``credentials`` is required and is the
    # only field that gets encrypted.
    config: dict = Field(..., description="Bucket config (bucket, region, etc.)")
    credentials: dict = Field(
        ...,
        description="Secret material — access_key_id/secret_access_key for S3 or client_email/private_key for GCS",
    )

    @field_validator("type")
    @classmethod
    def _type_must_be_known(cls, v: str) -> str:
        if v not in DESTINATION_TYPES:
            raise ValueError(f"type must be one of {DESTINATION_TYPES}")
        return v


class DestinationOut(BaseModel):
    destination_id: str
    org_id: str
    name: str
    type: str
    # The bucket shape is safe to return (it has no secrets). The
    # raw ``credentials`` blob is never echoed back.
    config: dict
    created_at: str
    created_by: str | None = None


class ScheduleIn(BaseModel):
    destination_id: str | None = Field(
        default=None,
        description="Omit / null for a one-shot download schedule",
    )
    data_type: str
    format: str
    # NULL cron → one-shot. 5-field cron string for recurring.
    cron_expression: str | None = Field(
        default=None,
        description="Standard 5-field cron (m h dom mon dow). Omit for one-shot.",
    )

    @field_validator("data_type")
    @classmethod
    def _data_type_must_be_known(cls, v: str) -> str:
        if v not in DATA_TYPES:
            raise ValueError(f"data_type must be one of {DATA_TYPES}")
        return v

    @field_validator("format")
    @classmethod
    def _format_must_be_known(cls, v: str) -> str:
        if v not in FORMATS:
            raise ValueError(f"format must be one of {FORMATS}")
        return v

    @field_validator("cron_expression")
    @classmethod
    def _cron_must_be_valid(cls, v: str | None) -> str | None:
        if v is None or v.strip() == "":
            return None
        # Standard 5-field cron: minute hour day-of-month month day-of-week
        parts = v.split()
        if len(parts) != 5:
            raise ValueError("cron_expression must be 5 whitespace-separated fields")
        for part in parts:
            if not re.match(r"^[\d\*\/\,\-\?LW#]+$", part):
                raise ValueError(f"invalid cron field: {part!r}")
        return v


class ScheduleOut(BaseModel):
    schedule_id: str
    org_id: str
    destination_id: str | None = None
    data_type: str
    format: str
    cron_expression: str | None = None
    last_run_at: str | None = None
    created_at: str
    created_by: str | None = None


class RunNowResult(BaseModel):
    schedule_id: str
    status: str
    bytes_written: int
    destination: str
    started_at: str
    finished_at: str


# ────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────

def _row_to_destination(row: Any) -> DestinationOut:
    config_blob = json.loads(decrypt_value(row["config_encrypted"]))
    # Strip the secret material before returning to the client.
    safe_config = {k: v for k, v in config_blob.items() if k != "credentials"}
    return DestinationOut(
        destination_id=str(row["destination_id"]),
        org_id=str(row["org_id"]),
        name=row["name"],
        type=row["type"],
        config=safe_config,
        created_at=row["created_at"].isoformat() if row.get("created_at") else "",
        created_by=row.get("created_by"),
    )


def _row_to_schedule(row: Any) -> ScheduleOut:
    return ScheduleOut(
        schedule_id=str(row["schedule_id"]),
        org_id=str(row["org_id"]),
        destination_id=str(row["destination_id"]) if row.get("destination_id") else None,
        data_type=row["data_type"],
        format=row["format"],
        cron_expression=row.get("cron_expression"),
        last_run_at=row["last_run_at"].isoformat() if row.get("last_run_at") else None,
        created_at=row["created_at"].isoformat() if row.get("created_at") else "",
        created_by=row.get("created_by"),
    )


# ────────────────────────────────────────────────────────────────────
# Destinations CRUD
# ────────────────────────────────────────────────────────────────────

@router.get("/destinations", response_model=list[DestinationOut])
async def list_destinations(
    org_id: str = Path(...),
    member: dict = Depends(get_current_user),
    authorization: str | None = Cookie(None),
) -> list[DestinationOut]:
    """List all export destinations for an org (secrets stripped)."""
    await _require_export_admin(org_id, authorization)
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    rows = await client.fetch(
        """
        SELECT destination_id, org_id, name, type, config_encrypted,
               created_by, created_at
        FROM export_destinations
        WHERE org_id = $1
        ORDER BY created_at DESC
        """,
        org_id,
    )
    return [_row_to_destination(r) for r in rows]


@router.post("/destinations", response_model=DestinationOut, status_code=201)
async def create_destination(
    body: DestinationIn,
    org_id: str = Path(...),
    member: dict = Depends(get_current_user),
    authorization: str | None = Cookie(None),
) -> DestinationOut:
    """Create a new export destination.

    The ``config`` and ``credentials`` blobs are merged into a
    single JSON object, then Fernet-encrypted at rest. We never
    persist or log the plaintext.
    """
    await _require_export_admin(org_id, authorization)
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")

    merged_blob = {**body.config, "credentials": body.credentials}
    encrypted = encrypt_value(json.dumps(merged_blob))
    dest_id = str(uuid.uuid4())

    try:
        row = await client.fetchrow(
            """
            INSERT INTO export_destinations
                (destination_id, org_id, name, type, config_encrypted, created_by)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING destination_id, org_id, name, type, config_encrypted,
                      created_by, created_at
            """,
            dest_id, org_id, body.name, body.type, encrypted, member.get("user_id"),
        )
    except Exception as exc:  # unique-violation, etc.
        # asyncpg raises UniqueViolationError — match by message
        # so we don't import a private exception class here.
        if "unique" in str(exc).lower() or "duplicate" in str(exc).lower():
            raise HTTPException(
                status_code=409,
                detail=f"A destination named {body.name!r} already exists for this org",
            ) from exc
        raise

    await log_audit_event(
        client=client,
        org_id=org_id,
        user_id=member["user_id"],
        action="export.destination.created",
        target_type="export_destination",
        target_id=dest_id,
        metadata={"name": body.name, "type": body.type},
    )

    return _row_to_destination(row)


@router.delete("/destinations/{destination_id}", status_code=200)
async def delete_destination(
    destination_id: str,
    org_id: str = Path(...),
    member: dict = Depends(get_current_user),
    authorization: str | None = Cookie(None),
) -> dict:
    """Delete a destination.

    Refuses if any schedule still references it — operators
    should drop the schedule first to avoid orphan cron jobs.
    """
    await _require_export_admin(org_id, authorization)
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")

    row = await client.fetchrow(
        "SELECT name FROM export_destinations WHERE destination_id = $1 AND org_id = $2",
        destination_id, org_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Destination not found")

    in_use = await client.fetchval(
        "SELECT COUNT(*) FROM export_schedules WHERE destination_id = $1",
        destination_id,
    )
    if in_use and in_use > 0:
        raise HTTPException(
            status_code=409,
            detail=f"Destination is referenced by {in_use} schedule(s); delete those first",
        )

    await client.execute(
        "DELETE FROM export_destinations WHERE destination_id = $1 AND org_id = $2",
        destination_id, org_id,
    )

    await log_audit_event(
        client=client,
        org_id=org_id,
        user_id=member["user_id"],
        action="export.destination.deleted",
        target_type="export_destination",
        target_id=destination_id,
        metadata={"name": row["name"]},
    )

    return {"message": "Destination deleted", "destination_id": destination_id}


# ────────────────────────────────────────────────────────────────────
# Schedules CRUD
# ────────────────────────────────────────────────────────────────────

@router.get("/schedules", response_model=list[ScheduleOut])
async def list_schedules(
    org_id: str = Path(...),
    member: dict = Depends(get_current_user),
    authorization: str | None = Cookie(None),
) -> list[ScheduleOut]:
    """List all export schedules for an org."""
    await _require_export_admin(org_id, authorization)
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    rows = await client.fetch(
        """
        SELECT schedule_id, org_id, destination_id, data_type, format,
               cron_expression, last_run_at, created_by, created_at
        FROM export_schedules
        WHERE org_id = $1
        ORDER BY created_at DESC
        """,
        org_id,
    )
    return [_row_to_schedule(r) for r in rows]


@router.post("/schedules", response_model=ScheduleOut, status_code=201)
async def create_schedule(
    body: ScheduleIn,
    org_id: str = Path(...),
    member: dict = Depends(get_current_user),
    authorization: str | None = Cookie(None),
) -> ScheduleOut:
    """Create an export schedule.

    A schedule without a ``destination_id`` is a "download" —
    the API will stream bytes back to the caller when run.
    """
    await _require_export_admin(org_id, authorization)
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")

    if body.destination_id:
        # Confirm the destination belongs to the same org.
        owner = await client.fetchval(
            "SELECT org_id FROM export_destinations WHERE destination_id = $1",
            body.destination_id,
        )
        if owner is None:
            raise HTTPException(status_code=404, detail="Destination not found")
        if str(owner) != str(org_id):
            raise HTTPException(
                status_code=403,
                detail="Destination belongs to a different org",
            )

    schedule_id = str(uuid.uuid4())
    row = await client.fetchrow(
        """
        INSERT INTO export_schedules (
            schedule_id, org_id, destination_id, data_type, format,
            cron_expression, created_by
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING schedule_id, org_id, destination_id, data_type, format,
                  cron_expression, last_run_at, created_by, created_at
        """,
        schedule_id, org_id, body.destination_id, body.data_type,
        body.format, body.cron_expression, member.get("user_id"),
    )

    await log_audit_event(
        client=client,
        org_id=org_id,
        user_id=member["user_id"],
        action="export.schedule.created",
        target_type="export_schedule",
        target_id=schedule_id,
        metadata={
            "data_type": body.data_type,
            "format": body.format,
            "cron": body.cron_expression,
            "destination_id": body.destination_id,
        },
    )

    return _row_to_schedule(row)


@router.delete("/schedules/{schedule_id}", status_code=200)
async def delete_schedule(
    schedule_id: str,
    org_id: str = Path(...),
    member: dict = Depends(get_current_user),
    authorization: str | None = Cookie(None),
) -> dict:
    """Delete an export schedule."""
    await _require_export_admin(org_id, authorization)
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")
    deleted = await client.fetchval(
        "DELETE FROM export_schedules WHERE schedule_id = $1 AND org_id = $2 RETURNING schedule_id",
        schedule_id, org_id,
    )
    if not deleted:
        raise HTTPException(status_code=404, detail="Schedule not found")

    await log_audit_event(
        client=client,
        org_id=org_id,
        user_id=member["user_id"],
        action="export.schedule.deleted",
        target_type="export_schedule",
        target_id=schedule_id,
    )
    return {"message": "Schedule deleted", "schedule_id": schedule_id}


# ────────────────────────────────────────────────────────────────────
# Run-now trigger
# ────────────────────────────────────────────────────────────────────

@router.post("/run-now/{schedule_id}", response_model=RunNowResult)
async def run_export_now(
    schedule_id: str,
    org_id: str = Path(...),
    member: dict = Depends(get_current_user),
    authorization: str | None = Cookie(None),
) -> RunNowResult:
    """Trigger a schedule immediately.

    The schedule's ``last_run_at`` is bumped, a synthetic export
    is materialised via :func:`eden.exports.runner.run_export`,
    and the destination / download metadata is returned. The
    actual push to S3 / GCS is best-effort and mocked in tests.
    """
    await _require_export_admin(org_id, authorization)
    client = await get_postgres_client()
    if not client:
        raise HTTPException(status_code=503, detail="Database unavailable")

    row = await client.fetchrow(
        """
        SELECT s.schedule_id, s.org_id, s.destination_id, s.data_type,
               s.format, s.cron_expression, s.last_run_at,
               d.name AS destination_name, d.type AS destination_type,
               d.config_encrypted
        FROM export_schedules s
        LEFT JOIN export_destinations d ON d.destination_id = s.destination_id
        WHERE s.schedule_id = $1 AND s.org_id = $2
        """,
        schedule_id, org_id,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Schedule not found")

    started_at = datetime.now(UTC)

    # Defer to the runner. We import lazily so test environments
    # without boto3 / google-cloud-storage can still import the
    # router module.
    from eden.exports.runner import run_export

    destination_name = row["destination_name"] or "download"
    decrypted_config: dict | None = None
    if row["config_encrypted"]:
        decrypted_config = json.loads(decrypt_value(row["config_encrypted"]))

    bytes_written = await run_export(
        org_id=str(row["org_id"]),
        data_type=row["data_type"],
        format=row["format"],
        destination_type=row["destination_type"],
        destination_name=destination_name,
        destination_config=decrypted_config,
    )

    finished_at = datetime.now(UTC)

    await client.execute(
        "UPDATE export_schedules SET last_run_at = $1 WHERE schedule_id = $2",
        started_at, schedule_id,
    )

    await log_audit_event(
        client=client,
        org_id=org_id,
        user_id=member["user_id"],
        action="export.run",
        target_type="export_schedule",
        target_id=schedule_id,
        metadata={
            "data_type": row["data_type"],
            "format": row["format"],
            "bytes_written": bytes_written,
            "destination": destination_name,
        },
    )

    return RunNowResult(
        schedule_id=str(row["schedule_id"]),
        status="success",
        bytes_written=bytes_written,
        destination=destination_name,
        started_at=started_at.isoformat(),
        finished_at=finished_at.isoformat(),
    )
