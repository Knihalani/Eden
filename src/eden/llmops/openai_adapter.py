"""OpenAI wire-format adapter for the Eden AI Gateway.

Phase 7.0 / Batch A1 — the "users point their app at gateway.eden.ai/v1"
killer feature. Translates OpenAI-compatible HTTP requests into a
provider call (OpenRouter or MiniMax, picked from ``Settings``) and
converts the response back into the OpenAI JSON shape so existing
OpenAI / Vercel AI / LangChain clients Just Work.

Wire shapes handled (matching the OpenAI Python SDK's
``chat.completions.create`` deserializer):

  Request:
    - model: str  (e.g. "openai/gpt-4o-mini")
    - messages: list[dict] — system / user / assistant / tool / function
    - tools / functions: list[dict]
    - tool_choice: str | dict
    - temperature, top_p, max_tokens / max_completion_tokens
    - stream: bool
    - n: int
    - logprobs: bool
    - response_format: dict  (json_object / json_schema)
    - seed, stop, user, store, service_tier
    - reasoning_effort  (OpenAI o-series; ignored on older models)
    - presence_penalty, frequency_penalty
    - image_url  / type: "image_url" content parts
    - modalities  (audio, text)

  Response (non-streaming):
    - id, object="chat.completion", created, model
    - choices: [{index, message:{role,content,tool_calls,...}, finish_reason, logprobs}]
    - usage: {prompt_tokens, completion_tokens, total_tokens}
    - system_fingerprint

  Response (streaming):  ``data: <ChatCompletionChunk>`` SSE chunks with
    ``object="chat.completion.chunk"``; each carries a delta with
    role/content/tool_calls and a finish_reason on the terminal chunk.

Embeddings / legacy /completions live in separate helpers — the chat
endpoint is the one most customers hit.
"""

from __future__ import annotations

import logging
import time
import uuid
from collections.abc import AsyncIterator, Iterable
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from eden.util.jsonx import dumps as json_dumps
from eden.util.jsonx import dumps_bytes as json_dumps_bytes

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# Pydantic request/response models (subset of OpenAI's contract)
# ─────────────────────────────────────────────────────────────────────


class ToolFunctionDef(BaseModel):
    name: str
    description: str | None = None
    parameters: dict[str, Any] | None = None
    strict: bool | None = None


class ToolDef(BaseModel):
    type: str = "function"
    function: ToolFunctionDef


class ResponseFormat(BaseModel):
    type: str  # "text" | "json_object" | "json_schema"
    json_schema: dict[str, Any] | None = None


class ChatCompletionRequest(BaseModel):
    """Pydantic mirror of OpenAI's create-chat-completion request body.

    Every field is optional unless otherwise noted; the OpenAI client
    sends many defaults we don't actually need to validate.

    ``extra='allow'`` so any forward-compat OpenAI fields the user
    passes (e.g. a brand-new ``service_tier`` value, an experimental
    sampling knob) round-trip into ``.extras`` and aren't silently
    dropped. The gateway forwards ``extras`` to the upstream provider
    so the call still works for callers on newer SDK versions.
    """

    model_config = ConfigDict(extra="allow")

    @model_validator(mode="before")
    @classmethod
    def _collect_extras(cls, data: Any) -> Any:
        """Forward-compat: fold any unknown fields into ``extras``.

        Pydantic's ``extra='allow'`` exposes unknown fields at the top
        level (``body.future_field``); the gateway code (and tests) read
        them via ``body.extras['future_field']`` so the rest of the
        pipeline has a single place to look. Without this validator
        callers would have to remember to inspect
        ``model_fields_set`` vs declared fields themselves.
        """
        if isinstance(data, dict):
            known = set(cls.model_fields)
            extras = {k: v for k, v in data.items() if k not in known}
            if extras:
                existing = data.get("extras") or {}
                data = {**data, "extras": {**existing, **extras}}
        return data

    @model_validator(mode="after")
    def _enforce_max_tokens_cap(self) -> ChatCompletionRequest:
        """C-11: default omitted max_tokens to the gateway cap, then reject over-cap.

        When ``max_tokens`` / ``max_completion_tokens`` are omitted, set
        ``max_tokens`` to ``gateway_max_tokens_cap`` before forwarding so
        unbounded upstream completions cannot burn cost. Explicit values
        above the cap still raise (422). ``cap == 0`` disables both the
        default and the check (enterprise plans raise it via env).
        """
        # Lazy import via module so a test patch on
        # ``eden.config.get_settings`` resolves at call time.
        from eden.config import get_settings

        cap = get_settings().gateway_max_tokens_cap
        if cap <= 0:
            return self
        if self.max_tokens is None and self.max_completion_tokens is None:
            self.max_tokens = cap
        for field_name in ("max_tokens", "max_completion_tokens"):
            value = getattr(self, field_name)
            if value is not None and value > cap:
                raise ValueError(
                    f"{field_name}={value} exceeds gateway_max_tokens_cap "
                    f"({cap}); lower {field_name} or raise the cap"
                )
        return self

    model: str = Field(..., description="Model identifier, e.g. openai/gpt-4o-mini")
    messages: list[dict[str, Any]] = Field(..., description="Chat messages")
    # Sampling
    temperature: float | None = None
    top_p: float | None = None
    max_tokens: int | None = None
    max_completion_tokens: int | None = None
    n: int | None = 1
    # Stop
    stop: Any | None = None  # str | list[str]
    # Tool calling (modern)
    tools: list[ToolDef] | None = None
    tool_choice: Any | None = None  # "none"|"auto"|"required"|{"type":"function","function":{...}}
    # Tool calling (legacy, pre-1.0)
    functions: list[ToolFunctionDef] | None = None
    function_call: Any | None = None
    # Output shape
    response_format: ResponseFormat | None = None
    # Determinism / metadata
    seed: int | None = None
    user: str | None = None
    store: bool | None = None
    # Penalties
    presence_penalty: float | None = None
    frequency_penalty: float | None = None
    logit_bias: dict[str, float] | None = None
    logprobs: bool | None = None
    top_logprobs: int | None = None
    # Streaming
    stream: bool | None = False
    stream_options: dict[str, Any] | None = None
    # o-series reasoning
    reasoning_effort: str | None = None
    # Misc
    modalities: list[str] | None = None
    audio: dict[str, Any] | None = None
    service_tier: str | None = None
    metadata: dict[str, Any] | None = None
    # Allow forward-compat: any extra fields land in ``extras``
    extras: dict[str, Any] = Field(default_factory=dict)


class CompletionRequest(BaseModel):
    """Legacy ``/v1/completions`` body."""

    model: str
    prompt: Any  # str | list[str] | list[int] | list[list[int]]
    max_tokens: int | None = None
    temperature: float | None = None
    top_p: float | None = None
    n: int | None = 1
    stream: bool | None = False
    logprobs: int | None = None
    stop: Any | None = None
    seed: int | None = None
    user: str | None = None
    suffix: str | None = None
    echo: bool | None = None
    presence_penalty: float | None = None
    frequency_penalty: float | None = None
    best_of: int | None = None
    logit_bias: dict[str, float] | None = None
    extras: dict[str, Any] = Field(default_factory=dict)


class EmbeddingRequest(BaseModel):
    model: str
    input: Any  # str | list[str] | list[int] | list[list[int]]
    encoding_format: str | None = None  # "float" | "base64"
    dimensions: int | None = None
    user: str | None = None
    extras: dict[str, Any] = Field(default_factory=dict)


# ─────────────────────────────────────────────────────────────────────
# Internal helper: messages → flat prompt (for AIGateway PII path)
# ─────────────────────────────────────────────────────────────────────


def messages_to_prompt(messages: list[dict[str, Any]]) -> str:
    """Flatten an OpenAI messages list to a single prompt string.

    Used for the PII filter (which operates on a single string) and
    for the AIGateway ``ModelRequest.prompt`` field when the
    ``prompt``-based path is taken. Tool calls and tool results are
    serialised as JSON so they still flow through PII detection.
    """
    parts: list[str] = []
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content")
        if content is None:
            # Assistant tool_calls-only message — render the tool call JSON
            if msg.get("tool_calls"):
                content = "[tool_calls] " + json_dumps(msg["tool_calls"])
            else:
                content = ""
        elif isinstance(content, list):
            # Multi-part content (text / image_url / input_audio)
            rendered: list[str] = []
            for part in content:
                ptype = part.get("type", "text")
                if ptype == "text":
                    rendered.append(part.get("text", ""))
                elif ptype == "image_url":
                    rendered.append(
                        f"[image_url: {part.get('image_url', {}).get('url', '')[:80]}]"
                    )
                elif ptype == "input_audio":
                    rendered.append("[input_audio]")
                elif ptype == "refusal":
                    rendered.append(f"[refusal: {part.get('refusal', '')}]")
                else:
                    rendered.append(f"[{ptype}: {json_dumps(part)[:120]}]")
            content = "\n".join(rendered)
        if msg.get("name"):
            parts.append(f"{role}({msg['name']}): {content}")
        elif msg.get("tool_call_id"):
            parts.append(f"tool({msg['tool_call_id']}): {content}")
        else:
            parts.append(f"{role}: {content}")
    return "\n\n".join(parts)


# ─────────────────────────────────────────────────────────────────────
# Upstream-call parameter shaping
# ─────────────────────────────────────────────────────────────────────


def redact_pii_in_messages(
    messages: list[dict[str, Any]],
    *,
    masker: Any | None = None,
    policy: Any | None = None,
    skip_message_types: tuple[str, ...] = ("image_url", "input_audio"),
) -> tuple[list[dict[str, Any]], int, list[str]]:
    """Redact PII in-place across an OpenAI-shaped messages list.

    Walks every message and every multi-part content block, replacing
    text fields with their PII-masked equivalent. Returns the (possibly
    mutated) messages list and the count of fields that were redacted.

    Why this lives here: the gateway's PII filter operates on a single
    string (the flattened prompt). For OpenAI wire compatibility we
    must keep the messages list structured, so we need a structured
    redactor that walks the same shape. Anything that ``PIIMasker.mask``
    can take as a string is handled here; image / audio binary blobs
    are skipped (no text to mask).

    Parameters
    ----------
    messages
        OpenAI-style messages list. Mutated in place (we also return
        it for chaining).
    masker
        Optional pre-built ``PIIMasker`` for callers that want to
        share one across requests. Defaults to a fresh
        ``PIIMasker()`` with default policy.
    skip_message_types
        Content-part types that are skipped during redaction (binary
        blobs / URLs that are not PII candidates). Defaults to image
        and audio parts.

    Returns
    -------
    (messages, redacted_count, findings)
        ``redacted_count`` is the number of text-bearing fields whose
        value changed after masking. ``findings`` is a list of
        human-readable finding tags (``"pii_bypassed:mode_off"``,
        ``"pii_masked:email,phone"``, etc.) suitable for telemetry.

    ``policy`` is the resolved per-tenant :class:`PIIPolicy` (or
    ``None`` for the platform default). When the policy's
    ``mode == "off"``, the messages are returned untouched with a
    ``pii_bypassed:mode_off`` finding so callers can attribute the
    bypass to the policy rather than a missing masker.
    """
    findings: list[str] = []

    # Honour the per-tenant policy. ``mode == "off"`` is the
    # documented "designed to use the PII" case — skip masking.
    if policy is not None and getattr(policy, "mode", "redact") == "off":
        return messages, 0, ["pii_bypassed:mode_off"]

    # Lazy import: the PII module pulls in eden.data_platform; tests
    # that don't exercise PII don't pay the import cost.
    if masker is None:
        from eden.data_platform.pii import PIIMasker
        masker = PIIMasker(policy=policy) if policy is not None else PIIMasker()

    redacted = 0
    for msg in messages:
        # ``name`` is a free-form identifier on tool/function messages.
        name = msg.get("name")
        if isinstance(name, str) and name:
            new = masker.mask(name)
            if isinstance(new, str) and new != name:
                msg["name"] = new
                redacted += 1

        content = msg.get("content")
        if isinstance(content, str):
            new = masker.mask(content)
            if isinstance(new, str) and new != content:
                msg["content"] = new
                redacted += 1
        elif isinstance(content, list):
            for part in content:
                if not isinstance(part, dict):
                    continue
                ptype = part.get("type", "text")
                if ptype in skip_message_types:
                    continue
                # text / refusal / json / unknown — mask any string field.
                for key in ("text", "refusal", "input", "content"):
                    val = part.get(key)
                    if isinstance(val, str) and val:
                        new = masker.mask(val)
                        if isinstance(new, str) and new != val:
                            part[key] = new
                            redacted += 1
        # Assistant tool_calls: serialised args may carry PII.
        for tc in msg.get("tool_calls") or ():
            if not isinstance(tc, dict):
                continue
            fn = tc.get("function") or {}
            args = fn.get("arguments")
            if isinstance(args, str) and args:
                new = masker.mask(args)
                if isinstance(new, str) and new != args:
                    fn["arguments"] = new
                    redacted += 1

    if redacted > 0:
        findings.append("pii_redacted")
    return messages, redacted, findings


def chat_to_provider_kwargs(body: ChatCompletionRequest) -> dict[str, Any]:
    """Translate an OpenAI ``ChatCompletionRequest`` into kwargs the
    ``openai`` Python SDK can pass to ``chat.completions.create``.

    We strip ``stream`` and ``stream_options`` from the kwargs — those
    are handled by the caller — but pass through every other OpenAI
    field unchanged.
    """
    data = body.model_dump(exclude_none=True, exclude={"stream", "stream_options", "extras"})
    return data


def embeddings_to_provider_kwargs(body: EmbeddingRequest) -> dict[str, Any]:
    data = body.model_dump(exclude_none=True, exclude={"extras"})
    return data


# ─────────────────────────────────────────────────────────────────────
# Response shaping
# ─────────────────────────────────────────────────────────────────────


def _to_message_dict(message: Any) -> dict[str, Any]:
    """Normalise an OpenAI SDK message object to a plain dict.

    The OpenAI SDK returns Pydantic models; we want a JSON-friendly
    representation. ``tool_calls`` are converted to the
    ``ChatCompletionMessageToolCall`` shape that OpenAI's REST API
    returns to clients (id, type, function.{name,arguments}).
    """
    out: dict[str, Any] = {}
    if getattr(message, "role", None):
        out["role"] = message.role
    if getattr(message, "content", None) is not None:
        out["content"] = message.content
    if getattr(message, "refusal", None):
        out["refusal"] = message.refusal
    if getattr(message, "tool_calls", None):
        out["tool_calls"] = [
            {
                "id": tc.id,
                "type": getattr(tc, "type", "function") or "function",
                "function": {
                    "name": tc.function.name,
                    "arguments": tc.function.arguments,
                },
            }
            for tc in message.tool_calls
        ]
    if getattr(message, "function_call", None):
        fc = message.function_call
        out["function_call"] = {"name": fc.name, "arguments": fc.arguments}
    if getattr(message, "audio", None):
        out["audio"] = (
            message.audio.model_dump() if hasattr(message.audio, "model_dump") else message.audio
        )
    return out


def _to_choice_dict(choice: Any, *, stream: bool = False) -> dict[str, Any]:
    """Normalise one OpenAI SDK choice to a dict matching the wire shape.

    For non-streaming responses, ``choice.message`` is the assistant
    message; for streaming, ``choice.delta`` is the incremental chunk.
    """
    out: dict[str, Any] = {"index": getattr(choice, "index", 0)}
    if not stream:
        out["message"] = _to_message_dict(choice.message)
    else:
        # Delta: same fields as message but partial.
        delta: dict[str, Any] = {}
        d = getattr(choice, "delta", None)
        if d is not None:
            if getattr(d, "role", None):
                delta["role"] = d.role
            if getattr(d, "content", None) is not None:
                delta["content"] = d.content
            if getattr(d, "refusal", None):
                delta["refusal"] = d.refusal
            if getattr(d, "tool_calls", None):
                delta["tool_calls"] = [
                    {
                        "index": getattr(tc, "index", 0),
                        "id": getattr(tc, "id", None),
                        "type": getattr(tc, "type", "function") or "function",
                        "function": {
                            "name": tc.function.name if tc.function else None,
                            "arguments": tc.function.arguments if tc.function else None,
                        },
                    }
                    for tc in d.tool_calls
                ]
            if getattr(d, "function_call", None):
                fc = d.function_call
                delta["function_call"] = {"name": fc.name, "arguments": fc.arguments}
        out["delta"] = delta
    if getattr(choice, "finish_reason", None) is not None:
        out["finish_reason"] = choice.finish_reason
    if getattr(choice, "logprobs", None):
        out["logprobs"] = (
            choice.logprobs.model_dump() if hasattr(choice.logprobs, "model_dump") else choice.logprobs
        )
    return out


def _to_usage_dict(usage: Any) -> dict[str, Any]:
    if usage is None:
        return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    out: dict[str, Any] = {
        "prompt_tokens": getattr(usage, "prompt_tokens", 0) or 0,
        "completion_tokens": getattr(usage, "completion_tokens", 0) or 0,
        "total_tokens": getattr(usage, "total_tokens", 0) or 0,
    }
    for opt in (
        "prompt_tokens_details",
        "completion_tokens_details",
        "cost",
        "cache_read_input_token_cost",
    ):
        val = getattr(usage, opt, None)
        if val is not None:
            out[opt] = val.model_dump() if hasattr(val, "model_dump") else val
    return out


def shape_chat_completion_response(response: Any) -> dict[str, Any]:
    """Convert an OpenAI SDK ``ChatCompletion`` into the wire-format dict."""
    created = getattr(response, "created", None) or int(time.time())
    out: dict[str, Any] = {
        "id": getattr(response, "id", None) or f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion",
        "created": created,
        "model": getattr(response, "model", None) or "",
        "choices": [_to_choice_dict(c) for c in (response.choices or [])],
        "usage": _to_usage_dict(getattr(response, "usage", None)),
    }
    sf = getattr(response, "system_fingerprint", None)
    if sf:
        out["system_fingerprint"] = sf
    return out


def shape_chat_completion_chunk(chunk: Any) -> dict[str, Any]:
    """Convert an OpenAI SDK ``ChatCompletionChunk`` into a wire dict."""
    created = getattr(chunk, "created", None) or int(time.time())
    out: dict[str, Any] = {
        "id": getattr(chunk, "id", None) or f"chatcmpl-{uuid.uuid4().hex[:24]}",
        "object": "chat.completion.chunk",
        "created": created,
        "model": getattr(chunk, "model", None) or "",
        "choices": [_to_choice_dict(c, stream=True) for c in (chunk.choices or [])],
    }
    if getattr(chunk, "system_fingerprint", None):
        out["system_fingerprint"] = chunk.system_fingerprint
    if getattr(chunk, "usage", None) is not None:
        out["usage"] = _to_usage_dict(chunk.usage)
    return out


def shape_completion_response(response: Any) -> dict[str, Any]:
    """Convert an OpenAI SDK ``Completion`` into the wire-format dict."""
    out: dict[str, Any] = {
        "id": getattr(response, "id", None) or f"cmpl-{uuid.uuid4().hex[:24]}",
        "object": "text_completion",
        "created": getattr(response, "created", None) or int(time.time()),
        "model": getattr(response, "model", None) or "",
        "choices": [
            {
                "text": getattr(c, "text", "") or "",
                "index": getattr(c, "index", i),
                "logprobs": (
                    c.logprobs.model_dump()
                    if getattr(c, "logprobs", None) and hasattr(c.logprobs, "model_dump")
                    else getattr(c, "logprobs", None)
                ),
                "finish_reason": getattr(c, "finish_reason", None),
            }
            for i, c in enumerate(response.choices or [])
        ],
        "usage": _to_usage_dict(getattr(response, "usage", None)),
    }
    return out


def shape_embedding_response(response: Any) -> dict[str, Any]:
    """Convert an OpenAI SDK ``CreateEmbeddingResponse`` to a wire dict."""
    out: dict[str, Any] = {
        "object": "list",
        "data": [
            {
                "object": "embedding",
                "index": getattr(item, "index", i),
                "embedding": list(getattr(item, "embedding", []) or []),
            }
            for i, item in enumerate(response.data or [])
        ],
        "model": getattr(response, "model", None) or "",
        "usage": _to_usage_dict(getattr(response, "usage", None)),
    }
    return out


# ─────────────────────────────────────────────────────────────────────
# Models listing
# ─────────────────────────────────────────────────────────────────────


# Static catalogue used when the upstream's /models call is unavailable
# or the operator hasn't registered an org_gateway_models row yet.
STATIC_MODEL_CATALOGUE: list[dict[str, Any]] = [
    {
        "id": "openai/gpt-4o",
        "object": "model",
        "created": 1700000000,
        "owned_by": "openai",
        "permission": [],
    },
    {
        "id": "openai/gpt-4o-mini",
        "object": "model",
        "created": 1700000000,
        "owned_by": "openai",
        "permission": [],
    },
    {
        "id": "openai/gpt-4-turbo",
        "object": "model",
        "created": 1700000000,
        "owned_by": "openai",
        "permission": [],
    },
    {
        "id": "openai/o1",
        "object": "model",
        "created": 1700000000,
        "owned_by": "openai",
        "permission": [],
    },
    {
        "id": "openai/o1-mini",
        "object": "model",
        "created": 1700000000,
        "owned_by": "openai",
        "permission": [],
    },
    {
        "id": "openai/o3-mini",
        "object": "model",
        "created": 1700000000,
        "owned_by": "openai",
        "permission": [],
    },
    {
        "id": "anthropic/claude-3-5-sonnet",
        "object": "model",
        "created": 1700000000,
        "owned_by": "anthropic",
        "permission": [],
    },
    {
        "id": "anthropic/claude-3-5-haiku",
        "object": "model",
        "created": 1700000000,
        "owned_by": "anthropic",
        "permission": [],
    },
    {
        "id": "anthropic/claude-3-opus",
        "object": "model",
        "created": 1700000000,
        "owned_by": "anthropic",
        "permission": [],
    },
    {
        "id": "google/gemini-pro-1.5",
        "object": "model",
        "created": 1700000000,
        "owned_by": "google",
        "permission": [],
    },
    {
        "id": "meta-llama/llama-3.1-70b-instruct",
        "object": "model",
        "created": 1700000000,
        "owned_by": "meta",
        "permission": [],
    },
    {
        "id": "mistralai/mistral-large",
        "object": "model",
        "created": 1700000000,
        "owned_by": "mistralai",
        "permission": [],
    },
]


def shape_models_response(
    *, upstream_models: Iterable[dict[str, Any]] | None = None
) -> dict[str, Any]:
    """Shape a /v1/models response in the OpenAI format."""
    rows = list(upstream_models) if upstream_models is not None else STATIC_MODEL_CATALOGUE
    return {
        "object": "list",
        "data": [
            {
                "id": m.get("id"),
                "object": m.get("object", "model"),
                "created": m.get("created", 0),
                "owned_by": m.get("owned_by", ""),
                "permission": m.get("permission", []),
            }
            for m in rows
        ],
    }


# ─────────────────────────────────────────────────────────────────────
# SSE encoding
# ─────────────────────────────────────────────────────────────────────


def sse_format(data: dict[str, Any], *, event: str | None = None) -> bytes:
    """Encode one SSE message in the OpenAI streaming style.

    OpenAI uses ``data: <json>\\n\\n`` and signals end-of-stream with
    ``data: [DONE]\\n\\n``. We follow that exactly so existing client
    SDKs (which parse the bytes verbatim) work without modification.

    Uses compact orjson encoding (same semantics as ``json.dumps``;
    clients parse JSON and ignore whitespace).
    """
    payload = json_dumps_bytes(data)
    if event is not None:
        return b"event: " + event.encode() + b"\ndata: " + payload + b"\n\n"
    return b"data: " + payload + b"\n\n"


def sse_done() -> bytes:
    return b"data: [DONE]\n\n"


# ─────────────────────────────────────────────────────────────────────
# Async-iterator utilities
# ─────────────────────────────────────────────────────────────────────


async def aiter_to_bytes_stream(
    upstream: AsyncIterator[Any],
) -> AsyncIterator[bytes]:
    """Convert an async stream of OpenAI SDK chunks into SSE bytes.

    Yields ``data: {...}\\n\\n`` for each chunk then the
    ``data: [DONE]`` sentinel.
    """
    async for chunk in upstream:
        try:
            payload = shape_chat_completion_chunk(chunk)
        except Exception as exc:  # noqa: BLE001
            logger.debug(f"chunk shape failed: {exc}")
            continue
        yield sse_format(payload)
    yield sse_done()
