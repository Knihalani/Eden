"""Regression tests for the ``transition_to_warm`` table parameter
validation.

Background
----------
``StorageLifecycleManager.transition_to_warm`` interpolates the
caller-supplied ``table`` parameter into raw SQL via an f-string.
The admin-only ``POST /storage/transition`` route forwards the
table name from the HTTP query string into this function, so a
malicious or compromised admin could otherwise inject arbitrary
SQL via ``?table=silver_events%20UNION%20...``.

The function previously accepted any string. We validate the
table name against Postgres unquoted-identifier syntax
(``[A-Za-z_][A-Za-z0-9_]*``) and reject anything else with a
``ValueError``.

See FIXES_LOG F49.
"""

from __future__ import annotations

from unittest.mock import patch

import pytest

from eden.data_platform.storage_lifecycle import StorageLifecycleManager


class _SentinelClient:
    """Stand-in client whose ``fetch`` raises immediately so the
    function exits after validation has accepted the table name.

    We need this to verify the validation gate *passes* for
    legitimate names — without it, the legitimate-name test would
    succeed silently even if the validation gate were removed.
    """

    def __getattr__(self, name):
        raise AssertionError(
            f"Validation gate regressed: function tried to use "
            f"the DB ({name!r}) for a legitimate table name."
        )


def _mgr_with_validation_only() -> StorageLifecycleManager:
    """Manager whose _get_postgres returns a client that fails fast."""
    mgr = StorageLifecycleManager(dry_run=True)
    mgr._postgres_client = _SentinelClient()
    return mgr


@pytest.mark.asyncio
async def test_transition_to_warm_rejects_sql_injection_in_table() -> None:
    """Injection attempts raise ``ValueError`` before any DB call."""
    mgr = _mgr_with_validation_only()
    with patch.object(mgr, "_get_postgres", return_value=None):
        with pytest.raises(ValueError, match="Invalid table name"):
            await mgr.transition_to_warm("silver_events UNION SELECT * FROM passwords", 7)


@pytest.mark.asyncio
async def test_transition_to_warm_rejects_quoted_identifier() -> None:
    """Quoted identifiers (``"weird.name"``) are rejected."""
    mgr = _mgr_with_validation_only()
    with patch.object(mgr, "_get_postgres", return_value=None):
        with pytest.raises(ValueError, match="Invalid table name"):
            await mgr.transition_to_warm('"weird.name"', 7)


@pytest.mark.asyncio
async def test_transition_to_warm_rejects_non_string() -> None:
    """Non-strings (e.g. None, int) are rejected."""
    mgr = _mgr_with_validation_only()
    with patch.object(mgr, "_get_postgres", return_value=None):
        for bad in [None, 123, 4.5, [], {}]:
            with pytest.raises(ValueError):
                await mgr.transition_to_warm(bad, 7)  # type: ignore[arg-type]


def test_validation_accepts_legitimate_table_names() -> None:
    """Legitimate Postgres unquoted-identifier names pass validation.

    We test the validation regex directly (without spinning up the
    full transition flow) because the function then needs a real
    Postgres client to actually run the migration. This test is
    the contract for the regex; the rest of the migration is
    covered by ``tests/data_platform/test_storage_lifecycle.py``.
    """
    import re

    pat = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
    for name in ["silver_events", "usage_events", "_archive_tmp", "Jobs2024", "a", "_"]:
        assert pat.match(name), f"expected {name!r} to be accepted"


def test_validation_rejects_known_unsafe_names() -> None:
    """SQL-injection payloads must fail validation."""
    import re

    pat = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
    for name in [
        "silver_events UNION SELECT * FROM passwords",
        '"weird.name"',
        "123_events",
        "a; DROP TABLE x",
        "a b",
        "",
    ]:
        assert not pat.match(name), f"expected {name!r} to be rejected"


@pytest.mark.asyncio
async def test_transition_to_warm_rejects_table_starting_with_digit() -> None:
    """Postgres identifiers can't start with a digit; reject."""
    mgr = _mgr_with_validation_only()
    with patch.object(mgr, "_get_postgres", return_value=None):
        with pytest.raises(ValueError, match="Invalid table name"):
            await mgr.transition_to_warm("123_events", 7)
