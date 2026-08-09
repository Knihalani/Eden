"""Autonomy policy engine (N22) — the closed-loop safety envelope.

Before the orchestrator (F46) executes *any* autonomous action it asks
this module ``may(policy, action)``. The policy is resolved per
``(org_id, agent_id)`` — an agent-level row beats the org default, which
in turn falls back to config-derived defaults (so the existing scattered
flags ``autonomous_actions_v0`` / ``code_change_enabled`` / ``auto_pr_enabled``
seed a coherent posture without a migration data-backfill).

Design decisions (recorded in the PR):

* **Functional defaults, not seeded rows.** ``resolve`` synthesises the
  org default from Settings when no ``autonomy_policies`` row exists,
  rather than the migration inserting a row per org (which would go stale
  the moment a flag changes). A row is only written when a human edits
  the policy via the API.
* **Compliance is a hard override.** ``hipaa`` forces ``observe`` and
  ``soc2_strict`` forbids auto-merge, applied *after* the stored policy
  so a mis-set flag can never widen the envelope.
* **Budget downgrades, never crashes.** When the daily maintenance spend
  is exhausted every mutating tier degrades to ``require_approval`` and
  the loop stays advisory.

Every decision is written to ``autonomy_audit_log`` (best-effort, async)
so the N06 compliance pack and the N17 cockpit can render *why* an action
was or wasn't taken.
"""

from __future__ import annotations

import contextlib
import json
import logging
import uuid
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime
from typing import Any, Literal

logger = logging.getLogger(__name__)

MaintenanceMode = Literal["autonomous", "assisted", "observe"]
ComplianceProfile = Literal["standard", "hipaa", "soc2_strict"]
Decision = Literal["allow", "require_approval", "deny"]

_CACHE_TTL_S = 60
_POLICY_CACHE_PREFIX = "autonomy:policy:"
_SPEND_PREFIX = "autonomy:spend:"

# Action → the fine-grained bound + tier it consumes. Tiers mirror the
# N22 spec's graded ladder (T0 observe → T4 auto-merge).
_ACTION_TIERS: dict[str, tuple[str, int]] = {
    # T0/T1 — always allowed (detect / diagnose / recommend / alert).
    "alert": ("observe", 0),
    "recommend": ("observe", 0),
    "investigate": ("observe", 1),
    "triage": ("observe", 1),
    # T2 — runtime heals (reversible) + code-patch PR.
    "rollback": ("auto_runtime_heal", 2),
    "reweight": ("auto_runtime_heal", 2),
    "cache_bust": ("auto_runtime_heal", 2),
    "self_heal": ("auto_runtime_heal", 2),
    "heal": ("auto_runtime_heal", 2),
    "propose_patch": ("auto_code_patch_pr", 2),
    "code_change": ("auto_code_patch_pr", 2),
    "patch": ("auto_code_patch_pr", 2),
    # T3 — prompt canaries / promotions (evidence-gated elsewhere too).
    "prompt_canary": ("auto_prompt_canary", 3),
    "nudge_promote": ("auto_nudge_promote", 3),
    "guardrail_promote": ("auto_guardrail_promote", 3),
    # T4 — highest blast radius.
    "code_patch_merge": ("auto_code_patch_merge", 4),
    "auto_merge": ("auto_code_patch_merge", 4),
}

@dataclass(slots=True)
class AutonomousMaintenancePolicy:
    org_id: str
    agent_id: str | None = None
    maintenance_mode: MaintenanceMode = "assisted"
    # Runtime self-heal defaults ON (reversible actions only). Settings
    # is opt-out; code PR / auto-merge stay off unless separately enabled.
    auto_runtime_heal: bool = True
    auto_code_patch_pr: bool = False
    auto_code_patch_merge: bool = False
    auto_prompt_canary: bool = True
    auto_nudge_promote: bool = False
    auto_guardrail_promote: bool = False
    daily_maintenance_budget_usd: float = 25.0
    max_auto_rollbacks_per_day: int = 3
    # M15 (§9): weekly canary auto-merge volume cap (org-overridable).
    auto_merge_max_per_week: int = 2
    compliance_profile: ComplianceProfile = "standard"

    def effective_mode(self) -> MaintenanceMode:
        """Apply the compliance hard-override to the stored mode."""
        if self.compliance_profile == "hipaa":
            return "observe"
        return self.maintenance_mode

    def to_json(self) -> dict[str, Any]:
        return asdict(self)


# ── Resolution ──────────────────────────────────────────────────────


def _defaults_from_settings(org_id: str, agent_id: str | None) -> AutonomousMaintenancePolicy:
    try:
        from eden.config import get_settings

        s = get_settings()
        mode = getattr(s, "default_maintenance_mode", "assisted")
        profile = getattr(s, "default_compliance_profile", "standard")
        return AutonomousMaintenancePolicy(
            org_id=org_id,
            agent_id=agent_id,
            maintenance_mode=mode if mode in ("autonomous", "assisted", "observe") else "assisted",
            auto_runtime_heal=bool(getattr(s, "autonomous_actions_v0", False)),
            auto_code_patch_pr=bool(getattr(s, "code_change_enabled", False)),
            auto_code_patch_merge=bool(getattr(s, "auto_pr_enabled", False)),
            daily_maintenance_budget_usd=float(
                getattr(s, "daily_maintenance_budget_usd", 25.0)
            ),
            max_auto_rollbacks_per_day=int(
                getattr(s, "max_auto_rollbacks_per_day", 3)
            ),
            auto_merge_max_per_week=int(
                getattr(s, "auto_merge_max_per_week", 2) or 2
            ),
            compliance_profile=profile
            if profile in ("standard", "hipaa", "soc2_strict")
            else "standard",
        )
    except Exception:
        return AutonomousMaintenancePolicy(org_id=org_id, agent_id=agent_id)


def _policy_from_row(
    org_id: str, agent_id: str | None, row: dict[str, Any]
) -> AutonomousMaintenancePolicy:
    base = _defaults_from_settings(org_id, agent_id)
    policy = row.get("policy")
    if isinstance(policy, str):
        try:
            policy = json.loads(policy)
        except (TypeError, ValueError):
            policy = {}
    policy = policy or {}
    merged = base.to_json()
    for k, v in policy.items():
        if k in merged and v is not None:
            merged[k] = v
    profile = row.get("compliance_profile") or merged.get("compliance_profile")
    if profile in ("standard", "hipaa", "soc2_strict"):
        merged["compliance_profile"] = profile
    merged["org_id"] = org_id
    merged["agent_id"] = agent_id
    return AutonomousMaintenancePolicy(**merged)


async def resolve(
    org_id: str, agent_id: str | None = None
) -> AutonomousMaintenancePolicy:
    """Resolve the effective policy for ``(org_id, agent_id)``.

    Agent override beats org default beats config-derived default. Cached
    in Redis for 60s (spec §7).
    """
    cache_key = f"{_POLICY_CACHE_PREFIX}{org_id}:{agent_id or '-'}"
    redis = await _redis()
    if redis is not None:
        try:
            cached = await redis.get(cache_key)
            if cached:
                data = json.loads(cached)
                return AutonomousMaintenancePolicy(**data)
        except Exception:
            pass

    policy = await _resolve_from_db(org_id, agent_id)

    if redis is not None:
        with contextlib.suppress(Exception):
            await redis.set(
                cache_key, json.dumps(policy.to_json()), ex=_CACHE_TTL_S
            )
    return policy


async def _resolve_from_db(
    org_id: str, agent_id: str | None
) -> AutonomousMaintenancePolicy:
    client = await _pg()
    if client is None:
        return _defaults_from_settings(org_id, agent_id)
    try:
        # Agent-level override first, then the org default (agent_id IS NULL).
        if agent_id:
            row = await client.fetchrow(
                "SELECT policy, compliance_profile FROM autonomy_policies "
                "WHERE org_id = $1 AND agent_id = $2",
                org_id,
                agent_id,
            )
            if row:
                return _policy_from_row(org_id, agent_id, dict(row))
        row = await client.fetchrow(
            "SELECT policy, compliance_profile FROM autonomy_policies "
            "WHERE org_id = $1 AND agent_id IS NULL",
            org_id,
        )
        if row:
            return _policy_from_row(org_id, agent_id, dict(row))
    except Exception as exc:
        logger.debug("autonomy_policy: resolve query failed: %s", exc)
    return _defaults_from_settings(org_id, agent_id)


# ── Decision ────────────────────────────────────────────────────────


def decide(policy: AutonomousMaintenancePolicy, action: str) -> tuple[Decision, str, str]:
    """Return ``(decision, reason, tier)`` for ``action`` under ``policy``.

    Pure + O(1). Budget is applied separately (``check_budget``) so this
    stays synchronous and side-effect free for hot-path callers.
    """
    tier_name, tier = _ACTION_TIERS.get(action, ("auto_runtime_heal", 2))
    mode = policy.effective_mode()

    # T0/T1 (observe tier) are always allowed — detect/diagnose/alert.
    if tier <= 1:
        return "allow", "observe-tier action", tier_name

    if mode == "observe":
        return "deny", f"maintenance_mode=observe (profile={policy.compliance_profile})", tier_name

    # soc2_strict never auto-merges.
    if action in ("code_patch_merge", "auto_merge") and policy.compliance_profile == "soc2_strict":
        return "deny", "soc2_strict forbids auto-merge", tier_name

    # assisted: runtime heals auto-execute; code patches/merges need a human.
    #
    # Soft Autonomy Phase 3 (PR-first): this check runs BEFORE the
    # fine-grained flag check for ``auto_code_patch_pr``. Drafting a fix
    # plan has no repo side-effect — the human Approve is the gate — so
    # the legacy ``code_change_enabled=False`` master switch must not
    # silently deny every code PR in assisted mode. The flag still gates
    # fully-autonomous execution below.
    if mode == "assisted" and tier_name in (
        "auto_code_patch_pr",
        "auto_code_patch_merge",
        "auto_nudge_promote",
        "auto_guardrail_promote",
    ):
        return "require_approval", "assisted mode requires human approval", tier_name

    # The fine-grained bound must be enabled.
    if not getattr(policy, tier_name, False):
        return "deny", f"{tier_name} disabled", tier_name

    return "allow", f"{mode} mode permits {tier_name}", tier_name


def may(policy: AutonomousMaintenancePolicy, action: str) -> bool:
    """True only when ``action`` is fully permitted (auto-execute)."""
    decision, _, _ = decide(policy, action)
    return decision == "allow"


# ── Effective mode (orchestrator convenience) ───────────────────────


async def evaluate_mode(
    org_id: str,
    *,
    agent_id: str | None = None,
    action_type: str | None = None,
    triage_result: dict[str, Any] | None = None,
) -> str:
    """Return the effective maintenance mode for the loop's ``_gate``.

    Applies the compliance override and the daily-budget downgrade: once
    the maintenance budget is exhausted, mutating tiers are forced to
    ``observe`` so nothing auto-executes.
    """
    policy = await resolve(org_id, agent_id)
    mode = policy.effective_mode()
    if mode == "observe":
        return "observe"
    ok, _spent, _limit = await check_budget(org_id, policy)
    if not ok:
        logger.info("autonomy_policy: org=%s budget exhausted → observe", org_id)
        await audit(
            org_id,
            agent_id=agent_id,
            action=action_type or "maintenance",
            tier="budget",
            decision="deny",
            reason="daily maintenance budget exhausted",
        )
        return "observe"
    return mode


# ── Budget (Redis daily counter) ────────────────────────────────────


def _today() -> str:
    return date.today().isoformat()


async def check_budget(
    org_id: str, policy: AutonomousMaintenancePolicy | None = None
) -> tuple[bool, float, float]:
    """Return ``(ok, spent_usd, limit_usd)`` for today's maintenance spend."""
    if policy is None:
        policy = await resolve(org_id)
    limit = float(policy.daily_maintenance_budget_usd)
    spent = 0.0
    redis = await _redis()
    if redis is not None:
        try:
            raw = await redis.get(f"{_SPEND_PREFIX}{org_id}:{_today()}")
            spent = float(raw) if raw else 0.0
        except Exception:
            spent = 0.0
    return (spent < limit, spent, limit)


async def record_spend(
    org_id: str,
    usd: float,
    *,
    feature: str = "autonomy",
    model: str = "autonomy",
    agent_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> float:
    """Increment today's maintenance spend + tag a customer CostEvent (W24).

    Returns the new Redis daily total (0 when Redis is unavailable). Daily
    caps are enforced by :func:`check_budget` / :func:`evaluate_mode`.
    """
    if usd <= 0:
        return 0.0
    new_total = 0.0
    redis = await _redis()
    if redis is not None:
        key = f"{_SPEND_PREFIX}{org_id}:{_today()}"
        try:
            pipe = redis.pipeline(transaction=False)
            pipe.incrbyfloat(key, float(usd))
            pipe.expire(key, 172_800)  # keep 2 days for reporting
            new_total_raw, _ = await pipe.execute()
            new_total = float(new_total_raw)
        except Exception as exc:
            logger.debug("autonomy_policy: record_spend failed: %s", exc)
            new_total = 0.0
    # Customer-visible CostEvent (FinOps explorer) — best-effort.
    try:
        from eden.llmops.cost_ledger import CostEvent, record_cost_event

        await record_cost_event(
            CostEvent(
                org_id=org_id,
                feature=(feature or "autonomy").lower(),
                model=model or "autonomy",
                cost_usd=float(usd),
                agent_id=agent_id,
                metadata={
                    "source": "autonomy_policy",
                    **(metadata or {}),
                },
            )
        )
    except Exception as exc:
        logger.debug("autonomy_policy: CostEvent tag failed: %s", exc)
    return new_total


# ── Audit ───────────────────────────────────────────────────────────


async def audit(
    org_id: str,
    *,
    agent_id: str | None,
    action: str,
    tier: str,
    decision: str,
    reason: str = "",
) -> None:
    """Append an autonomy decision to ``autonomy_audit_log`` (best-effort)."""
    client = await _pg()
    if client is None:
        return
    try:
        await client.execute(
            """
            INSERT INTO autonomy_audit_log
                (id, org_id, agent_id, action, tier_applied, decision, reason)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7)
            """,
            str(uuid.uuid4()),
            org_id,
            agent_id,
            action[:64],
            tier[:32],
            decision[:24],
            (reason or "")[:2000],
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("autonomy_policy: audit failed: %s", exc)


async def upsert_policy(
    org_id: str,
    *,
    agent_id: str | None,
    patch: dict[str, Any],
    compliance_profile: str | None = None,
    updated_by: str | None = None,
) -> AutonomousMaintenancePolicy:
    """Persist a policy edit (PATCH from the settings API) + bust cache."""
    current = await _resolve_from_db(org_id, agent_id)
    merged = current.to_json()
    for k, v in (patch or {}).items():
        if k in merged and v is not None and k not in ("org_id", "agent_id"):
            merged[k] = v
    if compliance_profile in ("standard", "hipaa", "soc2_strict"):
        merged["compliance_profile"] = compliance_profile
    merged["org_id"] = org_id
    merged["agent_id"] = agent_id
    new_policy = AutonomousMaintenancePolicy(**merged)

    client = await _pg()
    if client is not None:
        try:
            await client.execute(
                """
                INSERT INTO autonomy_policies
                    (id, org_id, agent_id, policy, compliance_profile, updated_at)
                VALUES ($1::uuid, $2, $3, $4::jsonb, $5, NOW())
                ON CONFLICT (org_id, agent_id) DO UPDATE
                    SET policy = EXCLUDED.policy,
                        compliance_profile = EXCLUDED.compliance_profile,
                        updated_at = NOW()
                """,
                str(uuid.uuid4()),
                org_id,
                agent_id,
                json.dumps(new_policy.to_json()),
                new_policy.compliance_profile,
            )
        except Exception as exc:
            logger.warning("autonomy_policy: upsert failed: %s", exc)

    redis = await _redis()
    if redis is not None:
        with contextlib.suppress(Exception):
            await redis.delete(f"{_POLICY_CACHE_PREFIX}{org_id}:{agent_id or '-'}")
    await audit(
        org_id,
        agent_id=agent_id,
        action="policy_update",
        tier="admin",
        decision="allow",
        reason=f"updated by {updated_by or 'unknown'} at {datetime.now(UTC).isoformat()}",
    )
    return new_policy


# ── infra helpers ───────────────────────────────────────────────────


async def _pg() -> Any | None:
    try:
        from eden.storage.postgres import get_postgres_client

        return await get_postgres_client()
    except Exception:
        return None


async def _redis() -> Any | None:
    try:
        from eden.storage.redis import get_redis_client

        return await get_redis_client()
    except Exception:
        return None


async def why_blocked(
    org_id: str,
    action: str,
    *,
    agent_id: str | None = None,
) -> tuple[str | None, str | None]:
    """Return ``(blocked_reason, tier_required)`` for the improve queue (D5)."""
    policy = await resolve(org_id, agent_id)
    verdict, reason, tier = decide(policy, action)
    if verdict == "allow":
        return None, tier
    return reason, tier


# ── T0–T4 ladder labels (FEAT-156) ───────────────────────────────────

# ``tier_applied`` / ``decide`` tier names → N22 ladder level for UI chips.
_TIER_NAME_LEVEL: dict[str, int] = {
    "observe": 0,
    "auto_runtime_heal": 2,
    "auto_code_patch_pr": 2,
    "auto_prompt_canary": 3,
    "auto_nudge_promote": 3,
    "auto_guardrail_promote": 3,
    "auto_code_patch_merge": 4,
    "budget": 0,
    "admin": 0,
}


def tier_ladder_level(tier_name: str | None) -> int | None:
    """Map a policy ``tier_applied`` name to the T0–T4 ladder level."""
    if not tier_name:
        return None
    key = str(tier_name).strip().lower()
    if key in _TIER_NAME_LEVEL:
        return _TIER_NAME_LEVEL[key]
    return None


def format_tier_ladder(tier_name: str | None) -> str | None:
    """Human label for UI chips, e.g. ``auto_code_patch_pr`` → ``T2``."""
    level = tier_ladder_level(tier_name)
    if level is None:
        return None
    return f"T{level}"


def action_for_plan_kind(plan_kind: str | None) -> str:
    """Primary autonomy action consumed by an improve plan kind."""
    k = (plan_kind or "").lower()
    if k == "code_patch":
        return "propose_patch"
    if k in ("prompt_update", "guardrail_tune"):
        return "prompt_canary"
    if "guardrail" in k:
        return "guardrail_promote"
    if "nudge" in k:
        return "nudge_promote"
    return "recommend"
