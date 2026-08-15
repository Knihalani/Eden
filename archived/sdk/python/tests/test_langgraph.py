"""Tests for the LangGraph instrumentation (OOM plan 4.5) and the doctor
sampling nudge (OOM plan 4.6 / S10).

Run subset:
    cd sdk/python && uv run pytest -q -k "langgraph or doctor"
"""

from __future__ import annotations

import sys
import types
from typing import Any, Generator
from unittest.mock import MagicMock

import pytest

import eden
from eden_sdk.client import get_default_client


# ── helpers ────────────────────────────────────────────────────────────────


def _capture_enqueued(client, monkeypatch) -> list[Any]:
    """Patch ``client.enqueue`` to record every TraceEvent passed to it."""
    captured: list[Any] = []
    monkeypatch.setattr(client, "enqueue", lambda event, **kw: captured.append(event))
    return captured


# ── sys.modules stub for langgraph ─────────────────────────────────────────


def _install_fake_langgraph() -> dict[str, Any]:
    """Inject a minimal ``langgraph`` / ``langgraph.pregel`` stub.

    Returns a dict with ``invoke_results``, ``stream_chunks``, and
    ``calls`` so tests can set up return values and assert on calls.
    """
    shared: dict[str, Any] = {
        "invoke_called": 0,
        "stream_called": 0,
        "invoke_input": None,
        "stream_input": None,
        "invoke_return": {"output": "hello", "step": 1},
        "stream_chunks": [
            {"node_a": {"messages": ["hi"], "count": 1}},
            {"node_b": {"result": "done"}},
        ],
    }

    class _FakePregelBase:
        """Minimal Pregel stand-in that the instrumentation can patch."""

        name = "fake-graph"

        def invoke(self, input, **kwargs):
            shared["invoke_called"] += 1
            shared["invoke_input"] = input
            return shared["invoke_return"]

        def stream(self, input, **kwargs) -> Generator:
            shared["stream_called"] += 1
            shared["stream_input"] = input
            yield from shared["stream_chunks"]

    # Build the module tree langgraph → langgraph.pregel
    pkg = types.ModuleType("langgraph")
    pregel_mod = types.ModuleType("langgraph.pregel")
    pregel_mod.Pregel = _FakePregelBase  # type: ignore[attr-defined]
    pkg.pregel = pregel_mod  # type: ignore[attr-defined]

    sys.modules["langgraph"] = pkg
    sys.modules["langgraph.pregel"] = pregel_mod

    shared["PregelClass"] = _FakePregelBase
    return shared


@pytest.fixture
def fake_langgraph(monkeypatch):
    """Install the fake langgraph stub and yield shared state."""
    from eden_sdk.instrumentations import langgraph as lg

    lg.uninstall()
    shared = _install_fake_langgraph()
    yield shared
    lg.uninstall()
    sys.modules.pop("langgraph", None)
    sys.modules.pop("langgraph.pregel", None)


# ── Instrumentation install / uninstall ────────────────────────────────────


def test_langgraph_install_patches_invoke(fake_langgraph):
    """install() monkey-patches Pregel.invoke on the live class."""
    from eden_sdk.instrumentations.langgraph import install, uninstall

    from langgraph.pregel import Pregel

    original_invoke = Pregel.invoke
    install()
    assert Pregel.invoke is not original_invoke, "invoke was not patched"
    uninstall()
    assert Pregel.invoke is original_invoke, "invoke was not restored"


def test_langgraph_absent_instrument_noops():
    """When langgraph is not installed, eden.instrument() must not raise.

    The SDK catches the RuntimeError raised by install() and logs at
    DEBUG level — this is the "no-op when absent" contract.
    """
    # Ensure langgraph is absent from sys.modules.
    sys.modules.pop("langgraph", None)
    sys.modules.pop("langgraph.pregel", None)

    # Should NOT raise even though langgraph is missing.
    eden.instrument("langgraph")


# ── invoke emits graph.node_start + graph.node_end ─────────────────────────


def test_langgraph_invoke_emits_start_and_end_spans(fake_langgraph, monkeypatch):
    """invoke() must emit graph.node_start then graph.node_end."""
    eden.instrument("langgraph")
    client = get_default_client()
    captured = _capture_enqueued(client, monkeypatch)

    from langgraph.pregel import Pregel

    graph = Pregel()
    result = graph.invoke({"question": "what?"})

    assert result == fake_langgraph["invoke_return"]
    assert fake_langgraph["invoke_called"] == 1

    payloads = [e.payload for e in captured]
    event_types = [p["event_type"] for p in payloads]

    assert "graph.node_start" in event_types, f"missing node_start; got {event_types}"
    assert "graph.node_end" in event_types, f"missing node_end; got {event_types}"

    start = next(p for p in payloads if p["event_type"] == "graph.node_start")
    end = next(p for p in payloads if p["event_type"] == "graph.node_end")

    assert start["attributes"]["langgraph.framework"] == "langgraph"
    assert start["attributes"]["langgraph.node"] == "fake-graph"
    assert end["outcome"] == "success"
    assert end["attributes"]["langgraph.state_keys"] == sorted(
        fake_langgraph["invoke_return"].keys()
    )


def test_langgraph_invoke_carries_trace_id(fake_langgraph, monkeypatch):
    """Every emitted event must carry a non-empty trace_id."""
    eden.instrument("langgraph")
    client = get_default_client()
    captured = _capture_enqueued(client, monkeypatch)

    from langgraph.pregel import Pregel

    Pregel().invoke({"x": 1})

    for event in captured:
        tid = event.payload.get("trace_id", "")
        assert tid, f"trace_id missing on event {event.payload['event_type']}"


def test_langgraph_invoke_error_emits_error_end_span(fake_langgraph, monkeypatch):
    """When invoke() raises, the end span must carry outcome=error + error attr."""
    fake_langgraph["invoke_return"]  # not used — we'll override invoke
    from langgraph.pregel import Pregel

    original_invoke = Pregel.invoke.__wrapped__ if hasattr(Pregel.invoke, "__wrapped__") else None

    # Patch the *base* class method to raise before instrumenting.
    def _bad_invoke(self, input, **kwargs):
        raise RuntimeError("graph exploded")

    fake_langgraph["PregelClass"].invoke = _bad_invoke

    eden.instrument("langgraph")
    client = get_default_client()
    captured = _capture_enqueued(client, monkeypatch)

    graph = Pregel()
    with pytest.raises(RuntimeError, match="graph exploded"):
        graph.invoke({"q": "?"})

    payloads = [e.payload for e in captured]
    end_events = [p for p in payloads if p["event_type"] == "graph.node_end"]
    assert end_events, "no node_end event emitted on error"
    assert end_events[0]["outcome"] == "error"
    assert "graph exploded" in end_events[0]["attributes"].get("langgraph.error", "")


# ── stream emits node_start + node_end per node ────────────────────────────


def test_langgraph_stream_emits_per_node_spans(fake_langgraph, monkeypatch):
    """stream() must emit start+end pairs for each node name in each chunk."""
    eden.instrument("langgraph")
    client = get_default_client()
    captured = _capture_enqueued(client, monkeypatch)

    from langgraph.pregel import Pregel

    graph = Pregel()
    chunks = list(graph.stream({"input": "test"}))

    assert fake_langgraph["stream_called"] == 1
    # Chunks must pass through unchanged.
    assert chunks == fake_langgraph["stream_chunks"]

    payloads = [e.payload for e in captured]
    node_names = {p["attributes"]["langgraph.node"] for p in payloads}

    # Expect events for node_a and node_b.
    assert "node_a" in node_names, f"node_a missing; got {node_names}"
    assert "node_b" in node_names, f"node_b missing; got {node_names}"

    # Each node must have exactly one start and one end event.
    for node in ("node_a", "node_b"):
        starts = [p for p in payloads
                  if p["event_type"] == "graph.node_start"
                  and p["attributes"]["langgraph.node"] == node]
        ends = [p for p in payloads
                if p["event_type"] == "graph.node_end"
                and p["attributes"]["langgraph.node"] == node]
        assert len(starts) == 1, f"{node}: expected 1 start, got {len(starts)}"
        assert len(ends) == 1, f"{node}: expected 1 end, got {len(ends)}"


def test_langgraph_stream_state_keys_match_node_state(fake_langgraph, monkeypatch):
    """state_keys on span must match the top-level keys of the node state."""
    eden.instrument("langgraph")
    client = get_default_client()
    captured = _capture_enqueued(client, monkeypatch)

    from langgraph.pregel import Pregel

    list(Pregel().stream({}))

    payloads = {e.payload["attributes"]["langgraph.node"]: e.payload
                for e in captured
                if e.payload["event_type"] == "graph.node_end"}

    assert set(payloads["node_a"]["attributes"]["langgraph.state_keys"]) == {
        "messages", "count"
    }
    assert set(payloads["node_b"]["attributes"]["langgraph.state_keys"]) == {"result"}


# ── Doctor sampling nudge (S10) ─────────────────────────────────────────────


def test_doctor_sampling_nudge_ok_when_sent_low():
    """sampling_nudge is ok when sent_total ≤ 10k regardless of profile."""
    from eden_sdk.doctor import run_doctor

    # dry_run=True → no real HTTP; sent stays at 0.
    report = run_doctor(emit_test_event=False)
    nudge = next((c for c in report.checks if c.name == "sampling_nudge"), None)
    assert nudge is not None, "sampling_nudge check not present in report"
    # sent=0 ≤ 10k → ok regardless of profile.
    assert nudge.ok is True


def test_doctor_sampling_nudge_warns_when_sent_high_and_full_profile(monkeypatch):
    """sampling_nudge fires when sent_total > 10k and profile is 'full'."""
    from eden_sdk.doctor import run_doctor

    client = get_default_client()
    # Simulate high volume by overriding the sent counter.
    monkeypatch.setattr(type(client), "sent", property(lambda self: 20_000))
    # Default sampling_profile is "full" (from conftest eden.configure).

    report = run_doctor(emit_test_event=False)
    nudge = next((c for c in report.checks if c.name == "sampling_nudge"), None)
    assert nudge is not None
    assert nudge.ok is False
    assert "balanced" in nudge.message.lower()
    assert nudge.detail["sent_total"] == 20_000
    assert nudge.detail["sampling_profile"] == "full"


def test_doctor_sampling_nudge_ok_when_profile_not_full(monkeypatch):
    """sampling_nudge does NOT fire when profile is already non-full."""
    from eden_sdk.doctor import run_doctor

    client = get_default_client()
    monkeypatch.setattr(type(client), "sent", property(lambda self: 20_000))

    # Switch to "balanced" via configure.
    eden.configure(
        org_id="test-org",
        api_key="test-key",
        base_url="http://test.invalid",
        sampling_profile="balanced",
    )

    report = run_doctor(emit_test_event=False)
    nudge = next((c for c in report.checks if c.name == "sampling_nudge"), None)
    assert nudge is not None
    assert nudge.ok is True
    assert nudge.detail["sampling_profile"] == "balanced"
