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

HELP_MISS_KIND = "help_miss"

_EXAMPLE_CAP = 20
_USER_CAP = 10_000


_SEVERITY_LADDER: tuple[str, ...] = ("p0", "p1", "p2", "p3")


def _more_severe(a: str, b: str) -> str:
    # p0 < p1 < p2 < p3 lexicographically → min == most severe.
    return min(a, b)


def _severity_index(severity: str) -> int:
    try:
        return _SEVERITY_LADDER.index(severity)
    except ValueError:
        return 2  # unknown → treat as p2


def _bump_severity(severity: str, levels: int) -> str:
    """Move ``levels`` steps toward p0 (more severe). Never past p0."""
    if levels <= 0:
        return severity
    idx = max(0, _severity_index(severity) - levels)
    return _SEVERITY_LADDER[idx]


def _severity_from_blast_radius(
    base: str,
    *,
    user_count: int,
    stumble_count: int,
    repetition_count: int,
) -> str:
    """Escalate kind/default severity when blast-radius counters grow.

    Ladder (tiers stack — tier 2 also satisfies tier 1):
    - +1 level: ``user_count >= 10`` OR ``stumble_count >= 20``
    - +1 more: ``user_count >= 50`` OR ``stumble_count >= 100`` OR
      ``repetition_count >= 5``
    """
    bumps = 0
    if user_count >= 10 or stumble_count >= 20:
        bumps += 1
    if user_count >= 50 or stumble_count >= 100 or repetition_count >= 5:
        bumps += 1
    return _bump_severity(base, bumps)


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

        stumble_count = int(existing["stumble_count"]) + 1
        user_count = max(int(existing["user_count"]), len(affected))
        escalated = _severity_from_blast_radius(
            severity,
            user_count=user_count,
            stumble_count=stumble_count,
            repetition_count=repetition,
        )
        new_severity = _more_severe(existing["severity"], escalated)

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
            user_count,
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
            stumble_count=stumble_count,
            user_count=user_count,
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

    async def upsert_help_miss(
        self,
        org_id: str,
        *,
        agent_id: str,
        fingerprint: str,
        reason: str,
        help_contract_id: str | None = None,
        session_id: str | None = None,
        user_id: str | None = None,
        snippet: str | None = None,
        path: str = "ambient",
        title: str | None = None,
    ) -> Issue | None:
        """Upsert agent_issues kind=help_miss. No agent_stumbles row."""
        client = await self._repo._client()
        if client is None:
            return None
        title = title or f"{agent_id} didn\u2019t help ({reason})"
        severity = "p1"
        issue: Issue | None = None
        try:
            async with client.acquire() as conn, conn.transaction():
                row = await conn.fetchrow(
                    "SELECT * FROM agent_issues "
                    "WHERE org_id = $1 AND fingerprint = $2 FOR UPDATE",
                    org_id,
                    fingerprint,
                )
                if row is None:
                    issue = await self._insert_help_miss(
                        conn,
                        org_id=org_id,
                        agent_id=agent_id,
                        fingerprint=fingerprint,
                        title=title,
                        severity=severity,
                        user_id=user_id,
                    )
                else:
                    issue = await self._update_help_miss(
                        conn, dict(row), user_id=user_id, severity=severity
                    )
        except Exception as exc:
            logger.warning("issue_promoter: help_miss upsert failed: %s", exc)
            return None

        if issue is None:
            return None
        proposed: dict[str, Any] | None = None
        if issue.was_created or issue.was_regressed:
            proposed = await self._propose_help_miss_plan(
                issue,
                reason=reason,
                help_contract_id=help_contract_id,
                snippet=snippet,
                session_id=session_id,
            )
        if issue.was_created and proposed and proposed.get("status") == "drafted":
            await self._notify_help_miss(
                issue,
                reason=reason,
                session_id=session_id,
                snippet=snippet,
                path=path,
                help_contract_id=help_contract_id,
                proposed=proposed,
            )
        return issue

    async def _insert_help_miss(
        self,
        conn: Any,
        *,
        org_id: str,
        agent_id: str,
        fingerprint: str,
        title: str,
        severity: str,
        user_id: str | None,
    ) -> Issue:
        iid = str(uuid.uuid4())
        affected = [user_id] if user_id else []
        await conn.execute(
            """
            INSERT INTO agent_issues
                (id, org_id, fingerprint, kind, title, status, severity,
                 agent_id, stumble_count, user_count, repetition_count,
                 affected_user_ids, example_stumble_ids)
            VALUES ($1::uuid, $2, $3, $4, $5, 'open', $6, $7, 1, $8, 1,
                    $9::text[], '{}'::uuid[])
            """,
            iid,
            org_id,
            fingerprint,
            HELP_MISS_KIND,
            title,
            severity,
            agent_id,
            max(1, len(affected)),
            affected,
        )
        return Issue(
            id=iid,
            org_id=org_id,
            fingerprint=fingerprint,
            kind=HELP_MISS_KIND,
            title=title,
            status="open",
            severity=severity,  # type: ignore[arg-type]
            stumble_count=1,
            user_count=max(1, len(affected)),
            agent_id=agent_id,
            affected_user_ids=affected,
            example_stumble_ids=[],
            was_created=True,
        )

    async def _update_help_miss(
        self,
        conn: Any,
        existing: dict[str, Any],
        *,
        user_id: str | None,
        severity: str,
    ) -> Issue:
        status = existing["status"]
        repetition = int(existing["repetition_count"])
        was_regressed = False
        if status in ("resolved", "ignored"):
            status = "regressed"
            was_regressed = True
            repetition += 1

        affected = list(existing["affected_user_ids"] or [])
        if user_id and user_id not in affected and len(affected) < _USER_CAP:
            affected.append(user_id)

        stumble_count = int(existing["stumble_count"]) + 1
        user_count = max(int(existing["user_count"]), len(affected) or 1)
        escalated = _severity_from_blast_radius(
            severity,
            user_count=user_count,
            stumble_count=stumble_count,
            repetition_count=repetition,
        )
        new_severity = _more_severe(existing["severity"], escalated)
        examples = [str(x) for x in (existing["example_stumble_ids"] or [])]

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
                updated_at = NOW()
            WHERE org_id = $1 AND id = $2::uuid
            """,
            existing["org_id"],
            str(existing["id"]),
            status,
            repetition,
            new_severity,
            user_count,
            affected,
        )
        return Issue(
            id=str(existing["id"]),
            org_id=existing["org_id"],
            fingerprint=existing["fingerprint"],
            kind=existing.get("kind") or HELP_MISS_KIND,
            title=existing["title"],
            status=status,
            severity=new_severity,  # type: ignore[arg-type]
            stumble_count=stumble_count,
            user_count=user_count,
            repetition_count=repetition,
            agent_id=existing.get("agent_id"),
            affected_user_ids=affected,
            example_stumble_ids=examples,
            was_created=False,
            was_regressed=was_regressed,
        )

    async def _notify_help_miss(
        self,
        issue: Issue,
        *,
        reason: str,
        session_id: str | None,
        snippet: str | None,
        path: str,
        help_contract_id: str | None,
        proposed: dict[str, Any] | None = None,
    ) -> None:
        try:
            from eden.integrations.slack import store as slack_store
            from eden.services.slack_notify import notify_help_miss

            person = {
                "took_over": "still did X",
                "rewrote": "rewrote it",
                "ticket_still_open": "ticket still open",
                "thumbs_down": "said it didn\u2019t help",
            }.get(reason, "still did X")
            sentence = ""
            try:
                contract = await slack_store.get_current_help_contract(
                    issue.org_id, issue.agent_id or ""
                )
                if isinstance(contract, dict):
                    sentence = str(contract.get("sentence") or "")
            except Exception:
                sentence = ""
            leftovers = (proposed or {}).get("leftovers") or []
            instruction = str((proposed or {}).get("instruction") or "")
            plan_id = str((proposed or {}).get("plan_id") or "") or None
            await notify_help_miss(
                issue.org_id,
                agent_id=issue.agent_id or "",
                fingerprint=issue.fingerprint,
                sentence=sentence,
                path=path,
                person=person,
                snippet=snippet or "",
                leftovers=leftovers if isinstance(leftovers, list) else [],
                instruction=instruction,
                plan_id=plan_id,
                session_id=session_id,
            )
        except Exception as exc:
            logger.debug("issue_promoter: notify_help_miss failed: %s", exc)

    async def _propose_help_miss_plan(
        self,
        issue: Issue,
        *,
        reason: str,
        help_contract_id: str | None,
        snippet: str | None = None,
        session_id: str | None = None,
    ) -> dict[str, Any] | None:
        try:
            from eden.improvement.issue_patch_trigger import (
                propose_prompt_canary_for_help_miss,
            )

            return await propose_prompt_canary_for_help_miss(
                issue.org_id,
                issue,
                reason=reason,
                help_contract_id=help_contract_id,
                snippet=snippet,
                session_id=session_id,
            )
        except Exception as exc:
            logger.debug("issue_promoter: help_miss plan failed: %s", exc)
            return None


def _as_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


async def promote_from_extra_work(event: dict[str, Any]) -> Issue | None:
    """ExtraWorkEvent hit → HelpMiss. Does not write agent_stumbles."""
    from eden.issues.fingerprint import (
        compute_help_miss_fingerprint,
        help_miss_reason_for_kind,
    )

    polarity = str(event.get("polarity") or "")
    confidence = str(event.get("confidence") or "")
    if polarity != "extra_work" or confidence not in {"high", "medium"}:
        return None
    reason = help_miss_reason_for_kind(event.get("kind"))
    if not reason:
        return None
    org_id = _as_str(event.get("org_id"))
    agent_id = _as_str(event.get("agent_id"))
    if not org_id or not agent_id:
        return None
    help_contract_id = _as_str(event.get("help_contract_id"))
    fingerprint = compute_help_miss_fingerprint(
        org_id, agent_id, help_contract_id, reason
    )
    return await IssuePromoter().upsert_help_miss(
        org_id,
        agent_id=agent_id,
        fingerprint=fingerprint,
        reason=reason,
        help_contract_id=help_contract_id,
        session_id=_as_str(event.get("session_id")),
        user_id=_as_str(event.get("user_id")),
        snippet=_as_str(event.get("snippet")),
        path=_as_str(event.get("path")) or "ambient",
    )

