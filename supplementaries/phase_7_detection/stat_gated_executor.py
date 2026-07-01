"""§12.7 spec implementation — StatGate-gated apply_approved wrapper.

Reference: eden-trace-quality-system-spec.md §12.7 + §4 Phase 6.

The existing `closed_loop_executor.py:ClosedLoopExecutor.apply_approved`
is currently `v0_noop` (per spec: "v0 ships a best-effort no-op
side effect").

This module provides `StatGateGatedExecutor` — a wrapper that:
  1. Computes the 5-check StatGate on the action's effect measurements
     (control vs. treatment)
  2. If gate accepts: applies the action via the real ClosedLoopExecutor
  3. If gate rejects: logs the rejection and returns without applying

This is the §12.7 "replace apply_approved v0_noop with StatGate-gated
action executor" deliverable.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Sequence

from supplementaries.phase_6_stat_gate.gate import (
    GateEvidence,
    evaluate as stat_gate_evaluate,
)


@dataclass(frozen=True)
class ApplyApprovedResult:
    """Result of a StatGate-gated apply_approved call."""

    action_id: str
    applied: bool           # True if the action was applied
    gate_evidence: GateEvidence
    side_effect_log: str    # human-readable description of what was/would-be applied


class StatGateGatedExecutor:
    """StatGate-gated wrapper around ClosedLoopExecutor.apply_approved.

    Usage:
        executor = StatGateGatedExecutor(real_executor)
        result = await executor.apply_approved_gated(
            org_id="org_1",
            action_id="action_xyz",
            control=[0.5] * 30,        # baseline measurements
            treatment=[0.3] * 30,      # trial measurements
        )
        if result.applied:
            # real side effect happened
            ...
    """

    def __init__(self, real_executor: Any = None):
        """`real_executor` is the actual ClosedLoopExecutor (or None
        for a stub that just records what would have been applied).
        """
        self.real_executor = real_executor
        self.applied_history: list[ApplyApprovedResult] = []

    async def apply_approved_gated(
        self,
        *,
        org_id: str,
        action_id: str,
        action_kind: str,
        control: Sequence[float],
        treatment: Sequence[float],
        predicted_probs: Sequence[float] | None = None,
        actual_labels: Sequence[float] | None = None,
    ) -> ApplyApprovedResult:
        """Apply the action ONLY if StatGate accepts.

        Auto-apply iff all 5 checks pass:
          C1 ECE < 0.05, C2 BH p < 0.05, C3 d > 0.2,
          C4 n > 30 + conformal coverage, C5 mSPRT p < 0.05
        """
        try:
            gate_evidence = stat_gate_evaluate(
                control, treatment,
                predicted_probs=predicted_probs,
                actual_labels=actual_labels,
            )
        except Exception as e:
            # Numerical edge case — treat as reject.
            gate_evidence = GateEvidence(
                verdict="REJECT",
                c1_ece=float("nan"),
                c2_p_bh=1.0,
                c3_d=0.0,
                c4_conformal_lower=float("-inf"),
                c5_msprt_p=1.0,
                n_treat=len(treatment),
                n_control=len(control),
                delta_mean=0.0,
                explanation=f"gate raised {type(e).__name__}: {e}",
            )

        if gate_evidence.verdict == "APPLY":
            # Apply the real side effect (or stub).
            side_effect_log = (
                f"applied action_id={action_id!r} "
                f"action_kind={action_kind!r} "
                f"delta_mean={gate_evidence.delta_mean:.4f}"
            )
            applied = True
            if self.real_executor is not None:
                try:
                    await self.real_executor.apply_approved(
                        org_id=org_id,
                        action_id=action_id,
                    )
                except Exception as e:
                    side_effect_log += f" (but executor raised: {e})"
                    applied = False
        else:
            side_effect_log = (
                f"rejected action_id={action_id!r} — "
                f"{gate_evidence.explanation}"
            )
            applied = False

        result = ApplyApprovedResult(
            action_id=action_id,
            applied=applied,
            gate_evidence=gate_evidence,
            side_effect_log=side_effect_log,
        )
        self.applied_history.append(result)
        return result

    def get_history(self) -> list[ApplyApprovedResult]:
        """Return the history of apply_approved_gated calls."""
        return list(self.applied_history)


__all__ = [
    "ApplyApprovedResult",
    "StatGateGatedExecutor",
]