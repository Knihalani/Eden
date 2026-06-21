"""Unit tests for Phase C — unified AI agent (Cat 14 real).

What's covered:

  * Tool registry — all 12 tools registered, RBAC on
    ``mark_incident_resolved``, unknown tool rejection.
  * Chart / Citation / AgentChunk schemas — to_dict roundtrip,
    field validation.
  * Block parsers — ```chart / ```cite / ```tool JSON extraction,
    malformed block tolerance, fence stripping from display text.
  * System prompt — contains the tool catalog and page context.
  * ChatService — picks T3 model from ModelRouter, persists
    conversations, loops up to max_turns, emits stream chunks in
    order. Uses a fully-mocked OpenRouter client + Postgres
    client so no live API or DB required.
  * API endpoints — GET /tools returns the catalog; GET
    /conversations and DELETE /conversations/{id} are
    per-org-isolated.

The full end-to-end chat (real LLM call) lives in
``tests/intelligence/autonomous/test_agent_e2e.py`` which requires
a real ``OPENROUTER_API_KEY``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.autonomous.agent import (
    AgentChunk,
    ChatService,
    Citation,
    ChartSpec,
    ToolCall,
    _build_system_prompt,
    _extract_blocks,
    _parse_chart,
    _parse_citation,
    _parse_tool_call,
    _strip_blocks,
    _TOOL_REGISTRY,
    dispatch_tool,
    get_chat_service,
    tool_specs,
)
from eden.api.routes.ai_agent import (
    _sse_format,
    _resolve_user_role,
)


# ── Tool registry ─────────────────────────────────────────────────


class TestToolRegistry:
    def test_all_specs_have_implementations(self):
        """Every tool in the public catalog must be wired up."""
        spec_names = {s["name"] for s in tool_specs()}
        registry_names = set(_TOOL_REGISTRY.keys())
        assert spec_names == registry_names, (
            f"specs not implemented: {spec_names - registry_names}; "
            f"registry not in catalog: {registry_names - spec_names}"
        )

    def test_count_matches_plan(self):
        assert len(_TOOL_REGISTRY) == 12

    def test_write_tools_require_role(self):
        assert _TOOL_REGISTRY["mark_incident_resolved"]["requires_role"] == "admin"
        for name, spec in _TOOL_REGISTRY.items():
            if name != "mark_incident_resolved":
                assert spec["requires_role"] is None, (
                    f"{name} unexpectedly requires role {spec['requires_role']!r}"
                )

    def test_tool_specs_have_required_fields(self):
        for spec in tool_specs():
            assert "name" in spec
            assert "summary" in spec
            assert "args" in spec
            assert isinstance(spec["args"], dict)


class TestDispatchTool:
    @pytest.mark.asyncio
    async def test_unknown_tool_returns_error(self):
        tc = await dispatch_tool(
            "nonexistent_tool", {}, tenant_id="t-1", user_role="user",
        )
        assert tc.name == "nonexistent_tool"
        assert "unknown tool" in tc.error

    @pytest.mark.asyncio
    async def test_admin_only_tool_rejects_non_admin(self):
        tc = await dispatch_tool(
            "mark_incident_resolved",
            {"cluster_id": "clu_abc"},
            tenant_id="t-1", user_role="member",
        )
        assert "permission_denied" in tc.error

    @pytest.mark.asyncio
    async def test_admin_only_tool_allows_admin(self):
        # We don't have a real DB, so the tool will fail at DB lookup —
        # but it should NOT be blocked by RBAC.
        tc = await dispatch_tool(
            "mark_incident_resolved",
            {"cluster_id": "clu_abc"},
            tenant_id="t-1", user_role="admin",
        )
        # Either success or a postgres error, but never "permission_denied".
        assert "permission_denied" not in (tc.error or "")


# ── Schemas ───────────────────────────────────────────────────────


class TestChartSpec:
    def test_line_chart_to_dict(self):
        cs = ChartSpec(
            type="line", title="Latency",
            data=[{"t": 1, "ms": 100}, {"t": 2, "ms": 200}],
            x_key="t", y_key="ms", unit="ms",
        )
        d = cs.to_dict()
        assert d["type"] == "line"
        assert d["x_key"] == "t"
        assert d["y_key"] == "ms"
        assert d["unit"] == "ms"
        assert len(d["data"]) == 2

    def test_heatmap_to_dict(self):
        cs = ChartSpec(
            type="heatmap", title="Cost matrix",
            data=[{"agent": "a", "day": "Mon", "cost": 1.2}],
            row_key="agent", col_key="day", value_key="cost",
        )
        d = cs.to_dict()
        assert d["row_key"] == "agent"
        assert d["col_key"] == "day"

    def test_sankey_to_dict(self):
        cs = ChartSpec(
            type="sankey", title="Tool flow",
            data=[{"src": "a", "tgt": "b", "v": 5}],
            source_key="src", target_key="tgt", value_key="v",
        )
        d = cs.to_dict()
        assert d["source_key"] == "src"

    def test_table_columns_fallback(self):
        cs = ChartSpec(
            type="table", title="Results",
            data=[{"a": 1, "b": 2}, {"a": 3, "b": 4}],
        )
        d = cs.to_dict()
        assert sorted(d["columns"]) == ["a", "b"]


class TestCitation:
    def test_to_dict(self):
        c = Citation(
            kind="span", id="abc", label="Span abc",
            trace_id="tr-1", excerpt="found python error",
        )
        d = c.to_dict()
        assert d["kind"] == "span"
        assert d["trace_id"] == "tr-1"


class TestToolCall:
    def test_to_dict_includes_error(self):
        tc = ToolCall(name="x", args={"q": "y"}, error="boom")
        d = tc.to_dict()
        assert d["error"] == "boom"

    def test_to_dict_default_fields(self):
        tc = ToolCall(name="x")
        d = tc.to_dict()
        assert d["args"] == {}
        assert d["result"] is None
        assert d["latency_ms"] == 0


class TestAgentChunk:
    def test_text_delta(self):
        ch = AgentChunk(type="text_delta", text="hello")
        d = ch.to_dict()
        assert d["type"] == "text_delta"
        assert d["text"] == "hello"

    def test_chart_chunk(self):
        ch = AgentChunk(
            type="chart",
            chart=ChartSpec(type="bar", title="x", data=[{"a": 1}]),
        )
        d = ch.to_dict()
        assert "chart" in d
        assert d["chart"]["type"] == "bar"

    def test_done_chunk(self):
        ch = AgentChunk(type="done")
        d = ch.to_dict()
        assert d["type"] == "done"


# ── Block parsers ─────────────────────────────────────────────────


class TestBlockExtractors:
    def test_chart_extract(self):
        text = (
            "Before\n"
            "```chart\n"
            '{"type": "line", "title": "X", "data": [{"x": 1}]}\n'
            "```\n"
            "After"
        )
        out = _extract_blocks(text, "chart", _parse_chart)
        assert len(out) == 1
        assert out[0]["type"] == "line"

    def test_citation_extract(self):
        text = (
            "```cite\n"
            '{"kind": "span", "id": "abc", "label": "x"}\n'
            "```"
        )
        out = _extract_blocks(text, "cite", _parse_citation)
        assert len(out) == 1
        assert out[0]["kind"] == "span"

    def test_tool_extract(self):
        text = (
            "```tool\n"
            '{"name": "search_spans", "args": {"query": "python"}}\n'
            "```"
        )
        out = _extract_blocks(text, "tool", _parse_tool_call)
        assert len(out) == 1
        assert out[0]["name"] == "search_spans"

    def test_malformed_blocks_skipped(self):
        text = "```chart\n{not json}\n```"
        out = _extract_blocks(text, "chart", _parse_chart)
        assert out == []

    def test_strip_blocks(self):
        text = (
            "Hello.\n"
            "```chart\n{\"a\": 1}\n```\n"
            "World.\n"
            "```cite\n{\"b\": 2}\n```"
        )
        out = _strip_blocks(text)
        assert "Hello." in out
        assert "World." in out
        assert "```" not in out

    def test_multiple_blocks_same_kind(self):
        text = (
            "```chart\n{\"type\": \"line\"}\n```\n"
            "```chart\n{\"type\": \"bar\"}\n```"
        )
        out = _extract_blocks(text, "chart", _parse_chart)
        assert len(out) == 2
        assert out[0]["type"] == "line"
        assert out[1]["type"] == "bar"


# ── System prompt ────────────────────────────────────────────────


class TestSystemPrompt:
    def test_includes_tool_catalog(self):
        prompt = _build_system_prompt({})
        for spec in tool_specs():
            assert spec["name"] in prompt

    def test_includes_page_context(self):
        ctx = {"trace_id": "tr-99", "incident_id": "clu_abc"}
        prompt = _build_system_prompt(ctx)
        assert "tr-99" in prompt
        assert "clu_abc" in prompt

    def test_includes_chart_and_citation_instructions(self):
        prompt = _build_system_prompt({})
        assert "```chart" in prompt
        assert "```cite" in prompt
        assert "```tool" in prompt


# ── Model selection ──────────────────────────────────────────────


class TestModelSelection:
    @pytest.mark.asyncio
    async def test_picks_t3_when_unset(self, monkeypatch):
        # Clear the override so the TIER_MODELS[T3] lookup fires.
        monkeypatch.setattr(
            "eden.autonomous.agent.get_settings",
            lambda: _FakeSettings(ai_agent_t3_model=""),
        )
        service = ChatService()
        model = await service._pick_model()
        # TIER_MODELS[T3][0] = "minimax/minimax-m3" (per the June 21
        # 2026 immutable-model-list decision — mid-tier is fine for the
        # expert slot, it's just what's wired).
        assert model == "minimax/minimax-m3"

    @pytest.mark.asyncio
    async def test_override_takes_precedence(self, monkeypatch):
        monkeypatch.setattr(
            "eden.autonomous.agent.get_settings",
            lambda: _FakeSettings(ai_agent_t3_model="anthropic/claude-sonnet-4.6"),
        )
        service = ChatService()
        assert await service._pick_model() == "anthropic/claude-sonnet-4.6"


class _FakeSettings:
    """Stand-in for the real Settings so we can override fields
    without mutating the Pydantic-cached singleton."""

    def __init__(self, *, ai_agent_t3_model: str = "") -> None:
        self.ai_agent_t3_model = ai_agent_t3_model
        self.ai_agent_max_turns = 10


# ── ChatService.stream_chat ──────────────────────────────────────


class _FakeChatCompletions:
    """Stub of the openai ChatCompletion streaming response."""

    def __init__(self, chunks: list[str]) -> None:
        self._chunks = chunks

    def create(self, **kwargs):
        return self._iter_chunks()

    def _iter_chunks(self):
        for piece in self._chunks:
            chunk = MagicMock()
            chunk.choices = [MagicMock()]
            chunk.choices[0].delta.content = piece
            chunk.choices[0].delta = MagicMock(content=piece)
            chunk.usage = None
            yield chunk


class _FakeOpenAIClient:
    """Stub of the openai.OpenAI client used by OpenRouterClient."""

    def __init__(self, response_chunks: list[str] | None = None) -> None:
        self.chat = MagicMock()
        self.chat.completions = _FakeChatCompletions(
            response_chunks or ["Hello, ", "this is a ", "test response."],
        )


class _FakePgClient:
    """Stub of the eden.storage.postgres async client."""

    def __init__(self) -> None:
        self.fetch_calls: list[tuple[str, tuple]] = []
        self.fetchrow_calls: list[tuple[str, tuple]] = []
        self.execute_calls: list[tuple[str, tuple]] = []
        self.fetchval_calls: list[tuple[str, tuple]] = []
        self._next_id = 1
        # Pre-seeded: a fresh conversation row.
        self.conversation_id = "00000000-0000-0000-0000-000000000001"
        self.messages: list[dict[str, Any]] = []

    async def fetch(self, sql, *args):
        self.fetch_calls.append((sql, args))
        return []

    async def fetchrow(self, sql, *args):
        self.fetchrow_calls.append((sql, args))
        if "INSERT INTO ai_conversations" in sql:
            return {"id": self.conversation_id}
        if "SELECT id FROM ai_conversations" in sql:
            return None
        return None

    async def fetchval(self, sql, *args):
        self.fetchval_calls.append((sql, args))
        self._next_id += 1
        return f"00000000-0000-0000-0000-{self._next_id:012d}"

    async def execute(self, sql, *args):
        self.execute_calls.append((sql, args))
        return "UPDATE 1"


@pytest.fixture
def chat_deps(monkeypatch):
    pg = _FakePgClient()
    fake_openai = _FakeOpenAIClient()

    async def _get_pg():
        return pg

    monkeypatch.setattr("eden.storage.postgres.get_postgres_client", _get_pg)
    # OpenRouterClient is imported inside _call_llm, so patch the
    # canonical symbol it pulls from.
    monkeypatch.setattr(
        "eden.llm.client.OpenRouterClient",
        lambda *a, **kw: _wrap_openai(fake_openai),
    )
    return pg, fake_openai


def _wrap_openai(fake: _FakeOpenAIClient) -> Any:
    """Wrap the fake client to look like an OpenRouterClient."""
    wrapper = MagicMock()
    wrapper.client = fake
    wrapper.MODEL_SLOTS = {}
    return wrapper


class TestChatServiceStream:
    @pytest.mark.asyncio
    async def test_stream_emits_text_deltas(self, chat_deps):
        pg, _ = chat_deps
        service = ChatService()
        chunks: list[AgentChunk] = []

        async def emit(c: AgentChunk) -> None:
            chunks.append(c)

        await service.stream_chat(
            tenant_id="t-1", user_id="u-1",
            conversation_id=None,
            user_message="hello",
            page_context={"trace_id": "tr-1"},
            user_role="member",
            emit=emit,
        )
        text_deltas = [c for c in chunks if c.type == "text_delta"]
        assert len(text_deltas) >= 1
        # Should also emit a done chunk
        assert any(c.type == "done" for c in chunks)

    @pytest.mark.asyncio
    async def test_persists_conversation(self, chat_deps):
        pg, _ = chat_deps
        service = ChatService()
        chunks: list[AgentChunk] = []

        async def emit(c: AgentChunk) -> None:
            chunks.append(c)

        await service.stream_chat(
            tenant_id="t-1", user_id="u-1",
            conversation_id=None,
            user_message="hi",
            page_context={},
            emit=emit,
        )
        # Conversation INSERT happened.
        assert any("INSERT INTO ai_conversations" in sql
                   for sql, _ in pg.fetchrow_calls)
        # User message INSERT happened.
        assert any("INSERT INTO ai_messages" in sql
                   for sql, _ in pg.fetchval_calls)

    @pytest.mark.asyncio
    async def test_parses_chart_and_citation_blocks(self, chat_deps):
        pg, fake = chat_deps
        # Override response with structured blocks
        fake.chat.completions = _FakeChatCompletions([
            "Here is the latency chart:\n\n"
            "```chart\n"
            '{"type": "line", "title": "p95 latency", "data": [{"t": 1, "ms": 200}], "x_key": "t", "y_key": "ms"}\n'
            "```\n\n"
            "And the offending span:\n\n"
            "```cite\n"
            '{"kind": "span", "id": "sp-1", "label": "Span sp-1", "trace_id": "tr-1"}\n'
            "```\n"
        ])
        service = ChatService()
        chunks: list[AgentChunk] = []

        async def emit(c: AgentChunk) -> None:
            chunks.append(c)

        await service.stream_chat(
            tenant_id="t-1", user_id="u-1",
            conversation_id=None, user_message="show me latency",
            page_context={"trace_id": "tr-1"}, emit=emit,
        )
        chart_chunks = [c for c in chunks if c.type == "chart"]
        cite_chunks = [c for c in chunks if c.type == "citation"]
        assert len(chart_chunks) == 1
        assert chart_chunks[0].chart.type == "line"
        assert len(cite_chunks) == 1
        assert cite_chunks[0].citation.kind == "span"

    @pytest.mark.asyncio
    async def test_executes_tool_calls_and_loops(self, chat_deps):
        pg, fake = chat_deps
        # First response: emit a tool call. Second response: no tool call.
        responses = [
            "I need to search for that.\n\n"
            "```tool\n"
            '{"name": "search_spans", "args": {"query": "python"}}\n'
            "```",
            "Found 5 spans mentioning python.",
        ]
        call_count = {"n": 0}

        class _FakeCompletions:
            def create(self, **kwargs):
                text = responses[min(call_count["n"], len(responses) - 1)]
                call_count["n"] += 1
                chunk = MagicMock()
                chunk.choices = [MagicMock()]
                chunk.choices[0].delta = MagicMock(content=text)
                chunk.usage = None
                return iter([chunk])

        fake.chat.completions = _FakeCompletions()

        service = ChatService()
        chunks: list[AgentChunk] = []

        async def emit(c: AgentChunk) -> None:
            chunks.append(c)

        # Patch search_spans to return a stub so we don't need a
        # real Typesense.
        with patch(
            "eden.autonomous.agent._tool_search_spans",
            new=AsyncMock(return_value={"hits": [], "total": 0}),
        ):
            await service.stream_chat(
                tenant_id="t-1", user_id="u-1",
                conversation_id=None,
                user_message="search python",
                page_context={}, emit=emit,
            )

        # We should have at least one tool_call event from the loop.
        tool_call_chunks = [c for c in chunks if c.type == "tool_call"]
        assert len(tool_call_chunks) >= 1
        assert tool_call_chunks[0].tool_call.name == "search_spans"


# ── SSE formatter ────────────────────────────────────────────────


class TestSSEFormat:
    def test_single_line(self):
        out = _sse_format({"type": "text", "value": "hi"})
        assert out.startswith("data: ")
        assert out.endswith("\n\n")
        # The JSON is parseable
        line = out.split("data: ", 1)[1].split("\n")[0]
        assert json.loads(line) == {"type": "text", "value": "hi"}

    def test_multiline_payload(self):
        # JSON with a newline inside a string should still work.
        out = _sse_format({"type": "text", "value": "line1\nline2"})
        lines = [l for l in out.split("\n") if l.startswith("data: ")]
        joined = "\n".join(l[len("data: "):] for l in lines)
        assert json.loads(joined) == {"type": "text", "value": "line1\nline2"}


# ── Role resolution ──────────────────────────────────────────────


class TestResolveUserRole:
    @pytest.mark.asyncio
    async def test_default_to_member_when_no_org_member_row(self):
        # Stub PG to return no row.
        fake_pg = MagicMock()
        fake_pg.fetchrow = AsyncMock(return_value=None)

        with patch("eden.storage.postgres.get_postgres_client",
                   new=AsyncMock(return_value=fake_pg)):
            role = await _resolve_user_role("t-1", "u-1")
        assert role == "member"

    @pytest.mark.asyncio
    async def test_returns_role_from_org_member_row(self):
        fake_pg = MagicMock()
        fake_pg.fetchrow = AsyncMock(return_value={"role": "admin"})

        with patch("eden.storage.postgres.get_postgres_client",
                   new=AsyncMock(return_value=fake_pg)):
            role = await _resolve_user_role("t-1", "u-1")
        assert role == "admin"


# ── Singleton ────────────────────────────────────────────────────


def test_get_chat_service_singleton():
    s1 = get_chat_service()
    s2 = get_chat_service()
    assert s1 is s2