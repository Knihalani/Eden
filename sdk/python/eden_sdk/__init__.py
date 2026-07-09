"""Eden Python Runtime SDK.

A lightweight, fire-and-forget observability SDK for LLM applications.

Highlights
----------
- ``@trace_agent`` decorator — trace any Python function (sync or async).
- ``with eden.trace(...)`` — manual span context manager.
- One-line auto-instrumentation for OpenAI, Anthropic, LangChain, LlamaIndex,
  CrewAI, AutoGen, Mastra.
- Async, batched, non-blocking HTTP sender (target p99 overhead ≤ 5 ms).
- Zero required dependencies beyond ``httpx`` (the only required runtime dep).

Example
-------
>>> import eden
>>> eden.configure(org_id="org_123", api_key="sk-...")
>>> eden.instrument()  # patches OpenAI, Anthropic, LangChain, etc.
>>>
>>> @eden.trace_agent(name="my-agent")
... async def run(q: str) -> str:
...     from openai import AsyncOpenAI
...     client = AsyncOpenAI()
...     resp = await client.chat.completions.create(
...         model="gpt-4o-mini", messages=[{"role": "user", "content": q}]
...     )
...     return resp.choices[0].message.content
"""

from __future__ import annotations

from eden_sdk._tokens import extract_usage, normalize_model_name
from eden_sdk.client import EdenClient, get_default_client
from eden_sdk.config import EdenConfig, configure, get_config, reset_config
from eden_sdk.filters import FilterConfig, PIIConfig, redact_payload
from eden_sdk.gateway_session import chat_completion, openai_client
from eden_sdk.model_advisor import (
    ModelAdvisor,
    ModelAdvisorError,
    ModelComparison,
    ModelSpec,
    Recommendation,
    RunnerUp,
    SwitchProjection,
)
from eden_sdk.trace import (
    Span,
    TraceContext,
    current_span,
    current_trace,
    trace,
    trace_agent,
)

__all__ = [
    # Configuration
    "EdenConfig",
    "configure",
    "get_config",
    "reset_config",
    # Public client
    "EdenClient",
    "get_default_client",
    # Tracing API
    "trace",
    "trace_agent",
    "Span",
    "TraceContext",
    "current_span",
    "current_trace",
    # Auto-instrumentation
    "instrument",
    "uninstrument",
    "autoInstrument",
    "detect_installed_frameworks",
    # Per-filter configuration for the gateway
    "FilterConfig",
    "PIIConfig",
    "redact_payload",
    # Shared token-extraction + model-normalization helpers
    "extract_usage",
    "normalize_model_name",
    # High-level gateway helpers
    "openai_client",
    "chat_completion",
    # Model comparison + recommendation
    "ModelAdvisor",
    "ModelAdvisorError",
    "ModelComparison",
    "ModelSpec",
    "Recommendation",
    "RunnerUp",
    "SwitchProjection",
    "__version__",
]

__version__ = "0.2.18"


# Lazy instrumentation registry — the per-framework modules are
# imported on demand so the SDK works for users that only need a subset.
INSTRUMENTED: set[str] = set()


def instrument(*frameworks: str) -> None:
    """Auto-instrument one or more LLM framework SDKs in place.

    Parameters
    ----------
    *frameworks
        Names of frameworks to instrument. Allowed values:
        ``"openai"``, ``"anthropic"``, ``"langchain"``, ``"llama_index"``,
        ``"crewai"``, ``"autogen"``, ``"mastra"``. If no name is given,
        all currently-importable frameworks are instrumented.
    """
    from eden_sdk import instrumentations  # local import to avoid cycles

    targets = frameworks or tuple(instrumentations.__all__)
    for name in targets:
        if name in INSTRUMENTED:
            continue
        module = getattr(instrumentations, name, None)
        if module is None:
            continue
        try:
            module.install()
        except Exception as exc:  # noqa: BLE001
            # Don't let a missing optional dep break the whole SDK.
            import logging

            logging.getLogger("eden_sdk").debug(
                "instrumentation %s skipped: %s", name, exc
            )
            continue
        INSTRUMENTED.add(name)


def uninstrument(*frameworks: str) -> None:
    """Reverse the patches applied by :func:`instrument`."""
    from eden_sdk import instrumentations

    targets = frameworks or tuple(INSTRUMENTED)
    for name in targets:
        if name not in INSTRUMENTED:
            continue
        module = getattr(instrumentations, name, None)
        if module is not None:
            try:
                module.uninstall()
            except Exception:  # noqa: BLE001
                pass
        INSTRUMENTED.discard(name)



# ── Detection helpers (parity with the TS SDK) ──────────────────────


# Distribution / import names for each supported framework. The
# Python distribution name is the canonical ``import`` target; the
# optional ``alias`` entries are PyPI package names that some users
# install under a different name (e.g. ``pyautogen`` for the ``autogen``
# module). Detecting any one of them counts the framework as installed.
_FRAMEWORK_DETECTORS: dict[str, tuple[str, ...]] = {
    "openai": ("openai",),
    "anthropic": ("anthropic",),
    "langchain": ("langchain", "langchain_core", "langchain_community"),
    "llama_index": ("llama_index", "llama_index.core"),
    "crewai": ("crewai",),
    "autogen": ("autogen", "pyautogen", "autogen_agentchat"),
    "mastra": ("mastra",),  # python wrapper around the TS framework
}


def _detect_one(module_names: tuple[str, ...]) -> bool:
    """Return True if any of ``module_names`` is importable.

    Uses :func:`importlib.util.find_spec` inside a ``try``/``except``
    because ``find_spec`` raises ``ModuleNotFoundError`` (not just
    returning ``None``) when probing dotted-path children of an
    uninstalled parent package. We treat any exception as "not
    installed" — a missing optional dep must never break the SDK.
    """
    import importlib.util

    for name in module_names:
        try:
            if importlib.util.find_spec(name) is not None:
                return True
        except (ImportError, ModuleNotFoundError, ValueError):
            continue
    return False


def detect_installed_frameworks() -> dict[str, bool]:
    """Detect which LLM SDKs are importable in the current process.

    Mirrors the TypeScript SDK's :func:`autoInstrument` /
    :func:`detectInstalledFrameworks` helpers. The Python SDK also
    has framework-specific entry points (:func:`instrument`) which
    apply the monkey-patches; this function only reports which
    frameworks would be wrappable without actually installing them.

    Returns
    -------
    dict[str, bool]
        Mapping of framework key (``"openai"``, ``"anthropic"``,
        ``"langchain"``, ``"llama_index"``, ``"crewai"``,
        ``"autogen"``, ``"mastra"``) to ``True`` if the framework is
        importable, ``False`` otherwise. The dict is always fully
        populated — every supported key is present.
    """
    return {
        key: _detect_one(modules)
        for key, modules in _FRAMEWORK_DETECTORS.items()
    }


# Alias kept for parity with the TypeScript SDK's exported name.
autoInstrument = detect_installed_frameworks
