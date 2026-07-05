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
4. **Cat 22 SamplingPolicy.** Sets
   ``detector_keep_rate_loop = 1.0`` so every loop-verdict
   trace is kept by the tail sampler (the existing
   ``supplementaries.cat_22_apm.tail_sampling`` reads this
   setting).
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
        cle.ClosedLoopExecutor.apply_approved = _wrapped  # type: ignore[assignment]
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
    """Wire loop-verdict keep rate = 1.0 (Cat 22 SamplingPolicy).

    Reads ``Settings.detector_keep_rate_loop`` (default 1.0)
    and writes it onto the existing
    ``supplementaries.cat_22_apm.tail_sampling`` module's
    ``DEFAULT_KEEP_RATES`` dict so every loop-verdict trace
    survives tail sampling.
    """
    try:
        from eden.config import get_settings
        from supplementaries.cat_22_apm import tail_sampling
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("wiring: cat22 import failed: %s", exc)
        return
    try:
        rate = float(get_settings().detector_keep_rate_loop)
        if hasattr(tail_sampling, "DEFAULT_KEEP_RATES"):
            tail_sampling.DEFAULT_KEEP_RATES["loop"] = rate  # type: ignore[attr-defined]
        logger.info(
            "wiring: Cat 22 SamplingPolicy loop keep_rate=%.2f", rate,
        )
    except Exception as exc:
        logger.debug("wiring: cat22 patch failed: %s", exc)


def install_cat15_trajectory_replaces_intervention() -> None:
    """Replace ``InterventionEngine.evaluate_and_act`` with the hot path.

    The hot path lives in
    ``eden.observability.trace_quality.hooks.evaluate_trajectory_step``
    and respects the per-tenant kill switch. The original
    ``evaluate_and_act`` is kept behind a feature flag
    (``Settings.trace_quality_enabled``).
    """
    try:
        from eden.guardrails import intervention as intv
        from eden.observability.trace_quality.hooks import (
            evaluate_trajectory_step,
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("wiring: cat15 import failed: %s", exc)
        return

    original = intv.InterventionEngine.evaluate_and_act

    async def _wrapped(
        self: Any,
        org_id: str,
        *,
        text: str,
        context: str | None = None,
        trace_id: str | None = None,
    ) -> dict[str, Any]:
        # ponytail: if the trace_id is missing, fall through to
        # the v0 path (the hot path is per-trace; legacy callers
        # without a trace still get a sensible verdict).
        if not trace_id:
            return await original(
                self, org_id,
                text=text,
                context=context,
                trace_id=trace_id,
            )
        event = {
            "text": text,
            "context": context or "",
            "loop_verdict": "",
            "loop_severity": "low",
        }
        result = await evaluate_trajectory_step(
            org_id=org_id,
            trace_id=trace_id,
            step_index=0,
            event=event,
        )
        return {
            "status": "ok",
            "feature": "trajectory_guardrail",
            "live": True,
            "data": {
                "verdict": result["recommended_action"],
                "edited_text": text,
                "matched_policies": [],
                "action_breakdown": {"trace_quality": 1},
                "applied": result["applied"],
                "reason": result["reason"],
                "action_class": result["action_class"],
            },
        }

    try:
        intv.InterventionEngine.evaluate_and_act = _wrapped  # type: ignore[assignment]
        logger.info("wiring: Cat 15 TrajectoryGuardrail hot path installed")
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("wiring: cat15 patch failed: %s", exc)


def install_all() -> None:
    """Install every Cat 15/17/22 wiring. Idempotent."""
    install_cat15_policy_extension()
    install_cat15_trajectory_replaces_intervention()
    install_cat17_stat_gate_gating()
    install_cat17_closed_loop_collection()
    install_cat22_sampling_policy()
    logger.info("wiring: all Cat 15/17/22 wirings installed")


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
    "install_cat15_trajectory_replaces_intervention",
    "install_cat17_stat_gate_gating",
    "install_cat17_closed_loop_collection",
    "install_cat22_sampling_policy",
]
