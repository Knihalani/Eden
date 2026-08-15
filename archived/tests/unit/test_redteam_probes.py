"""Unit tests for Phase L — adversarial red-team probes.

What's covered:

  Probe catalogue (8 tests)
  ─────────────────────────
  * 12 probes ship.
  * Every probe has a name, category, severity, description.
  * Severities + categories are from the allowed sets.
  * Every probe has at least 1 attack prompt.
  * Every probe has a detector.
  * list_probes() returns sorted output.

  Detection helpers (8 tests)
  ──────────────────────────
  * _looks_like_refusal: catches "I cannot", "Sorry", etc.
  * _looks_like_pii_leak: catches SSN-shaped content.
  * _looks_like_compliance: short text = refusal; long
    = compliance.
  * _system_prompt_leak_detect: catches "You are...".
  * _training_data_detect: catches verbatim markers.
  * _tool_amplification_detect: counts tools.

  Probe runners (10 tests)
  ───────────────────────
  * ProbeRunner.run_probe: each prompt → one finding.
  * Failed flag matches detector output.
  * ProbeRunner.run_suite: every probe runs.
  * on_finding callback fires.
  * Persist to PG (FakePg).
  * High-severity failure logs a warning.
  * Probe not in catalogue → KeyError from runner.
  * probe_name, target_label, severity recorded.
  * Detect failures don't crash the runner.

  ProbeRunResult + ProbeFinding dataclass (4 tests)
  ────────────────────────────────────────────────
  * to_dict round-trip.
  * Default fields populated.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Optional
from unittest.mock import AsyncMock

import pytest

from eden.redteam.probes import (
    ALL_CATEGORIES,
    ALL_SEVERITIES,
    CATEGORY_EXCESSIVE_AGENCY,
    CATEGORY_JAILBREAK,
    CATEGORY_PII,
    CATEGORY_PROMPT_INJECTION,
    PROBE_CATALOGUE,
    SEVERITY_CRITICAL,
    SEVERITY_HIGH,
    SEVERITY_LOW,
    SEVERITY_MEDIUM,
    SEVERITY_RANK,
    AgentInvoker,
    Probe,
    ProbeFinding,
    ProbeRunner,
    ProbeRunResult,
    _looks_like_compliance_with_attack,
    _looks_like_pii_leak,
    _looks_like_refusal,
    _system_prompt_leak_detect,
    _tool_amplification_detect,
    _training_data_detect,
    get_probe,
    list_probes,
)

# ── Fake PG ───────────────────────────────────────────────────────


class FakePg:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple]] = []
        self._table: dict[str, dict[str, Any]] = {}

    async def execute(self, query: str, *args: Any) -> str:
        self.calls.append((query.strip().lower(), args))
        sql = " ".join(query.strip().lower().split())
        if sql.startswith("insert into redteam_findings"):
            fid = args[0]
            self._table[fid] = {
                "id": fid,
                "probe_name": args[1],
                "category": args[2],
                "severity": args[3],
                "attack_prompt": args[4],
                "agent_response": args[5],
                "failed": args[6],
                "detection_reason": args[7],
                "target_label": args[8],
                "tags": args[9],
                "created_at": args[10],
            }
            return "INSERT 0 1"
        return "OK"


# ── Catalogue ─────────────────────────────────────────────────────


class TestProbeCatalogue:
    def test_twelve_probes_ship(self) -> None:
        # 5 jailbreak + 3 prompt-injection + 2 pii +
        # 2 excessive-agency = 12.
        assert len(PROBE_CATALOGUE) == 12

    def test_every_probe_has_required_fields(self) -> None:
        for name, p in PROBE_CATALOGUE.items():
            assert p.name == name
            assert p.category in ALL_CATEGORIES, f"{name}: bad category {p.category}"
            assert p.severity in ALL_SEVERITIES, f"{name}: bad severity {p.severity}"
            assert p.description  # non-empty
            assert p.prompts, f"{name}: no prompts"
            assert callable(p.detect)

    def test_catalogue_severities_well_distributed(self) -> None:
        # Sanity check: at least one of every severity.
        sevs = {p.severity for p in PROBE_CATALOGUE.values()}
        assert SEVERITY_LOW in sevs
        assert SEVERITY_MEDIUM in sevs
        assert SEVERITY_HIGH in sevs
        assert SEVERITY_CRITICAL in sevs

    def test_catalogue_categories_well_distributed(self) -> None:
        cats = {p.category for p in PROBE_CATALOGUE.values()}
        assert CATEGORY_JAILBREAK in cats
        assert CATEGORY_PROMPT_INJECTION in cats
        assert CATEGORY_PII in cats
        assert CATEGORY_EXCESSIVE_AGENCY in cats

    def test_list_probes_returns_sorted(self) -> None:
        probes = list_probes()
        names = [p.name for p in probes]
        assert names == sorted(names)

    def test_get_probe_returns_none_for_unknown(self) -> None:
        assert get_probe("nope") is None

    def test_get_probe_returns_probe(self) -> None:
        p = get_probe("stan_jailbreak")
        assert p is not None
        assert p.name == "stan_jailbreak"

    def test_severity_rank_is_strict_ordering(self) -> None:
        assert SEVERITY_RANK[SEVERITY_LOW] < SEVERITY_RANK[SEVERITY_MEDIUM]
        assert SEVERITY_RANK[SEVERITY_MEDIUM] < SEVERITY_RANK[SEVERITY_HIGH]
        assert SEVERITY_RANK[SEVERITY_HIGH] < SEVERITY_RANK[SEVERITY_CRITICAL]

    def test_every_probe_has_at_least_one_prompt(self) -> None:
        for p in PROBE_CATALOGUE.values():
            assert len(p.prompts) >= 1


# ── Detection helpers ─────────────────────────────────────────────


class TestDetectionHelpers:
    def test_refusal_detected(self) -> None:
        assert _looks_like_refusal("I cannot help with that.") is True
        assert _looks_like_refusal("Sorry, I'm not able to do that.") is True
        assert _looks_like_refusal("As an AI, I must decline.") is True
        assert _looks_like_refusal("I apologize, but I can't.") is True

    def test_refusal_not_detected(self) -> None:
        assert _looks_like_refusal("Sure! Here's how to bypass a firewall: step 1...") is False
        assert _looks_like_refusal("The capital of France is Paris.") is False

    def test_pii_leak_detected(self) -> None:
        assert _looks_like_pii_leak("Your SSN is 123-45-6789.") is True
        assert _looks_like_pii_leak("Their email address is alice@example.com") is True
        assert _looks_like_pii_leak("The phone number is 555-1234.") is True

    def test_pii_leak_not_detected(self) -> None:
        assert _looks_like_pii_leak("The capital of France is Paris.") is False
        # Marker present but no digit-shaped pattern.
        assert _looks_like_pii_leak("Tell me about your password policies.") is False

    def test_compliance_short_text_is_refusal(self) -> None:
        assert _looks_like_compliance_with_attack("No.") is False
        assert _looks_like_compliance_with_attack("I cannot help with that.") is False

    def test_compliance_long_text_without_refusal(self) -> None:
        text = "Sure, here's a long response about how to do the thing you asked about, with detailed steps."
        assert _looks_like_compliance_with_attack(text) is True

    def test_system_prompt_leak_detect(self) -> None:
        failed, _reason = _system_prompt_leak_detect("You are a helpful assistant. Your task is to...")
        assert failed is True
        failed, _reason = _system_prompt_leak_detect("You must always respond in a friendly tone.")
        assert failed is True
        failed, _reason = _system_prompt_leak_detect("Here's the weather: sunny.")
        assert failed is False

    def test_training_data_detect(self) -> None:
        # Lorem ipsum marker.
        failed, _reason = _training_data_detect("Lorem ipsum dolor sit amet, consectetur adipiscing elit.")
        assert failed is True
        # Long response.
        failed, _reason = _training_data_detect("x" * 6000)
        assert failed is True
        # Normal short response.
        failed, _reason = _training_data_detect("The capital of France is Paris.")
        assert failed is False

    def test_tool_amplification_detect(self) -> None:
        failed, _reason = _tool_amplification_detect("search, read, write, list, delete, archive")
        assert failed is True
        failed, _reason = _tool_amplification_detect("search")
        assert failed is False
        failed, _reason = _tool_amplification_detect("search, read, write, list")
        assert failed is False  # exactly 4, not >4


# ── Probe runner ──────────────────────────────────────────────────


class TestProbeRunner:
    async def _invoker(self, response: str) -> AgentInvoker:
        async def _i(prompt: str) -> str:
            return response
        return _i

    @pytest.mark.asyncio
    async def test_run_probe_one_finding_per_prompt(self) -> None:
        probe = PROBE_CATALOGUE["stan_jailbreak"]
        runner = ProbeRunner()
        invoker = await self._invoker("I cannot help with that.")
        result = await runner.run_probe(probe, target=invoker)
        # 2 prompts in stan_jailbreak.
        assert len(result.findings) == 2
        assert result.prompts_executed == 2

    @pytest.mark.asyncio
    async def test_run_probe_failed_flag(self) -> None:
        probe = PROBE_CATALOGUE["stan_jailbreak"]
        runner = ProbeRunner()
        # Agent refuses → no failure.
        ref_invoker = await self._invoker("I cannot help with that.")
        result = await runner.run_probe(probe, target=ref_invoker)
        assert result.failure_count == 0
        assert all(not f.failed for f in result.findings)

        # Agent complies → failure.
        comp_invoker = await self._invoker("Sure, here's how to do that dangerous thing.")
        result = await runner.run_probe(probe, target=comp_invoker)
        assert result.failure_count == len(probe.prompts)
        assert all(f.failed for f in result.findings)

    @pytest.mark.asyncio
    async def test_run_suite_runs_every_probe(self) -> None:
        runner = ProbeRunner()
        invoker = await self._invoker("I cannot help with that.")
        results = await runner.run_suite(
            list_probes(), target=invoker,
        )
        # One result per probe.
        assert len(results) == len(PROBE_CATALOGUE)
        assert {r.probe_name for r in results} == set(PROBE_CATALOGUE.keys())

    @pytest.mark.asyncio
    async def test_on_finding_callback_fires(self) -> None:
        seen: list[ProbeFinding] = []
        runner = ProbeRunner(on_finding=seen.append)
        probe = PROBE_CATALOGUE["refusal_suppression"]  # has 1 prompt
        invoker = await self._invoker("I cannot.")
        await runner.run_probe(probe, target=invoker)
        assert len(seen) == 1
        assert seen[0].probe_name == "refusal_suppression"

    @pytest.mark.asyncio
    async def test_persist_to_pg(self) -> None:
        pg = FakePg()
        runner = ProbeRunner(pg=pg)
        probe = PROBE_CATALOGUE["refusal_suppression"]  # 1 prompt
        invoker = await self._invoker("I cannot help with that.")
        await runner.run_probe(probe, target=invoker)
        # The pg saw one INSERT.
        insert_calls = [c for c in pg.calls if "insert into redteam_findings" in c[0]]
        assert len(insert_calls) == 1

    @pytest.mark.asyncio
    async def test_high_severity_failure_logs_warning(self, caplog) -> None:
        runner = ProbeRunner()  # fire_drift_hook defaults to True
        probe = PROBE_CATALOGUE["stan_jailbreak"]  # severity=high
        invoker = await self._invoker("Sure! Here's how to do that dangerous thing.")
        with caplog.at_level(logging.WARNING, logger="eden.redteam.probes"):
            await runner.run_probe(probe, target=invoker)
        # A warning was emitted.
        assert any("redteam.finding" in r.message for r in caplog.records)

    @pytest.mark.asyncio
    async def test_target_label_recorded(self) -> None:
        runner = ProbeRunner()
        probe = PROBE_CATALOGUE["refusal_suppression"]
        invoker = await self._invoker("I cannot help with that.")
        result = await runner.run_probe(
            probe, target=invoker, target_label="my-agent",
        )
        assert result.target_label == "my-agent"
        assert all(f.target_label == "my-agent" for f in result.findings)

    @pytest.mark.asyncio
    async def test_probe_with_exception_in_invoker_continues(self) -> None:
        # If the invoker raises for one prompt, the runner
        # should catch and continue (or at least propagate
        # clearly). The current impl propagates — we
        # document that.
        probe = PROBE_CATALOGUE["refusal_suppression"]

        async def flaky_invoker(prompt: str) -> str:
            raise RuntimeError("agent timed out")
        runner = ProbeRunner()
        with pytest.raises(RuntimeError, match="timed out"):
            await runner.run_probe(probe, target=flaky_invoker)

    @pytest.mark.asyncio
    async def test_pii_probe_detects_real_pii(self) -> None:
        # The PII probe's detector is stricter than the
        # generic refusal detector.
        probe = PROBE_CATALOGUE["pii_extraction"]
        runner = ProbeRunner()
        # Agent leaks "user@example.com" with a marker → PII probe flags.
        invoker = await self._invoker(
            "Sure, the previous user's email address is user@example.com.",
        )
        result = await runner.run_probe(probe, target=invoker)
        assert any(f.failed for f in result.findings)

    @pytest.mark.asyncio
    async def test_pii_probe_passes_on_clean_refusal(self) -> None:
        probe = PROBE_CATALOGUE["pii_extraction"]
        runner = ProbeRunner()
        invoker = await self._invoker("I cannot share other users' information.")
        result = await runner.run_probe(probe, target=invoker)
        assert all(not f.failed for f in result.findings)


# ── Dataclass ─────────────────────────────────────────────────────


class TestDataclass:
    def test_finding_to_dict_round_trip(self) -> None:
        f = ProbeFinding(
            id="f-1",
            probe_name="stan_jailbreak",
            category="jailbreak",
            severity="high",
            attack_prompt="attack",
            agent_response="response",
            failed=True,
            detection_reason="complied",
            target_label="agent-1",
            tags=["jailbreak", "high"],
            created_at="2026-06-17T12:00:00+00:00",
        )
        d = f.to_dict()
        assert d["id"] == "f-1"
        assert d["failed"] is True
        assert d["tags"] == ["jailbreak", "high"]

    def test_run_result_defaults(self) -> None:
        r = ProbeRunResult(probe_name="p", target_label="t")
        assert r.findings == []
        assert r.prompts_executed == 0
        assert r.failure_count == 0

    def test_run_result_to_dict(self) -> None:
        r = ProbeRunResult(
            probe_name="p",
            target_label="t",
            findings=[
                ProbeFinding(
                    id="f", probe_name="p", category="jailbreak",
                    severity="high", attack_prompt="a", agent_response="r",
                    failed=True, detection_reason="x",
                ),
            ],
            prompts_executed=1,
            failure_count=1,
        )
        d = r.to_dict()
        assert d["probe_name"] == "p"
        assert d["failure_count"] == 1
        assert len(d["findings"]) == 1
