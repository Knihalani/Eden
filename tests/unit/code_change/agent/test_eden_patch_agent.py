"""Tests for the EdenPatchAgent — the production-default PR agent.

The EdenPatchAgent wraps Eden's existing ``PatchGenerator``
(which calls real LLMs through the ``ModelRouter``). We
mock the underlying ``PatchGenerator.generate`` so the
tests don't need an actual LLM, but we exercise every
failure mode + every success path the agent handles.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.code_change.agent import (
    EdenPatchAgent,
    PRCandidate,
    PRResult,
)


def _candidate(**overrides) -> PRCandidate:
    base = dict(
        repo_full_name="acme/agent",
        branch="main",
        incident_summary="Latency spike on /v1/chat",
        candidate_id="clu_test_001",
        graph_files=("src/eden/foo.py",),
        graph_snippets=(),
        evidence_refs=("trace_a", "trace_b"),
        target_kind="incident",
        repo_id="repo_test",
        org_id="org_test",
    )
    base.update(overrides)
    return PRCandidate(**base)


# ── Failure modes that don't need the LLM ────────────────────────────


class TestEdenPatchAgentFailureModes:
    """Every failure mode returns a structured ``report_only``."""

    @pytest.mark.asyncio
    async def test_missing_repo_full_name(self):
        agent = EdenPatchAgent()
        result = await agent.run(_candidate(repo_full_name=""))
        assert result is not None
        assert result.kind == "report_only"
        assert result.reason == "missing_repo_full_name"

    @pytest.mark.asyncio
    async def test_missing_org_id(self):
        agent = EdenPatchAgent()
        result = await agent.run(_candidate(org_id=""))
        assert result is not None
        assert result.kind == "report_only"
        assert result.reason == "missing_org_id"

    @pytest.mark.asyncio
    async def test_patch_generator_init_failure(self):
        """A broken PatchGenerator init returns report_only, not raise."""
        agent = EdenPatchAgent()
        with patch(
            "eden.code_change.patch_generator.PatchGenerator",
            side_effect=RuntimeError("config missing"),
        ):
            result = await agent.run(_candidate())
        assert result is not None
        assert result.kind == "report_only"
        assert "patch_generator_init_failed" in result.reason

    @pytest.mark.asyncio
    async def test_timeout_returns_report_only(self):
        """An asyncio.wait_for timeout becomes a report-only result."""
        agent = EdenPatchAgent(policy={"timeout_seconds": 0.01})
        # Patch PatchGenerator to sleep forever.
        async def _slow(*args, **kwargs):
            import asyncio
            await asyncio.sleep(60)
            return {"status": "ok", "data": {"diff": "+++ b/x\n@@\n+x\n"}}
        with patch(
            "eden.code_change.patch_generator.PatchGenerator",
        ) as mock_pg:
            instance = mock_pg.return_value
            instance.generate = AsyncMock(side_effect=_slow)
            result = await agent.run(_candidate())
        assert result is not None
        assert result.kind == "report_only"
        assert "timeout" in result.reason

    @pytest.mark.asyncio
    async def test_generate_raises_returns_report_only(self):
        agent = EdenPatchAgent()
        with patch(
            "eden.code_change.patch_generator.PatchGenerator",
        ) as mock_pg:
            mock_pg.return_value.generate = AsyncMock(
                side_effect=RuntimeError("LLM outage"),
            )
            result = await agent.run(_candidate())
        assert result is not None
        assert result.kind == "report_only"
        assert "agent_exception" in result.reason


# ── PatchGenerator envelope handling ────────────────────────────────


class TestEdenPatchAgentEnvelopeHandling:
    """The agent correctly inspects PatchGenerator envelopes."""

    @pytest.mark.asyncio
    async def test_not_implemented_envelope_becomes_report_only(self):
        """PatchGenerator's Gate-4a block envelope → report_only."""
        agent = EdenPatchAgent()
        envelope = {
            "status": "not_implemented",
            "data": {"gate": "4a_blocked"},
            "message": "Gate 4a blocked — sandbox unavailable",
        }
        with patch(
            "eden.code_change.patch_generator.PatchGenerator",
        ) as mock_pg:
            mock_pg.return_value.generate = AsyncMock(return_value=envelope)
            result = await agent.run(_candidate())
        assert result is not None
        assert result.kind == "report_only"
        assert "4a_blocked" in result.reason

    @pytest.mark.asyncio
    async def test_error_envelope_becomes_report_only(self):
        agent = EdenPatchAgent()
        envelope = {
            "status": "error",
            "error_code": "validation_failed",
            "message": "diff rejected by critic",
        }
        with patch(
            "eden.code_change.patch_generator.PatchGenerator",
        ) as mock_pg:
            mock_pg.return_value.generate = AsyncMock(return_value=envelope)
            result = await agent.run(_candidate())
        assert result is not None
        assert result.kind == "report_only"
        assert "validation_failed" in result.reason

    @pytest.mark.asyncio
    async def test_ok_envelope_no_diff_becomes_report_only(self):
        agent = EdenPatchAgent()
        envelope = {
            "status": "ok",
            "data": {"diff": "", "cost_usd": 0.001},
        }
        with patch(
            "eden.code_change.patch_generator.PatchGenerator",
        ) as mock_pg:
            mock_pg.return_value.generate = AsyncMock(return_value=envelope)
            result = await agent.run(_candidate())
        assert result is not None
        assert result.kind == "report_only"
        assert "no_diff" in result.reason

    @pytest.mark.asyncio
    async def test_ok_envelope_with_diff_becomes_draft_pr(self):
        agent = EdenPatchAgent()
        envelope = {
            "status": "ok",
            "data": {
                "diff": "--- a/foo.py\n+++ b/foo.py\n@@ -1,1 +1,1 @@\n-old\n+new\n",
                "cost_usd": 0.05,
                "quality_score": 0.7,
                "model_used": "anthropic/claude-sonnet-4.6",
                "patch_id": "patch_001",
            },
        }
        with patch(
            "eden.code_change.patch_generator.PatchGenerator",
        ) as mock_pg:
            mock_pg.return_value.generate = AsyncMock(return_value=envelope)
            result = await agent.run(_candidate())
        assert result is not None
        assert result.kind == "draft_pr"
        assert "old" in result.diff and "new" in result.diff
        assert result.conversation_id == "patch_001"


class TestEdenPatchAgentQualityPromotion:
    """High-quality + allowed decision → ``pr_ready`` promotion."""

    @pytest.mark.asyncio
    async def test_high_quality_promotes_to_pr_ready(self):
        from eden.code_change.discipline import Decision
        agent = EdenPatchAgent()
        envelope = {
            "status": "ok",
            "data": {
                "diff": "--- a/foo.py\n+++ b/foo.py\n@@ -1,1 +1,1 @@\n-old\n+new\n",
                "cost_usd": 0.05,
                "quality_score": 0.92,  # high
                "model_used": "anthropic/claude-sonnet-4.6",
                "patch_id": "patch_high_quality",
            },
        }
        decision = Decision(
            allowed=True,
            score=0.92,
            reasons=["rca_confidence_high(0.92)"],
            fingerprint="fp_001",
        )
        with patch(
            "eden.code_change.patch_generator.PatchGenerator",
        ) as mock_pg:
            mock_pg.return_value.generate = AsyncMock(return_value=envelope)
            result = await agent.run(_candidate(), decision=decision)
        assert result is not None
        assert result.kind == "pr_ready"


# ── Cost + size enforcement ──────────────────────────────────────────


class TestEdenPatchAgentCostAndSize:
    """Cost cap + size cap are enforced even after the LLM call."""

    @pytest.mark.asyncio
    async def test_cost_above_cap_returns_report_only(self):
        agent = EdenPatchAgent(policy={"max_call_cost_usd": 0.10})
        envelope = {
            "status": "ok",
            "data": {
                "diff": "--- a/foo.py\n+++ b/foo.py\n@@ -1,1 +1,1 @@\n-old\n+new\n",
                "cost_usd": 1.50,  # above cap
                "quality_score": 0.7,
                "model_used": "anthropic/claude-opus-4",
            },
        }
        with patch(
            "eden.code_change.patch_generator.PatchGenerator",
        ) as mock_pg:
            mock_pg.return_value.generate = AsyncMock(return_value=envelope)
            result = await agent.run(_candidate())
        assert result is not None
        assert result.kind == "report_only"
        assert "cost_above_cap" in result.reason


# ── Cost accounting ─────────────────────────────────────────────────


class TestEdenPatchAgentCostAccounting:
    """Successful calls accumulate ``cost_used_usd``."""

    @pytest.mark.asyncio
    async def test_cost_accumulates_on_success(self):
        agent = EdenPatchAgent()
        envelope = {
            "status": "ok",
            "data": {
                "diff": "--- a/foo.py\n+++ b/foo.py\n@@ -1,1 +1,1 @@\n-old\n+new\n",
                "cost_usd": 0.05,
                "quality_score": 0.7,
                "model_used": "anthropic/claude-sonnet-4.6",
                "patch_id": "patch_001",
            },
        }
        with patch(
            "eden.code_change.patch_generator.PatchGenerator",
        ) as mock_pg:
            mock_pg.return_value.generate = AsyncMock(return_value=envelope)
            await agent.run(_candidate())
            await agent.run(_candidate())
        # Two successful calls at $0.05 each.
        assert abs(agent.cost_used_usd - 0.10) < 1e-6


# ── Policy shape ────────────────────────────────────────────────────


class TestEdenPatchAgentPolicy:
    """The agent's policy is exposed + overridable."""

    def test_default_policy(self):
        agent = EdenPatchAgent()
        assert agent.policy["max_call_cost_usd"] == 0.50
        assert agent.policy["timeout_seconds"] == 120.0

    def test_custom_policy_override(self):
        agent = EdenPatchAgent(policy={"max_call_cost_usd": 0.10})
        assert agent.policy["max_call_cost_usd"] == 0.10
        # Unchanged defaults.
        assert agent.policy["timeout_seconds"] == 120.0


# ── Default selection ───────────────────────────────────────────────


class TestEdenPatchAgentIsDefault:
    """The factory defaults to EdenPatchAgent — it's the production
    default that uses Eden's ModelRouter to produce real LLM-backed
    patches. LocalCodingAgent is the bulletproof fallback when the
    LLM is unreachable.
    """

    def test_factory_returns_eden_patch_by_default(self, monkeypatch, tmp_path):
        from eden.code_change.agent import get_default_pr_agent
        agent = get_default_pr_agent()
        assert agent.name == "eden_patch"
