"""Tests for the PR-agent layer."""

from __future__ import annotations

import pytest

from eden.code_change.agent import (
    LocalPRAgent,
    OpenHandsPRAgent,
    PRCandidate,
    PRResult,
    get_default_pr_agent,
)
from eden.code_change.agent.factory import get_default_pr_agent as _factory_direct
from eden.code_change.agent.openhands import _extract_diff, _prompt_for


class TestLocalPRAgent:
    """The local fallback returns a structured report-only payload."""

    @pytest.mark.asyncio
    async def test_returns_report_only(self):
        agent = LocalPRAgent()
        candidate = PRCandidate(
            repo_full_name="acme/agent",
            branch="main",
            incident_summary="Spike in latency.",
            candidate_id="clu_001",
            graph_files=("src/eden/foo.py",),
            evidence_refs=("trace_abc", "trace_def"),
        )
        result = await agent.run(candidate)
        assert result is not None
        assert result.kind == "report_only"
        assert result.reason == "no_openhands_key"
        # Body is structured markdown.
        assert "Spike in latency" in result.body
        assert "src/eden/foo.py" in result.body
        assert "trace_abc" in result.body
        # No diff fabricated.
        assert result.diff == ""

    @pytest.mark.asyncio
    async def test_returns_report_only_with_minimal_inputs(self):
        agent = LocalPRAgent()
        candidate = PRCandidate(repo_full_name="acme/agent")
        result = await agent.run(candidate)
        assert result.kind == "report_only"
        assert result.reason == "no_openhands_key"


class TestFactoryEdenPatchIsDefault:
    """EdenPatchAgent is the production default — real LLM-backed
    patches via Eden's ModelRouter. LocalCodingAgent is the
    bulletproof fallback when the LLM is unreachable.
    """

    def test_no_credentials_returns_eden_patch(self, monkeypatch, tmp_path):
        monkeypatch.delenv("OPENHANDS_API_KEY", raising=False)
        monkeypatch.delenv("EDEN_AGENT_KIND", raising=False)
        monkeypatch.setenv("EDEN_LOCAL_REPO_PATH", str(tmp_path))
        agent = _factory_direct()
        assert agent.name == "eden_patch"


class TestFactoryEdenPatchSurvivesOpenHandsKey:
    """EdenPatchAgent is the production default. The OPENHANDS_API_KEY
    upgrade path is reserved for callers who explicitly construct
    OpenHandsPRAgent (the factory does not auto-promote to it).
    """

    def test_eden_patch_default(self, monkeypatch, tmp_path):
        monkeypatch.setenv("EDEN_LOCAL_REPO_PATH", str(tmp_path))
        agent = _factory_direct()
        assert agent.name == "eden_patch"

    def test_openhands_key_does_not_promote_away_from_eden_patch(
        self, monkeypatch, tmp_path,
    ):
        # OPENHANDS_API_KEY alone does NOT auto-promote;
        # EdenPatchAgent stays the default. Callers who want
        # the hosted path construct OpenHandsPRAgent explicitly.
        monkeypatch.setenv("OPENHANDS_API_KEY", "test-key-1234")
        monkeypatch.setenv("EDEN_LOCAL_REPO_PATH", str(tmp_path))
        agent = _factory_direct()
        assert agent.name == "eden_patch"


class TestOpenHandsPRAgent:
    """The OpenHands client is constructable + raises on missing key."""

    def test_requires_api_key(self):
        with pytest.raises(ValueError, match="non-empty api_key"):
            OpenHandsPRAgent(api_key="")

    def test_constructs_with_key(self):
        client = OpenHandsPRAgent(api_key="test-key-1234")
        assert client.name == "openhands"

    @pytest.mark.asyncio
    async def test_run_invalid_key_fails_gracefully(self, monkeypatch):
        """An invalid key + unreachable host returns None."""
        client = OpenHandsPRAgent(
            api_key="test-key-1234",
            base_url="http://127.0.0.1:1",
            timeout=1.0,
            max_wait_seconds=2.0,
        )
        candidate = PRCandidate(
            repo_full_name="acme/agent",
            incident_summary="Test.",
        )
        result = await client.run(candidate)
        # Network failure returns None (not raise).
        assert result is None


class TestExtractDiff:
    """The diff extractor pulls the first fenced diff/patch block."""

    def test_extracts_diff(self):
        text = (
            "Here's the fix:\n"
            "```diff\n"
            "--- a/foo.py\n"
            "+++ b/foo.py\n"
            "@@ -1,1 +1,1 @@\n"
            "-old\n"
            "+new\n"
            "```\n"
        )
        diff = _extract_diff(text)
        assert "--- a/foo.py" in diff
        assert "+new" in diff

    def test_empty_text_returns_empty(self):
        assert _extract_diff("") == ""

    def test_no_diff_returns_empty(self):
        text = "Just a description, no diff."
        assert _extract_diff(text) == ""


class TestPromptBuilder:
    """The prompt builder includes all the candidate's evidence."""

    def test_prompt_contains_summary(self):
        candidate = PRCandidate(
            repo_full_name="acme/agent",
            branch="main",
            incident_summary="Latency spike on /v1/chat",
        )
        prompt = _prompt_for(candidate)
        assert "Latency spike on /v1/chat" in prompt
        assert "acme/agent" in prompt
        assert "main" in prompt

    def test_prompt_contains_graph_files(self):
        candidate = PRCandidate(
            repo_full_name="acme/agent",
            graph_files=("src/foo.py", "src/bar.py"),
        )
        prompt = _prompt_for(candidate)
        assert "src/foo.py" in prompt
        assert "src/bar.py" in prompt

    def test_prompt_contains_evidence(self):
        candidate = PRCandidate(
            repo_full_name="acme/agent",
            evidence_refs=("trace_a", "trace_b"),
        )
        prompt = _prompt_for(candidate)
        assert "trace_a" in prompt
        assert "trace_b" in prompt


class TestPRResult:
    """The PRResult dataclass is well-formed."""

    def test_default(self):
        result = PRResult()
        assert result.kind == "report_only"
        assert result.title == ""
        assert result.body == ""
        assert result.diff == ""

    def test_full_construction(self):
        result = PRResult(
            kind="draft_pr",
            title="[Eden] Fix latency",
            body="Body",
            diff="--- a/foo.py\n+++ b/foo.py\n",
            conversation_id="abc123",
        )
        assert result.kind == "draft_pr"
        assert result.conversation_id == "abc123"
