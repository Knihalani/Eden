"""N12 — session multi-turn timeline backend.

``rollup``   — ``SessionRollupIndexer``: incremental, idempotent upsert of
               ``session_summaries`` when a trace finalizes (hooked into
               the ``trace.finalized`` consumer).
``timeline`` — read side for the API: session list, ordered turn
               timeline, and issue linking.
"""

from eden.sessions.rollup import SessionRollupIndexer
from eden.sessions.timeline import (
    SessionNotFoundError,
    get_session_timeline,
    link_issue,
    list_sessions,
)

__all__ = [
    "SessionNotFoundError",
    "SessionRollupIndexer",
    "get_session_timeline",
    "link_issue",
    "list_sessions",
]
