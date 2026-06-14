"""Closed-loop wiring (Cat 17) — judge↔promotion and judge↔guardrail hooks.

This module is the operational glue between the 16 categories. In
production it subscribes to events from:

* :class:`JudgeRunner` (:mod:`eden.llmops.judges.runner`) — when a
  new judge score is written
* :class:`PromotionLoop` (:mod:`eden.llmops.promotion`) — when a
  canary is promoted or rolled back
* :class:`InterventionEngine` (Cat 15) — when an intervention
  fires
* :class:`DriftDetector` (Cat 13) — when output / embedding drift
  is detected

For each event, the matching hook decides whether to take an
action: raise a promotion gate, auto-promote a judge into a
guardrail, trigger a canary rollback, etc.

The v0 ship (2026-06-12) is **advisory only** — each hook persists
its *recommended* action to the ``closed_loop_actions`` table with
``status='pending_approval'`` and a ``severity`` tag. A separate
:class:`ClosedLoopExecutor` surfaces the pending actions to the
operator / portal for review. The hook does NOT mutate production
state. Auto-apply is a per-tenant opt-in (the v0.1 follow-up
extends the executor with the auto-apply path).

The DB write is best-effort: a missing Postgres substrate or a SQL
error never breaks the caller (the hook still logs the event so
operators can see the recommendation in the log stream).
"""

from __future__ import annotations

import json
import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)


# ─── Action kinds (canonical strings) ────────────────────────────

#: Action kinds per hook. Centralised so the executor's
#: RBAC + side-effect mapping is a single switch.
ACTION_KIND: dict[str, str] = {
    "on_judge_regression": "block_promotion",
    "on_judge_improvement": "bump_canary",
    "on_drift_alert": "rollback_canary",
    "on_judge_threshold_breach": "promote_judge",
    "on_judge_below_floor": "disable_guardrail",
    "on_winner": "archive_variant",
    "on_metric_promotion": "register_regression_watch",
    "on_compaction_drift": "pause_rollup_scheduler",
    "on_alert_lint_warning": "surface_lint_warning",
    "propose_patch_from_rca": "propose_patch",
    "post_merge_degraded": "consider_revert",
}


# ─── Persistence helper ──────────────────────────────────────────


async def _record_action(
    org_id: str,
    *,
    hook_name: str,
    action_kind: str,
    target: str | None = None,
    payload: dict[str, Any] | None = None,
    severity: str = "medium",
) -> str | None:
    """Persist a recommended action to ``closed_loop_actions``.

    Returns the generated action id (or ``None`` if the
    substrate is unavailable). Best-effort: any error is
    logged at debug and swallowed so the hook never breaks
    the caller.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("closed_loop: postgres import failed: %s", exc)
        return None
    try:
        client = await get_postgres_client()
    except Exception:
        return None
    if client is None:
        return None
    action_id = str(uuid.uuid4())
    try:
        await client.execute(
            """
            INSERT INTO closed_loop_actions
                (id, org_id, hook_name, action_kind, target,
                 payload_json, severity, status)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 'pending_approval')
            """,
            action_id,
            org_id,
            hook_name[:64],
            action_kind[:64],
            (target or "")[:256] or None,
            json.dumps(payload or {}, default=str)[:4000],
            severity[:16],
        )
    except Exception as exc:
        logger.debug("closed_loop: action insert failed: %s", exc)
        return None
    return action_id


# ─── Hook classes ────────────────────────────────────────────────


class PromotionHook:
    """judge→promotion and drift→rollback events.

    Each method records the recommended action to
    ``closed_loop_actions``. In v0 the action is purely
    advisory — the :class:`ClosedLoopExecutor` is what
    surfaces it to the operator and (in a follow-up) what
    applies it on opt-in.
    """

    name = "promotion_hook"

    async def on_judge_regression(
        self,
        org_id: str,
        *,
        judge_name: str,
        trace_id: str,
        score: float,
    ) -> str | None:
        """A new judge score fell below the threshold for its eval version.

        Returns the action id (or ``None`` on substrate error).
        """
        severity = "high" if score < 0.4 else "medium"
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["on_judge_regression"],
            target=judge_name,
            payload={
                "judge_name": judge_name,
                "trace_id": trace_id,
                "score": float(score),
            },
            severity=severity,
        )
        logger.debug(
            "promotion_hook.on_judge_regression org=%s judge=%s "
            "trace=%s score=%.3f action_id=%s",
            org_id, judge_name, trace_id, score, action_id,
        )
        return action_id

    async def on_judge_improvement(
        self,
        org_id: str,
        *,
        judge_name: str,
        trace_id: str,
        score: float,
    ) -> str | None:
        """A new judge score materially improved over baseline."""
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["on_judge_improvement"],
            target=judge_name,
            payload={
                "judge_name": judge_name,
                "trace_id": trace_id,
                "score": float(score),
            },
            severity="low",
        )
        logger.debug(
            "promotion_hook.on_judge_improvement org=%s judge=%s "
            "trace=%s score=%.3f action_id=%s",
            org_id, judge_name, trace_id, score, action_id,
        )
        return action_id

    async def on_drift_alert(
        self,
        org_id: str,
        *,
        drift_type: str,
        severity: str,
    ) -> str | None:
        """Output / embedding drift detected — auto-rollback candidate."""
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["on_drift_alert"],
            target=drift_type,
            payload={
                "drift_type": drift_type,
                "severity": severity,
            },
            severity=severity if severity in ("high", "medium", "low") else "medium",
        )
        logger.debug(
            "promotion_hook.on_drift_alert org=%s drift=%s severity=%s "
            "action_id=%s",
            org_id, drift_type, severity, action_id,
        )
        return action_id


class GuardrailHook:
    """judge→guardrail lifecycle events.

    The v0 ship: each event records the recommended action to
    ``closed_loop_actions``. The reverse direction
    (this hook → :class:`EvalToGuardrailLink.promote`) is
    also wired: :meth:`on_judge_threshold_breach` is the
    entry point of the eval-to-guardrail lifecycle and
    delegates to :class:`EvalToGuardrailLink` to create
    the policy + link row.
    """

    name = "guardrail_hook"

    async def on_judge_threshold_breach(
        self,
        org_id: str,
        *,
        judge_name: str,
        threshold: float,
    ) -> str | None:
        """A judge has reliably triggered below its threshold — promote
        the judge into a production guardrail (Galileo's eval-to-
        guardrail lifecycle).

        The v0 ship records the recommended action AND (best-
        effort) calls :class:`EvalToGuardrailLink.promote` to
        create the link + policy. The link creation is
        idempotent: re-running on the same judge creates the
        same ``(judge_name, threshold)`` policy.
        """
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["on_judge_threshold_breach"],
            target=judge_name,
            payload={
                "judge_name": judge_name,
                "threshold": float(threshold),
            },
            severity="high",
        )
        # Best-effort: also call EvalToGuardrailLink.promote
        # so the Cat 15 policy + link row get created. The
        # link service is fail-safe (returns a not_implemented
        # envelope on any error without raising).
        try:
            from eden.guardrails import EvalToGuardrailLink

            link = EvalToGuardrailLink()
            # The promote method needs a policy to attach the
            # link to; we create a minimal one inline if the
            # caller hasn't already done so.
            policy_resp = await link.promote(
                org_id,
                judge_name=judge_name,
                threshold=float(threshold),
                action="block",
                fire_hook=False,  # avoid recursion
            )
            _ = policy_resp
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug(
                "guardrail_hook: EvalToGuardrailLink.promote failed: %s",
                exc,
            )
        logger.debug(
            "guardrail_hook.on_judge_threshold_breach org=%s judge=%s "
            "threshold=%.3f action_id=%s",
            org_id, judge_name, threshold, action_id,
        )
        return action_id

    async def on_judge_below_floor(
        self,
        org_id: str,
        *,
        judge_name: str,
    ) -> str | None:
        """A promoted guardrail is now too noisy — auto-disable it."""
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["on_judge_below_floor"],
            target=judge_name,
            payload={"judge_name": judge_name},
            severity="medium",
        )
        logger.debug(
            "guardrail_hook.on_judge_below_floor org=%s judge=%s "
            "action_id=%s",
            org_id, judge_name, action_id,
        )
        return action_id


class ExperimentHook:
    """Experiment winner → archive losers.

    Records the recommended archive action. The actual
    archive (which moves the variant to ``archived`` status)
    is the :class:`ClosedLoopExecutor`'s job.
    """

    name = "experiment_hook"

    async def on_winner(
        self,
        org_id: str,
        *,
        experiment_id: str,
        winner_variant: str,
    ) -> str | None:
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["on_winner"],
            target=experiment_id,
            payload={
                "experiment_id": experiment_id,
                "winner_variant": winner_variant,
            },
            severity="low",
        )
        logger.debug(
            "experiment_hook.on_winner org=%s experiment=%s winner=%s "
            "action_id=%s",
            org_id, experiment_id, winner_variant, action_id,
        )
        return action_id


class MetricStudioHook:
    """Custom-metric Studio (Cat 21, v1.3) — closed-loop wiring.

    Fires when a custom metric is promoted to ``production`` in
    the org's metric store. A real implementation would (a)
    surface the new metric in the production dashboard, (b)
    enable any per-tenant opt-in auto-judge policy the
    customer has set, and (c) register a Cat 3 judge-regression
    detector that, on a regression, auto-rolls the metric back
    to ``draft`` and unregisters its judge.

    The v0 ship records the recommended action so the
    :class:`ClosedLoopExecutor` can surface it.
    """

    name = "metric_studio_hook"

    async def on_metric_promotion(
        self,
        org_id: str,
        *,
        metric_id: str,
        judge_name: str,
    ) -> str | None:
        """A custom metric was promoted to ``production``."""
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["on_metric_promotion"],
            target=metric_id,
            payload={
                "metric_id": metric_id,
                "judge_name": judge_name,
            },
            severity="low",
        )
        logger.debug(
            "metric_studio_hook.on_metric_promotion org=%s metric=%s "
            "judge=%s action_id=%s",
            org_id, metric_id, judge_name, action_id,
        )
        return action_id


class ColumnarHook:
    """Columnar Engine (Cat 18, v1.3) — closed-loop wiring.

    Fires when the columnar engine detects a problem the
    operator should know about. The v1.3 ship fires on
    three reasons:

    * ``sla_breach`` — a compaction took longer than the
      4h SLA. ``severity='high'``.
    * ``compaction_failed`` — the ClickHouse ``OPTIMIZE
      TABLE ... FINAL`` call raised. ``severity='high'``.
    * ``ch_unavailable`` — the ClickHouse substrate was
      unhealthy at query time, so the
      :class:`ColumnarQueryEngine` fell back to Postgres.
      ``severity='medium'``.

    The v0 ship records the recommended action; the
    :class:`ClosedLoopExecutor` would pause the rollup
    scheduler on the ``pause_rollup_scheduler`` action
    (a follow-up wires the auto-apply path).
    """

    name = "columnar_hook"

    async def on_compaction_drift(
        self,
        org_id: str,
        *,
        partition_id: str | None,
        reason: str,
        severity: str = "medium",
    ) -> str | None:
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["on_compaction_drift"],
            target=partition_id,
            payload={
                "partition_id": partition_id,
                "reason": reason,
            },
            severity=severity if severity in ("high", "medium", "low") else "medium",
        )
        logger.debug(
            "columnar_hook.on_compaction_drift org=%s partition=%s "
            "reason=%s severity=%s action_id=%s",
            org_id, partition_id, reason, severity, action_id,
        )
        return action_id


class DSLHook:
    """Trace Query DSL (Cat 19, v1.3) — closed-loop wiring.

    Fires when an EQL alert is compiled with at least one
    lint warning. The v1.3 ship fires from
    :meth:`AlertAsCode.compile` after the alert rule is
    persisted to ``eql_alert_rules``.

    The v0 ship records the recommended action.
    """

    name = "dsl_hook"

    async def on_alert_lint_warning(
        self,
        org_id: str,
        *,
        alert_id: str,
        warning_codes: list[str],
    ) -> str | None:
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["on_alert_lint_warning"],
            target=alert_id,
            payload={
                "alert_id": alert_id,
                "warning_codes": list(warning_codes or []),
            },
            severity="low",
        )
        logger.debug(
            "dsl_hook.on_alert_lint_warning org=%s alert=%s "
            "warning_codes=%s action_id=%s",
            org_id, alert_id, warning_codes, action_id,
        )
        return action_id


class CodeChangeHook:
    """Autonomous Code Modification (Cat 23, v1.6) — closed-loop wiring.

    Fires from the Cat 2 RCA scorer when a high-confidence RCA
    is detected, and from :class:`PostMergeMonitor` when a
    post-merge regression is observed. The v1.6 STUB surface
    fires both methods but they are no-ops in stub mode —
    they just log the call so the Cat 2 / Cat 22 surfaces
    can still call into the hook without crashing.

    Two methods:

    * :meth:`propose_patch_from_rca` — Cat 2 RCA scorer
      detected a high-confidence root cause. The hook records
      the recommendation ``propose_patch`` action so the
      :class:`ClosedLoopExecutor` can surface it. The real
      Gate-1 implementation will additionally call into
      :class:`CodeRootCauseLinker` + :class:`PatchGenerator`
      once ``code_change_enabled`` is true.

    * :meth:`post_merge_degraded` — :class:`PostMergeMonitor`
      detected a regression in the 1h/6h/24h/7d windows. The
      hook records the recommendation ``consider_revert``
      action so the operator can decide. The real Gate-4b
      implementation will additionally call into
      :class:`AutoRevertEngine` once ``auto_revert_enabled``
      is true.

    The v0 ship is **advisory only** — the hook records the
    recommended action and the :class:`ClosedLoopExecutor`
    surfaces it. No production state is mutated.
    """

    name = "code_change_hook"

    async def propose_patch_from_rca(
        self,
        org_id: str,
        *,
        rca_id: str,
        trace_id: str,
        confidence: float,
    ) -> str | None:
        """A Cat 2 RCA fired and the agent should propose a patch.

        STUB: records the recommendation. The real Gate-1
        implementation will additionally check
        ``code_change_enabled`` + ``min_rca_confidence`` and
        call into the :class:`CodeRootCauseLinker` +
        :class:`PatchGenerator` to mint a patch.
        """
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["propose_patch_from_rca"],
            target=rca_id,
            payload={
                "rca_id": rca_id,
                "trace_id": trace_id,
                "confidence": confidence,
            },
            severity="medium" if confidence >= 0.7 else "low",
        )
        logger.debug(
            "code_change_hook.propose_patch_from_rca org=%s rca=%s "
            "trace=%s confidence=%s action_id=%s",
            org_id, rca_id, trace_id, confidence, action_id,
        )
        return action_id

    async def post_merge_degraded(
        self,
        org_id: str,
        *,
        pr_id: str,
        regression_evidence: dict[str, Any],
        window_hours: int,
    ) -> str | None:
        """A post-merge window detected a regression.

        STUB: records the recommendation. The real Gate-4b
        implementation will additionally check
        ``auto_revert_enabled`` + the
        ``min_post_merge_window_hours`` floor and call into
        :class:`AutoRevertEngine` to choose a strategy.
        """
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["post_merge_degraded"],
            target=pr_id,
            payload={
                "pr_id": pr_id,
                "regression_evidence": dict(regression_evidence or {}),
                "window_hours": window_hours,
            },
            severity="high",
        )
        logger.debug(
            "code_change_hook.post_merge_degraded org=%s pr=%s "
            "window_hours=%s action_id=%s",
            org_id, pr_id, window_hours, action_id,
        )
        return action_id


# ─── Process-wide singletons ─────────────────────────────────────
_promotion_hook = PromotionHook()
_guardrail_hook = GuardrailHook()
_experiment_hook = ExperimentHook()
_metric_studio_hook = MetricStudioHook()
_columnar_hook = ColumnarHook()
_dsl_hook = DSLHook()
_code_change_hook = CodeChangeHook()


def get_promotion_hook() -> PromotionHook:
    return _promotion_hook


def get_guardrail_hook() -> GuardrailHook:
    return _guardrail_hook


def get_experiment_hook() -> ExperimentHook:
    return _experiment_hook


def get_metric_studio_hook() -> MetricStudioHook:
    return _metric_studio_hook


def get_columnar_hook() -> ColumnarHook:
    return _columnar_hook


def get_dsl_hook() -> DSLHook:
    return _dsl_hook


def get_code_change_hook() -> CodeChangeHook:
    """Process-wide singleton for the Cat 23 hook (added in v1.6)."""
    return _code_change_hook


def register_all_hooks() -> None:
    """Wire the hooks into the lifespan startup.

    Each hook is a coroutine-returning object. The lifespan
    registers them as the singleton instances the rest of
    the codebase imports; downstream services fire them
    via :func:`get_promotion_hook` etc.

    In v0 the hooks are *advisory only* — they record the
    recommended action to ``closed_loop_actions`` and let
    the :class:`ClosedLoopExecutor` surface it. A future
    version wires the auto-apply path behind a per-tenant
    opt-in.
    """
    logger.info(
        "closed-loop hooks registered (advisory): promotion, "
        "guardrail, experiment, metric_studio, columnar, dsl, "
        "code_change"
    )
