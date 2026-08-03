"""M15 (§9) — auto-merge ladder (canary).

DARK by default: requires N22 T4 ``auto_code_patch_merge=True`` plus
every eligibility gate below. Customer offer stays process-gated until
dogfood proves 5 consecutive auto-merges with zero guardian regressions.

Eligibility (ALL required):
  * ``evidence_tier ∈ {replay, tested}``
  * diff ≤ soft cap (``patch_max_diff_lines_soft``)
  * touched files have zero KG revert history
  * org opted into N22 T4 (``auto_code_patch_merge=True``)
  * compliance ∉ {hipaa, soc2_strict}
  * weekly volume cap not exceeded
  * feature kill ``auto_merge`` enabled
  * repo branch protection allows the App to merge (else draft-PR
    fallback stamped ``auto_merge_blocked:branch_protection``)

Canary path: non-draft PR → merge → 10-min ``auto_merge:`` verify
window → guardian auto-revert permitted for this class only.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

logger = logging.getLogger(__name__)

#: Evidence tiers that may ride the auto-merge ladder.
_ELIGIBLE_TIERS = frozenset({"replay", "tested"})

#: Compliance profiles that never auto-merge (mirrors N22 decide()).
_BLOCKED_COMPLIANCE = frozenset({"hipaa", "soc2_strict"})

#: Stamp key on plan evidence for the auto-merge decision.
EVIDENCE_KEY = "auto_merge"

#: Feature-kill key (``feature_kills`` infra).
FEATURE_KILL_KEY = "auto_merge"


@dataclass(slots=True)
class AutoMergeDecision:
    """Result of the M15 eligibility gate."""

    eligible: bool
    reasons: list[str] = field(default_factory=list)
    blocked_by: str | None = None
    details: dict[str, Any] = field(default_factory=dict)

    def to_evidence(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "eligible": self.eligible,
            "reasons": list(self.reasons),
            "decided_at": datetime.now(UTC).isoformat(),
        }
        if self.blocked_by:
            out["blocked_by"] = self.blocked_by
        if self.details:
            out["details"] = self.details
        return out


def _soft_cap() -> int:
    try:
        from eden.config import get_settings

        return int(getattr(get_settings(), "patch_max_diff_lines_soft", 200) or 200)
    except Exception:
        return 200


def _default_weekly_cap() -> int:
    try:
        from eden.config import get_settings

        return int(getattr(get_settings(), "auto_merge_max_per_week", 2) or 2)
    except Exception:
        return 2


async def weekly_cap_for_org(org_id: str, agent_id: str | None = None) -> int:
    """Org-overridable weekly cap (autonomy policy → Settings default)."""
    try:
        from eden.closed_loop.autonomy_policy import resolve

        policy = await resolve(org_id, agent_id)
        cap = getattr(policy, "auto_merge_max_per_week", None)
        if cap is not None:
            return max(0, int(cap))
    except Exception as exc:  # noqa: BLE001
        logger.debug("auto_merge: weekly_cap resolve failed: %s", exc)
    return _default_weekly_cap()


async def count_auto_merges_this_week(org_id: str) -> int:
    """Count canary auto-merges for ``org_id`` in the trailing 7 days."""
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
        if client is None:
            # Fail-closed: without a ledger we must not under-count.
            return 10**9
        since = datetime.now(UTC) - timedelta(days=7)
        row = await client.fetchrow(
            """
            SELECT COUNT(*)::int AS n
            FROM improvement_plans
            WHERE org_id = $1
              AND status = 'merged'
              AND COALESCE((evidence->'auto_merge'->>'merged')::boolean, false) = true
              AND updated_at >= $2
            """,
            org_id,
            since,
        )
        return int((row or {}).get("n") or 0)
    except Exception as exc:  # noqa: BLE001
        logger.debug("auto_merge: weekly count failed: %s", exc)
        # Fail closed — unknown count blocks eligibility.
        return 10**9


def _paths_from_plan(plan: dict[str, Any]) -> list[str]:
    files = plan.get("files_changed") or []
    if isinstance(files, list) and files:
        return [str(p) for p in files if p]
    diff = str(plan.get("diff_unified") or "")
    if not diff.strip():
        return []
    try:
        from eden.patches._common import diff_files_changed

        return list(diff_files_changed(diff))
    except Exception:
        return []


async def _kg_has_revert_history(
    org_id: str, repo_id: str, paths: list[str]
) -> tuple[bool, list[str]]:
    """True when any touched path has ``reverted_count > 0`` in the KG."""
    if not paths:
        return False, []
    try:
        from eden.patches.knowledge_graph import CodebaseKnowledgeGraph

        kg = CodebaseKnowledgeGraph()
    except Exception as exc:  # noqa: BLE001
        logger.debug("auto_merge: KG init failed: %s", exc)
        return True, ["kg_unavailable"]

    import asyncio

    async def _check(path: str) -> str | None:
        try:
            env = await kg.same_file_history(org_id, repo_id or "unknown", path)
            data = (env or {}).get("data") or {}
            if int(data.get("reverted_count") or 0) > 0:
                return path
        except Exception as exc:  # noqa: BLE001
            logger.debug("auto_merge: KG history %s failed: %s", path, exc)
            return path
        return None

    results = await asyncio.gather(*[_check(p) for p in paths[:16]])
    dirty = [p for p in results if p]
    return bool(dirty), dirty


async def _feature_kill_allows(org_id: str) -> bool:
    try:
        from eden.llmops.feature_kills import is_autonomy_action_enabled

        return await is_autonomy_action_enabled(org_id, FEATURE_KILL_KEY)
    except Exception as exc:  # noqa: BLE001
        logger.debug("auto_merge: feature kill check failed: %s", exc)
        return False


async def check_branch_allows_app_merge(
    provider: Any, base: str
) -> tuple[bool, str]:
    """Return ``(ok, reason)`` — prefer provider hook, else allow.

    When the provider cannot answer, we fail closed and stamp
    ``branch_protection`` so the draft-PR path is used.
    """
    checker = getattr(provider, "branch_allows_app_merge", None)
    if checker is None:
        # Local / mock providers without the hook are treated as allowed
        # (dev/test). Production GitHub provider always implements it.
        return True, "provider_no_protection_check"
    try:
        result = await checker(base)
        if isinstance(result, tuple) and len(result) == 2:
            return bool(result[0]), str(result[1] or "")
        return bool(result), "ok" if result else "branch_protection"
    except Exception as exc:  # noqa: BLE001
        logger.debug("auto_merge: branch protection check failed: %s", exc)
        return False, f"branch_protection_check_failed:{str(exc)[:120]}"


async def evaluate_auto_merge_eligibility(
    org_id: str,
    plan: dict[str, Any],
    *,
    provider: Any | None = None,
    base: str | None = None,
    repo_id: str | None = None,
    skip_branch_protection: bool = False,
) -> AutoMergeDecision:
    """Run every M15 eligibility gate. Pure of side-effects (no merge)."""
    reasons: list[str] = []
    details: dict[str, Any] = {}

    # Canary auto-revert force path (guardian) — bypasses the ladder
    # gates; the original merge already passed them.
    evidence = plan.get("evidence") if isinstance(plan.get("evidence"), dict) else {}
    if bool((evidence.get(EVIDENCE_KEY) or {}).get("force_canary_revert")):
        return AutoMergeDecision(
            eligible=True,
            reasons=["canary_auto_revert"],
            details={"force_canary_revert": True},
        )

    # ── feature kill ───────────────────────────────────────────────
    if not await _feature_kill_allows(org_id):
        return AutoMergeDecision(
            eligible=False,
            reasons=["feature_killed:auto_merge"],
            blocked_by="feature_kill",
        )

    # ── N22 T4 + compliance ────────────────────────────────────────
    agent_id = (str(plan.get("agent_id") or "").strip() or None)
    try:
        from eden.closed_loop.autonomy_policy import resolve

        policy = await resolve(org_id, agent_id)
    except Exception as exc:  # noqa: BLE001
        return AutoMergeDecision(
            eligible=False,
            reasons=[f"policy_resolve_failed:{str(exc)[:80]}"],
            blocked_by="policy",
        )

    profile = str(policy.compliance_profile or "standard")
    if profile in _BLOCKED_COMPLIANCE:
        return AutoMergeDecision(
            eligible=False,
            reasons=[f"compliance:{profile}"],
            blocked_by="compliance",
            details={"compliance_profile": profile},
        )

    if not bool(policy.auto_code_patch_merge):
        return AutoMergeDecision(
            eligible=False,
            reasons=["auto_code_patch_merge=False"],
            blocked_by="n22_t4",
        )

    # ── evidence tier ──────────────────────────────────────────────
    tier = str(evidence.get("evidence_tier") or "").strip().lower()
    details["evidence_tier"] = tier or None
    if tier not in _ELIGIBLE_TIERS:
        return AutoMergeDecision(
            eligible=False,
            reasons=[f"evidence_tier:{tier or 'missing'}"],
            blocked_by="evidence_tier",
            details=details,
        )
    reasons.append(f"evidence_tier:{tier}")

    # ── soft size cap ──────────────────────────────────────────────
    soft = _soft_cap()
    try:
        from eden.patches._common import diff_line_count

        lines = diff_line_count(str(plan.get("diff_unified") or ""))
    except Exception:
        lines = 10**9
    details["diff_lines"] = lines
    details["soft_cap"] = soft
    if lines > soft:
        return AutoMergeDecision(
            eligible=False,
            reasons=[f"diff_over_soft_cap:{lines}>{soft}"],
            blocked_by="soft_cap",
            details=details,
        )
    reasons.append(f"diff_lines:{lines}<={soft}")

    # ── KG zero-revert history ─────────────────────────────────────
    paths = _paths_from_plan(plan)
    details["touched_paths"] = paths
    has_reverts, dirty = await _kg_has_revert_history(
        org_id, repo_id or agent_id or "unknown", paths
    )
    if has_reverts:
        return AutoMergeDecision(
            eligible=False,
            reasons=["kg_revert_history"],
            blocked_by="kg_revert_history",
            details={**details, "dirty_paths": dirty},
        )
    reasons.append("kg_revert_history:none")

    # ── weekly volume cap ──────────────────────────────────────────
    cap = await weekly_cap_for_org(org_id, agent_id)
    used = await count_auto_merges_this_week(org_id)
    details["weekly_used"] = used
    details["weekly_cap"] = cap
    if used >= cap:
        return AutoMergeDecision(
            eligible=False,
            reasons=[f"weekly_cap:{used}>={cap}"],
            blocked_by="weekly_cap",
            details=details,
        )
    reasons.append(f"weekly_cap:{used}/{cap}")

    # ── branch protection ──────────────────────────────────────────
    if not skip_branch_protection:
        if provider is None or not base:
            return AutoMergeDecision(
                eligible=False,
                reasons=["branch_protection:unchecked"],
                blocked_by="branch_protection",
                details=details,
            )
        ok, bp_reason = await check_branch_allows_app_merge(provider, base)
        details["branch_protection"] = bp_reason
        if not ok:
            return AutoMergeDecision(
                eligible=False,
                reasons=[f"auto_merge_blocked:branch_protection"],
                blocked_by="branch_protection",
                details=details,
            )
        reasons.append(f"branch_protection:{bp_reason or 'ok'}")

    return AutoMergeDecision(eligible=True, reasons=reasons, details=details)


async def merge_pull_request(
    provider: Any,
    pr_number: int,
    *,
    merge_method: str = "squash",
    commit_title: str | None = None,
) -> dict[str, Any]:
    """Merge via provider hook. Returns ``{ok, reason, ...}``."""
    merger = getattr(provider, "merge_pr", None)
    if merger is None:
        return {"ok": False, "reason": "provider_no_merge"}
    try:
        info = await merger(
            pr_number,
            merge_method=merge_method,
            commit_title=commit_title,
        )
        state = getattr(info, "state", None) or (
            info.get("state") if isinstance(info, dict) else None
        )
        if str(state or "").lower() in ("merged", "closed"):
            return {"ok": True, "pr": info}
        # Some providers return the PR info with state=merged; others
        # just return truthy. Treat non-raising success as ok when
        # state is absent.
        if info is not None and state is None:
            return {"ok": True, "pr": info}
        return {"ok": False, "reason": f"merge_state:{state}", "pr": info}
    except Exception as exc:  # noqa: BLE001
        logger.warning("auto_merge: merge_pr failed: %s", exc)
        return {"ok": False, "reason": f"merge_failed:{str(exc)[:200]}"}


def parent_is_canary_auto_merged(parent: dict[str, Any]) -> bool:
    """True when the merged parent rode the M15 canary ladder.

    Requires an explicit ``canary: true`` stamp — missing key is not
    treated as canary (avoids accidental auto-revert on non-canary merges).
    """
    evidence = parent.get("evidence") if isinstance(parent.get("evidence"), dict) else {}
    am = evidence.get(EVIDENCE_KEY) if isinstance(evidence.get(EVIDENCE_KEY), dict) else {}
    return bool(am.get("merged")) and am.get("canary") is True


async def auto_revert_permitted(org_id: str, agent_id: str | None) -> bool:
    """Guardian may auto-execute a revert for the canary class only.

    Gated on auto-merge class (T4 + kill switch + compliance), NOT on
    ``auto_runtime_heal`` — plan §9 couples canary revert to the merge
    ladder, not runtime heal opt-in.
    """
    try:
        from eden.config import get_settings

        if not bool(getattr(get_settings(), "auto_revert_enabled", False)):
            return False
    except Exception:
        return False
    if not await _feature_kill_allows(org_id):
        return False
    try:
        from eden.closed_loop.autonomy_policy import resolve

        policy = await resolve(org_id, agent_id)
        if policy.compliance_profile in _BLOCKED_COMPLIANCE:
            return False
        # Canary auto-revert is part of the T4 merge ladder, not heal.
        return bool(getattr(policy, "auto_code_patch_merge", False))
    except Exception:  # noqa: BLE001
        return False
