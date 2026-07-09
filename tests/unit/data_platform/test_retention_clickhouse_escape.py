"""Regression tests for the ClickHouse DELETE SQL injection fix.

Background
----------
``DataRetentionManager._delete_from_clickhouse`` previously
interpolated ``tenant_id`` into a ClickHouse ``ALTER TABLE ...
DELETE WHERE tenant_id = '{tenant_id}'`` SQL string via an
f-string. The ClickHouse HTTP endpoint does not support
parameterised queries, so the only safe path is to escape single
quotes (SQL-standard doubled-quote) before substitution.

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
        captured["body"] = body.decode("utf-8") if isinstance(body, (bytes, bytearray)) else body
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

    assert "tenant_id = 'evil''; DROP TABLE x; --'" in captured["body"], (
        f"Expected SQL-standard doubled-quote escape in body; got: {captured['body']!r}"
    )
    # And the original attack string must NOT appear unmodified.
    assert "evil'; DROP TABLE x; --'" not in captured["body"]


@pytest.mark.asyncio
async def test_delete_from_clickhouse_returns_one_on_success() -> None:
    """Successful ALTER DELETE returns 1 (matches the existing contract)."""
    captured: dict = {}
    fake_session = _make_fake_session(captured)

    with patch("aiohttp.ClientSession", lambda *a, **kw: fake_session), \
         patch("eden.data_platform.retention.settings",
               SimpleNamespace(clickhouse_url="http://clickhouse:8123/")):
        mgr = DataRetentionManager()
        out = await mgr._delete_from_clickhouse("00000000-0000-0000-0000-000000000001")

    assert out == 1


@pytest.mark.asyncio
async def test_delete_from_clickhouse_returns_zero_when_unconfigured() -> None:
    """No clickhouse_url → no-op, returns 0 (existing contract)."""
    mgr = DataRetentionManager()
    with patch("eden.data_platform.retention.settings",
               SimpleNamespace(clickhouse_url="")):
        out = await mgr._delete_from_clickhouse("anything")
    assert out == 0
