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

from typing import Any

from eden_sdk._tokens import extract_usage, normalize_model_name
from eden_sdk.client import EdenClient, get_default_client
from eden_sdk.config import EdenConfig, configure, get_config, reset_config
from eden_sdk.filters import FilterConfig, PIIConfig, redact_payload
from eden_sdk.gateway_session import chat_completion, openai_client
from eden_sdk.stumbles import record_stumble
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
from eden_sdk.live import (
    LiveSpanPublisher,
    emit_span_live,
    get_live_publisher,
    live_mode_enabled,
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
    # N11 live streaming
    "LiveSpanPublisher",
    "emit_span_live",
    "get_live_publisher",
    "live_mode_enabled",
    # Auto-instrumentation
    "instrument",
    "uninstrument",
    "autoInstrument",
    "detect_installed_frameworks",
    # Tier-2 universal fallback
    "install_http_capture",
    "uninstall_http_capture",
    # Logging + OTel bridge
    "install_logging",
    "uninstall_logging",
    "configure_otel_exporter",
    # Doctor
    "run_doctor",
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
    # Self-reported stumbles (F28)
    "record_stumble",
    # Model comparison + recommendation
    "ModelAdvisor",
    "ModelAdvisorError",
    "ModelComparison",
    "ModelSpec",
    "Recommendation",
    "RunnerUp",
    "SwitchProjection",
    "__version__",
    # Agent sessions (F23)
    "begin",
    "complete_session",
    "current_session",
    "identify",
    "AgentSession",
]

__version__ = "0.3.1"


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
        ``"crewai"``, ``"autogen"``, ``"mastra"``, ``"pydantic_ai"``.
        Pass ``"http_capture"`` to enable universal httpx patching.
        If no name is given, all currently-importable frameworks are instrumented.
    """
    from eden_sdk import instrumentations  # local import to avoid cycles

    targets = frameworks or tuple(instrumentations.__all__)
    for name in targets:
        if name == "http_capture":
            install_http_capture()
            continue
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
        if name == "http_capture":
            uninstall_http_capture()
            continue
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


# Distribution / import names for each supported framework. Kept local
# to the SDK package so ``import eden_sdk`` does not pull the monorepo
# ``eden.integrations`` tree (which would circular-import the ``eden``
# shim that re-exports this module). Keep in sync with
# ``PYTHON_SDK_MODULES`` in ``src/eden/integrations/framework_registry.py``.
_FRAMEWORK_DETECTORS: dict[str, tuple[str, ...]] = {
    "langchain": ("langchain", "langchain_core", "langchain_community"),
    "crewai": ("crewai",),
    "autogen": ("autogen", "pyautogen", "autogen_agentchat"),
    "llama_index": ("llama_index", "llama_index.core"),
    "openai": ("openai",),
    "anthropic": ("anthropic",),
    "mastra": ("mastra",),
    "pydantic_ai": ("pydantic_ai", "pydantic_ai.agent"),
    "bedrock": ("boto3", "botocore"),
    "gemini": ("google.generativeai", "google.genai"),
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


def install_http_capture() -> None:
    """Enable universal LLM HTTP capture via httpx patching."""
    from eden_sdk.http_capture import install

    install()
    INSTRUMENTED.add("http_capture")


def uninstall_http_capture() -> None:
    """Disable universal LLM HTTP capture."""
    from eden_sdk.http_capture import uninstall

    uninstall()
    INSTRUMENTED.discard("http_capture")


def install_logging(level: int | str = "INFO") -> None:
    """Forward stdlib logging records to Eden as ``event_type: log`` events."""
    from eden_sdk.logging_forwarder import install_logging as _install

    _install(level=level)


def uninstall_logging() -> None:
    """Remove the Eden logging handler."""
    from eden_sdk.logging_forwarder import uninstall_logging as _uninstall

    _uninstall()


def configure_otel_exporter(**kwargs: Any) -> None:
    """Configure an OTLP HTTP exporter targeting Eden ingest."""
    from eden_sdk.otel import configure_exporter

    configure_exporter(**kwargs)


def run_doctor(**kwargs: Any) -> Any:
    """Validate config, connectivity, and emit a test event."""
    from eden_sdk.doctor import run_doctor as _run

    return _run(**kwargs)


def begin(**kwargs: Any) -> Any:
    from eden_sdk.session import begin as _begin

    return _begin(**kwargs)


def complete_session(session: Any, **kwargs: Any) -> None:
    from eden_sdk.session import complete_session as _complete

    return _complete(session, **kwargs)


def current_session() -> Any:
    from eden_sdk.session import current_session as _current

    return _current()


def identify(user_id: str, **kwargs: Any) -> None:
    from eden_sdk.session import identify as _identify

    return _identify(user_id, **kwargs)


def __getattr__(name: str) -> Any:
    if name == "AgentSession":
        from eden_sdk.session import AgentSession

        return AgentSession
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
