"""Bounded capture for LLM request/response payloads and span I/O.

Full-fidelity capture of every prompt/completion is the highest-value
signal the SDK ships, but it is also the biggest cost driver: a single
long-context call can carry hundreds of KB of text, and most of that
text is never read again after the trace is a few days old. This
module is the single choke point every provider instrumentation (and
the manual ``set_input``/``set_output`` path) calls through to keep
capture bounded without silently corrupting the record — every
truncation stamps ``eden.truncated`` + ``eden.original_bytes`` onto the
event's ``attributes`` dict so a shortened payload is never
indistinguishable from a short one.

Three capture modes (:data:`CaptureMode`), selected via
``EdenConfig.capture_mode`` / ``EDEN_CAPTURE_MODE``:

  * ``"bounded"`` (default) — head+tail truncate any string field
    longer than ``max_string_bytes``. Errors and slow calls
    (``duration_ms > slow_threshold_ms``, 5s by default — matching
    :mod:`eden_sdk.sampling`'s force-keep threshold) bypass truncation
    entirely: they are rare, and they are exactly the payloads an
    operator needs the full text for.
  * ``"full"`` — never truncate. Highest fidelity, highest ingestion
    cost.
  * ``"metrics_only"`` — never capture content at all; only
    duration/tokens/model/error metadata ships.

Truncation is head+tail, not head-only: prompts put their most
diagnostic content at both edges (system prompt / instructions at the
head, the actual question or a final answer/error at the tail), so a
pure head-truncate silently drops the part a human goes looking for
first.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

if TYPE_CHECKING:
    from eden_sdk.config import EdenConfig

CaptureMode = Literal["bounded", "full", "metrics_only"]

#: Per-string-field cap in bytes. 8 KiB keeps a typical multi-turn
#: prompt intact while bounding the pathological (100KB+ RAG context,
#: base64 image) case that otherwise dominates ingestion cost.
DEFAULT_MAX_STRING_BYTES = 8 * 1024
#: Matches ``eden_sdk.sampling.ClientSampler.slow_threshold_ms`` — a
#: call that was slow enough to force-keep on the sampling side is
#: also slow enough to be worth capturing in full on the truncation
#: side; keeping the two thresholds identical avoids a confusing case
#: where an event is force-kept by the sampler but still truncated.
DEFAULT_SLOW_THRESHOLD_MS = 5_000.0
# Keep more of the head than the tail: the system prompt / task
# framing at the head is usually more load-bearing for debugging than
# an equal number of tail bytes, but the tail still carries the final
# answer/error, so it isn't dropped outright.
_HEAD_KEEP_FRACTION = 0.7

#: Attribute keys stamped by :func:`stamp_capture_attributes`. Kept as
#: module constants so instrumentations and tests reference the same
#: strings rather than re-typing the literal.
TRUNCATED_ATTR = "eden.truncated"
ORIGINAL_BYTES_ATTR = "eden.original_bytes"
CAPTURE_MODE_ATTR = "eden.capture_mode"

_VALID_MODES: tuple[CaptureMode, ...] = ("bounded", "full", "metrics_only")


def _env_capture_mode(default: CaptureMode = "bounded") -> CaptureMode:
    raw = (os.getenv("EDEN_CAPTURE_MODE") or default).strip().lower()
    return raw if raw in _VALID_MODES else default  # type: ignore[return-value]


def _env_max_string_bytes(default: int = DEFAULT_MAX_STRING_BYTES) -> int:
    raw = os.getenv("EDEN_CAPTURE_MAX_STRING_BYTES")
    if not raw:
        return default
    try:
        n = int(raw)
    except ValueError:
        return default
    return n if n > 0 else default


def _env_slow_threshold_ms(default: float = DEFAULT_SLOW_THRESHOLD_MS) -> float:
    raw = os.getenv("EDEN_CAPTURE_SLOW_THRESHOLD_MS")
    if not raw:
        return default
    try:
        n = float(raw)
    except ValueError:
        return default
    return n if n > 0 else default


@dataclass(frozen=True)
class CaptureLimits:
    """Resolved bounded-capture policy for one call/span.

    Immutable and cheap to construct — instrumentations build one per
    call (or once per client via :func:`limits_from_config`) rather
    than threading raw config values through every helper.
    """

    mode: CaptureMode = "bounded"
    max_string_bytes: int = DEFAULT_MAX_STRING_BYTES
    slow_threshold_ms: float = DEFAULT_SLOW_THRESHOLD_MS

    @classmethod
    def from_env(cls) -> CaptureLimits:
        return cls(
            mode=_env_capture_mode(),
            max_string_bytes=_env_max_string_bytes(),
            slow_threshold_ms=_env_slow_threshold_ms(),
        )


def limits_from_config(cfg: EdenConfig | None) -> CaptureLimits:
    """Build :class:`CaptureLimits` from an ``EdenConfig``.

    Falls back to :meth:`CaptureLimits.from_env` when ``cfg`` is
    ``None`` or missing the capture fields (e.g. an older config
    object built before this field existed) so callers never crash on
    a partially-constructed config.
    """
    if cfg is None:
        return CaptureLimits.from_env()
    mode = getattr(cfg, "capture_mode", "bounded")
    if mode not in _VALID_MODES:
        mode = "bounded"
    max_bytes = getattr(cfg, "capture_max_string_bytes", DEFAULT_MAX_STRING_BYTES)
    if not isinstance(max_bytes, int) or max_bytes <= 0:
        max_bytes = DEFAULT_MAX_STRING_BYTES
    return CaptureLimits(
        mode=mode,  # type: ignore[arg-type]
        max_string_bytes=max_bytes,
        slow_threshold_ms=DEFAULT_SLOW_THRESHOLD_MS,
    )


def truncate_text(s: str, max_bytes: int) -> tuple[str, bool, int]:
    """Head+tail truncate ``s`` to (approximately) ``max_bytes`` UTF-8 bytes.

    Returns ``(text, was_truncated, original_bytes)``. A ``max_bytes``
    of 0 or less degrades to "drop everything" rather than raising —
    defensive against a misconfigured (non-positive) cap reaching this
    far.
    """
    raw = s.encode("utf-8")
    n = len(raw)
    if max_bytes <= 0:
        return "", n > 0, n
    if n <= max_bytes:
        return s, False, n
    marker = f"…[eden:truncated {n - max_bytes}b]…"
    marker_bytes = marker.encode("utf-8")
    budget = max(0, max_bytes - len(marker_bytes))
    head_budget = int(budget * _HEAD_KEEP_FRACTION)
    tail_budget = budget - head_budget
    # decode with errors="ignore" so slicing mid-multibyte-codepoint
    # never raises — losing a fractional character at the cut point is
    # an acceptable cost for a hard byte budget.
    head = raw[:head_budget].decode("utf-8", errors="ignore")
    tail = raw[n - tail_budget :].decode("utf-8", errors="ignore") if tail_budget > 0 else ""
    return f"{head}{marker}{tail}", True, n


def _truncate_walk(value: Any, max_bytes: int) -> tuple[Any, bool, int]:
    """Recursively truncate every string inside ``value``.

    Returns ``(new_value, any_truncated, total_original_bytes)``.
    Dicts/lists/tuples are walked and rebuilt; everything else
    (int/float/bool/None and anything the JSON encoder already
    handles) passes through unchanged. Single pass: truncation and the
    original-size accounting happen together so the common (bounded)
    path never walks the payload twice.
    """
    truncated_any = False
    total_bytes = 0

    def walk(v: Any) -> Any:
        nonlocal truncated_any, total_bytes
        if isinstance(v, str):
            new_s, was_trunc, orig = truncate_text(v, max_bytes)
            total_bytes += orig
            if was_trunc:
                truncated_any = True
            return new_s
        if isinstance(v, dict):
            return {k: walk(item) for k, item in v.items()}
        if isinstance(v, list):
            return [walk(item) for item in v]
        if isinstance(v, tuple):
            return tuple(walk(item) for item in v)
        return v

    return walk(value), truncated_any, total_bytes


def _approx_bytes(value: Any) -> int:
    """Cheap, non-recursive size estimate for the "keep full" paths.

    Used when we already know we're not going to truncate (``full``
    mode, or an error/slow bypass) — a JSON-dump-and-measure is far
    cheaper than walking + rebuilding the whole structure just to
    report a size nobody will use to reconstruct the payload.
    """
    try:
        return len(json.dumps(value, default=str).encode("utf-8"))
    except Exception:  # noqa: BLE001 — size reporting must never raise
        return 0


@dataclass(frozen=True)
class CaptureResult:
    """Outcome of applying the capture policy to one value."""

    value: Any
    truncated: bool
    original_bytes: int
    mode: CaptureMode


def capture_value(
    value: Any,
    *,
    has_error: bool = False,
    duration_ms: float = 0.0,
    limits: CaptureLimits | None = None,
) -> CaptureResult:
    """Apply the bounded-capture policy to a single value.

    ``value`` is typically a request/response payload dict, or a
    span's ``eden.input``/``eden.output`` attribute, but any JSON-ish
    structure works. This is the one function every capture surface
    (provider instrumentations, HTTP capture, manual
    ``set_input``/``set_output``) calls through, so truncation
    semantics — and the metadata-stamping contract — stay identical
    everywhere.
    """
    active = limits or CaptureLimits.from_env()
    if value is None:
        return CaptureResult(value=None, truncated=False, original_bytes=0, mode=active.mode)
    if active.mode == "metrics_only":
        return CaptureResult(value=None, truncated=False, original_bytes=0, mode=active.mode)
    keep_full = (
        active.mode == "full"
        or has_error
        or duration_ms > active.slow_threshold_ms
    )
    if keep_full:
        return CaptureResult(
            value=value,
            truncated=False,
            original_bytes=_approx_bytes(value),
            mode=active.mode,
        )
    new_value, truncated, original_bytes = _truncate_walk(value, active.max_string_bytes)
    return CaptureResult(
        value=new_value, truncated=truncated, original_bytes=original_bytes, mode=active.mode
    )


def stamp_capture_attributes(
    attributes: dict[str, Any], *results: CaptureResult
) -> dict[str, Any]:
    """Merge truncation metadata from one or more :class:`CaptureResult`
    into ``attributes`` in place, and return it for chaining.

    Called with the request- and response-side results for one call
    so a truncation of *either* side is visible on the event:
    ``eden.truncated=true`` if any result truncated, and
    ``eden.original_bytes`` summed across all of them.

    Values are stamped as strings — ``attributes`` is wire-typed as
    ``dict[str, str]`` on the server (see
    ``TelemetryEvent.attributes`` in
    ``src/eden/observability/telemetry_collector.py``), so a bool/int
    written here would either be silently coerced or rejected
    depending on the decoder path; stamping strings up front keeps the
    value stable across the whole ingest pipeline.
    """
    if not results:
        return attributes
    truncated_any = any(r.truncated for r in results)
    total_bytes = sum(r.original_bytes for r in results)
    modes = {r.mode for r in results}
    attributes[TRUNCATED_ATTR] = "true" if truncated_any else "false"
    attributes[ORIGINAL_BYTES_ATTR] = str(total_bytes)
    attributes[CAPTURE_MODE_ATTR] = next(iter(modes)) if len(modes) == 1 else "mixed"
    return attributes


def capture_request_response(
    request_payload: Any,
    response_payload: Any,
    *,
    error: str | None,
    duration_ms: float,
    limits: CaptureLimits | None = None,
) -> tuple[Any, Any, dict[str, str]]:
    """Apply the capture policy to a request/response pair in one call.

    The common shape every provider instrumentation's ``_enqueue_*``
    helper needs: truncate (or drop, or pass through) both sides
    consistently and get back the ready-to-merge ``attributes``
    fragment. Returns ``(request_payload, response_payload,
    capture_attrs)`` — callers do ``attrs.update(capture_attrs)`` (or
    pass ``capture_attrs`` straight into a fresh ``attributes`` dict).
    """
    active = limits or CaptureLimits.from_env()
    has_error = error is not None
    req_result = capture_value(
        request_payload, has_error=has_error, duration_ms=duration_ms, limits=active
    )
    resp_result = capture_value(
        response_payload, has_error=has_error, duration_ms=duration_ms, limits=active
    )
    attrs: dict[str, str] = {}
    stamp_capture_attributes(attrs, req_result, resp_result)
    return req_result.value, resp_result.value, attrs
