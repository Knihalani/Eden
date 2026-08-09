"""FEAT-57 / FEAT-152 — canonical session-table pointer."""

from __future__ import annotations

from eden.sessions import CANONICAL_TABLE, TABLE_ROLES, is_canonical_session_table
from eden.sessions.canonical import CANONICAL_TABLE as _CANONICAL_FROM_MODULE


def test_canonical_table_is_session_summaries() -> None:
    assert CANONICAL_TABLE == "session_summaries"
    assert _CANONICAL_FROM_MODULE == CANONICAL_TABLE
    assert is_canonical_session_table("session_summaries")
    assert not is_canonical_session_table("agent_sessions")
    assert not is_canonical_session_table("user_sessions")


def test_table_roles_cover_all_three_session_tables() -> None:
    assert set(TABLE_ROLES) == {
        "session_summaries",
        "agent_sessions",
        "user_sessions",
    }
    for table in TABLE_ROLES:
        assert TABLE_ROLES[table].strip()
