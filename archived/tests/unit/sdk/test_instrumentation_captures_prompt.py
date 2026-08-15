"""Every provider instrumentation must capture the prompt.

Regression lock for the 2026-07 remediation.

``openai.py`` and ``groq.py`` read ``messages`` only from ``args[0]``. Both
SDKs declare ``create()`` with keyword-only parameters, so ``args`` is empty on
every real call — and neither listed ``messages`` in its keyword allow-list.
Every captured span for those two providers carried ``model`` and
``temperature`` and **no prompt**, which for an LLM observability product is
the single most valuable field.

It survived review because both files *do* contain the string ``"messages"``,
in the unreachable positional branch, so a grep for the field name passes.
These tests therefore assert on the **returned payload**, never on source text.
"""

from __future__ import annotations

import importlib
import inspect

import pytest

# Providers whose request builder takes ``(args, kwargs)``.
_TUPLE_STYLE = ["openai", "groq"]
# Providers whose request builder takes ``(kwargs)`` only.
_KWARGS_STYLE = ["anthropic"]

_PROMPT = [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "What is the capital of France?"},
]


def _build(module_name: str) -> dict:
    mod = importlib.import_module(
        f"eden_sdk.instrumentations.{module_name}"
    )
    fn = mod._build_request_payload
    kwargs = {
        "model": "some-model",
        "messages": _PROMPT,
        "temperature": 0.7,
        "max_tokens": 256,
    }
    # Call it the way the real SDK does: everything keyword-only.
    if len(inspect.signature(fn).parameters) == 1:
        return fn(kwargs)
    return fn((), kwargs)


@pytest.mark.parametrize("provider", _TUPLE_STYLE + _KWARGS_STYLE)
def test_prompt_is_captured(provider: str) -> None:
    payload = _build(provider)
    assert "messages" in payload, (
        f"{provider} instrumentation captured {sorted(payload)} — no prompt. "
        "Check that 'messages' is in the keyword allow-list, not only in the "
        "unreachable positional branch."
    )


@pytest.mark.parametrize("provider", _TUPLE_STYLE + _KWARGS_STYLE)
def test_prompt_content_survives_intact(provider: str) -> None:
    """A truncated or emptied prompt is as useless as a missing one."""
    payload = _build(provider)
    messages = payload["messages"]
    assert len(messages) == 2
    assert messages[1]["content"] == "What is the capital of France?"


@pytest.mark.parametrize("provider", _TUPLE_STYLE + _KWARGS_STYLE)
def test_settings_still_captured(provider: str) -> None:
    """Adding the prompt must not have displaced the existing fields."""
    payload = _build(provider)
    assert payload.get("model") == "some-model"
    assert payload.get("temperature") == 0.7


@pytest.mark.parametrize("provider", _TUPLE_STYLE)
def test_positional_fallback_still_works(provider: str) -> None:
    """Wrappers that pass a single dict positionally must keep working."""
    mod = importlib.import_module(f"eden_sdk.instrumentations.{provider}")
    payload = mod._build_request_payload(
        ({"role": "user", "content": "hi"},), {"model": "m"}
    )
    assert "messages" in payload


def test_openai_create_really_is_keyword_only() -> None:
    """The premise of the bug, asserted against the installed SDK.

    If a future SDK release makes parameters positional again, the positional
    branch becomes live and this test documents why it is still there.
    """
    openai = pytest.importorskip("openai")
    from openai.resources.chat.completions import Completions

    params = list(inspect.signature(Completions.create).parameters.values())
    positional = [
        p.name
        for p in params
        if p.name != "self"
        and p.kind
        in (inspect.Parameter.POSITIONAL_ONLY, inspect.Parameter.POSITIONAL_OR_KEYWORD)
    ]
    assert positional == [], (
        f"openai {openai.__version__} now accepts positional params {positional}; "
        "revisit the instrumentation's arg handling."
    )
