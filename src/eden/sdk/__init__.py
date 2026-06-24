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

# A2A + Computer Use SDKs are added in the D.12.2 / D.12.3 steps.
try:  # pragma: no cover - graceful when A2A not yet shipped
    from eden.sdk.a2a import (  # type: ignore
        build_a2a_attributes,
        wrap_a2a_invocation,
    )
    _A2A_AVAILABLE = True
except ImportError:
    _A2A_AVAILABLE = False

try:  # pragma: no cover - graceful when Computer Use not yet shipped
    from eden.sdk.computer_use import (  # type: ignore
        ComputerUseAction,
        click,
        drag,
        key,
        record_step,
        scroll,
        type_text,
        wait,
    )
    _CU_AVAILABLE = True
except ImportError:
    _CU_AVAILABLE = False

if _A2A_AVAILABLE and _CU_AVAILABLE:
    __all__ = [
        "ComputerUseAction",
        "build_a2a_attributes",
        "build_mcp_attributes",
        "capture_byte_count",
        "click",
        "drag",
        "key",
        "mask_pii",
        "prompt",
        "record_step",
        "scroll",
        "StreamingTokenCapture",
        "TokenStreamStats",
        "type_text",
        "wait",
        "wrap_a2a_invocation",
        "wrap_mcp_call",
    ]
elif _A2A_AVAILABLE:
    __all__ = [
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
elif _CU_AVAILABLE:
    __all__ = [
        "ComputerUseAction",
        "build_mcp_attributes",
        "capture_byte_count",
        "click",
        "drag",
        "key",
        "mask_pii",
        "prompt",
        "record_step",
        "scroll",
        "StreamingTokenCapture",
        "TokenStreamStats",
        "type_text",
        "wait",
        "wrap_mcp_call",
    ]
else:
    __all__ = [
        "build_mcp_attributes",
        "capture_byte_count",
        "mask_pii",
        "prompt",
        "StreamingTokenCapture",
        "TokenStreamStats",
        "wrap_mcp_call",
    ]