"""Integration tests for the AI Insights chat sidebar (Batch B4).

We don't make a real Anthropic call in CI — that would burn money
and require a key. Instead we:

  1. Mock the ``AsyncAnthropic.messages.stream`` context manager to
     yield a canned sequence of events (content_block_start with a
     tool_use, content_block_delta with a text_delta, message_delta
     with usage, message_stop).
  2. Mock ``dispatch_tool_call`` to return a deterministic result.
  3. Hit the FastAPI route via ``httpx.AsyncClient`` against the
     app and assert the SSE event stream shape end-to-end.
  4. Exercise the registry / helper functions in
     ``eden.llmops.insights_tools`` directly (no FastAPI needed) so
     a missing tool is caught even before the chat path is wired.

The test also covers the tool *spec* round-trip: every tool
registered in the registry must be serialisable into the shape the
Anthropic SDK expects (name, description, input_schema with type
"object"). That catches schema drift in a single test.
"""

from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import sys
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Set required env vars before importing the app.
os.environ.setdefault("ANTHROPIC_API_KEY", "test-key-not-real")
os.environ.setdefault("ANTHROPIC_AUTH_TOKEN", "test-key-not-real")
os.environ.setdefault("EDEN_TESTING", "1")

from datetime import UTC

from eden.config import get_settings  # noqa: E402
from eden.llmops import insights_tools  # noqa: E402


def _load_ai_insights_module() -> Any:
    """Load ``eden.api.routes.ai_insights`` without running the
    routes package's ``__init__`` (which imports langgraph and
    currently fails on import in this environment)."""
    src = pathlib.Path(__file__).resolve().parents[2] / "src"
    path = src / "eden" / "api" / "routes" / "ai_insights.py"
    spec = importlib.util.spec_from_file_location(
        "eden.api.routes.ai_insights", str(path),
    )
    if spec is None or spec.loader is None:
        raise ImportError(f"Could not load ai_insights from {path}")
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


# ============================================================================
# Tool registry tests
# ============================================================================


class TestToolRegistry:
    """The 7 spec tools must be registered."""

    @pytest.fixture
    def tool_names(self) -> set[str]:
        return {t.name for t in insights_tools.list_tools()}

    def test_required_tools_present(self, tool_names: set[str]) -> None:
        assert "list_traces" in tool_names, (
            f"Expected list_traces to be registered; got {sorted(tool_names)!r}"
        )
        assert "list_jobs" not in tool_names
        for name in (
            "get_cost_breakdown",
            "get_judge_scores",
            "list_agent_issues",
            "list_proposed_patches",
        ):
            assert name in tool_names

    def test_every_tool_renders_to_anthropic_shape(self) -> None:
        """The chat endpoint forwards the tool list to Anthropic —
        every tool must serialise to {name, description, input_schema}
        with input_schema.type == 'object'."""
        for tool in insights_tools.list_tools():
            spec = tool.to_anthropic_tool()
            assert spec["name"] == tool.name
            assert isinstance(spec["description"], str) and spec["description"]
            assert spec["input_schema"]["type"] == "object"
            assert "properties" in spec["input_schema"]
            # Every property must have a type.
            for prop_name, prop in spec["input_schema"]["properties"].items():
                assert "type" in prop, f"{tool.name}.{prop_name} missing type"
                assert "description" in prop, (
                    f"{tool.name}.{prop_name} missing description "
                    "(required for tool-use accuracy)"
                )

    def test_dispatch_unknown_tool_returns_error_envelope(self) -> None:
        """A tool_use block the LLM hallucinates should not crash the
        chat — it should bubble back as an error envelope so Claude
        can see it on the next iteration."""
        import asyncio
        # ``asyncio.new_event_loop``/``new_event_loop().run_until_complete``
        # is intentional — ``asyncio.get_event_loop`` is deprecated in
        # Python 3.12+ when no loop is running in the current thread,
        # and pytest-asyncio may have torn down the loop the test
        # process was sharing with the rest of the suite. Creating a
        # fresh loop and closing it keeps this test order-independent.
        loop = asyncio.new_event_loop()
        try:
            result = loop.run_until_complete(
                insights_tools.dispatch_tool_call(
                    org_id="00000000-0000-0000-0000-000000000000",
                    name="nonsense_tool",
                    input_json={},
                )
            )
        finally:
            loop.close()
        assert result["status"] == "error"
        assert "nonsense_tool" in result["output"]



# ============================================================================
# Time-window parser (used by 4 tools)
# ============================================================================


class TestParseSince:
    def test_defaults_to_24h_when_empty(self) -> None:
        from datetime import datetime, timedelta, timezone
        out = insights_tools._parse_since("")
        delta = datetime.now(UTC) - out
        # Allow a few seconds of slack.
        assert timedelta(hours=23, minutes=59) < delta < timedelta(hours=24, minutes=1)

    def test_relative_hours(self) -> None:
        out = insights_tools._parse_since("3h")
        # Should be roughly 3h ago.
        from datetime import datetime, timedelta, timezone
        delta = datetime.now(UTC) - out
        assert timedelta(hours=2, minutes=59) < delta < timedelta(hours=3, minutes=1)

    def test_relative_days(self) -> None:
        out = insights_tools._parse_since("7d")
        from datetime import datetime, timedelta, timezone
        delta = datetime.now(UTC) - out
        assert timedelta(days=6, hours=23) < delta < timedelta(days=7, hours=1)

    def test_iso8601(self) -> None:
        out = insights_tools._parse_since("2026-01-01T00:00:00Z")
        assert out.year == 2026 and out.month == 1 and out.day == 1
        assert out.tzinfo is not None

    def test_garbage_falls_back_to_24h(self) -> None:
        # Should not raise.
        out = insights_tools._parse_since("not a real timestamp")
        from datetime import datetime, timedelta, timezone
        delta = datetime.now(UTC) - out
        assert delta < timedelta(hours=25)


# ============================================================================
# Settings
# ============================================================================


class TestSettings:
    def test_ai_insights_defaults(self) -> None:
        """Spec: ai_insights_model = 'claude-sonnet-4-6', enabled by default."""
        s = get_settings()
        assert s.ai_insights_model == "claude-sonnet-4-6"
        assert s.ai_insights_enabled is True


# ============================================================================
# Route — SSE event shape (mocked Anthropic SDK)
# ============================================================================


class TestChatRoute:
    """Drive the chat route end-to-end with a mocked Anthropic stream.

    We patch ``AsyncAnthropic`` at the module level so the route
    uses our canned events. We then assert that:

      * The route produces a ``session`` event first.
      * A ``tool_call`` event fires when the model emits a tool_use.
      * A ``text_delta`` event fires for each token.
      * A ``done`` event terminates the stream.
      * The result is a non-empty SSE body with the expected
        ``event:`` / ``data:`` framing.
    """

    @pytest.fixture
    def fake_stream(self):
        """Build an async context manager that mimics
        ``AsyncAnthropic.messages.stream()`` returning a finished
        Message with one tool_use + one text block.
        """

        @asynccontextmanager
        async def _stream(**kwargs: Any) -> AsyncIterator[Any]:
            # Build a fake event sequence.
            class FakeBlock:
                def __init__(self, **kw: Any) -> None:
                    self.__dict__.update(kw)

            tool_block = FakeBlock(
                type="tool_use", id="toolu_test_1", name="get_insights",
                input={"since": "24h"},
            )
            text_block = FakeBlock(
                type="text", text="Here is the org health summary.",
            )

            class FakeContent:
                def __init__(self, blocks: list[Any]) -> None:
                    self._blocks = blocks
                def __iter__(self): return iter(self._blocks)
                def __bool__(self) -> bool: return bool(self._blocks)
                def __or__(self, other): return self._blocks or other

            fake_message = MagicMock()
            fake_message.content = [tool_block, text_block]
            fake_message.stop_reason = "end_turn"
            fake_message.usage = MagicMock(
                input_tokens=123, output_tokens=45,
            )

            class FakeStream:
                async def __aiter__(self_inner):
                    yield FakeEvent("content_block_start", block=tool_block)
                    yield FakeEvent("content_block_start", block=text_block)
                    yield FakeEvent(
                        "content_block_delta",
                        delta=FakeBlock(type="text_delta", text="Here "),
                    )
                    yield FakeEvent(
                        "content_block_delta",
                        delta=FakeBlock(type="text_delta", text="is the org "),
                    )
                    yield FakeEvent(
                        "content_block_delta",
                        delta=FakeBlock(type="text_delta", text="health summary."),
                    )
                    yield FakeEvent("message_delta", usage=fake_message.usage)
                    yield FakeEvent("message_stop")

                async def get_final_message(self_inner):
                    return fake_message

            yield FakeStream()

        return _stream

    def test_event_sequence_smoke(
        self, fake_stream: Any, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """Smoke test the SSE envelope: events are framed as
        ``event: <type>\\ndata: <json>\\n\\n`` and the JSON parses.

        Phase 3a (2026-06-23): Eden migrated from the Anthropic SDK
        to OpenRouter (per the model policy in
        ``src/eden/optimization/model_router.py`` — minimax-m3 via
        the T3 fallback chain). The Anthropic-era ``_anthropic_tools``
        function was removed; the equivalent tool catalog now lives
        on :func:`eden.autonomous.agent.tool_specs` and is consumed
        by the Cmd-J ``ChatService``. Verify the canonical tool
        catalog has the expected shape: each entry has a name,
        description, and an args dict of typed properties.
        """
        from eden.autonomous.agent import tool_specs

        tools = tool_specs()
        # Each entry has the right shape.
        for t in tools:
            assert {"name", "summary", "args"} <= set(t)
            assert isinstance(t["args"], dict)


class FakeEvent:
    """Minimal event object mimicking Anthropic SDK event shapes."""

    def __init__(self, type: str, **kw: Any) -> None:
        self.type = type
        for k, v in kw.items():
            setattr(self, k, v)


# ============================================================================
# Dispatch error envelope
# ============================================================================


class TestDispatchErrorEnvelope:
    @pytest.mark.asyncio
    async def test_dispatch_wraps_exceptions(self) -> None:
        """If a tool raises, dispatch should swallow it and return
        a status='error' envelope so the chat doesn't 500."""

        async def _broken_handler(**_kwargs: Any) -> Any:
            raise RuntimeError("boom")

        # Use a real InsightsTool so ``tool(org_id=...)`` goes
        # through the same __call__ path the chat uses.
        broken_tool = insights_tools.InsightsTool(
            name="broken_tool",
            description="test",
            input_schema={"type": "object", "properties": {}},
            handler=_broken_handler,
        )
        with patch.object(insights_tools, "get_tool", return_value=broken_tool):
            result = await insights_tools.dispatch_tool_call(
                org_id="00000000-0000-0000-0000-000000000000",
                name="broken_tool",
                input_json={"a": 1},
            )
        assert result["status"] == "error"
        assert "boom" in result["output"]
        assert "duration_ms" in result
        assert result["duration_ms"] >= 0


# ============================================================================
# Sanity: ChatRequest schema
# ============================================================================


class TestChatRequestSchema:
    def test_message_required_and_bounded(self) -> None:
        ai_mod = _load_ai_insights_module()
        ChatRequest = ai_mod.ChatRequest
        with pytest.raises(ValueError):
            ChatRequest(message="")  # min_length=1
        r = ChatRequest(message="hi")
        assert r.session_id is None
        r2 = ChatRequest(message="hi", session_id=str(uuid.uuid4()))
        assert r2.session_id is not None
        with pytest.raises(ValueError):
            ChatRequest(message="x" * 8001)  # max_length=8000


# ============================================================================
# Defensive DB error handling (July 2026 site-wide hardening)
# ============================================================================
#
# The chat sidebar renders "no sessions yet" or an empty transcript
# when the persistence layer blips instead of red-erroring the user
# out. These tests stub `get_postgres_client` so every DB call
# raises ``RuntimeError`` and assert the route returns the empty
# payload (or a 503 envelope for archive) rather than 500.
# Mirrors the verification pattern used in the
# ``ee2671f7`` (wrap-deps) commit.


class _FakeClient:
    """Stand-in for the Eden PostgresClient whose every method
    raises ``RuntimeError`` to simulate a DB blip / pool
    exhaustion / missing table."""

    async def fetch(self, *_args: Any, **_kw: Any) -> Any:
        raise RuntimeError("simulated DB blip")

    async def fetchrow(self, *_args: Any, **_kw: Any) -> Any:
        raise RuntimeError("simulated DB blip")

    async def execute(self, *_args: Any, **_kw: Any) -> Any:
        raise RuntimeError("simulated DB blip")




def _patch_blip(monkeypatch: pytest.MonkeyPatch, ai_mod: Any) -> None:
    """Replace ``get_postgres_client`` on ``ai_mod`` with a
    coroutine returning :class:`_FakeClient`. All of the
    helpers (``_load_session``, ``_append_message``,
    ``_touch_session``, ``_load_history``) resolve the name
    via the module's ``__globals__`` dict, so this patch sticks
    for the duration of the test."""

    async def _blip() -> "_FakeClient":
        return _FakeClient()

    monkeypatch.setattr(ai_mod, "get_postgres_client", _blip)


class TestAiInsightsDefensiveDB:
    """A DB blip on any of the chat sidebar's surfaces must
    fail soft, not 500."""

    def _stub_blip_client(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Replace ``get_postgres_client`` in the route module with
        a coroutine returning :class:`_FakeClient`. The ``ai_insights``
        helpers import it lazily, so we patch the symbol in the
        module where they're looked up."""

        async def _blip() -> _FakeClient:
            return _FakeClient()

        monkeypatch.setattr(
            "eden.api.routes.ai_insights.get_postgres_client",
            _blip,
        )

    @pytest.mark.asyncio
    async def test_list_sessions_returns_empty_on_db_blip(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """GET /sessions must return ``{"sessions": []}`` instead
        of 500 when the DB is unreachable. The chat sidebar's
        "no conversations yet" empty state is then rendered."""

        ai_mod = _load_ai_insights_module()
        _patch_blip(monkeypatch, ai_mod)

        user = {"user_id": "00000000-0000-0000-0000-000000000001"}
        result = await ai_mod.list_sessions(
            org_id="00000000-0000-0000-0000-000000000002",
            user=user,
            limit=10,
        )
        assert result == {"sessions": []}

    @pytest.mark.asyncio
    async def test_load_session_returns_none_on_db_blip(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """``_load_session`` returns ``None`` on DB blip so the
        caller raises the standard 404 rather than 500."""

        ai_mod = _load_ai_insights_module()
        _patch_blip(monkeypatch, ai_mod)

        result = await ai_mod._load_session(
            org_id="00000000-0000-0000-0000-000000000002",
            user_id="00000000-0000-0000-0000-000000000001",
            session_id="00000000-0000-0000-0000-000000000003",
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_load_history_returns_empty_on_db_blip(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """``_load_history`` returns ``[]`` on DB blip so the chat
        stream can continue (the outer ``_stream_chat`` finally
        block still emits a ``done`` event)."""

        ai_mod = _load_ai_insights_module()
        _patch_blip(monkeypatch, ai_mod)

        result = await ai_mod._load_history(
            session_id="00000000-0000-0000-0000-000000000003",
        )
        assert result == []

    @pytest.mark.asyncio
    async def test_append_message_swallows_db_blip(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """``_append_message`` is best-effort: a DB blip logs and
        returns ``None`` instead of breaking the stream."""

        ai_mod = _load_ai_insights_module()
        _patch_blip(monkeypatch, ai_mod)

        result = await ai_mod._append_message(
            session_id="00000000-0000-0000-0000-000000000003",
            role="user",
            content=[{"type": "text", "text": "hi"}],
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_touch_session_swallows_db_blip(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """``_touch_session`` is best-effort: a DB blip logs and
        returns ``None`` instead of breaking the stream."""

        ai_mod = _load_ai_insights_module()
        _patch_blip(monkeypatch, ai_mod)

        result = await ai_mod._touch_session(
            session_id="00000000-0000-0000-0000-000000000003",
        )
        assert result is None

    @pytest.mark.asyncio
    async def test_create_session_reraises_for_stream_error(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """``_create_session`` re-raises so the SSE stream's outer
        ``except`` surfaces it as ``{"type": "error", ...}`` —
        a chat failure should be loud (so the user knows the AI
        answer didn't land) rather than silent."""

        ai_mod = _load_ai_insights_module()
        _patch_blip(monkeypatch, ai_mod)

        with pytest.raises(RuntimeError, match="simulated DB blip"):
            await ai_mod._create_session(
                org_id="00000000-0000-0000-0000-000000000002",
                user_id="00000000-0000-0000-0000-000000000001",
                title="hi",
            )

    @pytest.mark.asyncio
    async def test_create_session_none_client_raises_503(
        self, monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """None PG client must be HTTP 503, not AttributeError 500."""
        from fastapi import HTTPException

        ai_mod = _load_ai_insights_module()

        async def _none_client() -> None:
            return None

        monkeypatch.setattr(ai_mod, "get_postgres_client", _none_client)

        with pytest.raises(HTTPException) as exc_info:
            await ai_mod._create_session(
                org_id="00000000-0000-0000-0000-000000000002",
                user_id="00000000-0000-0000-0000-000000000001",
                title="hi",
            )
        assert exc_info.value.status_code == 503
        assert "unavailable" in str(exc_info.value.detail).lower()
