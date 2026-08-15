"""Pinning test for Wave 2.3 — ``@prompt`` decorator stamps spans.

The decorator's old docstring promised per-call ``telemetry_events``
recording it never did (drift). Wave 2 aligns the docstring and makes
the async path stamp the recorded ``prompt_version`` onto the SDK's
active span so canary per-version stats can see which template
generated a call.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.sdk.prompt_decorator import prompt


@pytest.mark.asyncio
async def test_async_wrapper_stamps_prompt_version_on_span(monkeypatch) -> None:
    """The async path stamps the recorded version id onto the span."""
    monkeypatch.setenv("EDEN_ORG_ID", "org-1")
    span = MagicMock()
    span.set_attribute = MagicMock()
    monkeypatch.setattr(
        "eden.sdk.prompt_decorator._ensure_prompt_row",
        AsyncMock(return_value="prompt-1"),
    )
    monkeypatch.setattr(
        "eden.sdk.prompt_decorator._record_template_version",
        AsyncMock(return_value="version-9"),
    )

    class _FakeSpan:
        def set_attribute(self, key: str, value: object) -> None:
            span.set_attribute(key, value)

    def _current_span():
        # The decorator calls current_span() synchronously.
        return _FakeSpan()

    # ``eden_sdk.trace`` is shadowed by an exported function of the same
    # name, so patch through the real module object (string setattr and
    # ``from eden_sdk import trace`` both resolve the function).
    from importlib import import_module

    trace_mod = import_module("eden_sdk.trace")
    monkeypatch.setattr(trace_mod, "current_span", _current_span)

    calls: list[str] = []

    @prompt(name="support_reply_v1", model="gpt-4o")
    async def build_reply(user_msg: str) -> str:
        calls.append(user_msg)
        return f"reply:{user_msg}"

    result = await build_reply("hello")
    assert result == "reply:hello"
    assert calls == ["hello"]
    # The recorded version id must be stamped onto the active span.
    span.set_attribute.assert_called_once_with("prompt_version", "version-9")


@pytest.mark.asyncio
async def test_wrapped_function_runs_even_when_db_fails(monkeypatch) -> None:
    """Best-effort: DB errors are swallowed, the wrapped fn still runs."""
    monkeypatch.setattr(
        "eden.sdk.prompt_decorator._ensure_prompt_row",
        AsyncMock(side_effect=RuntimeError("db down")),
    )
    calls: list[str] = []

    @prompt(name="x", model="gpt-4o", versioned=True)
    async def fn() -> str:
        calls.append("ran")
        return "ok"

    assert await fn() == "ok"
    assert calls == ["ran"]
