"""Prompt management + Playground (Phase I — Logfire + RagaAI parity).

Two surfaces:

  1. **Prompt registry** — versioned prompt templates
     (system + user + tool definitions). Each template has
     a name, a list of required params, and a body
     (Jinja-like ``{{param}}`` substitution). The
     :meth:`PromptTemplate.compile` method validates that
     all required params are supplied.

  2. **Playground** — interactive testing of a prompt
     against the LLM. The user picks a model (T1-T4
     tiers), supplies the params, and the playground
     returns the model's response. The :meth:`compare`
     method runs the same prompt against two models and
     returns the results side-by-side for inspection.

The registry is intentionally **in-memory** (the
:class:`PromptRegistry` class). The migration to a
DB-backed store is Phase I.5 — the unit-testable surface
is what we ship now, and the DB persistence is a thin
layer on top.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional


logger = logging.getLogger(__name__)


# ─- Dataclasses ───────────────────────────────────────────────


@dataclass
class PromptTemplate:
    """A versioned prompt template."""

    name: str
    system: str = ""
    user: str = ""
    tools: list[dict[str, Any]] = field(default_factory=list)
    required_params: list[str] = field(default_factory=list)
    optional_params: list[str] = field(default_factory=list)
    model: str = "t1"
    temperature: float = 0.0
    max_tokens: int = 1_024
    description: str = ""
    version: int = 1

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "system": self.system,
            "user": self.user,
            "tools": list(self.tools),
            "required_params": list(self.required_params),
            "optional_params": list(self.optional_params),
            "model": self.model,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "description": self.description,
            "version": self.version,
        }


@dataclass
class CompiledPrompt:
    """A template with all params substituted, ready for the LLM."""

    system: str
    user: str
    tools: list[dict[str, Any]]
    model: str
    temperature: float
    max_tokens: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "system": self.system,
            "user": self.user,
            "tools": list(self.tools),
            "model": self.model,
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
        }


@dataclass
class PlaygroundResult:
    """One playground run."""

    template_name: str
    template_version: int
    model: str
    response: str
    latency_ms: float
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    cost_usd: Optional[float] = None
    created_at: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "template_name": self.template_name,
            "template_version": self.template_version,
            "model": self.model,
            "response": self.response,
            "latency_ms": self.latency_ms,
            "prompt_tokens": self.prompt_tokens,
            "completion_tokens": self.completion_tokens,
            "cost_usd": self.cost_usd,
            "created_at": self.created_at,
        }


# ─- Errors ─────────────────────────────────────────────────────


class PromptError(Exception):
    """Base class for prompt-related errors."""


class PromptCompileError(PromptError):
    """A required param was not supplied at compile time."""


class PromptUnknownParamError(PromptError):
    """An unknown param was supplied (typo detection)."""


# ─- Compile ────────────────────────────────────────────────────


_PLACEHOLDER_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


def _extract_placeholders(text: str) -> list[str]:
    """Return the list of unique placeholder names in ``text``."""
    seen: set[str] = set()
    out: list[str] = []
    for m in _PLACEHOLDER_RE.finditer(text):
        name = m.group(1)
        if name not in seen:
            out.append(name)
            seen.add(name)
    return out


def _substitute(text: str, params: dict[str, Any]) -> str:
    """Replace every ``{{name}}`` with ``str(params[name])``."""
    def _replace(m: re.Match) -> str:
        name = m.group(1)
        if name in params:
            return str(params[name])
        return m.group(0)
    return _PLACEHOLDER_RE.sub(_replace, text)


def compile_template(
    template: PromptTemplate,
    params: dict[str, Any],
) -> CompiledPrompt:
    """Validate + substitute the template's params."""
    supplied = set(params.keys())
    required = set(template.required_params)
    optional = set(template.optional_params)
    missing = required - supplied
    if missing:
        raise PromptCompileError(f"missing required params: {sorted(missing)}")
    unknown = supplied - required - optional
    if unknown:
        raise PromptUnknownParamError(f"unknown params: {sorted(unknown)}")
    system = _substitute(template.system, params)
    user = _substitute(template.user, params)
    return CompiledPrompt(
        system=system,
        user=user,
        tools=list(template.tools),
        model=template.model,
        temperature=template.temperature,
        max_tokens=template.max_tokens,
    )


# ─- Prompt registry ─────────────────────────────────────────


class PromptRegistry:
    """In-memory registry of prompt templates."""

    def __init__(self) -> None:
        self._store: dict[str, dict[int, PromptTemplate]] = {}

    def register(self, template: PromptTemplate) -> PromptTemplate:
        if template.version == 0:
            template.version = 1
        if template.name in self._store:
            raise ValueError(
                f"template {template.name!r} already exists; use update()",
            )
        self._store.setdefault(template.name, {})[template.version] = template
        return template

    def get(self, name: str) -> Optional[PromptTemplate]:
        versions = self._store.get(name)
        if not versions:
            return None
        latest = max(versions)
        return versions[latest]

    def get_version(self, name: str, version: int) -> Optional[PromptTemplate]:
        return self._store.get(name, {}).get(version)

    def update(self, template: PromptTemplate) -> PromptTemplate:
        if template.name not in self._store:
            raise ValueError(
                f"template {template.name!r} does not exist; use register()",
            )
        latest = max(self._store[template.name])
        template.version = latest + 1
        self._store[template.name][template.version] = template
        return template

    def rollback(self, name: str, to_version: int) -> PromptTemplate:
        old = self.get_version(name, to_version)
        if old is None:
            raise ValueError(f"version {to_version} of {name!r} not found")
        latest = max(self._store[name])
        new = PromptTemplate(
            name=old.name,
            system=old.system,
            user=old.user,
            tools=list(old.tools),
            required_params=list(old.required_params),
            optional_params=list(old.optional_params),
            model=old.model,
            temperature=old.temperature,
            max_tokens=old.max_tokens,
            description=old.description,
            version=latest + 1,
        )
        self._store[name][new.version] = new
        return new

    def list_versions(self, name: str) -> list[int]:
        return sorted(self._store.get(name, {}))

    def list_names(self) -> list[str]:
        return sorted(self._store)

    def delete(self, name: str) -> bool:
        if name in self._store:
            del self._store[name]
            return True
        return False


# ─- Playground ───────────────────────────────────────────────


LLMHandler = Callable[[dict[str, Any]], Awaitable[PlaygroundResult]]


async def default_llm_handler(prompt_dict: dict[str, Any]) -> PlaygroundResult:
    """Default LLM handler stub."""
    import asyncio
    await asyncio.sleep(0)
    text = prompt_dict.get("user", "")
    return PlaygroundResult(
        template_name="",
        template_version=0,
        model=prompt_dict.get("model", "stub"),
        response=f"[stub:{text[:50]}{'...' if len(text) > 50 else ''}]",
        latency_ms=0.5,
        prompt_tokens=len(text.split()),
        completion_tokens=5,
        cost_usd=0.0,
        created_at=datetime.now(timezone.utc).isoformat(),
    )


class Playground:
    """Run a compiled prompt against an LLM."""

    def __init__(self, handler: LLMHandler = default_llm_handler) -> None:
        self.handler = handler

    async def run(
        self,
        template: PromptTemplate,
        params: dict[str, Any],
    ) -> PlaygroundResult:
        compiled = compile_template(template, params)
        result = await self.handler(compiled.to_dict())
        result.template_name = template.name
        result.template_version = template.version
        if not result.created_at:
            result.created_at = datetime.now(timezone.utc).isoformat()
        return result

    async def compare(
        self,
        template: PromptTemplate,
        params: dict[str, Any],
        model_b: str,
    ) -> tuple[PlaygroundResult, PlaygroundResult]:
        a = await self.run(template, params)
        b_template = PromptTemplate(
            name=template.name,
            system=template.system,
            user=template.user,
            tools=list(template.tools),
            required_params=list(template.required_params),
            optional_params=list(template.optional_params),
            model=model_b,
            temperature=template.temperature,
            max_tokens=template.max_tokens,
            description=template.description,
            version=template.version,
        )
        b = await self.run(b_template, params)
        return (a, b)


__all__ = [
    "PromptTemplate",
    "CompiledPrompt",
    "PlaygroundResult",
    "PromptError",
    "PromptCompileError",
    "PromptUnknownParamError",
    "PromptRegistry",
    "Playground",
    "compile_template",
    "_extract_placeholders",
    "_substitute",
    "default_llm_handler",
    "LLMHandler",
]
