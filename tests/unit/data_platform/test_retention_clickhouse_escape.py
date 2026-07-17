"""Regression tests for the ClickHouse DELETE SQL injection fix.

Background
----------
``DataRetentionManager._delete_from_clickhouse`` previously
interpolated ``tenant_id`` into a ClickHouse ``ALTER TABLE ...
DELETE WHERE tenant_id = '{tenant_id}'`` SQL string via an
f-string. The ClickHouse HTTP endpoint does not support
parameterised queries, so the only safe path is to escape single
quotes (SQL-standard doubled-quote) before substitution.

As of the Wave 6 GA hardening pass, ``_delete_from_clickhouse`` issues
TWO ``ALTER TABLE ... DELETE`` statements — one against
``metrics.agent_performance`` (keyed on ``tenant_id``) and one against
``default.telemetry_events_ch`` (keyed on ``org_id``, since that table
mirrors Postgres ``telemetry_events`` for GDPR completeness). Both
statements must escape the same way.

The admin-only ``DELETE /gdpr/tenant`` endpoint forwards
``tenant_id`` straight from the URL path into this function, so
a malicious or compromised admin could otherwise inject arbitrary
ClickHouse SQL (e.g. dropping tables, exfiltrating other tenants).

This test asserts the escape is in place and that an injection
attempt produces a properly-quoted literal instead of executable
SQL.

See FIXES_LOG F49.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from eden.data_platform.retention import DataRetentionManager


class _FakeResp:
    status = 200


def _make_fake_session(captured: dict):
    """Return a stand-in for ``aiohttp.ClientSession`` that records the body."""
    from unittest.mock import AsyncMock

    captured["ctx_enter_called"] = False
    captured["post_called"] = False
    captured["bodies"] = []

    resp = _FakeResp()
    ctx = AsyncMock()
    ctx.__aenter__ = AsyncMock(return_value=resp)
    ctx.__aexit__ = AsyncMock(return_value=False)

    session = AsyncMock()
    session.__aenter__ = AsyncMock(return_value=session)
    session.__aexit__ = AsyncMock(return_value=False)

    def _post(url, data):  # noqa: ARG002 - matches aiohttp API
        captured["post_called"] = True
        captured["url"] = url
        body = data
        decoded = body.decode("utf-8") if isinstance(body, (bytes, bytearray)) else body
        captured["bodies"].append(decoded)
        # Kept for backward-compat with call sites expecting the last body.
        captured["body"] = decoded
        return ctx

    session.post = _post
    return session


@pytest.mark.asyncio
async def test_delete_from_clickhouse_escapes_single_quotes() -> None:
    """A ``'`` in tenant_id must be doubled, not pass through raw."""
    captured: dict = {}
    fake_session = _make_fake_session(captured)

    with patch("aiohttp.ClientSession", lambda *a, **kw: fake_session), \
         patch("eden.data_platform.retention.settings",
               SimpleNamespace(clickhouse_url="http://clickhouse:8123/")):
        mgr = DataRetentionManager()
        # Inject a payload that *would* terminate the string and append SQL
        # if the escape regressed.
        await mgr._delete_from_clickhouse("evil'; DROP TABLE x; --")

    all_bodies = " | ".join(captured["bodies"])
    assert "tenant_id = 'evil''; DROP TABLE x; --'" in all_bodies, (
        f"Expected SQL-standard doubled-quote escape in agent_performance body; got: {all_bodies!r}"
    )
    assert "org_id = 'evil''; DROP TABLE x; --'" in all_bodies, (
        f"Expected SQL-standard doubled-quote escape in telemetry_events_ch body; got: {all_bodies!r}"
    )
    # And the original attack string must NOT appear unmodified anywhere.
    assert "evil'; DROP TABLE x; --'" not in all_bodies


@pytest.mark.asyncio
async def test_delete_from_clickhouse_returns_one_on_success() -> None:
    """Successful ALTER DELETE returns the count of tables purged.

    Wave 6 added a second DELETE against ``telemetry_events_ch``, so a
    fully successful run now purges 2 tables (agent_performance +
    telemetry_events_ch), not 1.
    """
    captured: dict = {}
    fake_session = _make_fake_session(captured)

    with patch("aiohttp.ClientSession", lambda *a, **kw: fake_session), \
         patch("eden.data_platform.retention.settings",
               SimpleNamespace(clickhouse_url="http://clickhouse:8123/")):
        mgr = DataRetentionManager()
        out = await mgr._delete_from_clickhouse("00000000-0000-0000-0000-000000000001")

    assert out == 2


@pytest.mark.asyncio
async def test_delete_from_clickhouse_returns_zero_when_unconfigured() -> None:
    """No clickhouse_url → no-op, returns 0 (existing contract)."""
    mgr = DataRetentionManager()
    with patch("eden.data_platform.retention.settings",
               SimpleNamespace(clickhouse_url="")):
        out = await mgr._delete_from_clickhouse("anything")
    assert out == 0
