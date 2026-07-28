"""Unit tests for F81 AlertCompiler."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.alerts.compiler import (
    AlertCompiler,
    UnsafeFilterKeyError,
    filters_to_nl,
    rule_to_eql,
)
from eden.alerts.triage_judge import AlertTriageJudge
from eden.services.cat2_intel.signals import CompiledRule, compile_signal


class TestRuleToEql:
    def test_cost_per_call_compiles(self) -> None:
        rule = compile_signal(
            "cost per call above $0.30 in the last hour"
        )
        assert rule.metric == "cost_per_call"
        eql = rule_to_eql(rule)
        assert "any.cost_usd" in eql
        assert "telemetry_events" in eql
        assert "0.3" in eql or "0.30" in eql

    def test_error_rate_compiles(self) -> None:
        rule = compile_signal("error rate above 5% in the last 24 hours")
        eql = rule_to_eql(rule)
        assert "error" in eql.lower()
        assert "0.05" in eql

    def test_filters_to_nl(self) -> None:
        text = filters_to_nl({"outcome": "failure", "agent_id": "support"})
        assert "failure" in text
        assert "support" in text


class TestScopeFiltersInjection:
    """Regression tests for the CRITICAL SQL/EQL injection in
    ``_scope_filters`` (client-controlled ``context.filters`` /
    ``context.trace_id`` interpolated unescaped into WHERE-clause
    fragments)."""

    def test_filter_value_quote_breakout_is_escaped(self) -> None:
        rule = compile_signal("error rate above 5% in the last hour")
        payload = "' OR '1'='1"
        eql = rule_to_eql(rule, {"filters": {"outcome": payload}})

        # The payload must end up escaped inside a single string literal
        # (quotes doubled per ClickHouse/SQL string-literal convention),
        # never as a bare `' OR '1'='1'` clause-breakout.
        expected_literal = "'" + payload.replace("'", "''") + "'"
        assert f"any.outcome = {expected_literal}" in eql
        # No unescaped clause injection: the raw payload with its
        # original (unescaped) quotes must not appear verbatim.
        assert f"any.outcome = '{payload}'" not in eql

        # The literal must contain an even number of quote characters
        # (every embedded `'` doubled to `''`), confirming it stays a
        # single balanced string literal rather than breaking out.
        assert expected_literal.count("'") % 2 == 0

    def test_trace_id_quote_breakout_is_escaped(self) -> None:
        rule = compile_signal("error rate above 5% in the last hour")
        payload = "abc' OR '1'='1"
        eql = rule_to_eql(rule, {"trace_id": payload})
        expected_literal = "'" + payload.replace("'", "''") + "'"
        assert f"trace_id = {expected_literal}" in eql
        assert f"trace_id = '{payload}'" not in eql

    def test_invalid_filter_key_is_rejected(self) -> None:
        rule = compile_signal("error rate above 5% in the last hour")
        with pytest.raises(UnsafeFilterKeyError):
            rule_to_eql(rule, {"filters": {"x; DROP TABLE telemetry_events;--": "1"}})

    def test_invalid_filter_key_with_space_is_rejected(self) -> None:
        rule = compile_signal("error rate above 5% in the last hour")
        with pytest.raises(UnsafeFilterKeyError):
            rule_to_eql(rule, {"filters": {"outcome or 1=1": "x"}})

    def test_valid_filter_key_and_value_still_compiles(self) -> None:
        rule = compile_signal("error rate above 5% in the last hour")
        eql = rule_to_eql(rule, {"filters": {"agent_id": "support-bot"}})
        assert "any.agent_id = 'support-bot'" in eql

    def test_filter_key_with_trailing_newline_is_rejected(self) -> None:
        """GAP 2: a bare ``^...$`` regex matched with ``.match()`` lets
        Python's ``$`` match immediately before a trailing newline (even
        without ``re.MULTILINE``), so ``"agent_id\\n"`` previously passed
        validation and was interpolated verbatim."""
        rule = compile_signal("error rate above 5% in the last hour")
        with pytest.raises(UnsafeFilterKeyError):
            rule_to_eql(rule, {"filters": {"agent_id\n": "support-bot"}})

    def test_filter_value_odd_trailing_backslashes_is_escaped(self) -> None:
        """A value ending in an odd number of backslashes must not defeat
        quote-doubling under ClickHouse's backslash-escape string-literal
        semantics (GAP 1: backslash-escaping bypass)."""
        rule = compile_signal("error rate above 5% in the last hour")
        payload = "x\\"  # two characters: 'x' and a single backslash
        eql = rule_to_eql(rule, {"filters": {"agent_id": payload}})

        # The unsafe old behaviour (only doubling quotes) would emit the
        # bare fragment `any.agent_id = 'x\'` -- under backslash-escape
        # parsing, that trailing `\'` is consumed as an *escaped* quote
        # character rather than the closing delimiter, so the string
        # never actually terminates there. That exact unterminated
        # sequence must not appear.
        unsafe_fragment = "any.agent_id = 'x\\'"
        assert unsafe_fragment not in eql

        # The safe fragment doubles the backslash first (so it is
        # unambiguously paired) and *then* the (absent) quote, yielding a
        # properly terminated literal: 'x\\' i.e. quote, x, \\, \\, quote.
        safe_fragment = "any.agent_id = 'x\\\\'"
        assert safe_fragment in eql

        # Sanity-check by walking the fragment under backslash-escape
        # semantics ourselves: strip the enclosing quotes and resolve
        # `\\` -> `\` pairs; the result must be exactly the original
        # payload, and the literal must consume exactly to its closing
        # quote (i.e. an even number of literal backslashes precede it).
        start = eql.index("any.agent_id = '") + len("any.agent_id = '")
        end = eql.index("'", start)
        # An escaped quote (odd run of backslashes immediately before it)
        # would make this the *wrong* closing quote, not the real one.
        backslash_run = 0
        i = end - 1
        while i >= start and eql[i] == "\\":
            backslash_run += 1
            i -= 1
        assert backslash_run % 2 == 0
        raw_between = eql[start:end]
        assert raw_between.replace("\\\\", "\\") == payload

    @pytest.mark.asyncio
    async def test_compile_rejects_malicious_filter_key(self) -> None:
        compiler = AlertCompiler()
        with patch(
            "eden.alerts.compiler.EQLParser.parse",
            AsyncMock(return_value={"status": "ok", "data": {"warnings": []}}),
        ):
            with pytest.raises(UnsafeFilterKeyError):
                await compiler.compile(
                    "org_test",
                    "error rate above 5% in the last hour",
                    context={"filters": {"x; DROP TABLE x;--": "1"}},
                )


@pytest.mark.asyncio
async def test_alert_compiler_returns_eql() -> None:
    compiler = AlertCompiler()
    with patch(
        "eden.alerts.compiler.EQLParser.parse",
        AsyncMock(return_value={"status": "ok", "data": {"warnings": []}}),
    ):
        result = await compiler.compile(
            "org_test",
            "cost per call above $0.30 for 15 minutes",
        )
    assert result["eql"]
    assert "telemetry_events" in result["eql"]
    assert result.get("suggested_name")


@pytest.mark.asyncio
async def test_benign_marketing_spike_suppressed() -> None:
    judge = AlertTriageJudge()
    verdict = await judge.judge(
        "org_test",
        alert_event_id="evt_1",
        rule_name="Cost spike",
        nl_text="cost alert",
        payload={"tags": "campaign=summer_sale marketing campaign"},
    )
    assert verdict["verdict"] == "benign"
    assert verdict["confidence"] >= 0.8


@pytest.mark.asyncio
async def test_duplicate_links_open_issue() -> None:
    judge = AlertTriageJudge()
    verdict = await judge.judge(
        "org_test",
        alert_event_id="evt_2",
        rule_name="Tool errors",
        nl_text="tool error rate",
        payload={"issue_id": "issue-abc"},
    )
    assert verdict["verdict"] == "duplicate"
    assert verdict.get("incident_id") == "issue-abc"
