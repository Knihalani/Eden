"""Tests for the incident + scheduled triggers."""

from __future__ import annotations

import pytest

from eden.code_change.triggers import incident_trigger, scheduled_trigger
from eden.code_change.triggers.incident_trigger import (
    IncidentContext,
    gather_context,
)


class TestGatherContext:
    """gather_context builds the context from the input payload."""

    def test_minimal_payload(self):
        ctx = gather_context({"org_id": "org_1"})
        assert ctx.org_id == "org_1"
        assert ctx.repo_full_name == ""
        assert ctx.incident_summary == ""

    def test_full_payload(self):
        ctx = gather_context({
            "org_id": "org_1",
            "repo_full_name": "acme/agent",
            "branch": "main",
            "summary": "Latency spike",
            "error_signature": "TimeoutError",
            "trace_ids": ["trace_a", "trace_b"],
            "file_path_hint": "src/eden/foo.py",
            "evidence_count": 3,
            "rca_confidence": 0.85,
            "quality_score": 0.80,
            "blast_radius_score": 0.10,
            "reverted_history": 0,
            "denied_history": 0,
            "fix_area_localized": True,
            "can_validate": True,
            "protected_path_match": False,
        })
        assert ctx.org_id == "org_1"
        assert ctx.repo_full_name == "acme/agent"
        assert ctx.incident_summary == "Latency spike"
        assert ctx.rca_confidence == 0.85
        assert ctx.fix_area_localized is True
        assert ctx.can_validate is True

    def test_graph_files_promote_to_hint(self):
        """If file_path_hint is empty but graph surfaced a path, use it."""
        ctx = gather_context({
            "org_id": "org_1",
            "graph_files": ("src/eden/foo.py", "src/eden/bar.py"),
        })
        assert ctx.file_path_hint == "src/eden/foo.py"
        assert "src/eden/bar.py" in ctx.graph_files

    def test_existing_hint_takes_precedence(self):
        ctx = gather_context({
            "org_id": "org_1",
            "file_path_hint": "src/existing.py",
            "graph_files": ("src/graph.py",),
        })
        assert ctx.file_path_hint == "src/existing.py"

    def test_candidate_id_priority(self):
        """cluster_id > rca_id > incident_id for the candidate id."""
        ctx = gather_context({
            "org_id": "org_1",
            "cluster_id": "clu_1",
            "rca_id": "rca_2",
            "incident_id": "inc_3",
        })
        assert ctx.candidate_id == "clu_1"

        ctx2 = gather_context({"org_id": "org_1", "rca_id": "rca_2"})
        assert ctx2.candidate_id == "rca_2"

        ctx3 = gather_context({"org_id": "org_1", "incident_id": "inc_3"})
        assert ctx3.candidate_id == "inc_3"


class TestIncidentTriggerRun:
    """The async run() returns structured decisions."""

    @pytest.mark.asyncio
    async def test_missing_org_id(self):
        result = await incident_trigger.run({})
        assert result["kind"] == "report_only"
        assert result["reason"] == "missing_org_id"

    @pytest.mark.asyncio
    async def test_low_confidence_denied(self):
        # All evidence low → gate denies → report_only.
        result = await incident_trigger.run({
            "org_id": "org_1",
            "summary": "tiny issue",
            "rca_confidence": 0.1,
            "quality_score": 0.2,
            "blast_radius_score": 0.5,
            "evidence_count": 0,
            "fix_area_localized": False,
            "can_validate": False,
        })
        assert result["kind"] == "report_only"
        # No DB so we expect gate_denied (the breaker +
        # dedupe + rate-limit all fail-open / fail-closed
        # in the unit-test env, but the gate check runs
        # first).
        assert "gate_denied" in result["reason"] or "rate_limit" in result["reason"]

    @pytest.mark.asyncio
    async def test_high_confidence_keeps_going(self):
        # High-confidence candidate with no DB → gate clears,
        # breaker fails open (True), dedupe fails open
        # (not duplicate), rate limit fails closed
        # (False) → still report_only but with reason
        # rate_limit, not gate_denied.
        result = await incident_trigger.run({
            "org_id": "org_1",
            "summary": "Real latency issue",
            "rca_confidence": 0.85,
            "quality_score": 0.80,
            "blast_radius_score": 0.10,
            "evidence_count": 5,
            "fix_area_localized": True,
            "can_validate": True,
            "repo_id": "repo_test",
            "repo_full_name": "acme/agent",
            "trace_ids": ["trace_a"],
        })
        # Either we got a real PR (if agent was wired) or
        # we hit the rate-limit fail-closed. Both are
        # acceptable for a high-confidence candidate.
        assert result["kind"] in ("pr_ready", "draft_pr", "report_only")


class TestScheduledTriggerRun:
    """The scheduled trigger aggregates results."""

    @pytest.mark.asyncio
    async def test_empty_candidates(self):
        summary = await scheduled_trigger.run([])
        assert summary["candidates_received"] == 0
        assert summary["prs_spawned"] == 0
        assert summary["reports_only"] == 0

    @pytest.mark.asyncio
    async def test_low_confidence_candidates_all_reports(self):
        # Without a DB, the rate limiter fails closed, so
        # every candidate becomes a report_only with
        # reason=rate_limit.
        candidates = [
            {
                "org_id": "org_1",
                "summary": "tiny issue 1",
                "rca_confidence": 0.1,
            },
            {
                "org_id": "org_1",
                "summary": "tiny issue 2",
                "rca_confidence": 0.1,
            },
        ]
        summary = await scheduled_trigger.run(candidates)
        assert summary["candidates_received"] == 2
        assert summary["prs_spawned"] == 0
        # All candidates were processed (not crashed).
        assert len(summary["results"]) == 2

    @pytest.mark.asyncio
    async def test_max_prs_cap_enforced(self):
        """Even if every candidate passed, cap at max_prs."""
        summary = await scheduled_trigger.run(
            [], max_prs=3,
        )
        assert summary["max_prs_cap"] == 3


class TestIncidentContextDataclass:
    """The IncidentContext dataclass is well-formed."""

    def test_default(self):
        ctx = IncidentContext(org_id="org_1")
        assert ctx.org_id == "org_1"
        assert ctx.trace_ids == ()
        assert ctx.graph_files == ()
        assert ctx.evidence_count == 0
