"""FEAT-162 shared HumanLabel helpers."""

from __future__ import annotations

from eden.evaluation.human_labels import (
    TOOL_CALL_ITEM_KIND,
    bridge_enabled,
    tool_call_thumbs_to_human_label,
)


def test_tool_call_kind_constant() -> None:
    assert TOOL_CALL_ITEM_KIND == "tool_call"


def test_thumbs_to_human_label_shape() -> None:
    ev = tool_call_thumbs_to_human_label(
        org_id="o1",
        span_id="s1",
        trace_id="t1",
        tool_name="search",
        label="good",
        labeled_by="user-1",
        agent_id="a1",
        reason="looks right",
    )
    assert ev["kind"] == "tool_call"
    assert ev["source"] == "tool_call_labels"
    assert ev["label"] == "good"
    assert ev["span_id"] == "s1"
    assert ev["annotator_id"] == "user-1"


def test_bridge_enabled_env(monkeypatch) -> None:
    monkeypatch.delenv("EDEN_TOOL_CALL_LABEL_BRIDGE", raising=False)
    assert bridge_enabled() is True
    monkeypatch.setenv("EDEN_TOOL_CALL_LABEL_BRIDGE", "0")
    assert bridge_enabled() is False
    monkeypatch.setenv("EDEN_TOOL_CALL_LABEL_BRIDGE", "true")
    assert bridge_enabled() is True
