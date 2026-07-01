"""Cat 17 closed-loop wiring — connect detection services to promotion_hooks.

Reference:
  - supplementaries/research/12_adversarial.md
  - src/eden/llmops/promotion_hooks.py (ACTION_KIND)
  - src/eden/llmops/closed_loop_executor.py (apply_approved — v0_noop)

Maps detection service outputs to ACTION_KIND entries so that
PromotionHook.on_drift_alert → ClosedLoopExecutor → apply_approved
can act on the new (real, non-stub) detections.

Mapping (per ACTION_KIND canonical strings in promotion_hooks):
  indirect_prompt_injection     → redact
  pair_semantic_iterative        → block_promotion
  tap_branch_burst               → block_promotion
  crescendo_monotonic            → investigate
  sycophancy_eval                → investigate
  reward_hogging_anomaly         → investigate
  reward_tampering_textual       → investigate
  multi_turn_escalation          → investigate
  calibration_audit              → investigate
  memory_bloat                   → investigate
  memory_conflict                → investigate
  memory_paging_pressure         → investigate
  agent_depth_runaway            → investigate
  blackboard_stale               → investigate
  topology_centralized           → investigate
  topology_dispersed             → investigate
  a2a_task_stuck                 → investigate
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from eden.llmops.promotion_hooks import ACTION_KIND

from supplementaries.phase_7_detection.detectors import (
    DetectionReport,
    detect_calibration_failure,
    detect_indirect_prompt_injection,
    detect_multi_turn_escalation,
    detect_pair_tap_crescendo,
    detect_reward_hogging,
    detect_sycophancy_markers,
)
from supplementaries.phase_10_memory.a2a import emit_drift_alert

# Mapping from detection service name → ACTION_KIND entry.
# Most detections fire `investigate` (the safe default); a few fire
# stronger actions (redact, block_promotion).
DETECTION_TO_ACTION: dict[str, str] = {
    "indirect_prompt_injection":  "redact",
    "tool_result_injection":      "redact",
    "pair_semantic_iterative":     "block_promotion",
    "tap_branch_burst":            "block_promotion",
    "crescendo_monotonic":         "investigate",
    "many_shot_preamble":          "investigate",
    "verifier_loop":               "investigate",
    "sycophancy_eval":             "investigate",
    "surface_agreement_marker":    "investigate",
    "reward_hogging_anomaly":      "investigate",
    "reward_tampering_textual":    "investigate",
    "multi_turn_escalation":       "investigate",
    "calibration_audit":           "investigate",
    "confidence_overclaim":        "investigate",
    "memory_bloat":                "investigate",
    "memory_conflict":             "investigate",
    "memory_paging_pressure":      "investigate",
    "agent_depth_runaway":         "investigate",
    "blackboard_stale":            "investigate",
    "topology_centralized":        "investigate",
    "topology_dispersed":          "investigate",
    "a2a_task_stuck":              "investigate",
}


@dataclass(frozen=True)
class ClosedLoopAction:
    """A single closed-loop action ready for PromotionHook consumption."""
    detection_name: str
    action_kind: str
    severity: str
    context: dict


def map_detection_to_action(
    detection_name: str,
    *,
    severity: str = "high",
    context: dict | None = None,
) -> ClosedLoopAction | None:
    """Map a detection name to a ClosedLoopAction.

    Returns None if the detection isn't in DETECTION_TO_ACTION
    (e.g. a typo or legacy name).

    Validates that the resulting action_kind exists in ACTION_KIND
    so the wire-up to PromotionHook never references a stale name.
    """
    if detection_name not in DETECTION_TO_ACTION:
        return None
    action = DETECTION_TO_ACTION[detection_name]
    if action not in ACTION_KIND.values():
        # Programming error: DETECTION_TO_ACTION drift from ACTION_KIND.
        raise ValueError(
            f"DETECTION_TO_ACTION[{detection_name!r}] = {action!r} "
            f"not in ACTION_KIND.values()"
        )
    return ClosedLoopAction(
        detection_name=detection_name,
        action_kind=action,
        severity=severity,
        context=context or {},
    )


def collect_closed_loop_actions(
    report: DetectionReport,
    *,
    profile_sizes: dict[str, int] | None = None,
    depth_by_trace: dict[str, tuple[str, str | None, int]] | None = None,
    parent_distribution: dict[str, int] | None = None,
) -> list[ClosedLoopAction]:
    """Walk a DetectionReport and emit a ClosedLoopAction for every
    triggered detection.

    Only detections whose score crosses a threshold are emitted.
    """
    actions: list[ClosedLoopAction] = []

    # 1. Indirect injection: max > 0 fires.
    if report.indirect_injection_max > 0:
        a = map_detection_to_action(
            "indirect_prompt_injection",
            severity="critical" if report.indirect_injection_max > 0.5 else "high",
            context={"score": report.indirect_injection_max},
        )
        if a:
            actions.append(a)

    # 2. Sycophancy: rate > 0.3 fires.
    if report.sycophancy_rate > 0.3:
        a = map_detection_to_action(
            "sycophancy_eval",
            severity="high",
            context={"rate": report.sycophancy_rate},
        )
        if a:
            actions.append(a)

    # 3. Reward hogging: any tool > 0.5 share fires.
    for tool, share in report.reward_hogging.items():
        if share > 0.5:
            a = map_detection_to_action(
                "reward_hogging_anomaly",
                severity="high",
                context={"tool": tool, "share": share},
            )
            if a:
                actions.append(a)

    # 4. Calibration failure: rate > 0.3 fires.
    if report.calibration_failure_rate > 0.3:
        a = map_detection_to_action(
            "calibration_audit",
            severity="high",
            context={"rate": report.calibration_failure_rate},
        )
        if a:
            actions.append(a)

    # 5. Multi-turn escalation: score > 0.3 fires.
    if report.multi_turn_escalation_score > 0.3:
        a = map_detection_to_action(
            "multi_turn_escalation",
            severity="high",
            context={"score": report.multi_turn_escalation_score},
        )
        if a:
            actions.append(a)

    # 6. PAIR/TAP/Crescendo: any > 0 fires. Map sub-pattern names
    # (refusal_then_retry, low_jaccard_burst, monotonic_entropy) to
    # their canonical VALID_POLICY_TYPES entries.
    _PAIR_TAP_MAP = {
        "refusal_then_retry": "pair_semantic_iterative",
        "low_jaccard_burst": "tap_branch_burst",
        "monotonic_entropy": "crescendo_monotonic",
    }
    for sub, score in report.pair_tap_crescendo.items():
        if score > 0:
            detection_name = _PAIR_TAP_MAP.get(sub, sub)
            a = map_detection_to_action(
                detection_name,
                severity="critical" if score > 0.5 else "high",
                context={"sub": sub, "score": score},
            )
            if a:
                actions.append(a)

    # 7. Memory bloat: any user over threshold fires.
    for user_id, size_bytes in report.memory_bloat:
        a = map_detection_to_action(
            "memory_bloat",
            severity="critical" if size_bytes > 16 * 1024 else "high",
            context={"user_id": user_id, "size_bytes": size_bytes},
        )
        if a:
            actions.append(a)

    # 8. Agent depth runaway: any trace over threshold fires.
    for alert in report.agent_depth_runaway:
        a = map_detection_to_action(
            "agent_depth_runaway",
            severity="critical",
            context=alert if isinstance(alert, dict) else {"trace": alert},
        )
        if a:
            actions.append(a)

    # 9. Topology: only fires for centralized or dispersed.
    if report.topology in {"centralized", "dispersed"}:
        a = map_detection_to_action(
            f"topology_{report.topology}",
            severity="medium",
            context={"classification": report.topology},
        )
        if a:
            actions.append(a)

    return actions


def to_promotion_hook_events(
    actions: Iterable[ClosedLoopAction],
) -> list[dict]:
    """Format ClosedLoopActions for PromotionHook.on_drift_alert.

    Returns a list of dicts matching the PromotionHook event schema.
    """
    events = []
    for a in actions:
        evt = emit_drift_alert(
            a.detection_name,
            severity=a.severity,
            action_kind=a.action_kind,
            **a.context,
        )
        events.append(evt)
    return events


__all__ = [
    "DETECTION_TO_ACTION",
    "ClosedLoopAction",
    "map_detection_to_action",
    "collect_closed_loop_actions",
    "to_promotion_hook_events",
]