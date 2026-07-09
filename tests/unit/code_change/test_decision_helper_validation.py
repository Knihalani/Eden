"""Regression tests for SQL-identifier validation added to
``eden.decision._common`` helpers.

Background
----------
``decision._common._delete_then_insert`` and ``decision._common
._insert_rows`` interpolate caller-supplied identifiers (``table``,
``columns``) straight into raw SQL via f-strings. Today every
internal caller passes hardcoded literals, but the helpers are
importable from ``eden.decision._common`` and a future caller
could trivially smuggle SQL via a column list that came from
request input.

We added validation at each helper boundary, mirroring the pattern
already in ``eden.code_change._common._delete_then_insert``.

See FIXES_LOG F53.
"""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest


def test_delete_then_insert_rejects_sql_injection_in_table() -> None:
    """Injection in the ``table`` parameter raises ``ValueError``."""
    from eden.decision._common import _delete_then_insert

    with pytest.raises(ValueError, match="invalid SQL identifier"):
        asyncio.run(
            _delete_then_insert(
                org_id="00000000-0000-0000-0000-000000000001",
                trace_id="00000000-0000-0000-0000-000000000002",
                table="decision_scores; DROP TABLE x",
                columns=["score"],
                values=[1.0],
            )
        )


def test_delete_then_insert_rejects_sql_injection_in_columns() -> None:
    """Injection in any column name raises ``ValueError``."""
    from eden.decision._common import _delete_then_insert

    with pytest.raises(ValueError, match="invalid SQL identifier"):
        asyncio.run(
            _delete_then_insert(
                org_id="00000000-0000-0000-0000-000000000001",
                trace_id="00000000-0000-0000-0000-000000000002",
                table="decision_scores",
                columns=["score", "components_json; DROP TABLE x"],
                values=[1.0, "{}"],
            )
        )


def test_insert_rows_rejects_sql_injection_in_table() -> None:
    """Injection in the ``table`` parameter raises ``ValueError``."""
    from eden.decision._common import _insert_rows

    with pytest.raises(ValueError, match="invalid SQL identifier"):
        asyncio.run(
            _insert_rows(
                org_id="00000000-0000-0000-0000-000000000001",
                table="decision_paths; DROP TABLE x",
                rows=[(1, "x")],
                columns=["step", "value"],
            )
        )


def test_insert_rows_rejects_sql_injection_in_columns() -> None:
    """Injection in any column name raises ``ValueError``."""
    from eden.decision._common import _insert_rows

    with pytest.raises(ValueError, match="invalid SQL identifier"):
        asyncio.run(
            _insert_rows(
                org_id="00000000-0000-0000-0000-000000000001",
                table="decision_paths",
                rows=[(1, "x")],
                columns=["step; DROP TABLE x", "value"],
            )
        )


def test_delete_then_insert_accepts_legitimate_params_with_none_client() -> None:
    """Legitimate identifiers pass validation; the function exits early
    because no Postgres client is wired in the test environment.
    """
    from eden.decision._common import _delete_then_insert

    with patch(
        "eden.decision._common.get_postgres_client",
        return_value=None,
        create=True,
    ):
        # Should not raise ValueError. May hit AttributeError because
        # the helper exits before using the client.
        try:
            asyncio.run(
                _delete_then_insert(
                    org_id="00000000-0000-0000-0000-000000000001",
                    trace_id="00000000-0000-0000-0000-000000000002",
                    table="decision_scores",
                    columns=["score", "components_json"],
                    values=[1.0, "{}"],
                )
            )
        except ValueError as exc:
            pytest.fail(f"legitimate params rejected: {exc}")
        except Exception:
            # Expected — the helper tried to use the (None) client.
            pass
