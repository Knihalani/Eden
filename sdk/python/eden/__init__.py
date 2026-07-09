"""Eden — top-level import.

This module is the canonical user-facing entry point. It re-exports
the public API from :mod:`eden_sdk` so that ``import eden`` works
the way the README and examples show.

We keep the implementation in ``eden_sdk`` so the PyPI distribution
name stays ``eden-sdk`` (which is unique) while the import path is
the short, memorable ``eden`` (which is what users actually type).
"""

from __future__ import annotations

from eden_sdk import (  # noqa: F401,F403
    EdenClient,
    EdenConfig,
    Span,
    TraceContext,
    __version__,
    autoInstrument,
    configure,
    current_span,
    current_trace,
    detect_installed_frameworks,
    get_config,
    get_default_client,
    instrument,
    reset_config,
    trace,
    trace_agent,
    uninstrument,
)
from eden_sdk._tokens import extract_usage, normalize_model_name  # noqa: F401
from eden_sdk.filters import FilterConfig, PIIConfig, redact_payload  # noqa: F401
from eden_sdk.gateway_session import chat_completion, openai_client  # noqa: F401
from eden_sdk.model_advisor import (  # noqa: F401
    ModelAdvisor,
    ModelAdvisorError,
    ModelComparison,
    ModelSpec,
    Recommendation,
    RunnerUp,
    SwitchProjection,
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
    # High-level gateway helpers (mirrors TypeScript SDK)
    "openai_client",
    "chat_completion",
    # Model comparison + recommendation (mirrors TypeScript SDK)
    "ModelAdvisor",
    "ModelAdvisorError",
    "ModelComparison",
    "ModelSpec",
    "Recommendation",
    "RunnerUp",
    "SwitchProjection",
    "__version__",
]
