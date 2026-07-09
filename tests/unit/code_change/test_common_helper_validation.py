"""Regression tests for the SQL-identifier validation added to
``eden.code_change._common`` helpers.

Background
----------
``_select_rows``, ``_insert_row``, and ``_update_row`` interpolate
caller-supplied identifiers (``table``, ``columns``, ``where``,
``order_by``, ``set_col``, ``where_col``) straight into raw SQL via
f-strings. Today every internal caller passes hardcoded literals,
but the helpers are public-ish (importable from ``eden.code_change.
_common``) and a future caller could trivially smuggle SQL via a
column list that came from request input.

We added validation at each helper boundary:

* ``_select_rows`` / ``_update_row`` / ``_insert_row`` all validate
  identifier-shaped params (``table``, column names, etc.) against
  ``[A-Za-z_][A-Za-z0-9_]*``.
* ``_select_rows`` also validates ``where`` and ``order_by`` against
  a forbidden-characters regex (``;``, SQL comments, backslash) so
  call sites can still pass legitimate SQL fragments like
  ``status != 'disconnected'`` (single quotes are fine) but not
  ``status; DROP TABLE x``.

See FIXES_LOG F53.
"""

from __future__ import annotations

import re
from unittest.mock import patch

import pytest


def test_select_rows_rejects_sql_injection_in_table() -> None:
    """Injection in the ``table`` parameter raises ``ValueError``."""
    from eden.code_change._common import _select_rows

    with pytest.raises(ValueError, match="invalid SQL identifier"):
        # Run synchronously by calling the inner block via __wrapped__'s
        # validation; the DB call would fail later, but validation runs first.
        asyncio_run_with_none_client(_select_rows)(
            org_id="00000000-0000-0000-0000-000000000001",
            table="proposed_patches UNION SELECT * FROM passwords",
        )


def test_select_rows_rejects_sql_injection_in_where() -> None:
    """``where`` containing ``;`` is rejected."""
    from eden.code_change._common import _select_rows

    with pytest.raises(ValueError, match="forbidden characters"):
        asyncio_run_with_none_client(_select_rows)(
            org_id="00000000-0000-0000-0000-000000000001",
            table="proposed_patches",
            where="status; DROP TABLE x",
        )


def test_select_rows_rejects_sql_comment_in_where() -> None:
    """``where`` containing SQL comments is rejected."""
    from eden.code_change._common import _select_rows

    for bad in ["status -- comment", "status /* comment */"]:
        with pytest.raises(ValueError, match="forbidden characters"):
            asyncio_run_with_none_client(_select_rows)(
                org_id="00000000-0000-0000-0000-000000000001",
                table="proposed_patches",
                where=bad,
            )


def test_select_rows_accepts_legitimate_where_with_quotes() -> None:
    """Legitimate WHERE fragments with literal single quotes pass."""
    from eden.code_change._common import _select_rows

    for ok in [
        "status = $2",
        "status != 'disconnected'",
        "status = 'active'",
        "repo_id = $2 AND code_path LIKE $3",
        "created_at > NOW() - INTERVAL '1 day'",
    ]:
        # Should not raise ValueError. Will hit the DB-call path next,
        # which will fail with the mocked client; that's expected.
        try:
            asyncio_run_with_none_client(_select_rows)(
                org_id="00000000-0000-0000-0000-000000000001",
                table="proposed_patches",
                where=ok,
            )
        except ValueError as exc:
            pytest.fail(
                f"legitimate WHERE {ok!r} was rejected with: {exc}"
            )
        except Exception:
            # DB call may fail; that's fine — validation passed.
            pass


def test_select_rows_rejects_sql_injection_in_order_by() -> None:
    """Injection in ``order_by`` raises ``ValueError``."""
    from eden.code_change._common import _select_rows

    with pytest.raises(ValueError, match="forbidden characters"):
        asyncio_run_with_none_client(_select_rows)(
            org_id="00000000-0000-0000-0000-000000000001",
            table="proposed_patches",
            order_by="created_at; DROP TABLE x",
        )


def test_insert_row_rejects_sql_injection_in_table() -> None:
    """Injection in ``table`` for insert raises ``ValueError``."""
    from eden.code_change._common import _insert_row

    with pytest.raises(ValueError, match="invalid SQL identifier"):
        asyncio_run_with_none_client(_insert_row)(
            org_id="00000000-0000-0000-0000-000000000001",
            table="proposed_patches; DROP TABLE x",
            columns=["id"],
            values=["abc"],
        )


def test_insert_row_rejects_sql_injection_in_columns() -> None:
    """Injection in any column name for insert raises ``ValueError``."""
    from eden.code_change._common import _insert_row

    with pytest.raises(ValueError, match="invalid SQL identifier"):
        asyncio_run_with_none_client(_insert_row)(
            org_id="00000000-0000-0000-0000-000000000001",
            table="proposed_patches",
            columns=["id", "name; DROP TABLE x"],
            values=["abc", "x"],
        )


def test_update_row_rejects_sql_injection_in_set_col() -> None:
    """Injection in ``set_col`` raises ``ValueError``."""
    from eden.code_change._common import _update_row

    with pytest.raises(ValueError, match="invalid SQL identifier"):
        asyncio_run_with_none_client(_update_row)(
            org_id="00000000-0000-0000-0000-000000000001",
            table="proposed_patches",
            where_col="id",
            where_val="abc",
            set_col="status; DROP TABLE x",
            set_val="closed",
        )


def test_update_row_rejects_sql_injection_in_where_col() -> None:
    """Injection in ``where_col`` raises ``ValueError``."""
    from eden.code_change._common import _update_row

    with pytest.raises(ValueError, match="invalid SQL identifier"):
        asyncio_run_with_none_client(_update_row)(
            org_id="00000000-0000-0000-0000-000000000001",
            table="proposed_patches",
            where_col="id; DROP TABLE x",
            where_val="abc",
            set_col="status",
            set_val="closed",
        )


# ── Helpers ────────────────────────────────────────────────────────


def asyncio_run_with_none_client(coro_factory):
    """Return a callable that runs the given async fn with ``get_postgres_client``
    patched to return ``None`` — the helpers will then exit early after
    validation succeeds/fails, without touching a real DB.

    The factory pattern lets the test stay synchronous-looking.
    """
    import asyncio

    def runner(*args, **kwargs):
        async def _inner():
            with patch("eden.storage.postgres.get_postgres_client", return_value=None):
                return await coro_factory(*args, **kwargs)

        return asyncio.run(_inner())

    return runner
