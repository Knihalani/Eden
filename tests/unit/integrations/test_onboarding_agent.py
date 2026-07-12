"""Tests for the onboarding integration agent."""

from __future__ import annotations

import json

import pytest

from eden.integrations.framework_detector import FrameworkDetection
from eden.integrations.onboarding_agent import (
    _merge_detection,
    _parse_agent_json,
    refine_framework_detection,
)


def test_parse_agent_json_strips_fences():
    raw = '```json\n{"framework": "langchain", "confidence": 0.8}\n```'
    parsed = _parse_agent_json(raw)
    assert parsed is not None
    assert parsed["framework"] == "langchain"


def test_merge_keeps_heuristic_when_agent_weak():
    heuristic = FrameworkDetection(
        framework="langchain",
        language="python",
        confidence=0.9,
        entry_points=[],
        matched_markers=["dep:langchain"],
        existing_instrumentation=[],
        project_files=[],
    )
    merged = _merge_detection(
        heuristic,
        {"framework": "openai", "language": "python", "confidence": 0.5},
    )
    assert merged.framework == "langchain"


def test_merge_accepts_agent_for_custom_heuristic():
    heuristic = FrameworkDetection(
        framework="custom",
        language="python",
        confidence=0.0,
        entry_points=[],
        matched_markers=[],
        existing_instrumentation=[],
        project_files=[],
    )
    merged = _merge_detection(
        heuristic,
        {
            "framework": "crewai",
            "language": "python",
            "confidence": 0.75,
            "entry_points": ["main.py"],
            "rationale": "crewai imports in main.py",
        },
    )
    assert merged.framework == "crewai"
    assert merged.confidence >= 0.75
    assert merged.entry_points == ["main.py"]


@pytest.mark.asyncio
async def test_refine_skips_llm_for_high_confidence(monkeypatch):
    monkeypatch.delenv("EDEN_ONBOARDING_SKIP_LLM", raising=False)

    async def _boom(*_a, **_k):
        raise AssertionError("LLM should not be called")

    monkeypatch.setattr(
        "eden.llm.client.OpenRouterClient",
        _boom,
    )

    heuristic = FrameworkDetection(
        framework="openai",
        language="python",
        confidence=0.95,
        entry_points=[],
        matched_markers=["dep:openai"],
        existing_instrumentation=[],
        project_files=[],
    )
    detection, notes = await refine_framework_detection({}, heuristic)
    assert detection.framework == "openai"
    assert notes == []


@pytest.mark.asyncio
async def test_refine_uses_agent_when_ambiguous(monkeypatch):
    monkeypatch.setenv("EDEN_ONBOARDING_SKIP_LLM", "0")

    class _FakeLLM:
        async def acall(self, **_kwargs):
            from eden.llm.client import LLMResponse, UsageStats

            return LLMResponse(
                content=json.dumps(
                    {
                        "framework": "langchain",
                        "language": "python",
                        "confidence": 0.82,
                        "entry_points": ["app/agent.py"],
                        "integration_notes": ["Import bootstrap from app entry."],
                        "rationale": "langchain imports detected",
                    }
                ),
                model="x-ai/grok-4.5",
                usage=UsageStats(
                    prompt_tokens=1,
                    completion_tokens=1,
                    total_tokens=2,
                    cost=0.0,
                ),
                finish_reason="stop",
            )

    monkeypatch.setattr(
        "eden.llm.client.OpenRouterClient",
        _FakeLLM,
    )

    heuristic = FrameworkDetection(
        framework="custom",
        language="python",
        confidence=0.0,
        entry_points=[],
        matched_markers=[],
        existing_instrumentation=[],
        project_files=["requirements.txt"],
    )
    files = {
        "requirements.txt": "langchain>=0.2\n",
        "app/agent.py": "from langchain.agents import AgentExecutor\n",
    }
    detection, notes = await refine_framework_detection(files, heuristic)
    assert detection.framework == "langchain"
    assert "app/agent.py" in detection.entry_points
    assert notes
