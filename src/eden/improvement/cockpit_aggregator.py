"""Aggregate issues, closed-loop actions, and proposed patches into one queue.

N17 is a read model + UX over F46 / Cat 23 / F29 — it does not replace the
orchestrator. Failures from any source are swallowed so the cockpit still
returns partial results.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)

_SEVERITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3, "info": 4}

# Column keys for portal Automate /improve dual-pane.
COLUMN_URGENT = "urgent"
COLUMN_NEEDS_YOU = "needs_you"
COLUMN_AUTONOMOUS = "autonomous"
COLUMN_PROPOSED = "proposed"
COLUMN_VERIFY = "verify"


@dataclass
class ImprovementItem:
    """One card in the improvement cockpit."""

    ref: str
    item_type: str
    title: str
    column: str
    severity: str = "medium"
    agent_id: str | None = None
    status: str = "open"
    href: str | None = None
    payload: dict[str, Any] = field(default_factory=dict)
    autonomy_tier_required: str | None = None
    blocked_reason: str | None = None
    source: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class ImprovementQueue:
    items: list[ImprovementItem]
    refreshed_at: str
    counts_by_column: dict[str, int] = field(default_factory=dict)
    counts_by_type: dict[str, int] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "items": [i.to_dict() for i in self.items],
            "refreshed_at": self.refreshed_at,
            "counts_by_column": self.counts_by_column,
            "counts_by_type": self.counts_by_type,
            "count": len(self.items),
        }


# In-process snooze map (org_id, item_ref) → iso expiry. Best-effort;
# Redis-backed persistence is a follow-up.
_SNOOZES: dict[tuple[str, str], datetime] = {}


def snooze_item(org_id: str, item_ref: str, until: datetime) -> None:
    _SNOOZES[(org_id, item_ref)] = until


def is_snoozed(org_id: str, item_ref: str, *, now: datetime | None = None) -> bool:
    until = _SNOOZES.get((org_id, item_ref))
    if until is None:
        return False
    now = now or datetime.now(UTC)
    if until.tzinfo is None:
        until = until.replace(tzinfo=UTC)
    if until <= now:
        _SNOOZES.pop((org_id, item_ref), None)
        return False
    return True


class ImprovementCockpitAggregator:
    """Build the unified N17 queue for an org."""

    async def list_queue(
        self,
        org_id: str,
        agent_id: str | None = None,
        *,
        limit: int = 100,
    ) -> ImprovementQueue:
        issues_t, actions_t, patches_t, nudges_t, promotions_t = await asyncio.gather(
            self._from_issues(org_id, agent_id),
            self._from_closed_loop(org_id),
            self._from_proposed_patches(org_id, agent_id),
            self._from_nudges(org_id, agent_id),
            self._from_promotions(org_id),
            return_exceptions=True,
        )
        items: list[ImprovementItem] = []
        for result in (issues_t, actions_t, patches_t, nudges_t, promotions_t):
            if isinstance(result, BaseException):
                logger.debug("cockpit source failed: %s", result)
                continue
            items.extend(result)

        now = datetime.now(UTC)
        items = [i for i in items if not is_snoozed(org_id, i.ref, now=now)]
        items.sort(
            key=lambda i: (
                _SEVERITY_RANK.get(i.severity, 9),
                i.title.lower(),
            )
        )
        if limit > 0:
            items = items[:limit]

        by_col: dict[str, int] = {}
        by_type: dict[str, int] = {}
        for i in items:
            by_col[i.column] = by_col.get(i.column, 0) + 1
            by_type[i.item_type] = by_type.get(i.item_type, 0) + 1

        return ImprovementQueue(
            items=items,
            refreshed_at=now.isoformat(),
            counts_by_column=by_col,
            counts_by_type=by_type,
        )

    async def _from_issues(
        self, org_id: str, agent_id: str | None
    ) -> list[ImprovementItem]:
        try:
            from eden.issues.repo import IssuesRepo

            rows = await IssuesRepo().list_issues(
                org_id, status="open", limit=50
            )
        except Exception as exc:
            logger.debug("cockpit issues: %s", exc)
            return []
        out: list[ImprovementItem] = []
        for issue in rows:
            if agent_id and issue.agent_id and issue.agent_id != agent_id:
                continue
            sev = (issue.severity or "medium").lower()
            column = COLUMN_URGENT if sev in ("critical", "high") else COLUMN_NEEDS_YOU
            if issue.status in ("remediating", "healing"):
                column = COLUMN_AUTONOMOUS
            out.append(
                ImprovementItem(
                    ref=f"issue:{issue.id}",
                    item_type="issue_p0" if sev == "critical" else "issue",
                    title=issue.title or issue.fingerprint,
                    column=column,
                    severity=sev,
                    agent_id=issue.agent_id,
                    status=issue.status,
                    href=f"/issues/{issue.id}",
                    payload={
                        "issue_id": issue.id,
                        "fingerprint": issue.fingerprint,
                        "kind": issue.kind,
                        "stumble_count": issue.stumble_count,
                    },
                    source="issues",
                )
            )
        return out

    async def _from_closed_loop(self, org_id: str) -> list[ImprovementItem]:
        try:
            from eden.llmops.closed_loop_executor import ClosedLoopExecutor

            envelope = await ClosedLoopExecutor().list_pending(org_id, limit=50)
        except Exception as exc:
            logger.debug("cockpit closed-loop: %s", exc)
            return []
        data = envelope.get("data") if isinstance(envelope, dict) else None
        actions = (data or {}).get("actions") or []
        out: list[ImprovementItem] = []
        for row in actions:
            if not isinstance(row, dict):
                continue
            action_id = str(row.get("id") or row.get("action_id") or "")
            kind = str(row.get("action_kind") or row.get("hook_name") or "action")
            sev = str(row.get("severity") or "medium").lower()
            title = str(row.get("title") or kind)
            action_type = _infer_action_type(kind, row)
            blocked_reason, tier = await _autonomy_block_reason(
                org_id, action_type, row.get("agent_id")
            )
            column = COLUMN_PROPOSED
            if blocked_reason:
                column = COLUMN_NEEDS_YOU
            out.append(
                ImprovementItem(
                    ref=f"closed_loop:{action_id}",
                    item_type=_map_closed_loop_type(kind),
                    title=title,
                    column=column,
                    severity=sev,
                    agent_id=row.get("agent_id"),
                    status=str(row.get("status") or "pending_approval"),
                    href="/closed-loop",
                    payload={
                        "action_id": action_id,
                        "action_kind": kind,
                        "payload": row.get("payload") or {},
                        "action_type": action_type,
                    },
                    autonomy_tier_required=tier,
                    blocked_reason=blocked_reason,
                    source="closed_loop",
                )
            )
        return out

    async def _from_proposed_patches(
        self, org_id: str, agent_id: str | None
    ) -> list[ImprovementItem]:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return []
            rows = await client.fetch(
                """
                SELECT id, repo_id, trace_id, rca_id, description, status,
                       created_at
                FROM proposed_patches
                WHERE org_id = $1 AND status IN ('proposed', 'approved')
                ORDER BY created_at DESC
                LIMIT 50
                """,
                org_id,
            )
        except Exception as exc:
            logger.debug("cockpit patches: %s", exc)
            return []
        out: list[ImprovementItem] = []
        for r in rows or []:
            repo = r.get("repo_id")
            if agent_id and repo and repo != agent_id:
                continue
            pid = str(r["id"])
            desc = (r.get("description") or "Proposed patch")[:160]
            status = str(r.get("status") or "proposed")
            out.append(
                ImprovementItem(
                    ref=f"proposed_patch:{pid}",
                    item_type="proposed_patch",
                    title=desc,
                    column=COLUMN_NEEDS_YOU
                    if status == "proposed"
                    else COLUMN_VERIFY,
                    severity="medium",
                    agent_id=repo,
                    status=status,
                    href="/pr-suggestions",
                    payload={
                        "patch_id": pid,
                        "rca_id": r.get("rca_id"),
                        "trace_id": r.get("trace_id"),
                    },
                    source="proposed_patches",
                )
            )
        return out

    async def _from_nudges(
        self, org_id: str, agent_id: str | None
    ) -> list[ImprovementItem]:
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return []
            if agent_id:
                rows = await client.fetch(
                    """
                    SELECT id, agent_id, name, mode, source_issue_id
                    FROM nudges
                    WHERE org_id = $1 AND agent_id = $2 AND mode = 'shadow'
                    ORDER BY created_at DESC
                    LIMIT 50
                    """,
                    org_id,
                    agent_id,
                )
            else:
                rows = await client.fetch(
                    """
                    SELECT id, agent_id, name, mode, source_issue_id
                    FROM nudges
                    WHERE org_id = $1 AND mode = 'shadow'
                    ORDER BY created_at DESC
                    LIMIT 50
                    """,
                    org_id,
                )
        except Exception as exc:
            logger.debug("cockpit nudges: %s", exc)
            return []
        out: list[ImprovementItem] = []
        for r in rows or []:
            nid = str(r["id"])
            name = str(r.get("name") or "Shadow nudge")
            aid = r.get("agent_id")
            blocked_reason, tier = await _autonomy_block_reason(
                org_id, "nudge_shadow", aid
            )
            column = COLUMN_AUTONOMOUS if not blocked_reason else COLUMN_NEEDS_YOU
            href = (
                f"/issues/{r['source_issue_id']}"
                if r.get("source_issue_id")
                else "/settings"
            )
            out.append(
                ImprovementItem(
                    ref=f"nudge:{nid}",
                    item_type="nudge_shadow",
                    title=f"Shadow nudge: {name}",
                    column=column,
                    severity="medium",
                    agent_id=str(aid) if aid else None,
                    status="shadow",
                    href=href,
                    payload={"nudge_id": nid, "mode": r.get("mode")},
                    autonomy_tier_required=tier,
                    blocked_reason=blocked_reason,
                    source="nudges",
                )
            )
        return out

    async def _from_promotions(self, org_id: str) -> list[ImprovementItem]:
        try:
            from eden.promotion.evidence_gate import EvidenceGate

            candidates = await EvidenceGate().list_queue(
                org_id, status="pending", limit=50
            )
        except Exception as exc:
            logger.debug("cockpit promotions: %s", exc)
            return []
        out: list[ImprovementItem] = []
        for row in candidates:
            if not isinstance(row, dict):
                continue
            cid = str(row.get("id") or "")
            kind = str(row.get("kind") or "promotion")
            ref_id = str(row.get("ref_id") or "")
            item_type = (
                "guardrail_promote" if "guardrail" in kind else "promotion_candidate"
            )
            action_type = "guardrail_promote" if "guardrail" in kind else "nudge_promote"
            blocked_reason, tier = await _autonomy_block_reason(
                org_id, action_type, None
            )
            column = COLUMN_PROPOSED if not blocked_reason else COLUMN_NEEDS_YOU
            title = f"Promotion pending: {kind}"
            if ref_id:
                title = f"{title} ({ref_id[:12]})"
            out.append(
                ImprovementItem(
                    ref=f"promotion:{cid}",
                    item_type=item_type,
                    title=title,
                    column=column,
                    severity="medium",
                    status=str(row.get("status") or "pending"),
                    href="/closed-loop",
                    payload={"candidate_id": cid, "kind": kind, "ref_id": ref_id},
                    autonomy_tier_required=tier,
                    blocked_reason=blocked_reason,
                    source="promotions",
                )
            )
        return out


def _map_closed_loop_type(kind: str) -> str:
    k = kind.lower()
    if "heal" in k or "rollback" in k or "reweight" in k or "cache" in k:
        return "self_heal"
    if "nudge" in k:
        return "nudge_shadow"
    if "guardrail" in k:
        return "guardrail_promote"
    if "canary" in k or "prompt" in k:
        return "prompt_canary"
    if "patch" in k or k.startswith("pr_") or k.endswith("_pr"):
        return "proposed_patch"
    return "closed_loop_action"


def _infer_action_type(kind: str, row: dict[str, Any]) -> str:
    payload = row.get("payload") or {}
    if isinstance(payload, dict):
        for key in ("action_type", "heal_action", "type"):
            val = payload.get(key)
            if val:
                return str(val)
    k = kind.lower()
    if "cache" in k:
        return "cache_bust"
    if "rollback" in k:
        return "rollback"
    if "reweight" in k:
        return "reweight"
    if "patch" in k or k.startswith("pr_") or k.endswith("_pr"):
        return "propose_patch"
    return "self_heal"


async def _autonomy_block_reason(
    org_id: str, action_type: str, agent_id: Any
) -> tuple[str | None, str | None]:
    try:
        from eden.closed_loop.autonomy_policy import why_blocked

        return await why_blocked(
            org_id, action_type, agent_id=str(agent_id) if agent_id else None
        )
    except Exception as exc:
        logger.debug("cockpit autonomy block reason: %s", exc)
        return None, None
