"""Canonical agent-framework registry for Eden.

Single source of truth consumed by:
  - onboarding framework detection + SDK integrator
  - Python SDK runtime detection
  - OTel ingestion span attribution

Provider routing (OpenRouter, Ollama base URLs, etc.) lives in
``sdk_integrator.PROVIDER_*`` — not here.
"""

from __future__ import annotations

from typing import Any

# ── Onboarding + SDK instrumentable frameworks ─────────────────────

_FRAMEWORK_DEFS: dict[str, dict[str, Any]] = {
    "langchain": {
        "pip": ["langchain", "langchain-core", "langchain-community"],
        "npm": ["langchain", "@langchain/core"],
        "imports": [
            r"from\s+langchain[\w\.]*\s+import",
            r"import\s+langchain[\w\.]*",
        ],
        "instrumentation": "LangChainInstrumentor",
        "python_modules": ("langchain", "langchain_core", "langchain_community"),
        "python_import": "import eden\neden.instrument(\"langchain\")\n",
        "ts_import": 'import { instrument, wrapLangChain } from "@eden-ai/sdk";\n',
        "otel_prefixes": ("ai.langchain.", "langchain."),
        "otel_headers": ("langchain",),
    },
    "crewai": {
        "pip": ["crewai"],
        "npm": ["crewai"],
        "imports": [r"from\s+crewai\s+import", r"import\s+crewai"],
        "instrumentation": "CrewAIInstrumentor",
        "python_modules": ("crewai",),
        "python_import": "import eden\neden.instrument(\"crewai\")\n",
        "ts_import": 'import { instrument } from "@eden-ai/sdk";\n',
        "otel_prefixes": ("crewai.",),
        "otel_headers": ("crewai",),
    },
    "autogen": {
        "pip": ["pyautogen", "autogen-agentchat"],
        "npm": ["autogen"],
        "imports": [
            r"from\s+autogen\s+import",
            r"import\s+autogen",
            r"from\s+autogen_agentchat\s+import",
        ],
        "instrumentation": "AutoGenInstrumentor",
        "python_modules": ("autogen", "pyautogen", "autogen_agentchat"),
        "python_import": "import eden\neden.instrument(\"autogen\")\n",
        "ts_import": 'import { instrument } from "@eden-ai/sdk";\n',
        "otel_prefixes": (),
        "otel_headers": ("autogen",),
    },
    "llama_index": {
        "pip": ["llama-index", "llama_index"],
        "npm": ["llama-index", "@llamaindex/core"],
        "imports": [
            r"from\s+llama_index[\w\.]*\s+import",
            r"import\s+llama_index[\w\.]*",
            r"from\s+llama_index\.core\s+import",
        ],
        "instrumentation": "LlamaIndexInstrumentor",
        "python_modules": ("llama_index", "llama_index.core"),
        "python_import": "import eden\neden.instrument(\"llama_index\")\n",
        "ts_import": 'import { wrapLangChain } from "@eden-ai/sdk";\n',
        "otel_prefixes": ("llama_index.", "li."),
        "otel_headers": ("llama-index", "llama_index", "llamaindex"),
        "otel_canonical": "llama-index",
    },
    "openai": {
        "pip": ["openai"],
        "npm": ["openai"],
        "imports": [
            r"from\s+openai\s+import",
            r"import\s+openai",
            r"OpenAI\s*\(",
        ],
        "instrumentation": "OpenAIInstrumentor",
        "python_modules": ("openai",),
        "python_import": "import eden\neden.instrument(\"openai\")\n",
        "ts_import": 'import { instrument, wrapOpenAI } from "@eden-ai/sdk";\n',
        "otel_prefixes": (),
        "otel_headers": (),
    },
    "anthropic": {
        "pip": ["anthropic"],
        "npm": ["@anthropic-ai/sdk", "anthropic"],
        "imports": [
            r"from\s+anthropic\s+import",
            r"import\s+anthropic",
            r"Anthropic\s*\(",
        ],
        "instrumentation": "AnthropicInstrumentor",
        "python_modules": ("anthropic",),
        "python_import": "import eden\neden.instrument(\"anthropic\")\n",
        "ts_import": 'import { instrument, wrapAnthropic } from "@eden-ai/sdk";\n',
        "otel_prefixes": (),
        "otel_headers": (),
    },
    "ollama": {
        "pip": ["ollama"],
        "npm": ["ollama", "@ollama/ollama"],
        "imports": [
            r"from\s+ollama\s+import",
            r"import\s+ollama",
            r"Ollama\s*\(",
            r"ollama\.chat\s*\(",
        ],
        "instrumentation": "OpenAIInstrumentor",
        "python_modules": ("ollama",),
        "python_import": "from openai import OpenAI  # Ollama's OpenAI-compat endpoint\n",
        "ts_import": 'import { instrument, wrapOpenAI } from "@eden-ai/sdk";\n',
        "otel_prefixes": (),
        "otel_headers": ("ollama",),
    },
    "mastra": {
        "pip": ["mastra", "@mastra/core"],
        "npm": ["mastra", "@mastra/core"],
        "imports": [r"from\s+mastra\s+import", r"import\s+mastra", r"@mastra/"],
        "instrumentation": "OpenAIInstrumentor",
        "python_modules": ("mastra",),
        "python_import": "",
        "ts_import": 'import { wrapMastra } from "@eden-ai/sdk";\n',
        "otel_prefixes": ("mastra.",),
        "otel_headers": ("mastra",),
    },
    "pydantic_ai": {
        "pip": ["pydantic-ai"],
        "npm": [],
        "imports": [
            r"from\s+pydantic_ai\s+import",
            r"import\s+pydantic_ai",
        ],
        "instrumentation": "PydanticAIInstrumentor",
        "python_modules": ("pydantic_ai",),
        "python_import": "import eden\neden.instrument(\"pydantic_ai\")\n",
        "ts_import": "",
        "otel_prefixes": ("pydantic_ai.",),
        "otel_headers": ("pydantic-ai", "pydantic_ai", "pydanticai"),
    },
}

# OTel-only frameworks (ingestion attribution, no onboarding codegen).
_OTEL_ONLY: dict[str, dict[str, Any]] = {
    "vercel-ai": {
        "otel_prefixes": ("vercel.ai.", "ai.vercel."),
        "otel_headers": ("vercel-ai", "vercel_ai", "vercelai"),
    },
    "smolagents": {
        "otel_prefixes": ("smolagents.",),
        "otel_headers": ("smolagents",),
    },
    "pydantic-ai": {
        "otel_prefixes": ("pydantic_ai.",),
        "otel_headers": ("pydantic-ai", "pydantic_ai", "pydanticai"),
        "otel_canonical": "pydantic-ai",
    },
    "dspy": {
        "otel_prefixes": ("dspy.",),
        "otel_headers": ("dspy",),
    },
}

KNOWN_FRAMEWORK_IDS = frozenset(_FRAMEWORK_DEFS) | frozenset(_OTEL_ONLY) | {"custom"}

FRAMEWORK_MARKERS: dict[str, dict[str, Any]] = {
    fw: {
        "pip": meta["pip"],
        "npm": meta["npm"],
        "imports": meta["imports"],
        "instrumentation": meta["instrumentation"],
    }
    for fw, meta in _FRAMEWORK_DEFS.items()
}

PYTHON_SDK_MODULES: dict[str, tuple[str, ...]] = {
    fw: meta["python_modules"]
    for fw, meta in _FRAMEWORK_DEFS.items()
    if meta.get("python_modules")
}

PYTHON_IMPORT_SNIPPETS: dict[str, str] = {
    fw: meta["python_import"]
    for fw, meta in _FRAMEWORK_DEFS.items()
    if meta.get("python_import")
}

TS_IMPORT_SNIPPETS: dict[str, str] = {
    fw: meta["ts_import"]
    for fw, meta in _FRAMEWORK_DEFS.items()
    if meta.get("ts_import")
}


def build_otel_prefix_map() -> dict[str, str]:
    """Attribute prefix → canonical framework name."""
    out: dict[str, str] = {}
    for fw_id, meta in {**_FRAMEWORK_DEFS, **_OTEL_ONLY}.items():
        canonical = meta.get("otel_canonical", fw_id)
        for prefix in meta.get("otel_prefixes", ()):
            out[prefix] = canonical
    return out


def build_otel_header_map() -> dict[str, str]:
    """Lowercased X-Source-Framework header value → canonical name."""
    out: dict[str, str] = {}
    for fw_id, meta in {**_FRAMEWORK_DEFS, **_OTEL_ONLY}.items():
        canonical = meta.get("otel_canonical", fw_id)
        for header in meta.get("otel_headers", ()):
            out[header.lower()] = canonical
        out[fw_id.lower()] = canonical
        if canonical != fw_id:
            out[canonical.lower()] = canonical
    return out


__all__ = [
    "FRAMEWORK_MARKERS",
    "KNOWN_FRAMEWORK_IDS",
    "PYTHON_IMPORT_SNIPPETS",
    "PYTHON_SDK_MODULES",
    "TS_IMPORT_SNIPPETS",
    "build_otel_header_map",
    "build_otel_prefix_map",
]
