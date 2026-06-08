"""Unit tests for the LangSmith integration."""
from __future__ import annotations

from eden.integrations import INTEGRATION_API_VERSION
from eden.integrations.langsmith import (
    LangSmithClient,
    eden_env_to_langsmith_dataset,
    trace_to_langsmith_run,
)


def test_eden_env_to_langsmith_dataset_maps_core_fields():
    env = {
        "id": "env_1",
        "description": "Adversarial coding eval",
        "category": "adversarial",
        "tags": ["adversarial", "coding"],
        "spec": {"stages": ["plan", "execute"]},
        "outcome_tier": "medium",
        "quality_score": 0.7,
    }
    item = eden_env_to_langsmith_dataset(env)
    wire = item.to_langsmith()
    assert wire["inputs"]["description"] == "Adversarial coding eval"
    assert wire["inputs"]["category"] == "adversarial"
    assert wire["outputs"]["outcome_tier"] == "medium"
    assert wire["outputs"]["quality_score"] == 0.7
    assert wire["metadata"]["eden_integration_version"] == INTEGRATION_API_VERSION


def test_trace_to_langsmith_run_uses_explicit_name():
    trace = {"name": "agent.run", "input": {"x": 1}, "output": {"y": 2}}
    run = trace_to_langsmith_run(trace)
    assert run.name == "agent.run"
    wire = run.to_langsmith()
    assert wire["name"] == "agent.run"
    assert wire["run_type"] == "llm"
    assert wire["extra"]["eden_integration_version"] == INTEGRATION_API_VERSION


def test_trace_to_langsmith_run_synthesises_name_when_missing():
    trace = {"input": {"x": 1}, "output": {"y": 2}}
    run = trace_to_langsmith_run(trace)
    # The synthetic name is a stable hash of "eden.run".
    assert run.name.startswith("eden.run.")
    assert len(run.name.split(".")[-1]) == 8


def test_trace_to_langsmith_run_respects_explicit_run_type():
    trace = {"name": "tool.call", "input": {}, "output": {}, "run_type": "tool"}
    run = trace_to_langsmith_run(trace)
    assert run.run_type == "tool"


def test_langsmith_client_export_dataset_returns_summary():
    client = LangSmithClient(enabled=True, api_key="lsv2_test")
    envs = [{"id": "e1", "description": "d"}, {"id": "e2", "description": "d2"}]
    out = client.export_dataset(envs, dataset_name="eden-prod-2026-06")
    assert out["dataset_name"] == "eden-prod-2026-06"
    assert out["count"] == 2
    assert len(out["items"]) == 2
    assert out["items"][0]["metadata"]["eden_integration_version"] == INTEGRATION_API_VERSION
