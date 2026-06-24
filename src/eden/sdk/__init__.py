"""Public SDK re-exports."""

from __future__ import annotations

from eden.sdk.mcp import build_mcp_attributes, wrap_mcp_call
from eden.sdk.prompt_decorator import prompt
from eden.sdk.streaming import (
    StreamingTokenCapture,
    TokenStreamStats,
    capture_byte_count,
    mask_pii,
)

# A2A SDK is added in the D.12.2 step.
try:  # pragma: no cover - graceful when A2A not yet shipped
    from eden.sdk.a2a import (  # type: ignore
        build_a2a_attributes,
        wrap_a2a_invocation,
    )
    __all__ = [  # noqa: F811
        "build_a2a_attributes",
        "build_mcp_attributes",
        "capture_byte_count",
        "mask_pii",
        "prompt",
        "StreamingTokenCapture",
        "TokenStreamStats",
        "wrap_a2a_invocation",
        "wrap_mcp_call",
    ]
except ImportError:
    __all__ = [
        "build_mcp_attributes",
        "capture_byte_count",
        "mask_pii",
        "prompt",
        "StreamingTokenCapture",
        "TokenStreamStats",
        "wrap_mcp_call",
    ]