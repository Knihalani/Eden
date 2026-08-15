"""StatGate incident scorer (N08).

Deterministic, sub-millisecond scoring of an issue for **auto-escalation**
before any LLM triage runs. Wraps the phase-6 StatGate ``evaluate()`` for
the numeric-regression case and layers the N08 P0 signals on top:

* **ETEC loop** — ≥4 identical tool calls or an ETEC loop score ≥ 0.85.
* **StatGate P0** — a stumble already tagged ``statgate_p0``.
* **MCP auth failure** — auth broke against an MCP server.
* **cost spike** — cost z-score > 3σ recorded in the stumble detail.
* **p0 severity** — the issue is already p0.

When any P0 fires the scorer returns ``auto_escalate=True`` with a
``suggested_heal`` so the orchestrator can act deterministically without
spending an LLM call.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

_LOOP_REPEAT_P0 = 4
_ETEC_P0 = 0.85
_COST_Z_P0 = 3.0


@dataclass(slots=True)
class StatGateScore:
    auto_escalate: bool
    p0: bool
    p0_checks: list[str] = field(default_factory=list)
    suggested_heal: str | None = None
    source: str = "statgate"
    detail: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "auto_escalate": self.auto_escalate,
            "p0": self.p0,
            "p0_checks": self.p0_checks,
            "suggested_heal": self.suggested_heal,
            "source": self.source,
            "detail": self.detail,
        }


class StatGateIncidentScorer:
    def score(
        self, issue: dict[str, Any], stumbles: list[dict[str, Any]]
    ) -> StatGateScore:
        checks: list[str] = []
        suggested: str | None = None

        kind = str(issue.get("kind") or "")
        severity = str(issue.get("severity") or "p3")

        # ── P0 severity is itself an escalation ──
        if severity == "p0":
            checks.append("p0_severity")

        # ── per-stumble P0 signals ──
        for s in stumbles:
            detail = s.get("detail") or {}
            skind = str(s.get("kind") or "")

            if skind == "statgate_p0":
                checks.append("statgate_p0")
                suggested = suggested or "rollback"

            if skind == "mcp_auth_failure":
                checks.append("mcp_auth_failure")

            # ETEC loop signal.
            repeat = _num(detail.get("repeat_count"))
            etec = _num(detail.get("etec_loop_score"))
            loop_hit = (repeat is not None and repeat >= _LOOP_REPEAT_P0) or (
                etec is not None and etec >= _ETEC_P0
            )
            if loop_hit and "etec_loop" not in checks:
                checks.append("etec_loop")

            # Cost spike.
            zc = _num(detail.get("cost_z_score") or detail.get("cost_zscore"))
            if zc is not None and zc > _COST_Z_P0:
                if "cost_spike" not in checks:
                    checks.append("cost_spike")
                suggested = suggested or "reweight"

        # Issue-level loop kind is also a strong P0 when repeated widely.
        loop_issue = (
            kind == "loop"
            and int(issue.get("stumble_count") or 0) >= _LOOP_REPEAT_P0
        )
        if loop_issue and "etec_loop" not in checks:
            checks.append("etec_loop")

        # Numeric StatGate regression (optional — only when the issue
        # carries before/after metric samples).
        gate_verdict = self._maybe_gate(issue)
        if gate_verdict == "APPLY":
            checks.append("statgate_regression")
            suggested = suggested or "rollback"

        # Map remaining kinds to a default heal when a P0 fired but no
        # specific heal was chosen.
        if checks and suggested is None:
            suggested = {
                "tool_error": "cache_bust",
                "mcp_auth_failure": None,
            }.get(kind, "rollback")

        p0 = bool(checks)
        return StatGateScore(
            auto_escalate=p0,
            p0=p0,
            p0_checks=checks,
            suggested_heal=suggested,
            detail={"gate_verdict": gate_verdict} if gate_verdict else {},
        )

    def _maybe_gate(self, issue: dict[str, Any]) -> str | None:
        tr = issue.get("triage_result") or {}
        samples = tr.get("metric_samples") if isinstance(tr, dict) else None
        if not isinstance(samples, dict):
            return None
        control = samples.get("control")
        treatment = samples.get("treatment")
        if not (isinstance(control, list) and isinstance(treatment, list)):
            return None
        try:
            from supplementaries.phase_6_stat_gate.gate import evaluate

            ev = evaluate([float(x) for x in control], [float(x) for x in treatment])
            return ev.verdict
        except Exception as exc:  # pragma: no cover - optional path
            logger.debug("statgate_scorer: gate evaluate failed: %s", exc)
            return None


def _num(v: Any) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None
