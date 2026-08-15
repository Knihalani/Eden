"""Public SDK re-exports."""

# ruff: noqa: I001  (intentional import order — always-available
# surface first, then optional features in chronological ship order)
from __future__ import annotations

# Always-available surface
from eden.sdk.mcp import build_mcp_attributes, wrap_mcp_call
from eden.sdk.prompt_decorator import prompt
from eden.sdk.streaming import (
    StreamingTokenCapture,
    TokenStreamStats,
    capture_byte_count,
    mask_pii,
)

# Optional surfaces (each gated by a try/except so the SDK
# remains importable when an individual feature is missing).
#
# Ponytail: a 2x2x2x2 feature matrix was building up
# (A2A / Computer Use / Voice / Fine-Tune) and the
# cascading if/elif pattern became unreadable. The new
# approach collects the per-feature exports into a list
# and adds them to __all__ dynamically.

_OPTIONAL_FEATURES: list[tuple[bool, list[str]]] = []

try:  # pragma: no cover - graceful when A2A not yet shipped
    from eden.sdk.a2a import (
        build_a2a_attributes,
        wrap_a2a_invocation,
    )
    _OPTIONAL_FEATURES.append((True, [
        "build_a2a_attributes",
        "wrap_a2a_invocation",
    ]))
except ImportError:
    _OPTIONAL_FEATURES.append((False, [
        "build_a2a_attributes",
        "wrap_a2a_invocation",
    ]))

try:  # pragma: no cover - graceful when Computer Use not yet shipped
    from eden.sdk.computer_use import (
        ComputerUseAction,
        click,
        drag,
        key,
        record_step,
        scroll,
        type_text,
        wait,
    )
    _OPTIONAL_FEATURES.append((True, [
        "ComputerUseAction",
        "click",
        "drag",
        "key",
        "record_step",
        "scroll",
        "type_text",
        "wait",
    ]))
except ImportError:
    _OPTIONAL_FEATURES.append((False, [
        "ComputerUseAction",
        "click",
        "drag",
        "key",
        "record_step",
        "scroll",
        "type_text",
        "wait",
    ]))

try:  # pragma: no cover - graceful when Fine-Tune not yet shipped
    from eden.sdk.fine_tune import (
        build_fine_tune_attributes,
        parse_openai_webhook_payload,
        register_run as register_fine_tune_run,
    )
    _OPTIONAL_FEATURES.append((True, [
        "build_fine_tune_attributes",
        "parse_openai_webhook_payload",
        "register_fine_tune_run",
    ]))
except ImportError:
    _OPTIONAL_FEATURES.append((False, [
        "build_fine_tune_attributes",
        "parse_openai_webhook_payload",
        "register_fine_tune_run",
    ]))

try:  # pragma: no cover - graceful when Provider Routing not yet shipped
    from eden.sdk.provider_routing import (
        build_provider_routing_attributes,
        record_attempt as record_provider_routing_attempt,
        retry_with_fallback,
    )
    _OPTIONAL_FEATURES.append((True, [
        "build_provider_routing_attributes",
        "record_provider_routing_attempt",
        "retry_with_fallback",
    ]))
except ImportError:
    _OPTIONAL_FEATURES.append((False, [
        "build_provider_routing_attributes",
        "record_provider_routing_attempt",
        "retry_with_fallback",
    ]))

try:  # pragma: no cover - graceful when Voice not yet shipped
    from eden.sdk.voice import (
        build_voice_attributes,
        detect_spike,
        mark_barge_in,
        wrap_voice_session,
    )
    _OPTIONAL_FEATURES.append((True, [
        "build_voice_attributes",
        "detect_spike",
        "mark_barge_in",
        "wrap_voice_session",
    ]))
except ImportError:
    _OPTIONAL_FEATURES.append((False, [
        "build_voice_attributes",
        "detect_spike",
        "mark_barge_in",
        "wrap_voice_session",
    ]))

# Build the public __all__ dynamically. The always-available
# names are always present; the optional ones are appended
# when their module imported successfully.
_BASE_EXPORTS: list[str] = [
    "StreamingTokenCapture",
    "TokenStreamStats",
    "build_mcp_attributes",
    "capture_byte_count",
    "mask_pii",
    "prompt",
    "wrap_mcp_call",
]

__all__ = list(_BASE_EXPORTS)
for available, names in _OPTIONAL_FEATURES:
    if available:
        __all__ = [*__all__, *names]
