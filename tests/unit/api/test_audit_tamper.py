"""Unit tests for §6.4 audit-log tamper-evidence + streaming export.

These tests cover the Python-side contracts:
- ``verify_audit_chain`` route shape (when the SQL function exists)
- Empty-state behavior when migration 021 is not applied
- Streaming export: JSONL yields one record per line, CSV yields
  one row per line with the expected columns

The trigger itself is exercised by the SQL migration; the test that
would mutate a row in Postgres is not in the unit-test scope (it
would need a real DB).
"""

from datetime import datetime
from io import BytesIO
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException


# ────────────────────────────────────────────────────────────────────────
# Hash-chain verify endpoint
# ────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_verify_chain_empty_state_when_migration_missing():
    """If the migration hasn't been applied, verify returns ok_rows=0
    and an empty list — the portal renders a 'needs migration' banner."""
    from eden.api.routes.audit import verify_audit_chain

    fake_client = MagicMock()
    fake_client.fetch = AsyncMock(side_effect=Exception("relation verify_audit_chain does not exist"))
    async def _client():
        return fake_client

    with patch("eden.api.routes.audit.get_postgres_client", side_effect=_client), \
         patch("eden.api.routes.audit.require_org_permission", new=AsyncMock()):
        resp = await verify_audit_chain(
            org_id="00000000-0000-0000-0000-000000000002",
            x_org_id=None,
            authorization="Bearer test",
        )
    assert resp.total_rows == 0
    assert resp.ok_rows == 0
    assert resp.broken_rows == 0
    assert resp.entries == []


@pytest.mark.asyncio
async def test_verify_chain_returns_ok_for_unchained_log():
    """A log with N rows all matching the recomputed hash returns
    ok_rows=N, broken_rows=0."""
    from eden.api.routes.audit import verify_audit_chain

    rows = [
        {"seq": 1, "id": "00000000-0000-0000-0000-000000000001",
         "created_at": datetime(2026, 6, 1, 10), "ok": True,
         "expected_hash": "aaa", "actual_hash": "aaa"},
        {"seq": 2, "id": "00000000-0000-0000-0000-000000000002",
         "created_at": datetime(2026, 6, 1, 11), "ok": True,
         "expected_hash": "bbb", "actual_hash": "bbb"},
    ]
    fake_client = MagicMock()
    fake_client.fetch = AsyncMock(return_value=rows)
    async def _client():
        return fake_client

    with patch("eden.api.routes.audit.get_postgres_client", side_effect=_client), \
         patch("eden.api.routes.audit.require_org_permission", new=AsyncMock()):
        resp = await verify_audit_chain(
            org_id="00000000-0000-0000-0000-000000000002",
            x_org_id=None,
            authorization="Bearer test",
        )
    assert resp.total_rows == 2
    assert resp.ok_rows == 2
    assert resp.broken_rows == 0


@pytest.mark.asyncio
async def test_verify_chain_detects_tampered_row():
    """A row with ok=False means the chain is broken at that point."""
    from eden.api.routes.audit import verify_audit_chain

    rows = [
        {"seq": 1, "id": "00000000-0000-0000-0000-000000000001",
         "created_at": datetime(2026, 6, 1, 10), "ok": True,
         "expected_hash": "aaa", "actual_hash": "aaa"},
        {"seq": 2, "id": "00000000-0000-0000-0000-000000000002",
         "created_at": datetime(2026, 6, 1, 11), "ok": False,
         "expected_hash": "expected-bbb", "actual_hash": "actual-ccc"},
    ]
    fake_client = MagicMock()
    fake_client.fetch = AsyncMock(return_value=rows)
    async def _client():
        return fake_client

    with patch("eden.api.routes.audit.get_postgres_client", side_effect=_client), \
         patch("eden.api.routes.audit.require_org_permission", new=AsyncMock()):
        resp = await verify_audit_chain(
            org_id="00000000-0000-0000-0000-000000000002",
            x_org_id=None,
            authorization="Bearer test",
        )
    assert resp.total_rows == 2
    assert resp.ok_rows == 1
    assert resp.broken_rows == 1
    assert resp.entries[1].ok is False
    assert resp.entries[1].expected_hash == "expected-bbb"


# ────────────────────────────────────────────────────────────────────────
# Streaming export
# ────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_export_jsonl_yields_one_record_per_line():
    """The JSONL export produces one JSON object per line, with all
    fields populated."""
    from eden.api.routes.audit import export_audit_log

    rows = [
        {"id": "00000000-0000-0000-0000-000000000001",
         "user_id": "00000000-0000-0000-0000-000000000002",
         "user_email": "a@b.com",
         "action": "member.invited",
         "target_type": "user",
         "target_id": "u3",
         "metadata": {"role": "admin"},
         "ip_address": "1.2.3.4",
         "user_agent": "ua",
         "created_at": datetime(2026, 6, 1, 10),
         "prev_hash": "0" * 64,
         "entry_hash": "abc123"},
    ]
    fake_client = MagicMock()
    fake_client.fetch = AsyncMock(return_value=rows)
    async def _client():
        return fake_client

    with patch("eden.api.routes.audit.get_postgres_client", side_effect=_client), \
         patch("eden.api.routes.audit.require_org_permission", new=AsyncMock()):
        resp = await export_audit_log(
            org_id="00000000-0000-0000-0000-000000000099",
            format="jsonl",
            from_date=None,
            to_date=None,
            x_org_id=None,
            authorization="Bearer test",
        )

    # StreamingResponse wraps a generator; consume it
    body = b""
    async for chunk in resp.body_iterator:
        body += chunk
    text = body.decode()
    lines = [l for l in text.split("\n") if l]
    assert len(lines) == 1
    import json
    rec = json.loads(lines[0])
    assert rec["action"] == "member.invited"
    assert rec["entry_hash"] == "abc123"
    assert rec["user_email"] == "a@b.com"


@pytest.mark.asyncio
async def test_export_csv_has_header_and_one_row_per_record():
    from eden.api.routes.audit import export_audit_log

    rows = [
        {"id": "00000000-0000-0000-0000-000000000001",
         "user_id": "00000000-0000-0000-0000-000000000002",
         "user_email": "a@b.com",
         "action": "member.invited",
         "target_type": "user",
         "target_id": "u3",
         "metadata": {"role": "admin"},
         "ip_address": "1.2.3.4",
         "user_agent": "ua",
         "created_at": datetime(2026, 6, 1, 10),
         "prev_hash": "0" * 64,
         "entry_hash": "abc123"},
    ]
    fake_client = MagicMock()
    fake_client.fetch = AsyncMock(return_value=rows)
    async def _client():
        return fake_client

    with patch("eden.api.routes.audit.get_postgres_client", side_effect=_client), \
         patch("eden.api.routes.audit.require_org_permission", new=AsyncMock()):
        resp = await export_audit_log(
            org_id="00000000-0000-0000-0000-000000000099",
            format="csv",
            from_date=None,
            to_date=None,
            x_org_id=None,
            authorization="Bearer test",
        )

    body = b""
    async for chunk in resp.body_iterator:
        body += chunk
    text = body.decode()
    lines = [l for l in text.split("\n") if l]
    # header + 1 row
    assert lines[0].startswith("id,user_id,user_email,action")
    assert "member.invited" in lines[1]


# ────────────────────────────────────────────────────────────────────────
# Migration 021 SQL syntax sanity-check
# ────────────────────────────────────────────────────────────────────────


def test_migration_021_defines_required_objects():
    """The migration file must define the trigger function, the
    canonical_json helper, the trigger itself, and the
    verify_audit_chain function. Locking these in here is a guard
    against accidental removal when refactoring the audit log."""
    migration = open(
        "/Users/kaiavnihalani/Downloads/Eden/migrations/021_audit_tamper_evidence.sql"
    ).read()
    assert "prev_hash" in migration
    assert "entry_hash" in migration
    assert "audit_canonical_json" in migration
    assert "compute_audit_hash" in migration
    assert "trg_compute_audit_hash" in migration
    assert "verify_audit_chain" in migration
    # Idempotent: ALTER TABLE uses ADD COLUMN IF NOT EXISTS
    assert "ADD COLUMN IF NOT EXISTS" in migration
    # Trigger is dropped + recreated so the migration is rerun-safe
    assert "DROP TRIGGER IF EXISTS" in migration
