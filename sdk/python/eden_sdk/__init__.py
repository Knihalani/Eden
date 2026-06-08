"""Eden Python Runtime SDK.

A lightweight, fire-and-forget observability SDK for LLM applications.

Highlights
----------
- ``@trace_agent`` decorator — trace any Python function (sync or async).
- ``with eden.trace(...)`` — manual span context manager.
- One-line auto-instrumentation for OpenAI, Anthropic, LangChain, LlamaIndex,
  CrewAI, AutoGen, Mastra.
- Async, batched, non-blocking HTTP sender (target p99 overhead ≤ 5 ms).
- Zero required dependencies beyond ``httpx`` and ``pydantic``.

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

from eden_sdk.client import EdenClient, get_default_client
from eden_sdk.config import EdenConfig, configure, get_config, reset_config
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
]

__version__ = "0.1.0"


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
