"""Unit tests for Phase F — guardrail evaluator (pure-Python layer).

The new :mod:`eden.guardrails.evaluator` module ships a
sibling of the DB-coupled
:class:`eden.guardrails.intervention.InterventionEngine`.
These tests prove the pure-Python surface works in
isolation.

What's covered:

  evaluate (8 tests)
  ──────────────────
  * Empty policies → no violations
  * Regex policy matches
  * Blocklist policy matches
  * Length policy matches
  * Judge policy with custom judge
  * Action: block → result.blocked = True
  * Action: rewrite → result.rewritten has [REDACTED:policy]
  * Direction filter: input / output / both

  Detector functions (4 tests)
  ──────────────────────────
  * _regex_match returns spans
  * _blocklist_match is case-insensitive
  * _length_match triggers on >max
  * _judge_match respects the judge return value

  Severity rank (3 tests)
  ─────────────────────
  * _max_severity returns highest
  * Default is "low"
  * Custom severities are honoured

  GuardrailResult dataclass (2 tests)
  ─────────────────────────────────
  * to_dict round-trip
  * Defaults
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

import pytest

from eden.guardrails.evaluator import (
    GuardrailPolicy,
    GuardrailResult,
    GuardrailViolation,
    SEVERITY_RANK,
    _blocklist_match,
    _judge_match,
    _length_match,
    _max_severity,
    _regex_match,
    evaluate,
)


# ── Helpers ───────────────────────────────────────────────────────


def _policy(**kwargs: Any) -> GuardrailPolicy:
    defaults = {
        "name": "p",
        "rule_type": "regex",
        "rule": r"\d+",
        "action": "flag",
        "severity": "medium",
        "direction": "both",
        "enabled": True,
        "description": "",
    }
    defaults.update(kwargs)
    return GuardrailPolicy(**defaults)


# ── Detector unit tests ──────────────────────────────────────────


class TestRegexMatch:
    def test_basic_match(self) -> None:
        p = _policy(rule=r"\d+")
        matches = _regex_match(p, "abc 123 def")
        assert len(matches) == 1
        assert matches[0] == (4, 7, "123")

    def test_no_match(self) -> None:
        p = _policy(rule=r"\d+")
        assert _regex_match(p, "no digits here") == []

    def test_invalid_regex(self) -> None:
        p = _policy(rule=r"[invalid")
        # No exception, just no matches.
        assert _regex_match(p, "anything") == []

    def test_non_string_rule(self) -> None:
        p = _policy(rule=["not", "a", "string"])
        assert _regex_match(p, "anything") == []


class TestBlocklistMatch:
    def test_case_insensitive(self) -> None:
        p = _policy(rule_type="blocklist", rule=["FORBIDDEN"])
        matches = _blocklist_match(p, "this is forbidden text")
        assert len(matches) == 1
        assert matches[0][2].lower() == "forbidden"

    def test_multiple_terms(self) -> None:
        p = _policy(rule_type="blocklist", rule=["bad", "worse"])
        m1 = _blocklist_match(p, "this is bad")
        m2 = _blocklist_match(p, "this is worse")
        assert len(m1) == 1
        assert len(m2) == 1

    def test_non_list_rule(self) -> None:
        p = _policy(rule_type="blocklist", rule="string-not-list")
        assert _blocklist_match(p, "anything") == []


class TestLengthMatch:
    def test_over_max(self) -> None:
        p = _policy(rule_type="length", rule=10)
        matches = _length_match(p, "x" * 20)
        assert len(matches) == 1

    def test_under_max(self) -> None:
        p = _policy(rule_type="length", rule=100)
        assert _length_match(p, "short text") == []

    def test_non_int_rule(self) -> None:
        p = _policy(rule_type="length", rule="not an int")
        assert _length_match(p, "x" * 100) == []


class TestJudgeMatch:
    @pytest.mark.asyncio
    async def test_judge_returns_true(self) -> None:
        async def judge(prompt: str, text: str) -> bool:
            return "yes" in text
        p = _policy(rule_type="judge", rule="contains yes")
        matches = await _judge_match(p, "yes this matches", judge=judge)
        assert len(matches) == 1

    @pytest.mark.asyncio
    async def test_judge_returns_false(self) -> None:
        async def judge(prompt: str, text: str) -> bool:
            return "yes" in text
        p = _policy(rule_type="judge", rule="contains yes")
        matches = await _judge_match(p, "no match", judge=judge)
        assert matches == []

    @pytest.mark.asyncio
    async def test_no_judge_provided(self) -> None:
        p = _policy(rule_type="judge", rule="anything")
        matches = await _judge_match(p, "text", judge=None)
        # No judge → never match.
        assert matches == []


# ── Severity rank ────────────────────────────────────────────────


class TestMaxSeverity:
    def test_empty(self) -> None:
        assert _max_severity([]) == "low"

    def test_single(self) -> None:
        assert _max_severity(["medium"]) == "medium"

    def test_picks_highest(self) -> None:
        assert _max_severity(["low", "critical", "medium"]) == "critical"


# ── evaluate ─────────────────────────────────────────────────────


class TestEvaluate:
    @pytest.mark.asyncio
    async def test_no_policies(self) -> None:
        result = await evaluate("anything", [], direction="input")
        assert result.violations == []
        assert result.blocked is False
        assert result.max_severity == "low"
        assert result.rewritten == "anything"

    @pytest.mark.asyncio
    async def test_disabled_policy_skipped(self) -> None:
        p = _policy(rule=r"\d+", enabled=False)
        result = await evaluate("123", [p], direction="input")
        assert result.violations == []

    @pytest.mark.asyncio
    async def test_direction_filter(self) -> None:
        p_in = _policy(name="in", rule=r"X", direction="input")
        p_out = _policy(name="out", rule=r"X", direction="output")
        # "X" appears in the text. Input policy fires for input direction.
        result_in = await evaluate("X", [p_in, p_out], direction="input")
        assert [v.policy_name for v in result_in.violations] == ["in"]
        result_out = await evaluate("X", [p_in, p_out], direction="output")
        assert [v.policy_name for v in result_out.violations] == ["out"]

    @pytest.mark.asyncio
    async def test_both_direction(self) -> None:
        p = _policy(rule=r"X", direction="both")
        r_in = await evaluate("X", [p], direction="input")
        r_out = await evaluate("X", [p], direction="output")
        assert len(r_in.violations) == 1
        assert len(r_out.violations) == 1

    @pytest.mark.asyncio
    async def test_block_action(self) -> None:
        p = _policy(rule=r"X", action="block", severity="high")
        result = await evaluate("X", [p], direction="input")
        assert result.blocked is True
        assert result.max_severity == "high"

    @pytest.mark.asyncio
    async def test_rewrite_action(self) -> None:
        p = _policy(
            name="my_policy",
            rule=r"\b\d{3}\b",
            action="rewrite",
            severity="medium",
        )
        result = await evaluate("the code is 123 here", [p], direction="output")
        assert "123" not in result.rewritten
        assert "[REDACTED:my_policy]" in result.rewritten

    @pytest.mark.asyncio
    async def test_multiple_rewrites(self) -> None:
        # Two policies, each rewrites a different range.
        p1 = _policy(name="p1", rule=r"\d+", action="rewrite", direction="output")
        p2 = _policy(name="p2", rule=r"[A-Z]+", action="rewrite", direction="output")
        result = await evaluate("abc 123 DEF", [p1, p2], direction="output")
        # Both replaced.
        assert "[REDACTED:p1]" in result.rewritten
        assert "[REDACTED:p2]" in result.rewritten

    @pytest.mark.asyncio
    async def test_on_violation_callback(self) -> None:
        seen: list[tuple[str, str]] = []

        def callback(v: GuardrailViolation, text: str) -> None:
            seen.append((v.policy_name, text))
        p = _policy(name="p1", rule=r"X", direction="input")
        await evaluate("X", [p], direction="input", on_violation=callback)
        assert ("p1", "X") in seen

    @pytest.mark.asyncio
    async def test_max_severity_picks_highest(self) -> None:
        p1 = _policy(name="low_p", rule=r"X", severity="low", direction="input")
        p2 = _policy(name="critical_p", rule=r"X", severity="critical", direction="input")
        result = await evaluate("X", [p1, p2], direction="input")
        assert result.max_severity == "critical"

    @pytest.mark.asyncio
    async def test_non_string_text_coerced(self) -> None:
        p = _policy(rule=r"\d+", direction="input")
        result = await evaluate(12345, [p], direction="input")
        assert result.text == "12345"
        assert len(result.violations) == 1


# ─- Dataclass round-trips ────────────────────────────────────────


class TestDataclass:
    def test_result_to_dict(self) -> None:
        v = GuardrailViolation(
            policy_name="p", rule_type="regex", action="flag",
            severity="low", direction="input",
            matched_text="x", span=(0, 1), reason="r",
        )
        r = GuardrailResult(
            text="x", violations=[v], rewritten="x",
            blocked=False, max_severity="low",
        )
        d = r.to_dict()
        assert d["text"] == "x"
        assert d["max_severity"] == "low"
        assert d["violations"][0]["policy_name"] == "p"
        assert d["violations"][0]["span"] == [0, 1]

    def test_result_defaults(self) -> None:
        r = GuardrailResult(text="x")
        assert r.violations == []
        assert r.rewritten == ""
        assert r.blocked is False
        assert r.max_severity == "low"

    def test_severity_rank_ordering(self) -> None:
        assert SEVERITY_RANK["low"] < SEVERITY_RANK["medium"]
        assert SEVERITY_RANK["medium"] < SEVERITY_RANK["high"]
        assert SEVERITY_RANK["high"] < SEVERITY_RANK["critical"]
