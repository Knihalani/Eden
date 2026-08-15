"""N12 — session multi-turn timeline backend.

``rollup``    — ``SessionRollupIndexer``: incremental, idempotent upsert of
                ``session_summaries`` when a trace finalizes (hooked into
                the ``trace.finalized`` consumer).
``timeline``  — read side for the API: session list, ordered turn
                timeline, and issue linking.
``canonical`` — FEAT-152 / FEAT-57 table-role pointer: three "session"
                tables exist; use :data:`CANONICAL_TABLE` (``session_summaries``)
                for product-metrics reads. See
                ``docs/specs/strategic-review-2026-08/session-model.md``.
"""

from eden.sessions.canonical import (
    CANONICAL_TABLE,
    TABLE_ROLES,
    is_canonical_session_table,
)
from eden.sessions.rollup import SessionRollupIndexer
from eden.sessions.timeline import (
    SessionNotFoundError,
    get_session_timeline,
    link_issue,
    list_sessions,
)

__all__ = [
    "CANONICAL_TABLE",
    "TABLE_ROLES",
    "SessionNotFoundError",
    "SessionRollupIndexer",
    "get_session_timeline",
    "is_canonical_session_table",
    "link_issue",
    "list_sessions",
]
