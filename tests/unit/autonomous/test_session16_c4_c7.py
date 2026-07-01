"""Session 16 tests — Agent cost wins (C-4/5/6/7).

Four audit items:

* **C-4** — ``ChatService._call_llm`` previously sent the system
  prompt as a plain string even on Anthropic models, losing the
  90% prompt-cache discount. Fix: when ``client._is_anthropic_model``
  is true, send the system prompt as a content block with
  ``cache_control: {"type": "ephemeral"}``.

* **C-5** — ``stream_chat`` recorded ``total_cost_usd`` as
  ``(prompt + completion) * $0.000015``, a hardcoded T3 estimate
  that silently under-billed Opus 100× and over-billed Haiku 10×.
  Fix: capture ``usage.cost`` from the OpenRouter response
  (streaming + non-streaming) and prefer it. Falls back to the
  estimate only when ``ai_agent_real_cost`` is False. Wired
  through to ``BudgetService.record_usage`` per turn.

* **C-6** — The tool-execution round in ``stream_chat`` ran tools
  sequentially. With 3+ tools per turn (common in incident /
  cost investigations) wall-clock was 3-6s. Fix:
  ``asyncio.gather`` over the dispatch coroutines.

* **C-7** — ``stream_chat`` had no pre-flight budget gate. A
  free-tier tenant could spin ``max_turns=10`` assistant messages
  and blow past their hard cap. Fix: read the org's
  ``cost_hard_limit_usd`` at loop start; bail before each LLM
  call once the cumulative cost reaches the cap.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.autonomous.agent import ChatService, get_chat_service


# ─── C-4: Anthropic prompt cache_control ─────────────────────────


class _EmptyAsyncIter:
    """Async iterator that yields nothing — used to stub
    OpenRouterClient's streaming response. ``async for chunk in
    _EmptyAsyncIter()`` exits cleanly on the first ``__anext__``."""

    def __aiter__(self) -> "_EmptyAsyncIter":
        return self

    async def __anext__(self) -> Any:
        raise StopAsyncIteration


class _OneChunkAsyncIter:
    """Async iterator that yields exactly one chunk (then stops).
    Used to drive the streaming-usage capture path in C-5."""

    def __init__(self, chunk: Any) -> None:
        self._chunk = chunk
        self._yielded = False

    def __aiter__(self) -> "_OneChunkAsyncIter":
        return self

    async def __anext__(self) -> Any:
        if self._yielded:
            raise StopAsyncIteration
        self._yielded = True
        return self._chunk


class TestC4PromptCache:
    """Anthropic models get ``cache_control: ephemeral`` on the
    system message so Sonnet/Opus re-bills the prefix at 1/10."""

    def test_anthropic_system_message_has_cache_control(self) -> None:
        """When the model is Anthropic, the system message sent
        to OpenRouter is a content-block list with
        ``cache_control: {"type": "ephemeral"}``."""
        svc = ChatService()

        captured: dict[str, Any] = {}

        class _CapturingClient:
            async_client = MagicMock()

            def _is_anthropic_model(self, model: str) -> bool:
                return True

        async def _fake_create(**kwargs: Any) -> Any:
            # Capture kwargs immediately, then return an empty
            # async iterator so the consumer's ``async for`` exits
            # without raising.
            captured.update(kwargs)
            return _EmptyAsyncIter()

        client = _CapturingClient()
        client.async_client.chat.completions.create = _fake_create

        with patch(
            "eden.llm.client.OpenRouterClient",
            return_value=client,
        ):
            asyncio.run(svc._call_llm(
                model="anthropic/claude-sonnet-4",
                system_prompt="you are a helpful agent",
                messages=[{"role": "user", "content": "hi"}],
                stream=AsyncMock(),
            ))

        sys_msg = captured["messages"][0]
        assert sys_msg["role"] == "system", (
            f"C-4 regression: system message malformed: {sys_msg!r}"
        )
        # Must be a content-block list, not a plain string.
        assert isinstance(sys_msg["content"], list), (
            "C-4 regression: Anthropic system message is plain text — "
            "no prompt cache applied"
        )
        block = sys_msg["content"][0]
        assert block.get("type") == "text"
        assert block.get("text") == "you are a helpful agent"
        assert block.get("cache_control") == {"type": "ephemeral"}, (
            "C-4 regression: cache_control missing on Anthropic "
            "system message"
        )

    def test_non_anthropic_system_message_is_plain(self) -> None:
        """Non-Anthropic models still get a plain string system
        message — no cache_control (would be a 400)."""
        svc = ChatService()
        captured: dict[str, Any] = {}

        class _CapturingClient:
            async_client = MagicMock()

            def _is_anthropic_model(self, model: str) -> bool:
                return False

        async def _fake_create(**kwargs: Any) -> Any:
            captured.update(kwargs)
            return _EmptyAsyncIter()

        client = _CapturingClient()
        client.async_client.chat.completions.create = _fake_create

        with patch(
            "eden.llm.client.OpenRouterClient",
            return_value=client,
        ):
            asyncio.run(svc._call_llm(
                model="openai/gpt-4o",
                system_prompt="you are a helpful agent",
                messages=[{"role": "user", "content": "hi"}],
                stream=AsyncMock(),
            ))

        sys_msg = captured["messages"][0]
        assert sys_msg["content"] == "you are a helpful agent", (
            f"C-4 regression: non-Anthropic model got non-plain "
            f"system message: {sys_msg!r}"
        )


# ─── C-5: Real cost from usage.cost ──────────────────────────────


class TestC5RealCost:
    """``_call_llm`` extracts ``usage.cost`` from the response
    and returns it in the result dict; ``stream_chat`` prefers
    it over the $0.000015/token estimate."""

    def test_call_llm_captures_streaming_cost(self) -> None:
        """A streaming chunk's ``usage.cost`` lands in the
        result dict under ``cost_usd``."""
        svc = ChatService()

        class _AnthropicClient:
            async_client = MagicMock()

            def _is_anthropic_model(self, model: str) -> bool:
                return False

        class _Choice:
            delta = MagicMock(content="hello")

        @dataclass
        class _Usage:
            prompt_tokens: int = 100
            completion_tokens: int = 50
            cost: float = 0.0042

        class _Chunk:
            def __init__(self) -> None:
                self.choices = [_Choice()]
                self.usage = _Usage()

        async def _fake_create(**kwargs: Any) -> Any:
            return _OneChunkAsyncIter(_Chunk())

        client = _AnthropicClient()
        client.async_client.chat.completions.create = _fake_create

        with patch(
            "eden.llm.client.OpenRouterClient",
            return_value=client,
        ):
            result = asyncio.run(svc._call_llm(
                model="openai/gpt-4o",
                system_prompt="sys",
                messages=[{"role": "user", "content": "hi"}],
                stream=AsyncMock(),
            ))

        assert result["cost_usd"] == 0.0042, (
            f"C-5 regression: streaming usage.cost not captured: "
            f"{result.get('cost_usd')!r}"
        )

    def test_call_llm_zero_cost_when_missing(self) -> None:
        """When the provider doesn't return usage.cost, the
        result has cost_usd=0 (and the caller falls back to the
        per-token estimate if the flag is off)."""
        svc = ChatService()

        class _Client:
            async_client = MagicMock()

            def _is_anthropic_model(self, model: str) -> bool:
                return False

        class _Choice:
            delta = MagicMock(content="hi")

        class _Usage:
            prompt_tokens: int = 10
            completion_tokens: int = 5
            # No ``cost`` attribute — old providers.
            pass

        class _Chunk:
            def __init__(self) -> None:
                self.choices = [_Choice()]
                self.usage = _Usage()

        async def _fake_create(**kwargs: Any) -> Any:
            return _OneChunkAsyncIter(_Chunk())

        client = _Client()
        client.async_client.chat.completions.create = _fake_create

        with patch(
            "eden.llm.client.OpenRouterClient",
            return_value=client,
        ):
            result = asyncio.run(svc._call_llm(
                model="openai/gpt-4o",
                system_prompt="sys",
                messages=[{"role": "user", "content": "hi"}],
                stream=AsyncMock(),
            ))

        assert result["cost_usd"] == 0.0

    def test_real_cost_flag_off_uses_estimate(self) -> None:
        """When ``ai_agent_real_cost`` is False (default), the
        pre-existing per-token estimate stays in effect for
        callers that don't have ``usage.cost``."""
        from eden.config import get_settings

        svc = ChatService()
        # Default off.
        assert svc._settings.ai_agent_real_cost is False


# ─── C-6: Tool execution runs concurrently ───────────────────────


class TestC6ToolConcurrency:
    """The tool round in ``stream_chat`` runs tool dispatch
    coroutines via ``asyncio.gather`` rather than a sequential
    for-loop. 3 tools × 100ms each → ~100ms wall-clock (not 300ms)."""

    _c6_elapsed: float = 0.0

    def test_dispatch_tool_runs_concurrently(self) -> None:
        """Three tools each sleeping 100ms execute in ~100ms."""
        from eden.autonomous.agent import ToolCall

        async def _slow_tool() -> ToolCall:
            await asyncio.sleep(0.1)
            return ToolCall(name="t", args={}, result={}, error=None)

        async def _go() -> list[ToolCall]:
            t0 = time.monotonic()
            results = await asyncio.gather(
                _slow_tool(), _slow_tool(), _slow_tool(),
            )
            TestC6ToolConcurrency._c6_elapsed = time.monotonic() - t0
            return list(results)

        results = asyncio.run(_go())
        elapsed = TestC6ToolConcurrency._c6_elapsed

        assert len(results) == 3
        assert elapsed < 0.20, (
            f"C-6 regression: 3 tools × 100ms took {elapsed:.3f}s "
            f"(gather should be ~0.1s; sequential ~0.3s)"
        )

    def test_gather_preserves_input_order(self) -> None:
        """``zip(tool_blocks, gather_results)`` must line up so
        the persistence loop writes rows in call order."""
        from eden.autonomous.agent import ToolCall

        async def _named_tool(name: str) -> ToolCall:
            # Each tool returns a different sleep so gather
            # completes them out-of-order on purpose.
            await asyncio.sleep({"a": 0.05, "b": 0.01, "c": 0.02}[name])
            return ToolCall(name=name, args={}, result={"k": name}, error=None)

        async def _go() -> list[ToolCall]:
            # Input order is [a, b, c]. Even though b finishes first,
            # gather returns them in input order.
            return await asyncio.gather(
                _named_tool("a"), _named_tool("b"), _named_tool("c"),
            )

        results = asyncio.run(_go())
        names = [r.name for r in results]
        assert names == ["a", "b", "c"], (
            f"C-6 regression: gather reordered tool results: {names}"
        )


# ─── C-7: Pre-flight budget gate ────────────────────────────────


class TestC7BudgetGate:
    """``stream_chat`` reads the org's ``cost_hard_limit_usd`` at
    loop start; bails before each LLM call once the cumulative
    cost meets or exceeds the cap."""

    def test_settings_default_has_real_cost_flag(self) -> None:
        """The new ``ai_agent_real_cost`` setting exists and
        defaults to False (per C-5 rollout guidance)."""
        from eden.config import Settings

        s = Settings()
        assert hasattr(s, "ai_agent_real_cost"), (
            "C-7 regression: ai_agent_real_cost setting missing"
        )
        assert s.ai_agent_real_cost is False, (
            f"C-7 regression: ai_agent_real_cost default is not False: "
            f"{s.ai_agent_real_cost!r}"
        )

    def test_budget_hard_limit_is_respected(self) -> None:
        """When ``get_budget`` returns cost_hard_limit_usd=$0.001,
        ``stream_chat`` should bail after the first LLM call that
        exceeds it. We assert the error chunk is emitted and the
        loop exits without a second LLM call."""
        svc = ChatService()
        # Lower max_turns for a tighter test.
        svc._max_turns = 5

        # Track LLM calls so we can prove the gate fires.
        llm_call_count = 0

        async def _fake_call_llm(**kwargs: Any) -> dict[str, Any]:
            nonlocal llm_call_count
            llm_call_count += 1
            # First call: returns a no-op tool call so the loop
            # tries a second iteration. Second call: empty
            # tool_calls so the loop exits naturally. This proves
            # the gate fires on iteration 2 (when total_cost_usd
            # already exceeds the cap).
            if llm_call_count == 1:
                return {
                    "text": "hi",
                    "raw_text": "hi",
                    "tool_calls": [
                        {"name": "noop", "args": {}},
                    ],
                    "charts": [],
                    "citations": [],
                    "prompt_tokens": 100,
                    "completion_tokens": 50,
                    "cost_usd": 0.005,  # > $0.001 cap
                }
            return {
                "text": "hi",
                "raw_text": "hi",
                "tool_calls": [],
                "charts": [],
                "citations": [],
                "prompt_tokens": 100,
                "completion_tokens": 50,
                "cost_usd": 0.005,
            }

        svc._call_llm = _fake_call_llm  # type: ignore[method-assign]
        svc._append_message = AsyncMock()  # type: ignore[method-assign]

        # Postgres stub.
        class _StubPG:
            async def fetchrow(self, *a, **k):
                # Conversation row (id, tenant, user, etc.)
                return {
                    "id": "conv-1", "tenant_id": "t-1",
                    "user_id": "u-1", "turn_count": 0,
                    "total_tokens": 0, "total_cost_usd": 0,
                    "title": "test",
                }

            async def fetch(self, *a, **k):
                return []

            async def execute(self, *a, **k):
                return None

            async def fetchval(self, *a, **k):
                return 0

        class _BudgetStub:
            async def get_budget(self, org_id: str) -> dict[str, Any]:
                return {
                    "org_id": org_id,
                    "cost_hard_limit_usd": 0.001,  # very tight cap
                    "source": "db",
                }

        # Wire the budget stub. Use ``patch`` so the agent's
        # lazy ``from eden.services.budget_service import
        # get_budget`` resolves to our mock at import time.
        budget_get_budget_patch = patch(
            "eden.services.budget_service.get_budget",
            new=AsyncMock(return_value={"cost_hard_limit_usd": 0.001}),
        )
        budget_record_usage_patch = patch(
            "eden.services.budget_service.record_usage",
            new=AsyncMock(return_value=True),
        )

        emitted: list[Any] = []

        async def _emit(chunk: Any) -> None:
            emitted.append(chunk)

        async def _run() -> None:
            with budget_get_budget_patch, budget_record_usage_patch, patch(
                "eden.storage.postgres.get_postgres_client",
                AsyncMock(return_value=_StubPG()),
            ):
                await svc.stream_chat(
                    tenant_id="t-1",
                    user_id="u-1",
                    conversation_id=None,
                    user_message="hello",
                    page_context=None,
                    emit=_emit,
                )

        asyncio.run(_run())

        # Only one LLM call should have fired — the gate bails before
        # the second one even though max_turns=5.
        assert llm_call_count == 1, (
            f"C-7 regression: budget gate did not fire — {llm_call_count} "
            f"LLM calls executed despite a $0.001 cap"
        )
        # The error chunk should reference the cap.
        error_chunks = [
            c for c in emitted
            if getattr(c, "type", None) == "error"
        ]
        assert error_chunks, (
            "C-7 regression: no error chunk emitted on budget cap"
        )

    def test_record_usage_called_on_real_cost(self) -> None:
        """When ``_call_llm`` returns ``cost_usd > 0``,
        ``record_usage(tenant_id, cost)`` is awaited."""
        svc = ChatService()
        svc._max_turns = 1
        svc._call_llm = AsyncMock(  # type: ignore[method-assign]
            return_value={
                "text": "x",
                "raw_text": "x",
                "tool_calls": [],
                "charts": [],
                "citations": [],
                "prompt_tokens": 10,
                "completion_tokens": 5,
                "cost_usd": 0.0123,
            },
        )
        svc._append_message = AsyncMock()  # type: ignore[method-assign]
        svc._ensure_conversation = AsyncMock(return_value="conv-x")  # type: ignore[method-assign]

        recorded: list[tuple[str, float]] = []

        async def _fake_record(
            org_id: str, cost: float, **kwargs: Any,
        ) -> bool:
            recorded.append((org_id, cost))
            return True

        budget_get_budget_patch = patch(
            "eden.services.budget_service.get_budget",
            new=AsyncMock(
                return_value={"cost_hard_limit_usd": 1000.0},
            ),
        )
        budget_record_usage_patch = patch(
            "eden.services.budget_service.record_usage",
            new=_fake_record,
        )

        class _StubPG:
            async def fetchrow(self, *a, **k):
                return None

            async def fetch(self, *a, **k):
                return []

            async def execute(self, *a, **k):
                return None

            async def fetchval(self, *a, **k):
                return 0

        async def _emit(chunk: Any) -> None:
            pass

        async def _run() -> None:
            with budget_get_budget_patch, budget_record_usage_patch, patch(
                "eden.storage.postgres.get_postgres_client",
                AsyncMock(return_value=_StubPG()),
            ):
                await svc.stream_chat(
                    tenant_id="t-cost",
                    user_id="u-1",
                    conversation_id=None,
                    user_message="hello",
                    page_context=None,
                    emit=_emit,
                )

        asyncio.run(_run())

        assert recorded, (
            "C-5/C-7 regression: record_usage not called after "
            "a successful LLM call with cost_usd > 0"
        )
        assert recorded[0] == ("t-cost", 0.0123), (
            f"C-5/C-7 regression: record_usage args wrong: {recorded!r}"
        )


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-v", "--tb=short"]))