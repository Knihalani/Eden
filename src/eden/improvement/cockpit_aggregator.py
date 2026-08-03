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
# M13 (§6.2): split Needs-you into Fix now / Improve later.
COLUMN_FIX_NOW = "fix_now"
COLUMN_IMPROVE_LATER = "improve_later"
COLUMN_AUTONOMOUS = "autonomous"
COLUMN_PROPOSED = "proposed"
COLUMN_VERIFY = "verify"

_FIX_NOW_KINDS = frozenset({"code_patch", "prompt_update"})
_IMPROVE_LATER_KINDS = frozenset(
    {"advisory", "config_change", "nudge_promote", "guardrail_tune", "cost_digest"}
)


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
        (
            issues_t,
            actions_t,
            patches_t,
            nudges_t,
            promotions_t,
            artifacts_t,
            ledger_t,
            evolution_t,
            heals_t,
            denials_t,
            loop_health_t,
        ) = await asyncio.gather(
            self._from_issues(org_id, agent_id),
            self._from_closed_loop(org_id),
            self._from_improvement_plans(org_id, agent_id),
            self._from_nudges(org_id, agent_id),
            self._from_promotions(org_id),
            self._from_artifacts_pending(org_id, agent_id),
            self._from_ledger_stale(org_id, agent_id),
            self._from_evolution_canaries(org_id, agent_id),
            self._from_self_heals(org_id),
            self._from_autonomy_denials(org_id, agent_id),
            self._from_loop_health(org_id),
            return_exceptions=True,
        )
        items: list[ImprovementItem] = []
        for result in (
            issues_t,
            actions_t,
            patches_t,
            nudges_t,
            promotions_t,
            artifacts_t,
            ledger_t,
            evolution_t,
            heals_t,
            denials_t,
            loop_health_t,
        ):
            if isinstance(result, BaseException):
                logger.debug("cockpit source failed: %s", result)
                continue
            items.extend(result)

        now = datetime.now(UTC)
        items = [i for i in items if not is_snoozed(org_id, i.ref, now=now)]
        fleet_sev = await self._fleet_severity_map(org_id)
        items.sort(
            key=lambda i: (
                _SEVERITY_RANK.get(i.severity, 9),
                -fleet_sev.get(i.agent_id or "", 0.0),
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

    async def _fleet_severity_map(self, org_id: str) -> dict[str, float]:
        """N05 severity ranking for N17 queue ordering."""
        try:
            from eden.fleet.service import FleetHealthService

            summary = await FleetHealthService().summary(org_id)
            return {
                str(a.get("agent_id")): float(a.get("severity_score") or 0)
                for a in summary.get("agents") or []
                if a.get("agent_id")
            }
        except Exception as exc:
            logger.debug("cockpit fleet severity: %s", exc)
            return {}

    async def _from_loop_health(self, org_id: str) -> list[ImprovementItem]:
        """URGENT banner when the closed-loop event bus is unreachable (M2).

        Best-effort like every other source — a probe failure yields no
        item rather than breaking the cockpit.
        """
        try:
            from eden.api.routes.loop_health import probe_loop_health

            health = await probe_loop_health()
            if health.get("bus") != "dead":
                return []
            return [
                ImprovementItem(
                    ref="loop_health:bus",
                    item_type="loop_health",
                    title="Autonomy paused — event bus unreachable",
                    column=COLUMN_URGENT,
                    severity="critical",
                    payload={
                        "bus": health.get("bus"),
                        "outbox_depth": health.get("outbox_depth"),
                        "last_publish_failure_age_s": health.get(
                            "last_publish_failure_age_s"
                        ),
                    },
                    source="loop_health",
                )
            ]
        except Exception as exc:
            logger.debug("cockpit loop-health source failed: %s", exc)
            return []

    async def _from_issues(self, org_id: str, agent_id: str | None) -> list[ImprovementItem]:
        try:
            from eden.issues.repo import IssuesRepo

            rows = await IssuesRepo().list_issues(org_id, status="open", limit=50)
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

    async def _from_self_heals(self, org_id: str) -> list[ImprovementItem]:
        """N21/W24 — surface recent auto-heal executions in Improve."""
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return []
            rows = await client.fetch(
                """
                SELECT id, action_type, status, before_state_json,
                       after_state_json, created_at
                FROM self_heal_actions
                WHERE org_id = $1
                  AND created_at > NOW() - INTERVAL '7 days'
                ORDER BY created_at DESC
                LIMIT 40
                """,
                org_id,
            )
        except Exception as exc:
            logger.debug("cockpit self_heals: %s", exc)
            return []
        out: list[ImprovementItem] = []
        for r in rows or []:
            if not isinstance(r, dict) and hasattr(r, "keys"):
                r = dict(r)
            aid = str(r.get("id") or "")
            action_type = str(r.get("action_type") or "self_heal")
            status = str(r.get("status") or "pending")
            column = COLUMN_AUTONOMOUS
            if status in ("pending_approval", "approved", "denied", "failed"):
                column = COLUMN_NEEDS_YOU
            elif status == "executed":
                column = COLUMN_VERIFY
            blocked = None
            if status == "denied":
                blocked = "Heal denied"
            elif status == "failed":
                blocked = "Heal execution failed"
            elif status == "pending_approval":
                blocked = "Awaiting human approval"
            out.append(
                ImprovementItem(
                    ref=f"self_heal:{aid}",
                    item_type="auto_heal",
                    title=f"Auto-heal: {action_type}",
                    column=column,
                    severity="high" if status == "failed" else "medium",
                    status=status,
                    href="/improve",
                    payload={
                        "action_id": aid,
                        "action_type": action_type,
                        "status": status,
                    },
                    blocked_reason=blocked,
                    source="self_heal",
                )
            )
        return out

    async def _from_autonomy_denials(
        self, org_id: str, agent_id: str | None
    ) -> list[ImprovementItem]:
        """N22/W24 — policy denials visible in Improve cockpit."""
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return []
            rows = await client.fetch(
                """
                SELECT id, agent_id, action, tier_applied, decision,
                       reason, created_at
                FROM autonomy_audit_log
                WHERE org_id = $1
                  AND decision IN ('deny', 'require_approval')
                  AND action NOT IN ('policy_update', 'alert', 'recommend')
                  AND created_at > NOW() - INTERVAL '7 days'
                ORDER BY created_at DESC
                LIMIT 40
                """,
                org_id,
            )
        except Exception as exc:
            logger.debug("cockpit autonomy denials: %s", exc)
            return []
        out: list[ImprovementItem] = []
        for r in rows or []:
            if not isinstance(r, dict) and hasattr(r, "keys"):
                r = dict(r)
            row_agent = r.get("agent_id")
            if agent_id and row_agent and str(row_agent) != agent_id:
                continue
            eid = str(r.get("id") or "")
            action = str(r.get("action") or "action")
            decision = str(r.get("decision") or "deny")
            reason = str(r.get("reason") or f"policy {decision}")
            tier = str(r.get("tier_applied") or "")
            # M10 (§5.2): heal denials become opt-in counterfactuals.
            if tier == "auto_runtime_heal":
                title = f"Eden would have fixed this: {action}"
            else:
                title = f"Policy {decision}: {action}"
            out.append(
                ImprovementItem(
                    ref=f"autonomy_denial:{eid}",
                    item_type="policy_denial",
                    title=title,
                    column=COLUMN_NEEDS_YOU,
                    severity="medium",
                    agent_id=str(row_agent) if row_agent else None,
                    status=decision,
                    href="/settings?tab=autonomous",
                    payload={
                        "audit_id": eid,
                        "action": action,
                        "decision": decision,
                        "tier": r.get("tier_applied"),
                    },
                    autonomy_tier_required=tier or None,
                    blocked_reason=reason[:240],
                    source="autonomy_audit",
                )
            )
        return out

    async def _from_improvement_plans(
        self, org_id: str, agent_id: str | None
    ) -> list[ImprovementItem]:
        try:
            from eden.improvement import plans_repo

            rows = await plans_repo.list_plans(
                org_id,
                status=None,
                agent_id=agent_id,
                limit=50,
            )
        except Exception as exc:
            logger.debug("cockpit improvement_plans: %s", exc)
            return []
        out: list[ImprovementItem] = []
        stale_days = 14
        try:
            from eden.config import get_settings

            stale_days = int(getattr(get_settings(), "plan_stale_after_days", 14) or 14)
        except Exception:
            pass
        for r in rows:
            status = str(r.get("status") or "draft")
            if status in ("rejected", "snoozed", "superseded", "merged", "closed"):
                continue
            pid = str(r["id"])
            title = (r.get("title") or "Improvement plan")[:160]
            plan_kind = str(r.get("plan_kind") or "")
            evidence = r.get("evidence") or {}
            if isinstance(evidence, str):
                try:
                    import json as _json

                    evidence = _json.loads(evidence)
                except Exception:
                    evidence = {}
            column = COLUMN_PROPOSED
            if status == "pr_opened":
                column = COLUMN_VERIFY
            elif status in ("draft", "pending_review"):
                # M13 (§6.2): Fix now vs Improve later (draft + pending_review).
                column = _queue_column_for_plan(plan_kind, evidence)
            payload: dict[str, Any] = {
                "plan_id": pid,
                "plan_kind": plan_kind,
                "source_ref": r.get("source_ref"),
                "base_ref_sha": evidence.get("base_ref_sha"),
                "ev_score": evidence.get("ev_score"),
            }
            # M13 (§6.6): stale badge when draft older than plan_stale_after_days.
            if status == "draft" and _plan_is_stale(r, stale_days):
                payload["stale"] = True
                payload["stale_after_days"] = stale_days
            out.append(
                ImprovementItem(
                    ref=f"improvement_plan:{pid}",
                    # N23 inbox — never label as Cat 23 proposed_patch (breaks approve wiring).
                    item_type="improvement_plan",
                    title=title,
                    column=column,
                    severity="medium",
                    agent_id=r.get("agent_id"),
                    status=status,
                    href=f"/improve/plans/{pid}",
                    payload=payload,
                    source="improvement_plans",
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
                    column=COLUMN_NEEDS_YOU if status == "proposed" else COLUMN_VERIFY,
                    severity="medium",
                    agent_id=repo,
                    status=status,
                    # Legacy Cat 23 — no detail page; portal maps to N23 inbox.
                    href="/improve/plans",
                    payload={
                        "patch_id": pid,
                        "rca_id": r.get("rca_id"),
                        "trace_id": r.get("trace_id"),
                    },
                    source="proposed_patches",
                )
            )
        return out

    async def _from_nudges(self, org_id: str, agent_id: str | None) -> list[ImprovementItem]:
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
            blocked_reason, tier = await _autonomy_block_reason(org_id, "nudge_shadow", aid)
            column = COLUMN_AUTONOMOUS if not blocked_reason else COLUMN_NEEDS_YOU
            href = f"/issues/{r['source_issue_id']}" if r.get("source_issue_id") else "/settings"
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

    async def _from_artifacts_pending(
        self, org_id: str, agent_id: str | None
    ) -> list[ImprovementItem]:
        try:
            from eden.preview.gates import artifacts_enabled

            if not await artifacts_enabled(org_id):
                return []
            from eden.promotion.evidence_gate import EvidenceGate

            candidates = await EvidenceGate().list_queue(org_id, status="shadow", limit=30)
        except Exception as exc:
            logger.debug("cockpit artifacts pending: %s", exc)
            return []
        out: list[ImprovementItem] = []
        for row in candidates:
            if str(row.get("kind") or "") != "nudge":
                continue
            cid = str(row.get("id") or "")
            ref_id = str(row.get("ref_id") or "")
            out.append(
                ImprovementItem(
                    ref=f"artifact:{ref_id}",
                    item_type="nudge_shadow",
                    title=f"Artifact candidate ready for review ({ref_id[:12]})",
                    column=COLUMN_PROPOSED,
                    severity="medium",
                    agent_id=agent_id,
                    status="shadow",
                    href=f"/artifacts?candidate={cid}",
                    payload={"candidate_id": cid, "artifact_id": ref_id},
                    source="artifacts_pending",
                )
            )
        return out

    async def _from_ledger_stale(self, org_id: str, agent_id: str | None) -> list[ImprovementItem]:
        try:
            from eden.preview.gates import ledger_enabled

            if not await ledger_enabled(org_id):
                return []
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return []
            if agent_id:
                rows = await client.fetch(
                    """
                    SELECT agent_id, version, updated_at
                    FROM agent_ledgers
                    WHERE org_id = $1 AND agent_id = $2
                      AND updated_at < now() - interval '7 days'
                    """,
                    org_id,
                    agent_id,
                )
            else:
                rows = await client.fetch(
                    """
                    SELECT agent_id, version, updated_at
                    FROM agent_ledgers
                    WHERE org_id = $1
                      AND updated_at < now() - interval '7 days'
                    LIMIT 20
                    """,
                    org_id,
                )
        except Exception as exc:
            logger.debug("cockpit ledger stale: %s", exc)
            return []
        out: list[ImprovementItem] = []
        for r in rows or []:
            aid = str(r.get("agent_id") or "")
            out.append(
                ImprovementItem(
                    ref=f"ledger_stale:{aid}",
                    item_type="ledger_stale",
                    title=f"Ledger stale for {aid} — review entries",
                    column=COLUMN_NEEDS_YOU,
                    severity="low",
                    agent_id=aid,
                    status="stale",
                    href=f"/agents/{aid}/ledger",
                    payload={"version": r.get("version")},
                    source="ledger_stale",
                )
            )
        return out

    async def _from_evolution_canaries(
        self, org_id: str, agent_id: str | None
    ) -> list[ImprovementItem]:
        """N18 — active prompt canaries visible in cockpit + Artifacts link."""
        try:
            from eden.preview.gates import evolution_loop_enabled_for_org

            if not await evolution_loop_enabled_for_org(org_id):
                return []
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return []
            # Read prompt_canary_experiments (PromotionLoop + evolver
            # auto-canary). Do not claim prompt_canaries here — that
            # table is not written by PromptEvolvers._auto_create_canary.
            if agent_id:
                rows = await client.fetch(
                    """
                    SELECT experiment_id::text AS id,
                           agent AS agent_id,
                           COALESCE(notes, 'Prompt canary') AS name,
                           status,
                           candidate_version AS current_version
                    FROM prompt_canary_experiments
                    WHERE tenant_id = $1 AND agent = $2 AND status = 'active'
                    ORDER BY started_at DESC
                    LIMIT 15
                    """,
                    org_id,
                    agent_id,
                )
            else:
                rows = await client.fetch(
                    """
                    SELECT experiment_id::text AS id,
                           agent AS agent_id,
                           COALESCE(notes, 'Prompt canary') AS name,
                           status,
                           candidate_version AS current_version
                    FROM prompt_canary_experiments
                    WHERE tenant_id = $1 AND status = 'active'
                    ORDER BY started_at DESC
                    LIMIT 15
                    """,
                    org_id,
                )
        except Exception as exc:
            logger.debug("cockpit evolution canaries: %s", exc)
            return []
        out: list[ImprovementItem] = []
        for r in rows or []:
            cid = str(r.get("id") or "")
            aid = str(r.get("agent_id") or "default")
            name = str(r.get("name") or "Prompt canary")
            blocked_reason, tier = await _autonomy_block_reason(org_id, "prompt_canary", aid)
            column = COLUMN_AUTONOMOUS if not blocked_reason else COLUMN_NEEDS_YOU
            out.append(
                ImprovementItem(
                    ref=f"evolution:{cid}",
                    item_type="prompt_canary",
                    title=f"Evolution canary: {name}",
                    column=column,
                    severity="medium",
                    agent_id=aid,
                    status=str(r.get("status") or "active"),
                    href=f"/agents/{aid}/artifacts",
                    payload={
                        "canary_id": cid,
                        "version": r.get("current_version"),
                    },
                    autonomy_tier_required=tier,
                    blocked_reason=blocked_reason,
                    source="evolution_loop",
                )
            )
        return out

    async def _from_promotions(self, org_id: str) -> list[ImprovementItem]:
        try:
            from eden.promotion.evidence_gate import EvidenceGate

            candidates = await EvidenceGate().list_queue(org_id, status="pending", limit=50)
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
            item_type = "guardrail_promote" if "guardrail" in kind else "promotion_candidate"
            action_type = "guardrail_promote" if "guardrail" in kind else "nudge_promote"
            blocked_reason, tier = await _autonomy_block_reason(org_id, action_type, None)
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

        return await why_blocked(org_id, action_type, agent_id=str(agent_id) if agent_id else None)
    except Exception as exc:
        logger.debug("cockpit autonomy block reason: %s", exc)
        return None, None


def _queue_column_for_plan(plan_kind: str, evidence: dict[str, Any]) -> str:
    """M13 (§6.2): Fix now (code/prompt + evidence) vs Improve later."""
    kind = (plan_kind or "").lower()
    has_evidence = bool(
        evidence.get("evidence_tier")
        or evidence.get("example_trace_ids")
        or evidence.get("issue_id")
        or evidence.get("failure_pack_status")
    )
    high_ev = False
    try:
        high_ev = float(evidence.get("ev_score") or 0) >= 1.0
    except (TypeError, ValueError):
        high_ev = False
    if kind in _FIX_NOW_KINDS and (has_evidence or high_ev):
        return COLUMN_FIX_NOW
    if kind in _IMPROVE_LATER_KINDS or kind in ("advisory", "config_change"):
        return COLUMN_IMPROVE_LATER
    if kind in _FIX_NOW_KINDS:
        return COLUMN_FIX_NOW
    return COLUMN_IMPROVE_LATER


def _plan_is_stale(plan: dict[str, Any], stale_days: int) -> bool:
    """True when draft ``created_at`` is older than ``stale_days`` (M13 §6.6)."""
    from datetime import timedelta

    created = plan.get("created_at")
    if created is None:
        return False
    if isinstance(created, str):
        try:
            created = datetime.fromisoformat(created.replace("Z", "+00:00"))
        except ValueError:
            return False
    if getattr(created, "tzinfo", None) is None:
        created = created.replace(tzinfo=UTC)
    return datetime.now(UTC) - created > timedelta(days=max(1, int(stale_days)))


def is_fix_now_item(item: ImprovementItem | dict[str, Any]) -> bool:
    """True when an item belongs on the Fix-now Slack notify path."""
    if isinstance(item, ImprovementItem):
        return item.column == COLUMN_FIX_NOW
    return str(item.get("column") or "") == COLUMN_FIX_NOW
