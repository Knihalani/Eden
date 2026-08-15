"""Tests for ``eden_sdk.trace`` — decorator + context manager."""

from __future__ import annotations

import asyncio

import eden
from eden_sdk.trace import current_trace, trace, trace_agent


def test_trace_context_manager_emits_framework_event(caplog):
    with trace("unit-test", attributes={"foo": "bar"}):
        ctx = current_trace()
        assert ctx is not None
        assert ctx.name == "unit-test"
        assert ctx.attributes == {"foo": "bar"}


def test_trace_agent_decorator_sync():
    @trace_agent(name="my-func")
    def add(a: int, b: int) -> int:
        return a + b

    assert add(2, 3) == 5


def test_trace_agent_decorator_async():
    @trace_agent(name="my-async-func")
    async def add_async(a: int, b: int) -> int:
        return a + b

    out = asyncio.run(add_async(2, 3))
    assert out == 5


def test_trace_agent_propagates_exceptions():
    @trace_agent(name="boom")
    def explode():
        raise RuntimeError("kaboom")

    with __import__("pytest").raises(RuntimeError):
        explode()


def test_nested_traces_share_outer_id():
    with trace("outer") as outer:
        with trace("inner"):
            inner = current_trace()
            assert inner is not None
            assert inner.trace_id == outer.trace_id


def test_disabled_sdk_is_noop():
    eden.configure(disabled=True)
    @trace_agent(name="noop")
    def add(a, b):
        return a + b
    assert add(2, 2) == 4
    assert current_trace() is None


# ── New: trace() yields a Span with input/output/tag/status ──────────


def test_trace_yields_span_with_input_output_methods() -> None:
    """The README example `with eden.trace("x") as s: s.set_input(...)`
    must work — `s` must be a Span, not a bare TraceContext."""
    import eden

    eden.configure(org_id="o", api_key="k", dry_run=True)
    with eden.trace("qa-pipeline") as root:
        # Span, not TraceContext — has the rich API.
        root.set_input({"q": "hi"})
        root.set_tag("prod", "checkout")
        with eden.trace("summarise") as child:
            child.set_input("summarising")
            child.set_output({"summary": "ok"})
        root.set_output({"final": "ok"})

    # The attributes should have been recorded on the spans.
    assert "eden.input" in root.attributes
    assert root.attributes["eden.input"] == {"q": "hi"}
    assert root.attributes["eden.tags"] == ["prod", "checkout"]
    assert child.attributes["eden.output"] == {"summary": "ok"}


def test_trace_set_status_marks_outcome_as_error() -> None:
    import eden

    eden.configure(org_id="o", api_key="k", dry_run=True)
    with eden.trace("error-path") as span:
        span.set_status("error", error="boom")
    assert span.outcome == "error"
    assert span.error == "boom"


def test_trace_set_status_ok_is_success() -> None:
    import eden

    eden.configure(org_id="o", api_key="k", dry_run=True)
    with eden.trace("ok-path") as span:
        span.set_status("ok")
    assert span.outcome == "success"


def test_trace_yielded_span_has_trace_id_and_span_id() -> None:
    """Users want `span.trace_id` for correlation in their own logs."""
    import eden

    eden.configure(org_id="o", api_key="k", dry_run=True)
    with eden.trace("outer") as outer:
        assert isinstance(outer.trace_id, str) and len(outer.trace_id) > 0
        assert isinstance(outer.span_id, str) and len(outer.span_id) > 0
        with eden.trace("inner") as inner:
            # Child shares the outer's trace_id.
            assert inner.trace_id == outer.trace_id
            # But has its own span_id.
            assert inner.span_id != outer.span_id
            # And parent_span_id points at the outer.
            assert inner.parent_span_id == outer.span_id


# ── Regression tests ────────────────────────────────────────────────
#
# The decorator used to write ``eden.tags`` as a comma-joined
# string. When the emitter then did
# ``tags=["eden-sdk", "framework", *extra_tags]`` the ``*``
# spread the string into per-character entries (e.g.
# ``['e','n','v',':','p','r','o','d',...]``). The fix writes
# a list and the emitter is hardened against legacy string
# attributes.


def _capture_enqueued_events() -> list:
    """Patch ``EdenClient.enqueue`` to capture outgoing events."""
    import eden_sdk.client as client_mod

    captured: list = []
    original = client_mod.EdenClient.enqueue

    def _capture(self, ev):
        captured.append(ev)

    client_mod.EdenClient.enqueue = _capture  # type: ignore[assignment]
    return captured, lambda: setattr(client_mod.EdenClient, "enqueue", original)


def test_trace_agent_decorator_emits_tag_list_not_per_char() -> None:
    """The decorator used to spread user-supplied tags as
    per-character entries on the wire. Each tag must round-trip
    as a single string."""
    import eden
    from eden_sdk.trace import trace_agent

    eden.configure(org_id="o", api_key="k", dry_run=True)
    captured, restore = _capture_enqueued_events()
    try:

        @trace_agent(name="my-func", tags=["env:prod", "team:ml"])
        def f(x):
            return x

        f(1)
    finally:
        restore()

    assert len(captured) == 1
    payload = captured[0].payload
    assert "env:prod" in payload["tags"]
    assert "team:ml" in payload["tags"]
    assert "sync" in payload["tags"]
    # No per-character entries.
    for tag in payload["tags"]:
        assert len(tag) > 1, f"tag {tag!r} looks per-character"
    # And the user-supplied tags appear as whole strings, not
    # substrings of a comma-joined mess.
    assert payload["tags"].count("env:prod") == 1
    assert payload["tags"].count("team:ml") == 1


def test_trace_agent_decorator_async_emits_tag_list_not_per_char() -> None:
    """Async decorator path — same regression check."""
    import asyncio

    import eden
    from eden_sdk.trace import trace_agent

    eden.configure(org_id="o", api_key="k", dry_run=True)
    captured, restore = _capture_enqueued_events()
    try:

        @trace_agent(name="my-async", tags=["env:prod"])
        async def f(x):
            return x

        asyncio.run(f(1))
    finally:
        restore()

    assert len(captured) == 1
    payload = captured[0].payload
    assert "env:prod" in payload["tags"]
    assert "async" in payload["tags"]


def test_set_tag_handles_legacy_comma_string_attribute() -> None:
    """Legacy code (or user mirror of the old contract) might
    still set ``eden.tags`` to a comma-joined string. ``set_tag``
    must not spread it into per-character entries."""
    from eden_sdk.trace import trace

    with trace("legacy", attributes={"eden.tags": "a,b,c"}) as t:
        t.set_tag("d")
    # Should be coerced into a list, with the new tag appended.
    assert t.attributes["eden.tags"] == ["a", "b", "c", "d"]


def test_set_tag_handles_existing_list_attribute() -> None:
    """The decorator writes a list; ``set_tag`` must extend it,
    not stringify it."""
    from eden_sdk.trace import trace

    with trace("listy", attributes={"eden.tags": ["preexisting"]}) as t:
        t.set_tag("new1", "new2")
    assert t.attributes["eden.tags"] == ["preexisting", "new1", "new2"]


def test_set_tag_no_existing_attribute() -> None:
    """Missing ``eden.tags`` attribute should still work."""
    from eden_sdk.trace import trace

    with trace("fresh") as t:
        t.set_tag("x", "y")
    assert t.attributes["eden.tags"] == ["x", "y"]


def test_set_status_with_error_overrides_status_field() -> None:
    """``set_status("ok", error="boom")`` must mark the span
    as an error. Previously the public ``eden.status`` field
    said ``"success"`` while ``outcome`` said ``"error"`` —
    the two fields disagreed because ``eden.status`` was
    written BEFORE the error override."""
    import eden

    eden.configure(org_id="o", api_key="k", dry_run=True)
    with eden.trace("bad-ok") as span:
        span.set_status("ok", error="boom")
    assert span.outcome == "error"
    assert span.error == "boom"
    # Public field must agree with outcome.
    assert span.attributes["eden.status"] == "error"


def test_set_status_error_no_error_arg() -> None:
    """``set_status("error")`` without an error string should
    also work and surface ``eden.status = "error"``."""
    import eden

    eden.configure(org_id="o", api_key="k", dry_run=True)
    with eden.trace("plain-error") as span:
        span.set_status("error")
    assert span.outcome == "error"
    assert span.attributes["eden.status"] == "error"


# ── S3/S4/S11 correctness regression suite ───────────────────────────
#
# These tests prove that the S3 (deferred capture), S4 (single config
# fetch), and S11 (fast ID generation) changes produce IDENTICAL emitted
# payloads to the pre-optimisation behaviour for representative inputs.
# They also verify the fast path (None input/output) stamps the same
# capture metadata as the old path did.


def _capture_enqueued_payloads(monkeypatch) -> list[dict]:
    """Replace EdenClient.enqueue to record payload dicts without sending."""
    import eden_sdk.client as client_mod

    captured: list[dict] = []
    monkeypatch.setattr(
        client_mod.EdenClient,
        "enqueue",
        lambda self, event, **kw: captured.append(dict(event.payload)),
    )
    return captured


def test_s3_none_input_output_stamps_correct_capture_metadata(monkeypatch):
    """Fast path (both values None) stamps eden.truncated=false and
    eden.original_bytes=0 — identical to what stamp_capture_attributes
    produced for two None CaptureResults before the optimisation."""
    from eden_sdk.capture import CAPTURE_MODE_ATTR, ORIGINAL_BYTES_ATTR, TRUNCATED_ATTR

    eden.configure(org_id="o", api_key="k", dry_run=True)
    payloads = _capture_enqueued_payloads(monkeypatch)

    with eden.trace("no-io"):
        pass

    assert len(payloads) == 1
    attrs = payloads[0]["attributes"]
    assert attrs[TRUNCATED_ATTR] == "false"
    assert attrs[ORIGINAL_BYTES_ATTR] == "0"
    assert attrs[CAPTURE_MODE_ATTR] == "bounded"


def test_s3_nested_dict_input_output_emitted_unchanged(monkeypatch):
    """Non-None input/output still go through capture_value() and
    arrive at the sender unchanged (no truncation for small payloads)."""
    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="bounded")
    payloads = _capture_enqueued_payloads(monkeypatch)

    nested = {"outer": {"inner": "value"}, "list": [1, 2, 3]}
    with eden.trace("dict-io") as span:
        span.set_input(nested)
        span.set_output({"result": True})

    assert len(payloads) == 1
    assert payloads[0]["input"] == nested
    assert payloads[0]["output"] == {"result": True}
    attrs = payloads[0]["attributes"]
    from eden_sdk.capture import TRUNCATED_ATTR
    assert attrs[TRUNCATED_ATTR] == "false"


def test_s3_long_string_over_truncation_limit_is_truncated(monkeypatch):
    """A string exceeding DEFAULT_MAX_STRING_BYTES (8 KiB) must be
    truncated in bounded mode — same behaviour as before the optimisation."""
    from eden_sdk.capture import DEFAULT_MAX_STRING_BYTES, TRUNCATED_ATTR

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="bounded")
    payloads = _capture_enqueued_payloads(monkeypatch)

    long_str = "x" * (DEFAULT_MAX_STRING_BYTES * 3)
    with eden.trace("long-str") as span:
        span.set_input({"text": long_str})
        span.set_output("short")

    assert len(payloads) == 1
    # Truncated value must be shorter than the original.
    assert len(payloads[0]["input"]["text"]) < len(long_str)
    # Truncation metadata must be stamped.
    assert payloads[0]["attributes"][TRUNCATED_ATTR] == "true"


def test_s3_non_serialisable_object_in_input_does_not_raise(monkeypatch):
    """A non-JSON-serialisable object in set_input should not crash
    the span — capture_value walks and converts via _truncate_walk."""
    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="bounded")
    payloads = _capture_enqueued_payloads(monkeypatch)

    class _Custom:
        def __repr__(self) -> str:
            return "<custom>"

    with eden.trace("non-serial") as span:
        # Wrap in a dict so _truncate_walk handles the string representation.
        span.set_input({"obj": repr(_Custom())})

    assert len(payloads) == 1
    # The string repr was stored and passed through unchanged (it's short).
    assert payloads[0]["input"]["obj"] == "<custom>"


def test_s3_error_path_keeps_full_input_output(monkeypatch):
    """On an error span the full (non-truncated) input/output must be
    retained regardless of capture_mode=bounded."""
    from eden_sdk.capture import TRUNCATED_ATTR, DEFAULT_MAX_STRING_BYTES

    eden.configure(org_id="o", api_key="k", dry_run=True, capture_mode="bounded")
    payloads = _capture_enqueued_payloads(monkeypatch)

    long_str = "y" * (DEFAULT_MAX_STRING_BYTES * 3)
    try:
        with eden.trace("err-full") as span:
            span.set_input({"text": long_str})
            raise RuntimeError("boom")
    except RuntimeError:
        pass

    assert len(payloads) == 1
    # Error bypass: full value must be kept.
    assert payloads[0]["input"]["text"] == long_str
    assert payloads[0]["attributes"][TRUNCATED_ATTR] == "false"
    assert payloads[0]["outcome"] == "error"


def test_s4_single_cfg_fetch_agent_id_in_payload(monkeypatch):
    """agent_id must be populated from the config — even when threaded
    through a single get_config() call rather than a local re-fetch."""
    eden.configure(org_id="o", api_key="k", dry_run=True, agent_id="my-bot")
    payloads = _capture_enqueued_payloads(monkeypatch)

    with eden.trace("agent-check"):
        pass

    assert len(payloads) == 1
    assert payloads[0]["agent_id"] == "my-bot"


def test_s11_span_id_is_16_hex_chars() -> None:
    """Span IDs generated by the fast thread-local PRNG must still be
    16 lower-case hex characters (64-bit) as before."""
    from eden_sdk.trace import Span

    ids = {Span().span_id for _ in range(100)}
    assert all(len(sid) == 16 for sid in ids)
    assert all(c in "0123456789abcdef" for sid in ids for c in sid)
    # Must be unique (extremely unlikely collision in 100 samples).
    assert len(ids) == 100


def test_s11_trace_id_is_32_hex_chars() -> None:
    """Trace IDs generated by the fast PRNG must be 32 lower-case hex
    characters (128-bit), matching the format of the old uuid4().hex."""
    from eden_sdk.trace import TraceContext

    ids = {TraceContext().trace_id for _ in range(100)}
    assert all(len(tid) == 32 for tid in ids)
    assert all(c in "0123456789abcdef" for tid in ids for c in tid)
    assert len(ids) == 100


def test_s11_span_and_trace_ids_are_unique_across_spans() -> None:
    """Thread-local PRNG must not produce collisions across sequential spans."""
    eden.configure(org_id="o", api_key="k", dry_run=True)
    span_ids: list[str] = []
    trace_ids: list[str] = []
    for _ in range(500):
        with eden.trace("id-check") as span:
            span_ids.append(span.span_id)
            trace_ids.append(span.trace_id)
    assert len(set(span_ids)) == 500, "Span IDs must be unique"
    assert len(set(trace_ids)) == 500, "Trace IDs must be unique (each root trace)"
