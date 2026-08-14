"""Canonical session-table pointer (FEAT-152 / FEAT-57).

Eden has three tables named "session": ``session_summaries``,
``agent_sessions``, and ``user_sessions``. They are not interchangeable —
see ``docs/specs/strategic-review-2026-08/session-model.md`` for the full
writeup (FEAT-152 decision). This module is a small, dependency-free
surface that names the canonical choice in code, so a future consumer can
check it instead of re-deriving "which session table do I want" from
scratch.

Use :data:`CANONICAL_TABLE` (and :func:`list_sessions` /
:func:`get_session_timeline`, re-exported from :mod:`eden.sessions`) for
anything answering "how did this session go" at the product-metrics
layer — cost, tokens, turn count, outcome, stumbles, issues, retention,
funnels. Do not query ``agent_sessions`` or ``user_sessions`` for that
question; see :data:`TABLE_ROLES` for what each table is actually for.
"""

from __future__ import annotations

from typing import Final

#: The read model for session/turn product metrics. Backed by
#: ``eden.sessions.rollup.SessionRollupIndexer``.
CANONICAL_TABLE: Final[str] = "session_summaries"

#: One-line role for each of the three "session" tables, keyed by table
#: name. Intentionally terse — see the session-model doc for the full
#: relationship/join-key writeup.
TABLE_ROLES: Final[dict[str, str]] = {
    "session_summaries": (
        "Canonical read model for product/session metrics — rolled up "
        "from telemetry_events + agent_stumbles per trace.finalized. "
        "helped is a derived ExtraWorkEvent rollup — not outcome."
    ),
    "agent_sessions": (
        "Ingest-side lifecycle record for one SDK-driven agent run "
        "(F23 session.begin()/complete_session()). Not an aggregate "
        "read model — read session_summaries for turn/cost/outcome "
        "metrics even for sessions that originated here."
    ),
    "user_sessions": (
        "Cat-9 user-intelligence behavioral-analytics identity "
        "(active/dormant/returned, abandonment rate). A different "
        "notion of session (app/site visit), not agent-run data."
    ),
}


def is_canonical_session_table(table_name: str) -> bool:
    """True if ``table_name`` is the canonical product-metrics session table."""
    return table_name == CANONICAL_TABLE


__all__ = [
    "CANONICAL_TABLE",
    "TABLE_ROLES",
    "is_canonical_session_table",
]
