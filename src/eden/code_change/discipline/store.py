"""Discipline store — persist decisions + outcomes.

The discipline layer is intentionally lightweight on
storage: it persists only what it needs to enforce
dedupe + circuit-breaker state across restarts. The
full audit trail (who triggered what, with what
evidence, when) lives in the existing Cat 23 surfaces
(``proposed_patches``, ``pull_requests``, ``pr_activity``).

This module centralises the writes so callers (the
incident + scheduled triggers) call a single
``record_outcome`` instead of touching each store
directly.

Outcomes recorded:

* ``"allowed"`` — the gate cleared and a PR was opened.
* ``"denied"`` — the gate denied the decision; no PR.
* ``"report_only"`` — the gate denied and a report was
  produced for the user instead of a PR.
* ``"merged"`` — the PR landed (dedupe fingerprint
  suppresses future re-fires).
* ``"reverted"`` — the PR was reverted (same).
* ``"breaker_open"`` — the breaker denied the request.
* ``"rate_limited"`` — the rate limiter denied the request.
* ``"duplicate"`` — the dedupe index said the fingerprint
  was seen recently.

Each call writes one row to ``pr_decision_audit`` and
appends to the dedupe index.
"""

from __future__ import annotations

import logging
import re

logger = logging.getLogger(__name__)


_IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def _validate_table(table: str) -> None:
    if not isinstance(table, str) or not _IDENT.match(table):
        raise ValueError(
            f"discipline.store: invalid SQL identifier table={table!r}"
        )


_AUDIT_TABLE_DEFAULT = "pr_decision_audit"
_DEDUPE_TABLE_DEFAULT = "pr_dedupe_index"


async def record_outcome(
    org_id: str,
    *,
    fingerprint: str,
    trigger_kind: str,
    outcome: str,
    score: float = 0.0,
    reasons: list[str] | None = None,
    repo_id: str = "",
    audit_table: str = _AUDIT_TABLE_DEFAULT,
    dedupe_table: str = _DEDUPE_TABLE_DEFAULT,
) -> bool:
    """Persist a discipline outcome.

    Writes:

    1. one row to ``audit_table`` with the full decision
       context (org, fingerprint, trigger_kind, outcome,
       score, reasons, repo_id).
    2. one row to ``dedupe_table`` (via the index's
       :meth:`DedupeIndex.record`) with the outcome.

    Both writes are best-effort. The function returns
    ``True`` only if the audit write succeeded; the
    dedupe write is silent on failure because it doesn't
    affect correctness of the current decision.

    The function is intentionally tolerant of missing
    tables: a fresh deploy without the discipline
    migration should still let the rest of the
    pipeline run. The DB error is logged at debug.
    """
    _validate_table(audit_table)
    _validate_table(dedupe_table)
    if not org_id or not fingerprint or not outcome:
        return False
    try:
        from eden.storage.postgres import get_postgres_client
        client = await get_postgres_client()
        if client is None:
            return False
        async with client.acquire() as conn:
            await conn.execute(
                f"INSERT INTO {audit_table} "
                f"(org_id, fingerprint, trigger_kind, outcome, score, "
                f"reasons, repo_id) "
                f"VALUES ($1, $2, $3, $4, $5, $6, $7)",
                org_id,
                fingerprint,
                trigger_kind,
                outcome,
                float(score),
                list(reasons or []),
                repo_id,
            )
        # Append to the dedupe index (best-effort, separate
        # try/except so the audit-write success isn't masked).
        try:
            from .dedupe import DedupeIndex
            index = DedupeIndex(table=dedupe_table)
            await index.record(org_id, fingerprint, outcome=outcome)
        except Exception as exc:
            logger.debug(
                "discipline.store: dedupe record failed (non-fatal): %s",
                exc,
            )
        return True
    except Exception as exc:
        logger.debug(
            "discipline.store.record_outcome(%s/%s): %s",
            org_id,
            outcome,
            exc,
        )
        return False
