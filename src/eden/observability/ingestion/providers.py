"""Provider decoders: OpenAI, Anthropic, Bedrock, Gemini.

Each decoder is a ``SourceDecoder``. Wire shapes are liberal — for
example, OpenAI accepts both a full ``ChatCompletion`` response and a
minimal ``{"model": "...", "usage": {...}}`` usage event. Decoders
always normalize to the same internal ``TelemetryEvent`` shape via
``normalize_to_telemetry_event``.
"""

from __future__ import annotations

import asyncio
import contextlib
import gzip
import io
import logging
from typing import Any

from eden.observability.ingestion.attribution import Attribution
from eden.observability.ingestion.errors import SchemaInvalidError
from eden.observability.ingestion.json_body import loads_body
from eden.observability.ingestion.normalizer import normalize_to_telemetry_event
from eden.observability.telemetry_collector import TelemetryEvent

logger = logging.getLogger(__name__)

# Bodies larger than this decompress off the event loop (sync gzip is CPU-bound).
_GZIP_OFFLOAD_BYTES = 64 * 1024
# Cap decompressed size (matches settings.ingestion_max_body_bytes default)
# and expansion ratio to reject gzip bombs before full inflate.
_MAX_GUNZIP_BYTES = 5 * 1024 * 1024
_MAX_GUNZIP_RATIO = 100
_GUNZIP_CHUNK = 64 * 1024


def _gunzip_limited(body: bytes) -> bytes:
    """Gunzip with absolute + ratio caps on decompressed size."""
    limit = min(
        _MAX_GUNZIP_BYTES,
        max(len(body) * _MAX_GUNZIP_RATIO, _GUNZIP_CHUNK),
    )
    chunks: list[bytes] = []
    total = 0
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(body), mode="rb") as gz:
            while True:
                chunk = gz.read(_GUNZIP_CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                if total > limit:
                    raise ValueError(
                        f"gzip decompressed size exceeds {limit} bytes"
                    )
                chunks.append(chunk)
    except OSError as exc:
        raise ValueError(f"invalid gzip body: {exc}") from exc
    return b"".join(chunks)


def maybe_gunzip_body(
    body: bytes,
    content_encoding: str | None = None,
) -> bytes:
    """Decode ``Content-Encoding: gzip`` request bodies for ingest.

    SDKs may POST gzip-compressed JSON with ``Content-Encoding: gzip``.
    Identity / missing encodings pass through unchanged. Invalid gzip
    or oversize inflate raises ``ValueError`` so the route can return 400.
    """
    if not body:
        return body
    encoding = (content_encoding or "").lower().strip()
    if not encoding or encoding == "identity":
        # Also accept raw gzip magic when the header was stripped by a proxy.
        if len(body) >= 2 and body[0] == 0x1F and body[1] == 0x8B:
            try:
                return _gunzip_limited(body)
            except ValueError as exc:
                # Size-cap violations always reject; corrupt gzip without an
                # explicit Content-Encoding header passes through unchanged.
                if "exceeds" in str(exc):
                    raise
                return body
        return body
    if "gzip" not in encoding.split(","):
        return body
    return _gunzip_limited(body)


def _needs_gunzip(body: bytes, content_encoding: str | None) -> bool:
    if not body:
        return False
    encoding = (content_encoding or "").lower().strip()
    if encoding and encoding != "identity":
        return "gzip" in encoding.split(",")
    return len(body) >= 2 and body[0] == 0x1F and body[1] == 0x8B


async def maybe_gunzip_body_async(
    body: bytes,
    content_encoding: str | None = None,
) -> bytes:
    """Async wrapper: offload large gzip payloads via ``asyncio.to_thread``."""
    if not _needs_gunzip(body, content_encoding):
        return body
    if len(body) < _GZIP_OFFLOAD_BYTES:
        return maybe_gunzip_body(body, content_encoding)
    return await asyncio.to_thread(maybe_gunzip_body, body, content_encoding)


# ── OpenAI ───────────────────────────────────────────────────────────


def _openai_extract_usage(usage: dict[str, Any]) -> dict[str, float]:
    metrics: dict[str, float] = {}
    for src, dst in (
        ("prompt_tokens", "input_tokens"),
        ("completion_tokens", "output_tokens"),
        ("total_tokens", "total_tokens"),
    ):
        if src in usage:
            with contextlib.suppress(TypeError, ValueError):
                metrics[dst] = float(usage[src])
    return metrics


def _openai_to_raw(item: dict[str, Any]) -> dict[str, Any]:
    """Map an OpenAI response/usage dict to the intermediate shape.

    Captures the full request/response (Phase 7.2) plus provider
    extensions used in the portal's transcript view:
    - request_body: original request messages, tools, temperature
    - response_body: full ChatCompletion response
    - reasoning: o1 / o3 reasoning tokens
    - tool_calls_full: structured tool invocations
    - logprobs: top_logprobs if requested
    - citations: search-preview response citations
    - system_fingerprint, service_tier, finish_reason, stop_sequence
    - cache_hit + prompt_cache_savings_usd: cached input token analytics
    """
    response_id = str(item.get("id") or "")
    model = str(item.get("model") or "")
    usage = dict(item.get("usage") or {})
    metrics = _openai_extract_usage(usage)

    # Choices: extract first message content for backward-compat with
    # downstream detectors that read payload["openai"]["first_message_content"].
    choices = item.get("choices") or []
    first_content: str | None = None
    first_role: str | None = None
    finish_reason: str | None = None
    if isinstance(choices, list) and choices:
        first = choices[0] or {}
        msg = first.get("message") or {}
        first_content = msg.get("content") if isinstance(msg, dict) else None
        first_role = msg.get("role") if isinstance(msg, dict) else None
        finish_reason = first.get("finish_reason")

    # ── Tool calls: extract from every choice, not just the first ──
    tool_calls_full: list[dict[str, Any]] = []
    if isinstance(choices, list):
        for choice in choices:
            msg = (choice or {}).get("message") or {}
            if not isinstance(msg, dict):
                continue
            for tc in (msg.get("tool_calls") or []):
                if not isinstance(tc, dict):
                    continue
                tool_calls_full.append({
                    "id": tc.get("id"),
                    "type": tc.get("type", "function"),
                    "function": {
                        "name": (tc.get("function") or {}).get("name"),
                        "arguments": (tc.get("function") or {}).get("arguments"),
                    },
                })

    # ── Reasoning: o1/o3 reasoning_tokens from usage ──
    reasoning: dict[str, Any] = {}
    completion_details = usage.get("completion_tokens_details") or {}
    prompt_details = usage.get("prompt_tokens_details") or {}
    if isinstance(completion_details, dict):
        o1_tokens = completion_details.get("reasoning_tokens")
        if o1_tokens is not None:
            with contextlib.suppress(TypeError, ValueError):
                reasoning["o1_tokens"] = int(o1_tokens)
    if isinstance(prompt_details, dict):
        cached = prompt_details.get("cached_tokens")
        if cached is not None:
            try:
                reasoning["cached_input_tokens"] = int(cached)
                metrics["cache_read_tokens"] = float(cached)
            except (TypeError, ValueError):
                pass

    # ── Logprobs: top_logprobs blob verbatim ──
    logprobs_data: dict[str, Any] | None = None
    raw_logprobs = (choices[0] if choices else {}).get("logprobs") if choices else None
    if raw_logprobs and isinstance(raw_logprobs, dict):
        logprobs_data = raw_logprobs

    # ── Citations: o-series search-preview (o3, o4-mini) ──
    citations: list[dict[str, Any]] = []
    annotation_citations = (choices[0] if choices else {}).get("message", {}).get("citations") if choices else []
    if isinstance(annotation_citations, list):
        citations = [c for c in annotation_citations if isinstance(c, dict)]
    if not citations:
        # Older annotation format: message.annotations[].url_citation
        annotations = (choices[0] if choices else {}).get("message", {}).get("annotations") if choices else None
        if isinstance(annotations, list):
            for ann in annotations:
                if isinstance(ann, dict) and ann.get("type") == "url_citation":
                    citations.append({
                        "url": ann.get("url"),
                        "title": ann.get("title"),
                        "start_index": ann.get("start_index"),
                        "end_index": ann.get("end_index"),
                    })

    # ── Cache hit detection ──
    cache_hit = bool(reasoning.get("cached_input_tokens", 0) and reasoning["cached_input_tokens"] > 0)
    prompt_cache_savings_usd: float | None = None
    # The cost engine fills this in later. We just record that cache hit.

    # Cost: leave to upstream cost service; we don't hardcode pricing
    # here (the cost engine is responsible).
    payload: dict[str, Any] = {
        "openai": {
            "response_id": response_id or None,
            "model": model or None,
            "object": item.get("object"),
            "created": item.get("created"),
            "system_fingerprint": item.get("system_fingerprint"),
            "service_tier": item.get("service_tier"),
            "choices_count": (
                len(choices) if isinstance(choices, list) else None
            ),
            "first_message_role": first_role,
            "first_message_content": first_content,
            "finish_reason": finish_reason,
        }
    }

    attributes: dict[str, str] = {}
    if model:
        attributes["model"] = model
        attributes["openai.model"] = model
    if response_id:
        attributes["openai.response_id"] = response_id
    if finish_reason:
        attributes["openai.finish_reason"] = str(finish_reason)
    if (sf := item.get("system_fingerprint")):
        attributes["openai.system_fingerprint"] = str(sf)

    tags = ["openai"]
    if model:
        tags.append(f"model:{model}")

    # The full response body is captured as-is. The portal transcript
    # view renders it without re-parsing.
    response_body: dict[str, Any] | None = dict(item) if item else None
    if response_body is not None:
        # Strip any top-level keys we already expose as dedicated fields
        # to avoid duplicating massive JSON in the request_body.
        # Keep the body in full — the transcript needs every byte.
        pass

    # The request body (when the SDK or batch script sends the original
    # request alongside the response) is passed in via the
    # `request_payload` key. Otherwise we leave it None and the
    # portal can fall back to a synthetic reconstruction.
    request_body: dict[str, Any] | None = item.get("request_payload") or item.get("request")

    # Prefer SDK-supplied correlation ids (eden.trace / instrumentations).
    # Falling back to OpenAI ``user`` or response ``id`` used to orphan LLM
    # spans onto separate traces from the enclosing agent.run.
    sdk_trace_id = item.get("trace_id") or item.get("user") or ""
    return {
        "event_id": response_id or f"openai_{model}_{usage.get('total_tokens', '')}",
        "trace_id": str(sdk_trace_id or response_id or ""),
        "agent_id": item.get("agent_id"),
        "name": model or None,
        "model": model or None,
        "model_name": model or None,
        "event_type": "openai.chat_completion",
        "timestamp": (
            item.get("created")
            and (
                # OpenAI's `created` is a unix epoch float (seconds).
                # _normalize_timestamp handles int/float epoch correctly.
                item.get("created")
            )
        ),
        "realm": "production",
        "payload": payload,
        "metrics": metrics,
        "attributes": attributes,
        "tags": tags,
        "outcome": (
            "failure"
            if (first := (choices[0] if choices else None))
            and str(first.get("finish_reason") or "") == "stop"
            and (msg := first.get("message"))
            and isinstance(msg, dict)
            and msg.get("content") is None
            else "success"
        ) if choices else None,
        # Phase 7.2 — full capture fields.
        "request_body": request_body,
        "response_body": response_body,
        "reasoning": reasoning or None,
        "tool_calls_full": tool_calls_full,
        "logprobs": logprobs_data,
        "citations": citations,
        "finish_reason": str(finish_reason) if finish_reason else None,
        "stop_sequence": item.get("stop_sequence"),
        "system_fingerprint": item.get("system_fingerprint"),
        "cache_hit": cache_hit,
        "prompt_cache_savings_usd": prompt_cache_savings_usd,
        "model_version": item.get("service_tier") or None,  # OpenAI surfaces variant here
        "service_tier": item.get("service_tier"),
    }


class OpenAIDecoder:
    source_format = "openai"

    def detect(self, body: bytes, content_type: str | None) -> bool:
        try:
            parsed = loads_body(body)
        except (ValueError, UnicodeDecodeError):
            return False
        if not isinstance(parsed, dict):
            return False
        # OpenAI usage events or full chat-completion responses.
        if "usage" in parsed and (
            "model" in parsed or "object" in parsed
        ):
            return True
        return bool("choices" in parsed and isinstance(parsed["choices"], list))

    async def decode(
        self, body: bytes, attribution: Attribution
    ) -> list[TelemetryEvent]:
        try:
            payload = loads_body(body)
        except (ValueError, UnicodeDecodeError) as exc:
            raise SchemaInvalidError(
                f"OpenAI body is not valid JSON: {exc}",
                problems=[f"json_decode_error: {exc}"],
            ) from exc
        items = payload if isinstance(payload, list) else [payload]
        if not items:
            raise SchemaInvalidError(
                "OpenAI body parsed but contained no items",
                problems=["empty"],
            )
        events: list[TelemetryEvent] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            raw = _openai_to_raw(item)
            event = await normalize_to_telemetry_event(
                raw, attribution.with_source_format(self.source_format)
            )
            events.append(event)
        return events


# ── Anthropic ────────────────────────────────────────────────────────


def _anthropic_to_raw(item: dict[str, Any]) -> dict[str, Any]:
    """Map an Anthropic Messages response (or usage event) to the
    intermediate shape.

    Phase 7.2: captures the full content array (every block type),
    extended-thinking blocks, prompt cache analytics, and tool calls.
    """
    response_id = str(item.get("id") or "")
    model = str(item.get("model") or "")
    usage = dict(item.get("usage") or {})

    metrics: dict[str, float] = {}
    for src, dst in (
        ("input_tokens", "input_tokens"),
        ("output_tokens", "output_tokens"),
        ("cache_creation_input_tokens", "cache_creation_tokens"),
        ("cache_read_input_tokens", "cache_read_tokens"),
    ):
        if src in usage:
            with contextlib.suppress(TypeError, ValueError):
                metrics[dst] = float(usage[src])
    if (
        "input_tokens" in metrics
        and "output_tokens" in metrics
    ):
        metrics["total_tokens"] = (
            metrics["input_tokens"] + metrics["output_tokens"]
        )

    # Content blocks — extract text for backward-compat with detectors
    # that read payload["anthropic"]["content_text"].
    content = item.get("content")
    text_chunks: list[str] = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text_chunks.append(str(block.get("text", "")))
            elif isinstance(block, str):
                text_chunks.append(block)

    stop_reason = item.get("stop_reason")

    # ── Phase 7.2 — full content capture ──
    # Walk every content block, classify by type, and route to the
    # appropriate capture field.
    thinking_blocks: list[dict[str, Any]] = []
    redacted_thinking_blocks: list[dict[str, Any]] = []
    tool_calls_full: list[dict[str, Any]] = []
    tool_results: list[dict[str, Any]] = []
    image_blocks: list[dict[str, Any]] = []
    document_blocks: list[dict[str, Any]] = []
    if isinstance(content, list):
        for block in content:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "thinking":
                thinking_blocks.append({
                    "thinking": block.get("thinking"),
                    "signature": block.get("signature"),
                })
            elif btype == "redacted_thinking":
                redacted_thinking_blocks.append({
                    "data": block.get("data"),
                })
            elif btype == "tool_use":
                tool_calls_full.append({
                    "id": block.get("id"),
                    "type": "tool_use",
                    "name": block.get("name"),
                    "input": block.get("input"),
                })
            elif btype == "tool_result":
                tool_results.append({
                    "tool_use_id": block.get("tool_use_id"),
                    "content": block.get("content"),
                    "is_error": block.get("is_error", False),
                })
            elif btype == "image":
                image_blocks.append({
                    "source_type": (block.get("source") or {}).get("type"),
                    "media_type": (block.get("source") or {}).get("media_type"),
                    "data_b64": (block.get("source") or {}).get("data"),  # PII mask will redact
                })
            elif btype == "document":
                document_blocks.append({
                    "source_type": (block.get("source") or {}).get("type"),
                    "media_type": (block.get("source") or {}).get("media_type"),
                    "title": block.get("title"),
                })

    reasoning: dict[str, Any] = {}
    if thinking_blocks:
        reasoning["thinking"] = thinking_blocks
    if redacted_thinking_blocks:
        reasoning["redacted"] = redacted_thinking_blocks

    # Cache analytics — Anthropic charges 10% of input price for
    # cache_read tokens. The cost engine fills in the actual dollar
    # figure, but we record that a cache hit happened.
    cache_read = metrics.get("cache_read_tokens", 0)
    cache_hit = bool(cache_read and cache_read > 0)

    # Full response body — every content block, every field. The
    # transcript view renders straight from this.
    response_body: dict[str, Any] | None = None
    if response_id or content is not None:
        response_body = {
            "id": response_id or None,
            "type": item.get("type"),
            "role": item.get("role"),
            "model": model or None,
            "content": content,
            "stop_reason": stop_reason,
            "stop_sequence": item.get("stop_sequence"),
            "usage": usage,
        }

    # System block + messages: only present if the SDK forwards the
    # original request via `request_payload`. We accept it as-is.
    request_body: dict[str, Any] | None = item.get("request_payload") or item.get("request")
    if isinstance(request_body, dict):
        # Add media descriptors if any were on the request side.
        pass

    payload: dict[str, Any] = {
        "anthropic": {
            "response_id": response_id or None,
            "model": model or None,
            "type": item.get("type"),
            "role": item.get("role"),
            "stop_reason": stop_reason,
            "stop_sequence": item.get("stop_sequence"),
            "content_text": "\n".join(text_chunks) if text_chunks else None,
            "content_block_count": len(content) if isinstance(content, list) else 0,
        }
    }

    attributes: dict[str, str] = {}
    if model:
        attributes["model"] = model
        attributes["anthropic.model"] = model
    if response_id:
        attributes["anthropic.response_id"] = response_id
    if stop_reason:
        attributes["anthropic.stop_reason"] = str(stop_reason)

    tags = ["anthropic"]
    if model:
        tags.append(f"model:{model}")

    outcome = None
    if stop_reason == "end_turn":
        outcome = "success"
    elif stop_reason in ("max_tokens", "model_context_window_exceeded"):
        outcome = "partial"
    elif stop_reason in ("stop_sequence", "tool_use"):
        outcome = "success"
    elif item.get("error"):
        outcome = "failure"

    # Build the full images list (multimodal: any image blocks become
    # entries in the images JSONB column; the media store URI is set
    # by the normalizer when base64 data is detected).
    images_full: list[dict[str, Any]] = []
    for img in image_blocks:
        if img.get("data_b64"):
            images_full.append({
                "role": "user",
                "content_type": img.get("media_type"),
                "data_b64": img["data_b64"],
                "source": "anthropic_input",
            })

    sdk_trace_id = item.get("trace_id") or ""
    return {
        "event_id": response_id or f"anthropic_{model}",
        "trace_id": str(sdk_trace_id or response_id or ""),
        "agent_id": item.get("agent_id"),
        "name": model or None,
        "model": model or None,
        "model_name": model or None,
        "event_type": "anthropic.message",
        "timestamp": None,  # Anthropic responses don't carry created_at
        "realm": "production",
        "payload": payload,
        "metrics": metrics,
        "attributes": attributes,
        "tags": tags,
        "outcome": outcome,
        # Phase 7.2 — full capture fields.
        "request_body": request_body,
        "response_body": response_body,
        "reasoning": reasoning or None,
        "tool_calls_full": tool_calls_full,
        "tool_results": tool_results,
        "images": images_full,
        "logprobs": None,  # Anthropic doesn't expose top_logprobs
        "citations": [],  # Anthropic has no equivalent to OpenAI citations
        "finish_reason": str(stop_reason) if stop_reason else None,
        "stop_sequence": item.get("stop_sequence"),
        "system_fingerprint": None,  # Anthropic has no equivalent
        "cache_hit": cache_hit,
        "prompt_cache_savings_usd": None,
        "model_version": model or None,
        "service_tier": None,
    }


class AnthropicDecoder:
    source_format = "anthropic"

    def detect(self, body: bytes, content_type: str | None) -> bool:
        try:
            parsed = loads_body(body)
        except (ValueError, UnicodeDecodeError):
            return False
        if not isinstance(parsed, dict):
            return False
        if parsed.get("type") == "message" and "content" in parsed:
            return True
        return bool("usage" in parsed and ("input_tokens" in parsed["usage"] or "output_tokens" in parsed["usage"]))

    async def decode(
        self, body: bytes, attribution: Attribution
    ) -> list[TelemetryEvent]:
        try:
            payload = loads_body(body)
        except (ValueError, UnicodeDecodeError) as exc:
            raise SchemaInvalidError(
                f"Anthropic body is not valid JSON: {exc}",
                problems=[f"json_decode_error: {exc}"],
            ) from exc
        items = payload if isinstance(payload, list) else [payload]
        if not items:
            raise SchemaInvalidError(
                "Anthropic body parsed but contained no items",
                problems=["empty"],
            )
        events: list[TelemetryEvent] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            raw = _anthropic_to_raw(item)
            event = await normalize_to_telemetry_event(
                raw, attribution.with_source_format(self.source_format)
            )
            events.append(event)
        return events


# ── Bedrock ──────────────────────────────────────────────────────────


def _bedrock_to_raw(item: dict[str, Any]) -> dict[str, Any]:
    """Map a Bedrock InvokeModel request/response to the intermediate
    shape. Bedrock's API surface is heterogeneous (Converse, InvokeModel,
    InvokeModelWithResponseStream) — we accept any of them.

    Phase 7.2: passes through the full request/response bodies and
    surfaces any tool calls present in the Converse output.
    """
    model_id = str(
        item.get("modelId")
        or item.get("model_id")
        or ""
    )
    # usage: Converse returns usage.inputTokens/outputTokens/totalTokens
    usage = dict(item.get("usage") or {})
    metrics: dict[str, float] = {}
    for src, dst in (
        ("inputTokens", "input_tokens"),
        ("outputTokens", "output_tokens"),
        ("input_tokens", "input_tokens"),
        ("output_tokens", "output_tokens"),
        ("totalTokens", "total_tokens"),
        ("total_tokens", "total_tokens"),
        # Bedrock-specific cache token analytics (Claude on Bedrock
        # surfaces these via Converse API).
        ("cacheReadInputTokens", "cache_read_tokens"),
        ("cacheWriteInputTokens", "cache_creation_tokens"),
        ("cacheReadInputTokenCount", "cache_read_tokens"),
    ):
        if src in usage:
            with contextlib.suppress(TypeError, ValueError):
                metrics[dst] = float(usage[src])

    # Pull request and response bodies verbatim. Bedrock's wire shape
    # varies; the most common keys are `input` (Converse), `body`
    # (InvokeModel), and `output` / `response`.
    request_body = item.get("input") or item.get("body") or item.get("request_payload")
    response_body = item.get("output") or item.get("response") or item.get("response_body")

    # Tool calls: Converse surfaces them as `output.message.content[]`
    # with `toolUse` blocks. Walk and extract.
    tool_calls_full: list[dict[str, Any]] = []
    if isinstance(response_body, dict):
        message = response_body.get("message") or {}
        content = message.get("content") or []
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and "toolUse" in block:
                    tu = block["toolUse"]
                    if isinstance(tu, dict):
                        tool_calls_full.append({
                            "id": tu.get("toolUseId"),
                            "name": tu.get("name"),
                            "input": tu.get("input"),
                        })

    payload: dict[str, Any] = {
        "bedrock": {
            "model_id": model_id or None,
            "request_body": request_body,
            "response_body": response_body,
            "request_id": item.get("requestId") or item.get("request_id"),
            "amazon_request_id": item.get("AmazonRequestId"),
            "invocation_metrics": item.get("invocationMetrics")
            or item.get("metrics"),
        }
    }

    attributes: dict[str, str] = {}
    if model_id:
        attributes["bedrock.model_id"] = model_id
    if req_id := (item.get("requestId") or item.get("request_id")):
        attributes["bedrock.request_id"] = str(req_id)

    tags = ["bedrock"]
    if model_id:
        tags.append(f"model:{model_id}")

    # Outcome: check for stopReason or error field
    stop_reason = (
        item.get("stopReason")
        or (item.get("output") or {}).get("stopReason")
        or (response_body or {}).get("stopReason")
        if isinstance(response_body, dict) else None
    )
    error = item.get("error")
    if error:
        outcome = "failure"
    elif stop_reason in ("end_turn", "stop", "tool_use"):
        outcome = "success"
    elif stop_reason in ("max_tokens", "model_context_window_exceeded"):
        outcome = "partial"
    else:
        outcome = None

    cache_hit = bool(metrics.get("cache_read_tokens", 0) and metrics["cache_read_tokens"] > 0)

    return {
        "event_id": str(req_id or item.get("AmazonRequestId") or model_id),
        "trace_id": str(req_id or model_id or ""),
        "name": model_id or None,
        "event_type": "bedrock.invoke_model",
        "timestamp": None,
        "realm": "production",
        "payload": payload,
        "metrics": metrics,
        "attributes": attributes,
        "tags": tags,
        "outcome": outcome,
        # Phase 7.2 — full capture fields.
        "request_body": request_body if isinstance(request_body, (dict, type(None))) else None,
        "response_body": response_body if isinstance(response_body, (dict, type(None))) else None,
        "reasoning": None,  # Bedrock doesn't surface reasoning
        "tool_calls_full": tool_calls_full,
        "tool_results": [],  # Bedrock InvokeModel doesn't include tool results
        "images": [],
        "audio": [],
        "logprobs": None,
        "citations": [],
        "finish_reason": str(stop_reason) if stop_reason else None,
        "stop_sequence": None,
        "system_fingerprint": None,
        "cache_hit": cache_hit,
        "prompt_cache_savings_usd": None,
        "model_version": model_id or None,
        "service_tier": None,
    }


class BedrockDecoder:
    source_format = "bedrock"

    def detect(self, body: bytes, content_type: str | None) -> bool:
        try:
            parsed = loads_body(body)
        except (ValueError, UnicodeDecodeError):
            return False
        if not isinstance(parsed, dict):
            return False
        if parsed.get("modelId") or parsed.get("model_id"):
            return "amazon" in str(
                parsed.get("modelId", parsed.get("model_id", ""))
            ).lower() or "." in str(
                parsed.get("modelId", parsed.get("model_id", ""))
            )
        return False

    async def decode(
        self, body: bytes, attribution: Attribution
    ) -> list[TelemetryEvent]:
        try:
            payload = loads_body(body)
        except (ValueError, UnicodeDecodeError) as exc:
            raise SchemaInvalidError(
                f"Bedrock body is not valid JSON: {exc}",
                problems=[f"json_decode_error: {exc}"],
            ) from exc
        items = payload if isinstance(payload, list) else [payload]
        if not items:
            raise SchemaInvalidError(
                "Bedrock body parsed but contained no items",
                problems=["empty"],
            )
        events: list[TelemetryEvent] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            raw = _bedrock_to_raw(item)
            event = await normalize_to_telemetry_event(
                raw, attribution.with_source_format(self.source_format)
            )
            events.append(event)
        return events


# ── Gemini ───────────────────────────────────────────────────────────


def _gemini_to_raw(item: dict[str, Any]) -> dict[str, Any]:
    """Map a Gemini GenerateContent response (or usage event) to the
    intermediate shape.

    Phase 7.2: captures thoughts (Gemini 2.0 reasoning), function
    calls/responses, inline images/audio, and grounding citations.
    """
    # Model version: response.modelVersion (newer API) or model (older)
    model = str(
        item.get("modelVersion")
        or item.get("model")
        or ""
    )
    response_id = str(item.get("responseId") or "")

    usage_metadata = dict(item.get("usageMetadata") or item.get("usage") or {})
    metrics: dict[str, float] = {}
    for src, dst in (
        ("promptTokenCount", "input_tokens"),
        ("candidatesTokenCount", "output_tokens"),
        ("thoughtsTokenCount", "thoughts_tokens"),
        ("cachedContentTokenCount", "cached_tokens"),
        ("totalTokenCount", "total_tokens"),
        # snake_case fallbacks
        ("prompt_token_count", "input_tokens"),
        ("candidates_token_count", "output_tokens"),
        ("total_token_count", "total_tokens"),
    ):
        if src in usage_metadata:
            with contextlib.suppress(TypeError, ValueError):
                metrics[dst] = float(usage_metadata[src])

    # Extract first text from candidates for backward-compat detectors
    candidates = item.get("candidates") or []
    first_text: str | None = None
    finish_reason: str | None = None
    if isinstance(candidates, list) and candidates:
        first = candidates[0] or {}
        finish_reason = first.get("finishReason")
        content = first.get("content") or {}
        if isinstance(content, dict):
            parts = content.get("parts") or []
            if isinstance(parts, list) and parts:
                p0 = parts[0]
                if isinstance(p0, dict):
                    first_text = p0.get("text")

    # ── Phase 7.2 — full content capture ──
    thinking_blocks: list[dict[str, Any]] = []
    tool_calls_full: list[dict[str, Any]] = []
    tool_results: list[dict[str, Any]] = []
    image_blocks: list[dict[str, Any]] = []
    audio_blocks: list[dict[str, Any]] = []
    if isinstance(candidates, list):
        for cand in candidates:
            if not isinstance(cand, dict):
                continue
            cand_content = cand.get("content") or {}
            parts = (cand_content or {}).get("parts") or []
            if not isinstance(parts, list):
                continue
            for part in parts:
                if not isinstance(part, dict):
                    continue
                if part.get("thought") is True:
                    thinking_blocks.append({
                        "text": part.get("text"),
                        "thought": True,
                    })
                if isinstance(part.get("text"), str) and not thinking_blocks and not part.get("thought"):
                    # First non-thought text — surfaced as first_text above.
                    pass
                fc = part.get("functionCall")
                if isinstance(fc, dict):
                    tool_calls_full.append({
                        "name": fc.get("name"),
                        "args": fc.get("args"),
                    })
                fr = part.get("functionResponse")
                if isinstance(fr, dict):
                    tool_results.append({
                        "name": fr.get("name"),
                        "response": fr.get("response"),
                    })
                inline = part.get("inlineData") or part.get("inline_data")
                if isinstance(inline, dict):
                    mime = inline.get("mimeType") or inline.get("mime_type", "")
                    if mime.startswith("image/"):
                        image_blocks.append({
                            "content_type": mime,
                            "data_b64": inline.get("data"),
                            "source": "gemini_output",
                        })
                    elif mime.startswith("audio/"):
                        audio_blocks.append({
                            "content_type": mime,
                            "data_b64": inline.get("data"),
                            "source": "gemini_output",
                        })

    reasoning: dict[str, Any] = {}
    if thinking_blocks:
        reasoning["thoughts"] = thinking_blocks
    if metrics.get("thoughts_tokens"):
        reasoning["thoughts_tokens"] = int(metrics["thoughts_tokens"])

    cache_hit = bool(metrics.get("cached_tokens", 0) and metrics["cached_tokens"] > 0)

    # Citations — Gemini grounding / search citations
    citations: list[dict[str, Any]] = []
    for cand in (candidates if isinstance(candidates, list) else []):
        if not isinstance(cand, dict):
            continue
        meta = cand.get("citationMetadata") or cand.get("citation_metadata")
        if not isinstance(meta, dict):
            continue
        for src in (meta.get("citationSources") or []):
            if isinstance(src, dict):
                citations.append({
                    "url": src.get("uri") or src.get("url"),
                    "title": src.get("title"),
                    "cited_text": src.get("citedText") or src.get("cited_text"),
                    "start_index": src.get("startIndex") or src.get("start_index"),
                    "end_index": src.get("endIndex") or src.get("end_index"),
                })

    payload: dict[str, Any] = {
        "gemini": {
            "model_version": model or None,
            "response_id": response_id or None,
            "candidates_count": (
                len(candidates) if isinstance(candidates, list) else None
            ),
            "first_text": first_text,
            "finish_reason": finish_reason,
            "prompt_feedback": item.get("promptFeedback"),
            "grounding_metadata": item.get("groundingMetadata"),
        }
    }

    attributes: dict[str, str] = {}
    if model:
        attributes["gemini.model"] = model
    if response_id:
        attributes["gemini.response_id"] = response_id
    if finish_reason:
        attributes["gemini.finish_reason"] = str(finish_reason)

    tags = ["gemini"]
    if model:
        tags.append(f"model:{model}")

    outcome = None
    if finish_reason == "STOP":
        outcome = "success"
    elif finish_reason in ("MAX_TOKENS",):
        outcome = "partial"
    elif finish_reason in ("SAFETY", "RECITATION", "OTHER") or finish_reason == "BLOCKLIST":
        outcome = "failure"

    # Full response body — portal transcript view renders straight from
    # this. Keep the entire response in JSONB.
    response_body: dict[str, Any] | None = {
        "candidates": candidates,
        "modelVersion": model or None,
        "responseId": response_id or None,
        "usageMetadata": usage_metadata,
    } if (candidates or usage_metadata) else None

    request_body: dict[str, Any] | None = item.get("request_payload") or item.get("request")

    return {
        "event_id": response_id or f"gemini_{model}",
        "trace_id": response_id or "",
        "name": model or None,
        "event_type": "gemini.generate_content",
        "timestamp": None,
        "realm": "production",
        "payload": payload,
        "metrics": metrics,
        "attributes": attributes,
        "tags": tags,
        "outcome": outcome,
        # Phase 7.2 — full capture fields.
        "request_body": request_body,
        "response_body": response_body,
        "reasoning": reasoning or None,
        "tool_calls_full": tool_calls_full,
        "tool_results": tool_results,
        "images": image_blocks,
        "audio": audio_blocks,
        "logprobs": None,  # Gemini doesn't expose top_logprobs
        "citations": citations,
        "finish_reason": str(finish_reason) if finish_reason else None,
        "stop_sequence": None,
        "system_fingerprint": None,
        "cache_hit": cache_hit,
        "prompt_cache_savings_usd": None,
        "model_version": model or None,
        "service_tier": None,
    }


class GeminiDecoder:
    source_format = "gemini"

    def detect(self, body: bytes, content_type: str | None) -> bool:
        try:
            parsed = loads_body(body)
        except (ValueError, UnicodeDecodeError):
            return False
        if not isinstance(parsed, dict):
            return False
        if "candidates" in parsed or "usageMetadata" in parsed:
            return True
        if "modelVersion" in parsed or "model" in parsed:
            if "contents" in parsed or "generationConfig" in parsed:
                return True
        return False

    async def decode(
        self, body: bytes, attribution: Attribution
    ) -> list[TelemetryEvent]:
        try:
            payload = loads_body(body)
        except (ValueError, UnicodeDecodeError) as exc:
            raise SchemaInvalidError(
                f"Gemini body is not valid JSON: {exc}",
                problems=[f"json_decode_error: {exc}"],
            ) from exc
        items = payload if isinstance(payload, list) else [payload]
        if not items:
            raise SchemaInvalidError(
                "Gemini body parsed but contained no items",
                problems=["empty"],
            )
        events: list[TelemetryEvent] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            raw = _gemini_to_raw(item)
            event = await normalize_to_telemetry_event(
                raw, attribution.with_source_format(self.source_format)
            )
            events.append(event)
        return events
