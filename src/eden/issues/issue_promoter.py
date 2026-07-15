"""IssuePromoter — promote a stumble into a grouped issue (F29).

On each new stumble the promoter upserts the issue keyed by
``(org_id, fingerprint)`` inside a ``SELECT ... FOR UPDATE`` transaction:

* **new fingerprint** → insert an ``open`` issue (``was_created``).
* **existing** → bump ``stumble_count`` / ``last_seen`` / ``user_count``,
  append the stumble id (cap 20), and keep the most-severe severity.
* **existing but resolved/ignored** → flip to ``regressed`` and bump
  ``repetition_count`` (``was_regressed``).

On create or regression it fires the ``on_issue_created`` closed-loop
hook (best-effort) so F47 alerts + F30 triage + the F46 orchestrator can
pick it up.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from eden.issues.models import Issue, StumbleCreate
from eden.issues.repo import IssuesRepo

logger = logging.getLogger(__name__)

_EXAMPLE_CAP = 20
_USER_CAP = 10_000


def _more_severe(a: str, b: str) -> str:
    # p0 < p1 < p2 < p3 lexicographically → min == most severe.
    return min(a, b)


class IssuePromoter:
    def __init__(self, repo: IssuesRepo | None = None) -> None:
        self._repo = repo or IssuesRepo()

    async def upsert(
        self, sc: StumbleCreate, fingerprint: str, stumble_id: str
    ) -> Issue | None:
        client = await self._repo._client()
        if client is None:
            return None
        severity = sc.resolved_severity()
        issue: Issue | None = None
        try:
            async with client.acquire() as conn, conn.transaction():
                row = await conn.fetchrow(
                    "SELECT * FROM agent_issues "
                    "WHERE org_id = $1 AND fingerprint = $2 FOR UPDATE",
                    sc.org_id,
                    fingerprint,
                )
                if row is None:
                    issue = await self._insert(conn, sc, fingerprint, stumble_id, severity)
                else:
                    issue = await self._update(conn, dict(row), sc, stumble_id, severity)
        except Exception as exc:
            logger.warning("issue_promoter: upsert failed: %s", exc)
            return None

        if issue is not None and (issue.was_created or issue.was_regressed):
            await self._fire_issue_created(issue)
        return issue

    async def _insert(
        self,
        conn: Any,
        sc: StumbleCreate,
        fingerprint: str,
        stumble_id: str,
        severity: str,
    ) -> Issue:
        iid = str(uuid.uuid4())
        affected = [sc.user_id] if sc.user_id else []
        await conn.execute(
            """
            INSERT INTO agent_issues
                (id, org_id, fingerprint, kind, title, status, severity,
                 agent_id, stumble_count, user_count, repetition_count,
                 affected_user_ids, example_stumble_ids)
            VALUES ($1::uuid, $2, $3, $4, $5, 'open', $6, $7, 1, $8, 1,
                    $9::text[], ARRAY[$10]::uuid[])
            """,
            iid,
            sc.org_id,
            fingerprint,
            sc.kind,
            sc.title,
            severity,
            sc.agent_id,
            max(1, len(affected)),
            affected,
            stumble_id,
        )
        return Issue(
            id=iid,
            org_id=sc.org_id,
            fingerprint=fingerprint,
            kind=sc.kind,
            title=sc.title,
            status="open",
            severity=severity,  # type: ignore[arg-type]
            stumble_count=1,
            user_count=max(1, len(affected)),
            agent_id=sc.agent_id,
            affected_user_ids=affected,
            example_stumble_ids=[stumble_id],
            was_created=True,
        )

    async def _update(
        self,
        conn: Any,
        existing: dict[str, Any],
        sc: StumbleCreate,
        stumble_id: str,
        severity: str,
    ) -> Issue:
        status = existing["status"]
        repetition = int(existing["repetition_count"])
        was_regressed = False
        if status in ("resolved", "ignored"):
            status = "regressed"
            was_regressed = True
            repetition += 1

        examples = [str(x) for x in (existing["example_stumble_ids"] or [])]
        if stumble_id not in examples and len(examples) < _EXAMPLE_CAP:
            examples.append(stumble_id)

        affected = list(existing["affected_user_ids"] or [])
        if sc.user_id and sc.user_id not in affected and len(affected) < _USER_CAP:
            affected.append(sc.user_id)

        new_severity = _more_severe(existing["severity"], severity)

        await conn.execute(
            """
            UPDATE agent_issues
            SET stumble_count = stumble_count + 1,
                last_seen = NOW(),
                status = $3,
                repetition_count = $4,
                severity = $5,
                user_count = $6,
                affected_user_ids = $7::text[],
                example_stumble_ids = $8::uuid[],
                updated_at = NOW()
            WHERE org_id = $1 AND id = $2::uuid
            """,
            sc.org_id,
            str(existing["id"]),
            status,
            repetition,
            new_severity,
            max(int(existing["user_count"]), len(affected)),
            affected,
            examples,
        )
        return Issue(
            id=str(existing["id"]),
            org_id=sc.org_id,
            fingerprint=existing["fingerprint"],
            kind=existing["kind"],
            title=existing["title"],
            status=status,
            severity=new_severity,  # type: ignore[arg-type]
            stumble_count=int(existing["stumble_count"]) + 1,
            user_count=max(int(existing["user_count"]), len(affected)),
            repetition_count=repetition,
            agent_id=existing.get("agent_id"),
            affected_user_ids=affected,
            example_stumble_ids=examples,
            was_created=False,
            was_regressed=was_regressed,
        )

    async def _fire_issue_created(self, issue: Issue) -> None:
        try:
            from eden.llmops.promotion_hooks import get_issue_hook

            await get_issue_hook().on_issue_created(
                issue.org_id,
                issue_id=issue.id,
                fingerprint=issue.fingerprint,
                kind=issue.kind,
                severity=issue.severity,
                title=issue.title,
                regressed=issue.was_regressed,
                user_count=issue.user_count,
                stumble_count=issue.stumble_count,
            )
        except Exception as exc:  # pragma: no cover - hook optional
            logger.debug("issue_promoter: on_issue_created failed: %s", exc)
