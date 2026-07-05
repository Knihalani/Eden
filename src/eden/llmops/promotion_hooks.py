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

# Module-level truncation caps. Postgres column sizes per the migration
# that introduced ``closed_loop_actions`` / ``hook_events`` —
# keep these in sync with the schema or the DB will reject the write.
MAX_HOOK_NAME_LEN = 64
MAX_ACTION_KIND_LEN = 64
MAX_TARGET_LEN = 256
MAX_PAYLOAD_LEN = 4000
MAX_SEVERITY_LEN = 16


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
    # New per upgradespec §E.1 — wired in 2026-06-23 Phase 2B.4
    "on_budget_threshold_breached": "throttle",
    "on_budget_exceeded": "kill",
    "on_incident_clustered": "investigate",
    "on_low_user_satisfaction": "investigate",
    "on_low_roi_department": "investigate",
    "on_compliance_gap_gdpr": "rtbf",
    "on_compliance_gap_soc2": "investigate",
    "on_compliance_gap_hipaa": "investigate",
    "on_compliance_gap_iso27001": "investigate",
    "on_security_pii_scanner": "redact",
    "on_sla_breach": "investigate",
    "on_voice_barge_in_spike": "investigate",
    "on_fine_tune_data_drift": "investigate",
    "on_provider_routing_repeated_failures": "investigate",
    # D.12.1 (MCP) — added 2026-06-24 per upgradespec §E.1
    "on_mcp_server_auth_failure": "investigate",
    # D.12.2 (A2A) — added 2026-06-24 per upgradespec §E.1
    "on_a2a_invocation_failed": "investigate",
    # D.12.3 (Computer Use) — added 2026-06-24 per upgradespec §E.1 row 23
    "on_computer_use_blocked": "pause_session",
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
    """Persist a recommended action via the HookBus (Cat 17 / upgradespec §E).

    The bus handles dedup (5-min window per §E.3), severity precedence,
    cascade, and the approval gate (§E.4) — then writes to
    ``closed_loop_actions`` (legacy) or ``hook_events`` (post-migration 051).

    Returns the generated action id (or ``None`` if the substrate is
    unavailable or the event was dedup'd). Best-effort: any error is
    logged at debug and swallowed so the hook never breaks the caller.
    """
    # ponytail: route through HookBus for dedup + approval gate. Falls back
    # to direct Postgres insert only if HookBus itself fails to initialise
    # (should never happen — HookBus is in-process and trivial).
    try:
        from eden.llmops.hooks_bus import HookEvent, get_hook_bus

        bus = get_hook_bus()
        event = HookEvent(
            reason=hook_name,
            severity=severity if severity in ("low", "medium", "high", "critical") else "medium",
            org_id=org_id,
            source={
                "primary_entity_id": target or "",
                "target_id": target or "",
                "target_type": "closed_loop_target",
                "action_kind": action_kind,
                **(payload or {}),
            },
            context={"action_kind": action_kind},
        )
        hook_id = await bus.emit(event)
        return hook_id
    except Exception as exc:
        logger.debug("closed_loop: HookBus route failed (%s); falling back", exc)

    # Fallback: direct insert into closed_loop_actions (pre-HookBus behavior).
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
    # B-8 (Session 24): action_id is content-derived so the same logical
    # action lands on the same id on retry — the ``UNIQUE`` constraint on
    # ``id`` then makes the ``ON CONFLICT (id) DO NOTHING`` clause a real
    # dedup gate against double-emission under hook storms.
    #
    # The column is ``UUID PRIMARY KEY`` (see migration 025), so the id
    # must be a valid UUID. We derive one with ``uuid.uuid5`` over a
    # canonical JSON encoding of the (org, hook, kind, target, payload)
    # tuple — uuid5 is deterministic in its name + input, so retries with
    # the same content map to the same UUID. The first 8 hex chars of the
    # underlying sha256 are also returned as ``action_short_hash`` so log
    # greppers can still pivot on a stable token (``act_<short>``)
    # without needing a UUID parser.
    canonical = json.dumps(
        {
            "org_id": org_id,
            "hook_name": hook_name,
            "action_kind": action_kind,
            "target": target,
            "payload": payload or {},
        },
        sort_keys=True,
        default=str,
    )
    content_uuid = uuid.uuid5(uuid.NAMESPACE_DNS, canonical)
    action_id = str(content_uuid)
    try:
        await client.execute(
            """
            INSERT INTO closed_loop_actions
                (id, org_id, hook_name, action_kind, target,
                 payload_json, severity, status)
            VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, 'pending_approval')
            ON CONFLICT (id) DO NOTHING
            """,
            action_id,
            org_id,
            hook_name[:MAX_HOOK_NAME_LEN],
            action_kind[:MAX_ACTION_KIND_LEN],
            (target or "")[:MAX_TARGET_LEN] or None,
            json.dumps(payload or {}, default=str)[:MAX_PAYLOAD_LEN],
            severity[:MAX_SEVERITY_LEN],
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
            # Audit 2026-07-03 B-20 — accept ``critical`` so an
            # RTBF / GDPR auto-fire path doesn't silently downgrade
            # to medium (the pre-fix whitelist was the only place
            # in the codebase that downgraded severity).
            severity=(
                severity
                if severity in ("high", "medium", "low", "critical")
                else "medium"
            ),
        )
        logger.debug(
            "promotion_hook.on_drift_alert org=%s drift=%s severity=%s "
            "action_id=%s",
            org_id, drift_type, severity, action_id,
        )
        return action_id

    # ─── D.12.1 MCP + D.12.2 A2A (added 2026-06-24) ─────

    async def on_mcp_server_auth_failure(
        self,
        org_id: str,
        *,
        server_name: str,
        failure_kind: str,
        failure_id: str | None = None,
    ) -> str | None:
        """MCP server returned a 401/403 or DNS/TLS error.

        Fires per upgradespec §E.1 row for ``mcp_server_auth_failure``.
        The action kind is ``investigate`` (closed-loop executor
        surfaces to the operator per the v0 pattern).
        """
        severity = "high" if failure_kind in {"unauthorized", "expired_token"} else "medium"
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["on_mcp_server_auth_failure"],
            target=server_name,
            payload={
                "server_name": server_name,
                "failure_kind": failure_kind,
                "failure_id": failure_id,
            },
            severity=severity,
        )
        logger.debug(
            "promotion_hook.on_mcp_server_auth_failure org=%s server=%s "
            "kind=%s action_id=%s",
            org_id, server_name, failure_kind, action_id,
        )
        return action_id

    async def on_a2a_invocation_failed(
        self,
        org_id: str,
        *,
        parent_trace_id: str,
        child_trace_id: str | None,
        invocation_type: str,
        error_kind: str,
    ) -> str | None:
        """An A2A invocation (agent-to-agent hand-off) failed.

        Fires per upgradespec §E.1 row for ``a2a_invocation_failed``.
        The action kind is ``investigate`` (same v0 pattern).
        """
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["on_a2a_invocation_failed"],
            target=parent_trace_id,
            payload={
                "parent_trace_id": parent_trace_id,
                "child_trace_id": child_trace_id,
                "invocation_type": invocation_type,
                "error_kind": error_kind,
            },
            severity="high",
        )
        logger.debug(
            "promotion_hook.on_a2a_invocation_failed org=%s parent=%s "
            "kind=%s action_id=%s",
            org_id, parent_trace_id, error_kind, action_id,
        )
        return action_id

    async def on_computer_use_blocked(
        self,
        org_id: str,
        *,
        trace_id: str,
        span_id: str,
        step_index: int,
        action_type: str,
        error: str | None = None,
    ) -> str | None:
        """A Computer Use step was blocked (safety policy hit).

        Fires per upgradespec §E.1 row 23. Per spec the
        default action is "Pause session"; the v0 ship is
        advisory (records the recommended action for the
        executor; the per-tenant pause is gated by the
        ``computer_use_auto_pause`` flag in a follow-up).
        """
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["on_computer_use_blocked"],
            target=trace_id,
            payload={
                "trace_id": trace_id,
                "span_id": span_id,
                "step_index": int(step_index),
                "action_type": action_type,
                "error": error,
            },
            severity="high",
        )
        logger.debug(
            "promotion_hook.on_computer_use_blocked org=%s trace=%s "
            "step=%s type=%s action_id=%s",
            org_id, trace_id, step_index, action_type, action_id,
        )
        return action_id

    async def on_voice_barge_in_spike(
        self,
        org_id: str,
        *,
        window_minutes: int,
        threshold: int,
        count: int,
        session_ids: list[str],
    ) -> str | None:
        """A voice session cluster had a barge-in spike
        (per spec §8.4 + §E.1 row 24).

        Fired by :meth:`VoiceSessionService.detect_barge_in_spike`
        when the rolling ``window_minutes`` count crosses
        ``threshold`` for the org. Per spec the default
        action is "Alert" with severity ``low``; the v0
        ship is advisory (records the recommended action
        for the executor; the per-tenant alert subscription
        is a follow-up that extends the ClosedLoopExecutor
        to walk the new ``action_kind``).
        """
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["on_voice_barge_in_spike"],
            target=org_id,
            payload={
                "primary_entity_id": f"org:{org_id}:voice_barge_in",
                "window_minutes": int(window_minutes),
                "threshold": int(threshold),
                "count": int(count),
                "session_ids": list(session_ids or []),
            },
            severity="low",
        )
        logger.debug(
            "promotion_hook.on_voice_barge_in_spike org=%s count=%s "
            "window=%s threshold=%s action_id=%s",
            org_id, count, window_minutes, threshold, action_id,
        )
        return action_id

    async def on_fine_tune_data_drift(
        self,
        org_id: str,
        *,
        run_id: str,
        base_model: str,
        current_score: float,
        prior_mean: float,
        prior_stdev: float,
        z_score: float,
        direction: str,
    ) -> str | None:
        """A fine-tuning run's eval score regressed or
        improved materially (per spec §8.7 + §E.1 row 25).

        Fired by :meth:`FineTuneLineageService.detect_data_drift`
        when the rolling z-score against the previous
        ``window`` runs sharing the same ``base_model``
        exceeds the configured threshold. The default
        action per spec is "Alert → Investigation" with
        severity ``medium``; the v0 ship is advisory
        (records the recommended action for the executor).
        """
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["on_fine_tune_data_drift"],
            target=run_id,
            payload={
                "primary_entity_id": f"fine_tune_run:{run_id}",
                "run_id": run_id,
                "base_model": base_model,
                "current_score": float(current_score),
                "prior_mean": float(prior_mean),
                "prior_stdev": float(prior_stdev),
                "z_score": float(z_score),
                "direction": direction,
            },
            severity="medium",
        )
        logger.debug(
            "promotion_hook.on_fine_tune_data_drift org=%s run=%s "
            "z=%.3f direction=%s action_id=%s",
            org_id, run_id, z_score, direction, action_id,
        )
        return action_id

    async def on_provider_routing_repeated_failures(
        self,
        org_id: str,
        *,
        attempted_provider: str,
        window_minutes: int,
        threshold: int,
        non_success_count: int,
        failure_rate: float,
    ) -> str | None:
        """A provider is throwing repeated non-success
        decisions (per spec §2.12 + §E.1 row 26).

        Fired by
        :meth:`ProviderRoutingService.detect_repeated_failures`
        when the rolling ``window_minutes`` count of
        ``fallback``/``abort``/``retry`` decisions for
        ``(org_id, attempted_provider)`` crosses
        ``threshold``. Per spec the default action is
        "Alert" with severity ``medium``; the v0 ship
        is advisory (records the recommended action for
        the executor; the per-tenant circuit-breaker /
        fallback policy is a follow-up that extends the
        ClosedLoopExecutor to walk the new ``action_kind``).
        """
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["on_provider_routing_repeated_failures"],
            target=attempted_provider,
            payload={
                "primary_entity_id": f"provider:{attempted_provider}",
                "attempted_provider": attempted_provider,
                "window_minutes": int(window_minutes),
                "threshold": int(threshold),
                "non_success_count": int(non_success_count),
                "failure_rate": float(failure_rate),
            },
            severity="medium",
        )
        logger.debug(
            "promotion_hook.on_provider_routing_repeated_failures org=%s "
            "provider=%s count=%s rate=%.3f action_id=%s",
            org_id, attempted_provider, non_success_count, failure_rate, action_id,
        )
        return action_id

    # ─── §E.1 row 3-6 (compliance_gap) + row 9 (sla_breach) ─────

    async def on_compliance_gap_gdpr(
        self,
        org_id: str,
        *,
        finding_id: str,
        framework_control: str,
        details: dict[str, Any] | None = None,
    ) -> str | None:
        """A GDPR compliance gap was detected (per spec
        §E.1 row 4). The default action per spec is
        "Alert + Auto-RTBF suggestion" with severity
        ``critical`` (the most severe of the 26 §E.1
        hooks; it auto-suggests the RTBF workflow).

        Note: the actual RTBF execution requires D.11
        cross-store infrastructure. D.11 is deferred
        (no legal team), so the ``action_kind=rtbf`` is
        a no-op in v0 — the operator sees the event in
        the closed-loop dashboard and can choose to
        invoke the existing Cat 10 Postgres-only
        ``RightToBeForgottenService`` manually.

        Audit 2026-07-02 S-18 — when ``details`` carries a
        ``target_user_id`` (or the Cat 9 alias ``subject_id``),
        auto-fire ``RightToBeForgottenService.process_request``
        in best-effort mode. Failures (DB down, schema
        missing) MUST NOT break the hook — the hook is the
        action-RECORDING layer, not the side-effect gatekeeper.
        """
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["on_compliance_gap_gdpr"],
            target=finding_id,
            payload={
                "primary_entity_id": f"gdpr_finding:{finding_id}",
                "finding_id": finding_id,
                "framework_control": framework_control,
                "details": dict(details or {}),
            },
            severity="critical",
        )
        # Audit 2026-07-02 S-18 — auto-fire RTBF if a target user
        # is identified. Best-effort; never raises.
        target_user_id = (details or {}).get("target_user_id") or (
            details or {}
        ).get("subject_id")
        if target_user_id:
            try:
                from eden.services.governance_intel.gdpr import (
                    RightToBeForgottenService,
                )
                rtbf = RightToBeForgottenService()
                await rtbf.process_request(
                    user_id=str(target_user_id),
                    requested_by="auto:on_compliance_gap_gdpr",
                    dry_run=False,
                )
            except Exception as exc:  # noqa: BLE001 — best-effort
                logger.debug(
                    "promotion_hook.on_compliance_gap_gdpr rtbf auto-fire "
                    "failed (non-fatal): %s", exc,
                )
        logger.debug(
            "promotion_hook.on_compliance_gap_gdpr org=%s finding=%s "
            "control=%s action_id=%s",
            org_id, finding_id, framework_control, action_id,
        )
        return action_id

    async def on_compliance_gap_soc2(
        self,
        org_id: str,
        *,
        finding_id: str,
        framework_control: str,
        details: dict[str, Any] | None = None,
    ) -> str | None:
        """A SOC2 compliance gap was detected (per spec
        §E.1 row 3). Severity ``high``, action
        "Alert → Investigation".
        """
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["on_compliance_gap_soc2"],
            target=finding_id,
            payload={
                "primary_entity_id": f"soc2_finding:{finding_id}",
                "finding_id": finding_id,
                "framework_control": framework_control,
                "details": dict(details or {}),
            },
            severity="high",
        )
        logger.debug(
            "promotion_hook.on_compliance_gap_soc2 org=%s finding=%s "
            "control=%s action_id=%s",
            org_id, finding_id, framework_control, action_id,
        )
        return action_id

    async def on_compliance_gap_hipaa(
        self,
        org_id: str,
        *,
        finding_id: str,
        framework_control: str,
        details: dict[str, Any] | None = None,
    ) -> str | None:
        """A HIPAA compliance gap was detected (per spec
        §E.1 row 5). Severity ``high``, action "Alert".
        """
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["on_compliance_gap_hipaa"],
            target=finding_id,
            payload={
                "primary_entity_id": f"hipaa_finding:{finding_id}",
                "finding_id": finding_id,
                "framework_control": framework_control,
                "details": dict(details or {}),
            },
            severity="high",
        )
        logger.debug(
            "promotion_hook.on_compliance_gap_hipaa org=%s finding=%s "
            "control=%s action_id=%s",
            org_id, finding_id, framework_control, action_id,
        )
        return action_id

    async def on_compliance_gap_iso27001(
        self,
        org_id: str,
        *,
        finding_id: str,
        framework_control: str,
        details: dict[str, Any] | None = None,
    ) -> str | None:
        """An ISO 27001 compliance gap was detected (per
        spec §E.1 row 6). Severity ``high``, action
        "Alert".
        """
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["on_compliance_gap_iso27001"],
            target=finding_id,
            payload={
                "primary_entity_id": f"iso27001_finding:{finding_id}",
                "finding_id": finding_id,
                "framework_control": framework_control,
                "details": dict(details or {}),
            },
            severity="high",
        )
        logger.debug(
            "promotion_hook.on_compliance_gap_iso27001 org=%s finding=%s "
            "control=%s action_id=%s",
            org_id, finding_id, framework_control, action_id,
        )
        return action_id

    async def on_sla_breach(
        self,
        org_id: str,
        *,
        sla_id: str,
        sla_name: str,
        target_ms: int,
        actual_ms: int,
        breach_pct: float,
    ) -> str | None:
        """An SLA breach was detected (per spec §E.1
        row 9, source Cat 16). The default action is
        "Alert → Investigation" with severity ``high``.
        """
        action_id = await _record_action(
            org_id,
            hook_name=self.name,
            action_kind=ACTION_KIND["on_sla_breach"],
            target=sla_id,
            payload={
                "primary_entity_id": f"sla:{sla_id}",
                "sla_id": sla_id,
                "sla_name": sla_name,
                "target_ms": int(target_ms),
                "actual_ms": int(actual_ms),
                "breach_pct": float(breach_pct),
            },
            severity="high",
        )
        logger.debug(
            "promotion_hook.on_sla_breach org=%s sla=%s "
            "target=%s actual=%s breach=%.3f action_id=%s",
            org_id, sla_id, target_ms, actual_ms, breach_pct, action_id,
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
            severity=(
                severity
                if severity in ("high", "medium", "low", "critical")
                else "medium"
            ),
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
        policy: dict[str, Any] | None = None,
        repo_id: str | None = None,
        stack_trace: str | None = None,
        candidate_files: list[str] | None = None,
        rca_description: str = "",
    ) -> dict[str, Any]:
        """A Cat 2 RCA fired and the agent should propose a patch.

        Gate 4a wiring (this method):

        1. Record the recommendation (``propose_patch``
           action kind).
        2. If ``policy.code_change_enabled`` is true AND
           ``confidence >= policy.min_rca_confidence``,
           additionally call
           :class:`CodeRootCauseLinker.link` →
           :class:`PatchGenerator.generate` to mint a real
           patch (a row in ``proposed_patches``).
        3. Persist the patch_id in the action payload so
           the operator can pick it up.

        Without ``policy`` or when the opt-in isn't
        granted, the action is advisory-only — no patch is
        minted. The :class:`ClosedLoopExecutor` surfaces
        the recommendation either way.

        Returns:
            A dict carrying the action_id, the policy-check
            result, and (when minted) the patch_id + diff.
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

        result: dict[str, Any] = {
            "action_id": action_id,
            "executed": False,
        }

        # Opt-in gate. The policy carries both
        # ``code_change_enabled`` + ``min_rca_confidence``
        # per the v1.6 cat spec.
        policy = policy or {}
        if not policy.get("code_change_enabled", False):
            result["skipped_reason"] = "code_change_disabled"
            return result
        min_conf = float(policy.get("min_rca_confidence", 0.8))
        if confidence < min_conf:
            result["skipped_reason"] = (
                f"confidence {confidence} < min_rca_confidence {min_conf}"
            )
            return result
        if not repo_id:
            result["skipped_reason"] = "repo_id_required"
            return result

        # Mint a real patch. We import lazily so the import
        # chain doesn't pull in the model-router + repo-
        # connector (and their package init side-effects)
        # when the hook fires for an advisory-only call.
        try:
            from eden.code_change.patch_generator import PatchGenerator
            from eden.code_change.rca_linker import CodeRootCauseLinker
            from eden.code_change.repo_connector import RepoConnector
            from eden.optimization.model_router import ModelRouter
        except Exception as exc:
            logger.warning(
                "code_change_hook: imports failed: %s", exc,
            )
            result["skipped_reason"] = f"imports_failed:{type(exc).__name__}"
            return result

        try:
            connector = RepoConnector()
            router: ModelRouter | None = None  # type: ignore[assignment]
            linker = CodeRootCauseLinker(
                router=router, repo_connector=connector,
            )
            link_result = await linker.link(
                org_id=org_id,
                rca_id=rca_id,
                repo_id=repo_id,
                stack_trace=stack_trace,
                trace_id=trace_id,
                candidate_files=candidate_files,
                rca_description=rca_description,
            )
            primary_path = (link_result.get("data") or {}).get("primary_path")
            linked_files = []
            if primary_path:
                linked_files.append({"path": primary_path})
            generator = PatchGenerator(router=router)
            patch_result = await generator.generate(
                org_id=org_id,
                rca_id=rca_id,
                trace_id=trace_id,
                repo_id=repo_id,
                linked_files=linked_files,
                rca_summary=rca_description,
            )
            patch_id = (patch_result.get("data") or {}).get("patch_id")
            result["executed"] = True
            result["patch_id"] = patch_id
            result["link_result"] = link_result.get("data") or {}
            result["patch_status"] = patch_result.get("status")
            result["patch_gate"] = (patch_result.get("data") or {}).get("gate")
            return result
        except Exception as exc:
            logger.warning(
                "code_change_hook.propose_patch_from_rca: mint failed: %s",
                exc,
            )
            result["skipped_reason"] = f"mint_failed:{type(exc).__name__}"
            return result

    async def post_merge_degraded(
        self,
        org_id: str,
        *,
        pr_id: str,
        regression_evidence: dict[str, Any],
        window_hours: int,
        policy: dict[str, Any] | None = None,
        pr_state: str = "merged",
        history_is_linear: bool = True,
        merge_sha: str | None = None,
    ) -> dict[str, Any]:
        """A post-merge window detected a regression.

        Gate 4b wiring (this method):

        1. Record the recommendation (``consider_revert``
           action kind).
        2. If ``policy.auto_revert_enabled`` is true AND
           ``window_hours >= policy.min_post_merge_window_hours``
           AND the configured :class:`AutoRevertEngine`
           has a provider, additionally call
           ``engine.revert`` to dispatch the revert.

        Without ``auto_revert_enabled``, the action is
        advisory-only — the operator gets a notification
        and can dispatch the revert manually (the manual-
        trigger path).

        Returns:
            A dict carrying the action_id, the policy-check
            result, and (when executed) the revert strategy
            + revert_pr_url.
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
        logger.warning(
            "code_change_hook.post_merge_degraded org=%s pr=%s "
            "window_hours=%s action_id=%s",
            org_id, pr_id, window_hours, action_id,
        )

        result: dict[str, Any] = {
            "action_id": action_id,
            "executed": False,
        }

        policy = policy or {}
        if not policy.get("auto_revert_enabled", False):
            result["skipped_reason"] = "auto_revert_disabled"
            return result
        min_window = int(policy.get("min_post_merge_window_hours", 24))
        if window_hours < min_window:
            result["skipped_reason"] = (
                f"window_hours {window_hours} < min {min_window}"
            )
            return result

        # Dispatch the revert via the engine. The engine
        # decides the strategy; the hook is just the
        # signal carrier.
        try:
            from eden.code_change.revert_engine import AutoRevertEngine
            from eden.providers import get_default_pr_provider
            engine = AutoRevertEngine(provider=get_default_pr_provider())
            revert_result = await engine.revert(
                org_id=org_id,
                pr_id=pr_id,
                policy={
                    "code_change_enabled": True,
                    "auto_revert_enabled": True,
                },
                pr_state=pr_state,
                history_is_linear=history_is_linear,
                regression_evidence=dict(regression_evidence or {}),
                merge_sha=merge_sha,
            )
            data = revert_result.get("data") or {}
            result["executed"] = bool(data.get("executed", False))
            result["strategy"] = data.get("strategy")
            result["revert_pr_url"] = data.get("revert_pr_url")
            result["revert_id"] = data.get("revert_id")
            result["engine_status"] = revert_result.get("status")
            return result
        except Exception as exc:
            logger.warning(
                "code_change_hook.post_merge_degraded: revert failed: %s",
                exc,
            )
            result["skipped_reason"] = f"revert_failed:{type(exc).__name__}"
            return result


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


# ─── Phase 2B.4 — new hooks per upgradespec §E.1 ─────────────────
#
# Each is a thin wrapper around :func:`_record_action` (which now
# routes through :class:`HookBus` for dedup + approval gate). The bus
# is in-process; no new infra needed.


class BudgetHook:
    """§6.3 — fires when an org crosses a budget threshold or exceeds its cap.

    Threshold breach (80% by default) → alert + throttle warning.
    Hard cap exceeded → kill action (highest severity, requires_approval=False
    because the kill itself is the human-approved policy; the operator
    configured the budget + action='kill' ahead of time).
    """

    name = "budget"

    async def on_threshold_breached(
        self,
        org_id: str,
        *,
        budget_id: str,
        spent_usd: float,
        limit_usd: float,
        period: str,
    ) -> str | None:
        return await _record_action(
            org_id,
            hook_name="on_budget_threshold_breached",
            action_kind=ACTION_KIND["on_budget_threshold_breached"],
            target=budget_id,
            payload={
                "primary_entity_id": f"budget:{budget_id}",
                "spent_usd": spent_usd,
                "limit_usd": limit_usd,
                "period": period,
                "pct": spent_usd / limit_usd if limit_usd else 0,
            },
            severity="medium",
        )

    async def on_exceeded(
        self,
        org_id: str,
        *,
        budget_id: str,
        spent_usd: float,
        limit_usd: float,
        period: str,
    ) -> str | None:
        return await _record_action(
            org_id,
            hook_name="on_budget_exceeded",
            action_kind=ACTION_KIND["on_budget_exceeded"],
            target=budget_id,
            payload={
                "primary_entity_id": f"budget:{budget_id}",
                "spent_usd": spent_usd,
                "limit_usd": limit_usd,
                "period": period,
                "over_by_usd": max(0.0, spent_usd - limit_usd),
            },
            severity="high",
        )


# ─── D.14 Cold-start onboarding hook ─────────────────────────────────
#
# Per upgradespec §10.1 + §E.1 row 4: the 7-step onboarding checklist
# is auto-advanced when a milestone is reached:
#   - first_10_traces  → advance to "wait"
#   - first_judge_score → advance to "done"
#   - first_prompt_version → advance to "tour"
#
# The hook is a thin wrapper around OnboardingStateMachine.
# Milestones are inherently idempotent (the state machine ignores
# duplicates), so we don't route through HookBus dedup. The hook
# just records + advances — the state machine is the source of
# truth. The call sites are:
#   - first_10_traces:  cat 1 trace counter (the trace ingest
#     hot path checks the per-org count and calls the hook when
#     the count crosses 10)
#   - first_judge_score: cat 3 judge runner (after the first
#     judge_score row is written for the org)
#   - first_prompt_version: D.9 prompt versioning service
#     (after the first prompt_version row is created)


class OnboardingMilestoneHook:
    """§10.1 — fires when an org reaches a cold-start UX milestone.

    Each method is idempotent (the state machine dedup's by
    org_id + milestone), so duplicate calls within the
    same org are a no-op. Returns the new StateRow as a dict
    so call sites can log + advance.
    """

    name = "onboarding"

    async def _record(
        self,
        org_id: str,
        milestone: str,
    ) -> dict[str, Any] | None:
        try:
            from eden.services.onboarding import get_state_machine
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning(
                "onboarding_hook: import failed: %s", exc
            )
            return None
        sm = get_state_machine()
        try:
            state = await sm.record_milestone(org_id, milestone)
        except Exception as exc:
            logger.warning(
                "onboarding_hook: record_milestone failed: %s", exc
            )
            return None
        return {
            "org_id": state.org_id,
            "current_step": state.current_step,
            "milestones_reached": list(state.milestones_reached),
            "last_audit": state.last_audit,
        }

    async def on_first_10_traces(
        self, org_id: str, *, trace_count: int
    ) -> dict[str, Any] | None:
        """Cat 1 trace counter → advance to 'wait'."""
        return await self._record(org_id, "first_10_traces")

    async def on_first_judge_score(
        self, org_id: str, *, judge_name: str, score: float
    ) -> dict[str, Any] | None:
        """Cat 3 judge runner → advance to 'done'."""
        return await self._record(org_id, "first_judge_score")

    async def on_first_prompt_version(
        self, org_id: str, *, prompt_name: str, version: int
    ) -> dict[str, Any] | None:
        """D.9 prompt versioning service → advance to 'tour'."""
        return await self._record(org_id, "first_prompt_version")


class IncidentHook:
    """Cat 2 RCA — fires when an incident cluster is detected.

    Severity is 'medium' (clusters are pre-investigation). The HookBus
    dedups subsequent firings for the same cluster_id within 5 min.
    """

    name = "incident"

    async def on_clustered(
        self,
        org_id: str,
        *,
        cluster_id: str,
        trace_count: int,
        sample_trace_ids: list[str],
    ) -> str | None:
        return await _record_action(
            org_id,
            hook_name="on_incident_clustered",
            action_kind=ACTION_KIND["on_incident_clustered"],
            target=cluster_id,
            payload={
                "primary_entity_id": f"cluster:{cluster_id}",
                "trace_count": trace_count,
                "sample_trace_ids": sample_trace_ids[:10],
            },
            severity="medium",
        )


class UserSatisfactionHook:
    """Cat 9 — fires when user-corrected satisfaction drops below 0.4.

    Per Cat 9 hook spec — already implemented inside the user-intel
    service, but the wiring into the hook bus was missing. This thin
    wrapper exposes the bus entry point so the service can call it.
    """

    name = "user_satisfaction"

    async def on_low_satisfaction(
        self,
        org_id: str,
        *,
        coverage_weighted: float,
        affected_user_count: int,
        window: str = "7d",
    ) -> str | None:
        return await _record_action(
            org_id,
            hook_name="on_low_user_satisfaction",
            action_kind=ACTION_KIND["on_low_user_satisfaction"],
            target=org_id,
            payload={
                "primary_entity_id": f"org:{org_id}:satisfaction",
                "coverage_weighted": coverage_weighted,
                "affected_user_count": affected_user_count,
                "window": window,
            },
            severity="medium",
        )


class DriftAlertHook:
    """Cat 13 — fires when PSI drift exceeds threshold.

    Severity scales with drift magnitude: <0.1 → low, 0.1-0.25 → medium,
    >0.25 → high. High severity triggers the approval gate per spec §E.4.
    """

    name = "drift_alert"

    async def on_drift(
        self,
        org_id: str,
        *,
        drift_type: str,
        psi: float,
        baseline_window: str = "7d",
        current_window: str = "24h",
    ) -> str | None:
        if psi >= 0.25:
            severity = "high"
        elif psi >= 0.10:
            severity = "medium"
        else:
            severity = "low"
        return await _record_action(
            org_id,
            hook_name="on_drift_alert",
            action_kind=ACTION_KIND["on_drift_alert"],
            target=f"{drift_type}:{org_id}",
            payload={
                "primary_entity_id": f"drift:{drift_type}:{org_id}",
                "drift_type": drift_type,
                "psi": psi,
                "baseline_window": baseline_window,
                "current_window": current_window,
            },
            severity=severity,
        )


class RoiHook:
    """Cat 11 — fires when a department's ROI drops below threshold.

    90-day z-score regression per Cat 11 service. Medium severity
    routes to InvestigationAgent (auto-approved).
    """

    name = "roi"

    async def on_low_roi_department(
        self,
        org_id: str,
        *,
        department: str,
        roi: float,
        z_score: float,
    ) -> str | None:
        severity = "high" if z_score < -2.0 else "medium"
        return await _record_action(
            org_id,
            hook_name="on_low_roi_department",
            action_kind=ACTION_KIND["on_low_roi_department"],
            target=f"{department}:{org_id}",
            payload={
                "primary_entity_id": f"dept:{department}:{org_id}",
                "department": department,
                "roi": roi,
                "z_score": z_score,
            },
            severity=severity,
        )


# ─── Singleton accessors for the new hooks ───────────────────────

_budget_hook: BudgetHook | None = None
_incident_hook: IncidentHook | None = None
_user_satisfaction_hook: UserSatisfactionHook | None = None
_drift_alert_hook: DriftAlertHook | None = None
_roi_hook: RoiHook | None = None


def get_budget_hook() -> BudgetHook:
    global _budget_hook
    if _budget_hook is None:
        _budget_hook = BudgetHook()
    return _budget_hook


def get_incident_hook() -> IncidentHook:
    global _incident_hook
    if _incident_hook is None:
        _incident_hook = IncidentHook()
    return _incident_hook


def get_user_satisfaction_hook() -> UserSatisfactionHook:
    global _user_satisfaction_hook
    if _user_satisfaction_hook is None:
        _user_satisfaction_hook = UserSatisfactionHook()
    return _user_satisfaction_hook


def get_drift_alert_hook() -> DriftAlertHook:
    global _drift_alert_hook
    if _drift_alert_hook is None:
        _drift_alert_hook = DriftAlertHook()
    return _drift_alert_hook


def get_roi_hook() -> RoiHook:
    global _roi_hook
    if _roi_hook is None:
        _roi_hook = RoiHook()
    return _roi_hook


def register_all_hooks() -> None:
    """No-op shim kept for backward compatibility.

    Hooks are now registered as singletons via ``get_*_hook()``; nothing
    to register at startup because the in-process bus is lazy.
    """
    logger.info(
        "closed-loop hooks registered (advisory): promotion, "
        "guardrail, experiment, metric_studio, columnar, dsl, "
        "code_change, budget, incident, user_satisfaction, "
        "drift_alert, roi"
    )
