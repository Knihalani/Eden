"""Unit tests for Phase I — Prompt management + Playground.

What's covered:

  Placeholder extraction (3 tests)
  ──────────────────────────────
  * Empty text
  * Single placeholder
  * Multiple placeholders + dedup

  Substitute (3 tests)
  ──────────────────
  * Replaces placeholders
  * Leaves missing alone
  * Stringifies non-strings

  compile_template (5 tests)
  ────────────────────────
  * Happy path
  * Missing required param raises
  * Unknown param raises
  * Tools + temperature pass through
  * Empty params

  PromptRegistry (8 tests)
  ──────────────────────
  * Register new
  * Get latest
  * Get specific version
  * Update bumps version
  * Rollback creates new version with old content
  * List versions sorted
  * List names sorted
  * Delete

  Playground (5 tests)
  ──────────────────
  * Run uses default handler
  * Run annotates template_name / version
  * Run with model override
  * Compare returns both results
  * Compile error propagates

  Dataclass (3 tests)
  ───────────────
  * PromptTemplate to_dict
  * CompiledPrompt to_dict
  * PlaygroundResult to_dict
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from eden.prompts.registry import (
    CompiledPrompt,
    Playground,
    PlaygroundResult,
    PromptCompileError,
    PromptRegistry,
    PromptTemplate,
    PromptUnknownParamError,
    _extract_placeholders,
    _substitute,
    compile_template,
    default_llm_handler,
)

# ─- Placeholders ──────────────────────────────────────────────


class TestExtractPlaceholders:
    def test_empty_text(self) -> None:
        assert _extract_placeholders("") == []
        assert _extract_placeholders("no placeholders here") == []

    def test_single(self) -> None:
        assert _extract_placeholders("Hello {{name}}") == ["name"]

    def test_multiple_dedup(self) -> None:
        text = "Hello {{name}}, you are {{age}}. {{name}} again."
        assert _extract_placeholders(text) == ["name", "age"]


class TestSubstitute:
    def test_replaces(self) -> None:
        out = _substitute("Hello {{name}}", {"name": "Alice"})
        assert out == "Hello Alice"

    def test_leaves_missing(self) -> None:
        out = _substitute("Hello {{name}}", {})
        assert out == "Hello {{name}}"

    def test_stringifies(self) -> None:
        out = _substitute("{{n}}", {"n": 42})
        assert out == "42"


# ─- compile_template ──────────────────────────────────────


class TestCompileTemplate:
    def test_happy_path(self) -> None:
        t = PromptTemplate(
            name="summarise",
            system="You are a summariser.",
            user="Summarise in {{length}} words: {{text}}",
            required_params=["text", "length"],
        )
        compiled = compile_template(t, {"text": "Hello world.", "length": 5})
        assert compiled.user == "Summarise in 5 words: Hello world."

    def test_missing_required_raises(self) -> None:
        t = PromptTemplate(
            name="x", user="{{a}} {{b}}",
            required_params=["a", "b"],
        )
        with pytest.raises(PromptCompileError, match="missing"):
            compile_template(t, {"a": "1"})

    def test_unknown_param_raises(self) -> None:
        t = PromptTemplate(
            name="x", user="{{a}}",
            required_params=["a"],
        )
        with pytest.raises(PromptUnknownParamError, match="unknown"):
            compile_template(t, {"a": "1", "typo": "v"})

    def test_tools_temperature_pass_through(self) -> None:
        t = PromptTemplate(
            name="x", user="{{q}}",
            required_params=["q"],
            tools=[{"name": "search"}],
            temperature=0.7, max_tokens=2048,
        )
        compiled = compile_template(t, {"q": "hi"})
        assert compiled.tools == [{"name": "search"}]
        assert compiled.temperature == 0.7
        assert compiled.max_tokens == 2048

    def test_empty_params(self) -> None:
        t = PromptTemplate(name="x", user="hi")
        compiled = compile_template(t, {})
        assert compiled.user == "hi"


# ─- PromptRegistry ───────────────────────────────────────


class TestPromptRegistry:
    def test_register_new(self) -> None:
        r = PromptRegistry()
        t = r.register(PromptTemplate(name="x", user="hi"))
        assert t.version == 1

    def test_register_duplicate_raises(self) -> None:
        r = PromptRegistry()
        r.register(PromptTemplate(name="x"))
        with pytest.raises(ValueError, match="already exists"):
            r.register(PromptTemplate(name="x"))

    def test_get_latest(self) -> None:
        r = PromptRegistry()
        r.register(PromptTemplate(name="x", user="v1"))
        t = r.get("x")
        assert t.user == "v1"

    def test_get_specific_version(self) -> None:
        r = PromptRegistry()
        r.register(PromptTemplate(name="x", user="v1"))
        t = PromptTemplate(name="x", user="v2")
        r.update(t)
        assert r.get_version("x", 1).user == "v1"
        assert r.get_version("x", 2).user == "v2"

    def test_update_bumps_version(self) -> None:
        r = PromptRegistry()
        r.register(PromptTemplate(name="x", user="v1"))
        t = PromptTemplate(name="x", user="v2")
        out = r.update(t)
        assert out.version == 2

    def test_rollback_creates_new_version(self) -> None:
        r = PromptRegistry()
        r.register(PromptTemplate(name="x", user="v1"))
        r.update(PromptTemplate(name="x", user="v2"))
        out = r.rollback("x", 1)
        assert out.version == 3
        assert out.user == "v1"
        # The audit trail is preserved.
        assert r.list_versions("x") == [1, 2, 3]

    def test_list_versions_sorted(self) -> None:
        r = PromptRegistry()
        r.register(PromptTemplate(name="x", user="v1"))
        r.update(PromptTemplate(name="x", user="v2"))
        assert r.list_versions("x") == [1, 2]

    def test_list_names_sorted(self) -> None:
        r = PromptRegistry()
        r.register(PromptTemplate(name="b"))
        r.register(PromptTemplate(name="a"))
        assert r.list_names() == ["a", "b"]

    def test_delete(self) -> None:
        r = PromptRegistry()
        r.register(PromptTemplate(name="x"))
        assert r.delete("x") is True
        assert r.get("x") is None
        assert r.delete("x") is False


# ─- Playground ──────────────────────────────────────────


class TestPlayground:
    @pytest.mark.asyncio
    async def test_run_uses_default_handler(self) -> None:
        t = PromptTemplate(name="x", user="{{q}}", required_params=["q"])
        pg = Playground()
        result = await pg.run(t, {"q": "hello"})
        assert "hello" in result.response

    @pytest.mark.asyncio
    async def test_run_annotates_template_metadata(self) -> None:
        t = PromptTemplate(name="summarise", user="hi", version=3)
        pg = Playground()
        result = await pg.run(t, {})
        assert result.template_name == "summarise"
        assert result.template_version == 3

    @pytest.mark.asyncio
    async def test_compare_returns_both(self) -> None:
        async def handler(prompt: dict) -> PlaygroundResult:
            return PlaygroundResult(
                template_name="",
                template_version=0,
                model=str(prompt.get("model") or ""),
                response="ok",
                latency_ms=1.0,
            )

        t = PromptTemplate(name="x", user="hi", model="model-a")
        pg = Playground(handler=handler)
        a, b = await pg.compare(t, {}, "model-b")
        assert a.model == "model-a"
        assert b.model == "model-b"

    @pytest.mark.asyncio
    async def test_run_with_custom_handler(self) -> None:
        async def handler(prompt: dict) -> PlaygroundResult:
            return PlaygroundResult(
                template_name="", template_version=0,
                model="custom", response="CUSTOM_RESPONSE",
                latency_ms=1.0,
            )
        t = PromptTemplate(name="x", user="hi")
        pg = Playground(handler=handler)
        result = await pg.run(t, {})
        assert result.response == "CUSTOM_RESPONSE"

    @pytest.mark.asyncio
    async def test_compile_error_propagates(self) -> None:
        t = PromptTemplate(name="x", user="{{a}}", required_params=["a"])
        pg = Playground()
        with pytest.raises(PromptCompileError):
            await pg.run(t, {})


# ─- Dataclass ───────────────────────────────────────────────


class TestDataclass:
    def test_prompt_template_to_dict(self) -> None:
        t = PromptTemplate(
            name="x", system="sys", user="usr",
            required_params=["a"], version=2,
        )
        d = t.to_dict()
        assert d["name"] == "x"
        assert d["version"] == 2

    def test_compiled_prompt_to_dict(self) -> None:
        c = CompiledPrompt(
            system="s", user="u", tools=[],
            model="m", temperature=0.5, max_tokens=100,
        )
        d = c.to_dict()
        assert d["system"] == "s"
        assert d["temperature"] == 0.5

    def test_playground_result_to_dict(self) -> None:
        r = PlaygroundResult(
            template_name="x", template_version=1,
            model="m", response="r", latency_ms=10.0,
        )
        d = r.to_dict()
        assert d["response"] == "r"
        assert d["latency_ms"] == 10.0
