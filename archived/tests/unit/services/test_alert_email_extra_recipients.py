"""FEAT-106 — org-level soft-alert recipient list independent of org_members.

``_org_alert_recipients()`` used to be structurally incapable of routing to
anyone who wasn't an org owner/admin. These tests cover the additive merge
with ``organizations.settings`` (``budget_alert_emails`` /
``soft_alert_recipients``) that fixes that, without requiring a migration.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import pytest

from eden.services import alert_email


def _pg(settings_value):
    pg = AsyncMock()
    pg.fetchrow = AsyncMock(return_value={"settings": settings_value})
    return pg


@pytest.mark.asyncio
async def test_org_extra_alert_recipients_reads_both_keys() -> None:
    settings = {
        "budget_alert_emails": ["finance@acme.com", "cfo@acme.com"],
        "soft_alert_recipients": ["oncall-distro@acme.com"],
    }
    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=_pg(settings)),
    ):
        extras = await alert_email._org_extra_alert_recipients("org_1")

    assert extras == ["finance@acme.com", "cfo@acme.com", "oncall-distro@acme.com"]


@pytest.mark.asyncio
async def test_org_extra_alert_recipients_handles_json_string_column() -> None:
    """asyncpg/poolers can return JSONB as a raw JSON string."""
    settings = json.dumps({"soft_alert_recipients": ["ops@acme.com"]})
    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=_pg(settings)),
    ):
        extras = await alert_email._org_extra_alert_recipients("org_1")

    assert extras == ["ops@acme.com"]


@pytest.mark.asyncio
async def test_org_extra_alert_recipients_empty_when_no_settings() -> None:
    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(return_value=_pg(None)),
    ):
        extras = await alert_email._org_extra_alert_recipients("org_1")

    assert extras == []


@pytest.mark.asyncio
async def test_org_extra_alert_recipients_fails_open_on_db_error() -> None:
    with patch(
        "eden.storage.postgres.get_postgres_client",
        AsyncMock(side_effect=RuntimeError("db down")),
    ):
        extras = await alert_email._org_extra_alert_recipients("org_1")

    assert extras == []


@pytest.mark.asyncio
async def test_org_alert_recipients_merges_admins_and_extras_deduped() -> None:
    """The core FEAT-106 fix: a non-member finance address must reach the
    recipient list alongside (not instead of) owner/admin emails, with no
    duplicates even when the same address appears in both sources."""

    async def _fake_extra(_org_id: str) -> list[str]:
        return ["Finance@acme.com", "owner@acme.com"]

    pg = AsyncMock()
    pg.fetch = AsyncMock(return_value=[{"email": "owner@acme.com"}])

    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=pg),
        ),
        patch.object(alert_email, "_org_extra_alert_recipients", _fake_extra),
    ):
        recipients = await alert_email._org_alert_recipients("org_1")

    # owner@acme.com only once despite appearing in both sources (case-insensitive).
    assert recipients == ["owner@acme.com", "Finance@acme.com"]


@pytest.mark.asyncio
async def test_org_alert_recipients_caps_total_recipients() -> None:
    extras = [f"extra{i}@acme.com" for i in range(30)]

    async def _fake_extra(_org_id: str) -> list[str]:
        return extras

    pg = AsyncMock()
    pg.fetch = AsyncMock(return_value=[{"email": "owner@acme.com"}])

    with (
        patch(
            "eden.storage.postgres.get_postgres_client",
            AsyncMock(return_value=pg),
        ),
        patch.object(alert_email, "_org_extra_alert_recipients", _fake_extra),
    ):
        recipients = await alert_email._org_alert_recipients("org_1")

    assert len(recipients) == alert_email._MAX_RECIPIENTS
