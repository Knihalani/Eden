"""Confidence gate — the single chokepoint before any PR is opened.

The brief is explicit: PRs should be created only when the
evidence justifies it, not on every incident. This module
encapsulates the rules so both the incident-driven trigger
and the scheduled optimization trigger reach the same
verdict for the same evidence.

The :class:`ConfidenceGate` collapses a small bundle of
inputs into a single :class:`Decision` with a boolean
``allowed`` flag and a structured ``reasons`` list. The
caller (incident pipeline or scheduler) is responsible for
turning a denied decision into a report-only response so
the user sees *why* Eden chose to stay silent.

Inputs (all optional — missing inputs default to a
conservative 0.0 score):

* ``rca_confidence`` (0-1) — how strongly the RCA links
  the symptom to the code area.
* ``quality_score`` (0-1) — the multi-dimensional quality
  score from :class:`PRQualityScorer`.
* ``blast_radius_score`` (0-1) — the patch's blast radius
  (lower is better).
* ``reverted_history`` (int) — how many times this code
  path has been reverted in the past 90d (more = worse).
* ``denied_history`` (int) — how many times a similar
  patch was denied by a human (more = worse).
* ``evidence_count`` (int) — the count of distinct evidence
  rows that corroborate the issue (more = better, capped).
* ``protected_path_match`` (bool) — True if the patch
  touches a protected path (e.g. ``src/auth/``).
* ``fix_area_localized`` (bool) — True if the patch is
  well-localized (≤3 files).
* ``can_validate`` (bool) — True if there's a unit/integration
  test or build that the agent can run before opening the
  PR.

Thresholds (per-org overridable):

* ``min_confidence`` (default 0.65) — the composite score
  must clear this for the decision to be ``allowed``.
* ``max_blast_radius`` (default 0.5) — independent ceiling.
* ``max_reverted_history`` (default 3) — independent ceiling.
* ``require_validation`` (default True) — if True, a patch
  with no validation path is denied.
* ``protected_path_block`` (default True) — if True, a
  patch touching a protected path is denied.

The composite score is a weighted sum (sums to 1.0):

    0.35 * rca_confidence
    0.25 * quality_score
    0.20 * (1 - blast_radius_score)
    0.10 * min(evidence_count / 5, 1.0)
    0.05 * (1 if fix_area_localized else 0)
    0.05 * (1 if can_validate else 0)

The composite is in [0, 1]; a score of 0.5 represents
"weak evidence". Anything below 0.65 is denied.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from typing import Any, Literal

logger = logging.getLogger(__name__)


# Default per-org policy for the discipline layer. The values
# are intentionally conservative — they're the "Eden doesn't
# open PRs unless it's pretty sure" defaults. An org admin
# can raise ``min_confidence`` for stricter behavior or lower
# it for looser, but they cannot disable the protected-path
# block without an admin grant.
DEFAULT_GATE_POLICY: dict[str, Any] = {
    "min_confidence": 0.65,
    "max_blast_radius": 0.5,
    "max_reverted_history": 3,
    "max_denied_history": 5,
    "require_validation": True,
    "protected_path_block": True,
}


# Weights for the composite score. Must sum to 1.0 (the
# 0.05 increments sum to 1.0 exactly).
_WEIGHTS = {
    "rca_confidence": 0.35,
    "quality_score": 0.25,
    "blast_radius_inverse": 0.20,
    "evidence": 0.10,
    "localized": 0.05,
    "validation": 0.05,
}


@dataclass(frozen=True)
class Trigger:
    """The trigger context for a confidence decision.

    Attributes:
        kind: ``"incident"`` for an incident-driven candidate,
            ``"scheduled"`` for the daily optimization run.
        identifier: A stable id for the trigger (cluster id,
            incident id, optimization run id).
        summary: Human-readable one-liner for the report.
        evidence_refs: A list of identifiers (trace ids, RCA
            ids, telemetry signatures) that back this trigger.
    """

    kind: Literal["incident", "scheduled"]
    identifier: str
    summary: str = ""
    evidence_refs: tuple[str, ...] = field(default_factory=tuple)


@dataclass
class Decision:
    """The output of :func:`compute_decision`.

    Attributes:
        allowed: ``True`` iff the gate cleared.
        score: The composite score in [0, 1].
        reasons: Human-readable reasons for the verdict
            (positive + negative). Empty when ``allowed``.
        fingerprint: A stable hash identifying this decision
            for the dedupe index.
        gate_policy: The policy the decision was made against
            (echoed for audit trails).
    """

    allowed: bool
    score: float
    reasons: list[str] = field(default_factory=list)
    fingerprint: str = ""
    gate_policy: dict[str, Any] = field(default_factory=dict)


def _normalise_inputs(
    *,
    rca_confidence: float,
    quality_score: float,
    blast_radius_score: float,
    evidence_count: int,
    reverted_history: int,
    denied_history: int,
    protected_path_match: bool,
    fix_area_localized: bool,
    can_validate: bool,
) -> dict[str, float]:
    """Normalise + clamp inputs to [0, 1].

    The ``blast_radius_score`` is flipped (1 - x) because
    a *high* blast radius is a *negative* signal. Counts
    are scaled: every count is divided by a saturation
    point (5 evidence, 3 reverts, 5 denies) and clipped
    at 1.0.
    """
    rc = max(0.0, min(float(rca_confidence), 1.0))
    qs = max(0.0, min(float(quality_score), 1.0))
    br = max(0.0, min(float(blast_radius_score), 1.0))
    ev = max(0.0, min(float(evidence_count) / 5.0, 1.0))
    rh = max(0.0, min(float(reverted_history) / 3.0, 1.0))
    dh = max(0.0, min(float(denied_history) / 5.0, 1.0))
    return {
        "rca_confidence": rc,
        "quality_score": qs,
        "blast_radius_inverse": 1.0 - br,
        "evidence": ev,
        "reverted_penalty": rh,
        "denied_penalty": dh,
        "localized": 1.0 if fix_area_localized else 0.0,
        "validation": 1.0 if can_validate else 0.0,
        "protected": 1.0 if protected_path_match else 0.0,
    }


def fingerprint_trigger(
    trigger: Trigger,
    *,
    file_paths: tuple[str, ...] = (),
) -> str:
    """Stable fingerprint for dedupe.

    Combines the trigger kind + identifier + a sorted
    signature over the touched file paths. Two PR
    candidates with the same fingerprint are duplicates
    from the dedupe index's perspective.
    """
    h = hashlib.sha256()
    h.update(trigger.kind.encode("utf-8"))
    h.update(b"|")
    h.update((trigger.identifier or "").encode("utf-8"))
    h.update(b"|")
    for path in sorted(file_paths):
        h.update(path.encode("utf-8"))
        h.update(b",")
    return h.hexdigest()[:24]


def compute_decision(
    trigger: Trigger,
    *,
    rca_confidence: float = 0.0,
    quality_score: float = 0.0,
    blast_radius_score: float = 0.0,
    evidence_count: int = 0,
    reverted_history: int = 0,
    denied_history: int = 0,
    protected_path_match: bool = False,
    fix_area_localized: bool = False,
    can_validate: bool = False,
    file_paths: tuple[str, ...] = (),
    gate_policy: dict[str, Any] | None = None,
) -> Decision:
    """Compute the discipline decision for ``trigger``.

    The function is pure — no DB calls, no side-effects —
    so it's trivially testable and reusable across the
    incident and scheduled triggers. Persistence (writing
    the decision to the dedupe index + audit trail) is
    the caller's job; see :mod:`eden.code_change.discipline.store`.

    Args:
        trigger: The :class:`Trigger` describing the source.
        rca_confidence: How strongly the RCA links symptom
            to the proposed fix area. Range [0, 1].
        quality_score: The patch's multi-dimensional quality
            score. Range [0, 1].
        blast_radius_score: The patch's blast radius
            (lower is better). Range [0, 1].
        evidence_count: How many distinct evidence rows
            corroborate the issue. Capped at 5 inside the
            function.
        reverted_history: How many times this code path
            has been reverted in the past 90d.
        denied_history: How many times a similar patch was
            denied by a human in the past 90d.
        protected_path_match: True if the patch touches a
            protected path (e.g. ``src/auth/``).
        fix_area_localized: True if the patch is well-
            localized (≤3 files).
        can_validate: True if the agent can run a test or
            check before opening the PR.
        file_paths: The list of files the patch touches.
            Used for the dedupe fingerprint.
        gate_policy: Optional per-org policy overrides.

    Returns:
        A :class:`Decision` with ``allowed`` + ``score`` +
        ``reasons`` + ``fingerprint``.
    """
    policy = {**DEFAULT_GATE_POLICY, **(gate_policy or {})}
    inputs = _normalise_inputs(
        rca_confidence=rca_confidence,
        quality_score=quality_score,
        blast_radius_score=blast_radius_score,
        evidence_count=evidence_count,
        reverted_history=reverted_history,
        denied_history=denied_history,
        protected_path_match=protected_path_match,
        fix_area_localized=fix_area_localized,
        can_validate=can_validate,
    )
    score = sum(_WEIGHTS[k] * inputs[k] for k in _WEIGHTS)

    reasons: list[str] = []
    allowed = True

    # Hard ceilings — these cannot be overridden by raising
    # the composite score. They are the "never open a PR if
    # X is true" rules.
    if policy["protected_path_block"] and inputs["protected"] >= 1.0:
        allowed = False
        reasons.append("protected_path_touched")
    if float(inputs["blast_radius_inverse"]) < (1.0 - float(policy["max_blast_radius"])):
        allowed = False
        reasons.append("blast_radius_above_ceiling")
    if reverted_history >= int(policy["max_reverted_history"]):
        allowed = False
        reasons.append("reverted_history_above_ceiling")
    if denied_history >= int(policy["max_denied_history"]):
        allowed = False
        reasons.append("denied_history_above_ceiling")
    if policy["require_validation"] and inputs["validation"] < 1.0:
        allowed = False
        reasons.append("validation_path_missing")
    if score < float(policy["min_confidence"]):
        allowed = False
        reasons.append("composite_below_threshold")

    # Surface the strongest positive signals too — when the
    # report is delivered to the user, the reasons list should
    # explain *why* Eden was confident enough (or not). This
    # matters for trust: the user can see exactly which inputs
    # carried weight.
    if allowed:
        if inputs["rca_confidence"] >= 0.7:
            reasons.append(f"rca_confidence_high({inputs['rca_confidence']:.2f})")
        if inputs["quality_score"] >= 0.7:
            reasons.append(f"quality_score_high({inputs['quality_score']:.2f})")
        if inputs["localized"] >= 1.0:
            reasons.append("fix_area_localized")
        if inputs["validation"] >= 1.0:
            reasons.append("validation_path_present")
        if not reasons:
            reasons.append("composite_at_threshold")

    return Decision(
        allowed=allowed,
        score=round(score, 4),
        reasons=reasons,
        fingerprint=fingerprint_trigger(trigger, file_paths=file_paths),
        gate_policy=policy,
    )


class ConfidenceGate:
    """The discipline chokepoint, as a service object.

    The class form mirrors the rest of Cat 23 (``name``,
    ``__call__`` envelope) so the v1.6 envelope-style route
    handlers can call it directly. The underlying logic
    lives in :func:`compute_decision` for testability.
    """

    name = "confidence_gate"

    async def evaluate(
        self,
        trigger: Trigger,
        **kwargs: Any,
    ) -> dict[str, Any]:
        """Compute the discipline decision for ``trigger``.

        Returns the standard Cat 23 envelope
        (``status`` / ``feature`` / ``live`` / ``trace_id`` /
        ``timestamp`` / ``data``) wrapping a :class:`Decision`.
        The route layer is responsible for turning a denied
        decision into the report-only path.
        """
        from eden.code_change._common import _ok_envelope

        decision = compute_decision(trigger, **kwargs)
        return _ok_envelope(
            self.name,
            {
                "allowed": decision.allowed,
                "score": decision.score,
                "reasons": decision.reasons,
                "fingerprint": decision.fingerprint,
                "trigger_kind": trigger.kind,
                "trigger_identifier": trigger.identifier,
            },
        )
