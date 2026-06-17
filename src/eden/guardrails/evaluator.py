"""Pure-Python guardrail evaluator (Phase F addition).

The existing :mod:`eden.guardrails.policy` module is
DB-coupled (CRUD over the ``guardrail_policies`` table).
This module is a **sibling** that provides a unit-testable
``GuardrailEvaluator`` — no DB, no SQL, just a pure function
that takes a text and a list of policies and returns a
:class:`GuardrailResult`.

Production code paths use the DB-coupled
:class:`eden.guardrails.intervention.InterventionEngine`;
this module is for unit tests + small synchronous
evaluations (e.g. a route that wants to evaluate a single
text on demand).
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Iterable, Optional


logger = logging.getLogger(__name__)


# ── Local dataclass (different shape from the DB-coupled
#    GuardrailPolicy in the parent module) ──────────────────────


@dataclass
class GuardrailPolicy:
    """Pure-Python policy descriptor.

    Different shape from the DB-coupled
    :class:`eden.guardrails.policy.GuardrailPolicy` (which
    is a service with create/update/delete methods). This
    dataclass is the unit-testable carrier of "what to check"
    + "what to do on match".
    """

    name: str
    rule_type: str  # "regex" | "blocklist" | "judge" | "length"
    rule: Any
    action: str = "flag"        # "block" | "rewrite" | "flag"
    severity: str = "medium"    # "low" | "medium" | "high" | "critical"
    direction: str = "both"     # "input" | "output" | "both"
    enabled: bool = True
    description: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "rule_type": self.rule_type,
            "rule": self.rule,
            "action": self.action,
            "severity": self.severity,
            "direction": self.direction,
            "enabled": self.enabled,
            "description": self.description,
        }


# Severity ordering (matches the policy module).
SEVERITY_RANK: dict[str, int] = {
    "low": 1,
    "medium": 2,
    "high": 3,
    "critical": 4,
}


@dataclass
class GuardrailViolation:
    """One matched policy."""

    policy_name: str
    rule_type: str
    action: str
    severity: str
    direction: str
    matched_text: str = ""
    span: tuple[int, int] = (-1, -1)
    reason: str = ""


@dataclass
class GuardrailResult:
    """The outcome of one :func:`evaluate` call."""

    text: str
    violations: list[GuardrailViolation] = field(default_factory=list)
    rewritten: str = ""
    blocked: bool = False
    max_severity: str = "low"

    def to_dict(self) -> dict[str, Any]:
        return {
            "text": self.text,
            "rewritten": self.rewritten or self.text,
            "blocked": self.blocked,
            "max_severity": self.max_severity,
            "violations": [
                {
                    "policy_name": v.policy_name,
                    "rule_type": v.rule_type,
                    "action": v.action,
                    "severity": v.severity,
                    "direction": v.direction,
                    "matched_text": v.matched_text,
                    "span": list(v.span),
                    "reason": v.reason,
                }
                for v in self.violations
            ],
        }


# An async judge function: ``(policy_prompt, text) -> bool``.
JudgeFn = Callable[[str, str], Awaitable[bool]]


def _max_severity(severities: Iterable[str]) -> str:
    sevs = list(severities)
    if not sevs:
        return "low"
    return max(sevs, key=lambda s: SEVERITY_RANK.get(s, 0))


def _regex_match(policy: GuardrailPolicy, text: str) -> list[tuple[int, int, str]]:
    if not isinstance(policy.rule, str):
        return []
    try:
        regex = re.compile(policy.rule, re.IGNORECASE | re.DOTALL)
    except re.error as exc:
        logger.warning("guardrails: invalid regex in %s: %s", policy.name, exc)
        return []
    return [(m.start(), m.end(), m.group(0)) for m in regex.finditer(text)]


def _blocklist_match(policy: GuardrailPolicy, text: str) -> list[tuple[int, int, str]]:
    blocklist = policy.rule if isinstance(policy.rule, list) else []
    text_lower = text.lower()
    matches: list[tuple[int, int, str]] = []
    for term in blocklist:
        if not isinstance(term, str):
            continue
        idx = text_lower.find(term.lower())
        if idx >= 0:
            matches.append((idx, idx + len(term), text[idx:idx + len(term)]))
    return matches


def _length_match(policy: GuardrailPolicy, text: str) -> list[tuple[int, int, str]]:
    if not isinstance(policy.rule, int):
        return []
    if len(text) > policy.rule:
        return [(0, len(text), text[:200] + ("…" if len(text) > 200 else ""))]
    return []


async def _judge_match(
    policy: GuardrailPolicy,
    text: str,
    judge: Optional[JudgeFn] = None,
) -> list[tuple[int, int, str]]:
    if not isinstance(policy.rule, str) or judge is None:
        return []
    matched = await judge(policy.rule, text)
    if matched:
        return [(0, len(text), text[:200] + ("…" if len(text) > 200 else ""))]
    return []


async def evaluate(
    text: str,
    policies: list[GuardrailPolicy],
    *,
    direction: str = "input",
    judge: Optional[JudgeFn] = None,
    on_violation: Optional[Callable[[GuardrailViolation, str], Any]] = None,
) -> GuardrailResult:
    """Run every enabled policy that matches ``direction`` against ``text``.

    This is the pure-Python sibling of
    :class:`eden.guardrails.intervention.InterventionEngine`. The
    same detectors + the same action semantics, but no DB.
    Use this for unit tests + on-demand evaluation.

    Args:
        text: The text to evaluate.
        policies: The policies to apply.
        direction: ``"input"`` / ``"output"`` / ``"both"`` filter.
        judge: Optional async judge for ``"judge"``-type policies.
        on_violation: Optional callback per violation.

    Returns:
        :class:`GuardrailResult` with violations, rewrites,
        block verdict, and max severity.
    """
    if not isinstance(text, str):
        text = str(text)
    result = GuardrailResult(text=text, rewritten=text)
    applicable = [
        p for p in policies
        if p.enabled and (p.direction == direction or p.direction == "both")
    ]
    for policy in applicable:
        if policy.rule_type == "regex":
            matches = _regex_match(policy, text)
        elif policy.rule_type == "blocklist":
            matches = _blocklist_match(policy, text)
        elif policy.rule_type == "length":
            matches = _length_match(policy, text)
        elif policy.rule_type == "judge":
            matches = await _judge_match(policy, text, judge)
        else:
            continue
        for start, end, matched_text in matches:
            violation = GuardrailViolation(
                policy_name=policy.name,
                rule_type=policy.rule_type,
                action=policy.action,
                severity=policy.severity,
                direction=policy.direction,
                matched_text=matched_text,
                span=(start, end),
                reason=policy.description or f"matched rule {policy.rule_type}",
            )
            result.violations.append(violation)
            if policy.action == "block":
                result.blocked = True
            if on_violation is not None:
                try:
                    on_violation(violation, text)
                except Exception as exc:  # pragma: no cover
                    logger.debug("on_violation callback raised: %s", exc)
    # Apply rewrites (right-to-left so spans don't shift).
    rewrites = [v for v in result.violations if v.action == "rewrite"]
    if rewrites:
        text_chars = list(result.text)
        for v in sorted(rewrites, key=lambda v: v.span[0], reverse=True):
            start, end = v.span
            if start < 0 or end > len(text_chars):
                continue
            placeholder = f"[REDACTED:{v.policy_name}]"
            text_chars[start:end] = list(placeholder)
        result.rewritten = "".join(text_chars)
    result.max_severity = _max_severity(v.severity for v in result.violations)
    return result


__all__ = [
    "GuardrailViolation",
    "GuardrailResult",
    "evaluate",
    "SEVERITY_RANK",
    "JudgeFn",
]
