"""Request-scoped PG connection binding for FORCE RLS."""

from __future__ import annotations

from unittest.mock import MagicMock

from eden.storage.postgres import (
    bind_request_pg_conn,
    get_bound_request_pg_conn,
    reset_request_pg_conn,
)


def test_bind_request_pg_conn_round_trip():
    assert get_bound_request_pg_conn() is None
    fake = MagicMock(name="pg_conn")
    token = bind_request_pg_conn(fake)
    try:
        assert get_bound_request_pg_conn() is fake
    finally:
        reset_request_pg_conn(token)
    assert get_bound_request_pg_conn() is None
