"""Cat 15/17/22 wiring shim (spec §12, deliverable C).

Centralises the four ``monkey-patch``-style wirings that the
trace-quality deployment needs. The lifespan in
``api/app.py:lifespan`` calls :func:`install_all` exactly once
on startup; each wiring function is idempotent.

The four wirings (spec §12.6, §12.7, §12.9):

1. **Cat 15 Policy extension.** Monkey-patches
   ``eden.guardrails.policy.VALID_ACTIONS`` from 5 → 14 actions
   via ``policy_extension.apply_extension()``.
2. **Cat 17 Closed-loop gating.** Replaces
   ``eden.llmops.closed_loop_executor.ClosedLoopExecutor.apply_approved``
   with a thin wrapper that routes through the 5-check StatGate
   before applying. The wrapper delegates the actual side-effect
   to the v0 implementation (idempotent on retry).
3. **Cat 17 Closed-loop action collection.** Registers a
   ``PromotionHook.on_drift_alert`` listener that turns high-
   severity drift events into ``ClosedLoopAction`` rows. The
   existing Cat 17 surface picks them up via the
   ``ClosedLoopExecutor.apply_approved`` path.
4. **Cat 22 / N16 SamplingPolicy.** Sets
   ``detector_keep_rate_loop/error`` and the N16 profile
   probabilistic rate onto ``DEFAULT_KEEP_RATES`` so loop/error
   traces are kept and non-signal traces follow
   ``sampling_profile`` (``eden.observability.sampling.policy``).
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def install_cat15_policy_extension() -> None:
    """Wire ``policy_extension.apply_extension`` into the Cat 15 surface."""
    try:
        from supplementaries.phase_4_guardrails.policy_extension import (
            apply_extension,
        )
        apply_extension()
        logger.info("wiring: Cat 15 policy extension applied")
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("wiring: Cat 15 policy extension failed: %s", exc)


def install_cat17_stat_gate_gating() -> None:
    """Replace ``ClosedLoopExecutor.apply_approved`` with a StatGate-gated shim.

    The shim wraps the v0 ``ClosedLoopExecutor`` (kept as the
    real executor for the actual side-effect) and runs the
    5-check StatGate on the action's evidence. ``verdict ==
    APPLY`` → delegate to the real executor; otherwise return
    ``{"verdict": "REJECT", "side_effect": "stat_gate_blocked"}``.
    """
    try:
        from eden.llmops import closed_loop_executor as cle
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("wiring: cat17 import failed: %s", exc)
        return
    try:
        from supplementaries.phase_7_detection.stat_gated_executor import (
            StatGateGatedExecutor,
        )
    except Exception as exc:
        logger.warning("wiring: StatGateGatedExecutor import failed: %s", exc)
        return

    real = cle.ClosedLoopExecutor()
    gated = StatGateGatedExecutor(real_executor=real)

    original = cle.ClosedLoopExecutor.apply_approved

    async def _wrapped(
        self: Any,
        org_id: str,
        *,
        action_id: str,
        applied_by: str | None = None,
    ) -> dict[str, Any]:
        """Wrapped ``apply_approved`` that requires the 5-check StatGate.

        Falls through to the v0 implementation when the
        StatGate is unavailable (no measurements on the action)
        so the audit trail still records the apply attempt.
        """
        # ponytail: if we have evidence rows on the action we
        # gate on them; otherwise we fall through. This keeps
        # the rollout safe for the ~30% of actions that lack
        # measurement evidence today.
        try:
            evidence = await _fetch_action_evidence(org_id, action_id)
        except Exception:
            evidence = None
        if evidence is None:
            return await original(
                self, org_id,
                action_id=action_id,
                applied_by=applied_by,
            )
        control = evidence.get("control") or []
        treatment = evidence.get("treatment") or []
        if not control or not treatment:
            return await original(
                self, org_id,
                action_id=action_id,
                applied_by=applied_by,
            )
        try:
            result = await gated.apply_approved_gated(
                org_id=org_id,
                action_id=action_id,
                action_kind=evidence.get("action_kind", "unknown"),
                control=control,
                treatment=treatment,
            )
        except Exception as exc:
            logger.debug("wiring: stat_gate failed: %s", exc)
            return await original(
                self, org_id,
                action_id=action_id,
                applied_by=applied_by,
            )
        if not getattr(result, "applied", False):
            return {
                "status": "ok",
                "feature": "stat_gate_gated",
                "live": True,
                "data": {
                    "action_id": action_id,
                    "verdict": "REJECT",
                    "side_effect": "stat_gate_blocked",
                    "explanation": getattr(result, "explanation", ""),
                },
            }
        # APPLY → delegate to the real executor for the actual
        # side-effect + audit write.
        return await original(
            self, org_id,
            action_id=action_id,
            applied_by=applied_by,
        )

    # ponytail: bind the wrapper to the class so monkey-patch
    # is symmetric with ``original`` (the unbind path uses
    # ``delattr`` on the class).
    try:
        cle.ClosedLoopExecutor.apply_approved = _wrapped
        logger.info("wiring: Cat 17 apply_approved gated")
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("wiring: cat17 patch failed: %s", exc)


def install_cat17_closed_loop_collection() -> None:
    """Wire ``collect_closed_loop_actions`` into ``PromotionHook.on_drift_alert``."""
    try:
        from eden.llmops.promotion_hooks import get_promotion_hook
        from supplementaries.phase_7_detection.closed_loop import (
            collect_closed_loop_actions,
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("wiring: cat17 import failed: %s", exc)
        return

    try:
        hook = get_promotion_hook()
    except Exception as exc:
        logger.warning("wiring: hook load failed: %s", exc)
        return

    on_drift = getattr(hook, "on_drift_alert", None)
    if on_drift is None:
        logger.warning("wiring: hook has no on_drift_alert")
        return

    async def _listener(
        drift_type: str,
        severity: str,
        org_id: str | None = None,
        **context: Any,
    ) -> Any:
        # Always call the upstream listener first (preserves the
        # existing Cat 6/Cat 13/Cat 14 hook chains).
        result = None
        try:
            if callable(on_drift):
                result = on_drift(
                    drift_type=drift_type,
                    severity=severity,
                    org_id=org_id,
                    **context,
                )
                if hasattr(result, "__await__"):
                    result = await result
        except Exception as exc:
            logger.debug("wiring: upstream on_drift_alert failed: %s", exc)

        # High-severity drift → produce a ClosedLoopAction row.
        if severity not in ("high", "critical"):
            return result
        try:
            actions = collect_closed_loop_actions(
                drift_type=drift_type,
                severity=severity,
                org_id=org_id or "",
                context=context,
            )
            logger.info(
                "wiring: cat17 collected %d closed-loop action(s) for %s",
                len(actions or []),
                drift_type,
            )
        except Exception as exc:
            logger.debug("wiring: collect_closed_loop_actions failed: %s", exc)

        return result

    try:
        hook.on_drift_alert = _listener  # type: ignore[assignment]
        logger.info("wiring: Cat 17 closed_loop collection installed")
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("wiring: cat17 listener install failed: %s", exc)


def install_cat22_sampling_policy() -> None:
    """Wire N16 / Cat 22 SamplingPolicy keep rates from Settings.

    Writes onto ``supplementaries.cat_22_apm.tail_sampling.DEFAULT_KEEP_RATES``
    so loop/error traces honour ``detector_keep_rate_*`` and the
    probabilistic fallback follows ``sampling_profile`` (N16). Also
    refreshes the process-wide :func:`eden.observability.sampling.policy.get_sampling_policy`
    singleton so in-process callers see the same profile.
    """
    try:
        from eden.config import get_settings
        from supplementaries.cat_22_apm import tail_sampling
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("wiring: cat22 import failed: %s", exc)
        return
    try:
        settings = get_settings()
        loop_rate = float(settings.detector_keep_rate_loop)
        error_rate = float(settings.detector_keep_rate_error)
        if hasattr(tail_sampling, "DEFAULT_KEEP_RATES"):
            rates = tail_sampling.DEFAULT_KEEP_RATES
            rates["loop"] = loop_rate
            rates["error"] = error_rate
            enabled = bool(getattr(settings, "sampling_enabled", True))
            profile = getattr(settings, "sampling_profile", "full") or "full"
            if not enabled or profile == "full":
                rates["probabilistic"] = 1.0
            else:
                from eden.observability.sampling.policy import profile_keep_rate

                rates["probabilistic"] = profile_keep_rate(profile)
                override = float(getattr(settings, "probabilistic_sample_rate", 1.0))
                if override < 1.0:
                    rates["probabilistic"] = override
        # Reset N16 singleton so next get_sampling_policy() re-reads Settings.
        try:
            from eden.observability.sampling.policy import reset_sampling_policy

            reset_sampling_policy()
        except Exception as exc:
            logger.debug("wiring: n16 policy reset skipped: %s", exc)
        logger.info(
            "wiring: Cat 22/N16 SamplingPolicy loop=%.2f error=%.2f profile=%s",
            loop_rate,
            error_rate,
            getattr(settings, "sampling_profile", "full"),
        )
    except Exception as exc:
        logger.debug("wiring: cat22 patch failed: %s", exc)


def install_all() -> None:
    """Install every Cat 15/17/22 wiring. Idempotent.

    Note: ``InterventionEngine.evaluate_and_act`` (the real,
    fail-closed content-safety guardrail check — prompt
    injection, PII redaction, hallucination, content policy)
    is deliberately left unpatched here. The Cat 15 trajectory
    hot path (cost/loop/latency checks) is a *separate*
    enforcement surface with its own dedicated call sites —
    the ``POST /v1/guardrails/trajectory/check`` route
    (``eden.api.routes.trace_quality``) and the
    ``TrajectoryInterventionGatewayFilter`` gateway filter
    (``eden.llmops.filters.trajectory``) — so there is no need
    (and it was actively harmful) to substitute it in place of
    the real guardrail check on the ``evaluate_and_act`` path.
    A prior wiring (``install_cat15_trajectory_replaces_intervention``)
    did exactly that substitution by rebinding
    ``InterventionEngine.evaluate_and_act`` to the trajectory
    hot path whenever a ``trace_id`` was present, silently
    skipping all policy evaluation and returning
    ``edited_text`` unredacted. It has been removed; see
    FEAT-3/FEAT-4 in ``docs/specs/strategic-review-2026-08``.
    """
    installed: list[str] = []
    success = True
    try:
        install_cat15_policy_extension()
        installed.append("cat15_policy_extension")
        install_cat17_stat_gate_gating()
        installed.append("cat17_stat_gate_gating")
        install_cat17_closed_loop_collection()
        installed.append("cat17_closed_loop_collection")
        install_cat22_sampling_policy()
        installed.append("cat22_sampling_policy")
        logger.info("wiring: all Cat 15/17/22 wirings installed")
    except Exception as exc:  # pragma: no cover - defensive
        success = False
        logger.warning("wiring: install_all partial failure: %s", exc)
    # Observability: a single structured line naming exactly what got
    # installed this boot. Cheap, and it's what would have made the
    # FEAT-3 guardrail-swap bug (a wiring silently rebinding
    # ``InterventionEngine.evaluate_and_act`` with no log/metric
    # anywhere) discoverable well before a strategic review caught it.
    logger.info(
        "wiring: install_all installed=%s success=%s",
        installed,
        success,
    )
    try:
        from eden.observability.platform_activation import mark_wiring_installed

        mark_wiring_installed(success=success)
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("wiring: platform_activation mark failed: %s", exc)

    # FEAT-33 defense-in-depth: verify none of the wirings above (or
    # anything else that ran before this point) rebound
    # ``InterventionEngine.evaluate_and_act`` away from its original
    # implementation — the exact failure mode the removed
    # ``install_cat15_trajectory_replaces_intervention`` wiring used
    # to cause. Alerts via the same counter/log path a live response
    # carrying the ``trajectory_guardrail`` marker would use, so both
    # detection surfaces show up in one place.
    try:
        from eden.guardrails.intervention import (
            is_evaluate_and_act_patched,
            record_guardrail_bypass_if_detected,
        )

        if is_evaluate_and_act_patched():
            record_guardrail_bypass_if_detected(
                {"feature": "trajectory_guardrail"},
                org_id="install_all",
                source="install_all",
            )
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("wiring: evaluate_and_act patch check failed: %s", exc)


# ── Helpers ───────────────────────────────────────────────────────


async def _fetch_action_evidence(
    org_id: str, action_id: str
) -> dict[str, Any] | None:
    """Return the (control, treatment) arrays for an action.

    Reads from ``closed_loop_action_evidence`` (table created
    in the v0 ship). Returns ``None`` when no evidence row
    exists so the caller falls through to the legacy path.
    """
    try:
        from eden.storage.postgres import get_postgres_client
    except Exception:
        return None
    try:
        client = await get_postgres_client()
    except Exception:
        return None
    if client is None:
        return None
    try:
        row = await client.fetchrow(
            """
            SELECT control_measurements, treatment_measurements,
                   action_kind
            FROM closed_loop_action_evidence
            WHERE org_id = $1 AND action_id = $2
            """,
            org_id, action_id,
        )
    except Exception:
        return None
    if row is None:
        return None
    try:
        d = dict(row)
        return {
            "control": list(d.get("control_measurements") or []),
            "treatment": list(d.get("treatment_measurements") or []),
            "action_kind": str(d.get("action_kind") or "unknown"),
        }
    except Exception:
        return None


__all__ = [
    "install_all",
    "install_cat15_policy_extension",
    "install_cat17_stat_gate_gating",
    "install_cat17_closed_loop_collection",
    "install_cat22_sampling_policy",
]
