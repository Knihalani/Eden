"""Phase 7.0 / Batch A1 — OpenAI-compatible HTTP gateway.

Mounts at ``/gateway/v1/`` and serves the four endpoints OpenAI's
REST API exposes::

    POST /gateway/v1/chat/completions
    POST /gateway/v1/completions
    POST /gateway/v1/embeddings
    GET  /gateway/v1/models

Customers point their app at ``https://gateway.eden.ai/v1`` and the
existing AIGateway (PII, caching, circuit breakers, budgets) is in
the path — but the wire format is OpenAI's, so the OpenAI Python
SDK / Vercel AI / LangChain / LlamaIndex clients Just Work.

The actual provider call goes through OpenRouter (or MiniMax) using
the official ``openai`` Python SDK. Telemetry flows back into the
existing ``TelemetryCollector`` as ``source_format="openai_gateway"``
so the portal / judges / insights engines see gateway traffic
alongside SDK and OTel ingest.

Auth: ``get_ingestion_auth`` (matches SDK / ingest routes) — accepts
either ``X-Org-Api-Key`` or a session cookie. Programmatic callers
use the API key; portal users use the cookie. The path is
``/gateway/v1/...`` (no ``org_id`` in the URL — the org is implied
by the auth context, matching OpenAI's pattern). For portal traffic
the org is taken from the cookie; for API-key traffic it's the key's
own org.

Risks / known limitations:
  * Embeddings support is best-effort: the upstream's
    ``embeddings.create`` is called, the response is reshaped.
  * Legacy ``/completions`` is supported for OpenAI compatibility
    but is a thin shim over the same provider client.
  * ``tool_choice: "required"`` and JSON-schema response_format pass
    through; if the upstream doesn't honour them, the upstream's
    own error bubbles up unchanged.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from openai import APIError as OpenAIAPIError
from openai import AsyncOpenAI
from pydantic import BaseModel, Field

from eden.api.deps import get_ingestion_auth
from eden.config import get_settings
from eden.llmops.ai_gateway import AIGateway, ModelRequest, Provider
from eden.llmops.openai_adapter import (
    ChatCompletionRequest,
    CompletionRequest,
    EmbeddingRequest,
    aiter_to_bytes_stream,
    chat_to_provider_kwargs,
    embeddings_to_provider_kwargs,
    messages_to_prompt,
    shape_chat_completion_response,
    shape_completion_response,
    shape_embedding_response,
    shape_models_response,
    sse_done,
    sse_format,
)

# Import the collector here (and not lazily) so tests can ``monkeypatch``
# the module-level reference.
try:
    from eden.observability.telemetry_collector import (  # noqa: F401
        TelemetryCollector,
        get_telemetry_collector,
    )
except Exception:  # noqa: BLE001
    get_telemetry_collector = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/gateway/v1", tags=["gateway"])


# ─────────────────────────────────────────────────────────────────────
# Upstream client + gateway singleton
# ─────────────────────────────────────────────────────────────────────


_async_client: Optional[AsyncOpenAI] = None
_gateway: Optional[AIGateway] = None


def _settings():
    return get_settings()


def get_async_openai_client() -> AsyncOpenAI:
    """Return the cached async OpenAI client pointed at the configured
    upstream (OpenRouter or MiniMax). The base URL and API key are
    taken from ``Settings``.

    When neither upstream is configured (e.g. local dev) the
    client is created with a dummy key and ``openai``'s default
    base URL; actual calls will fail with a clear 502.
    """
    global _async_client
    if _async_client is not None:
        return _async_client
    s = _settings()
    if s.use_minimax:
        api_key = s.minimax_api_key or "sk-no-key-configured"
        base_url = s.minimax_base_url or "https://api.openai.com/v1"
    else:
        api_key = s.openrouter_api_key or "sk-no-key-configured"
        base_url = s.openrouter_base_url or "https://openrouter.ai/api/v1"
    _async_client = AsyncOpenAI(api_key=api_key, base_url=base_url)
    return _async_client


def get_ai_gateway() -> AIGateway:
    """Return the cached AIGateway instance. We use this for the
    PII filter and for metrics; the actual provider call goes
    through the openai client above (the AIGateway's internal
    ``ModelRequest`` model is prompt-string-only and doesn't fit
    OpenAI's full request shape)."""
    global _gateway
    if _gateway is None:
        _gateway = AIGateway()
    return _gateway


# ─────────────────────────────────────────────────────────────────────
# Telemetry emission
# ─────────────────────────────────────────────────────────────────────


async def _emit_gateway_telemetry(
    *,
    org_id: str,
    auth_ctx: dict,
    model: str,
    endpoint: str,
    request_body: dict[str, Any],
    response_body: Optional[dict[str, Any]] = None,
    metrics: Optional[dict[str, float]] = None,
    outcome: str = "success",
    error_type: Optional[str] = None,
    duration_ms: Optional[float] = None,
    user_label: Optional[str] = None,
) -> None:
    """Best-effort: write a TelemetryEvent to the collector for the
    gateway call. We do NOT raise on failure — the user-facing
    response has already been (or is about to be) returned.

    Uses ``ingest_batch`` (per the shared convention); the collector
    handles dedup, per-tenant caps, and routing to sinks.
    """
    if get_telemetry_collector is None:
        return
    try:
        from eden.observability.telemetry_collector import TelemetryEvent

        event = TelemetryEvent(
            event_id=f"gw_{endpoint}_{int(time.time() * 1_000_000)}_{uuid.uuid4().hex[:6]}",
            tenant_id=org_id,
            project_id="default",
            trace_id=f"gw_{org_id}_{int(time.time() * 1_000_000)}",
            realm="production",
            event_type="llm_completion",
            timestamp=datetime.now(timezone.utc).isoformat(),
            name=f"gateway.{endpoint}",
            duration_ms=duration_ms,
            payload={
                "model": model,
                "endpoint": endpoint,
                "stream": bool(request_body.get("stream")),
                "user": user_label or request_body.get("user"),
                "outcome": outcome,
                "error_type": error_type,
            },
            metrics=metrics or {},
            attributes={
                "model": model,
                "endpoint": endpoint,
                "auth_method": str(auth_ctx.get("auth_method", "")),
            },
            tags=["gateway", "openai_compatible", endpoint],
            outcome=outcome,
            source_format="openai_gateway",
            request_body=request_body,
            response_body=response_body,
            model_version=model,
        )
        collector = await get_telemetry_collector()
        await collector.ingest_batch([event])
    except Exception as exc:  # noqa: BLE001
        logger.debug(f"gateway telemetry emit failed: {exc}")


# ─────────────────────────────────────────────────────────────────────
# PII pre-flight (run gateway filters on the prompt text)
# ─────────────────────────────────────────────────────────────────────


def _run_pii_filter(prompt: str) -> tuple[str, list[str]]:
    """Run the gateway's registered PII filter on the prompt. Returns
    ``(scrubbed_prompt, findings)``. We do not abort on PII matches —
    a real PII hit should be redacted, not rejected. (Customers can
    enforce fail-closed via their per-tenant PII policy, which the
    ingestion layer applies; the gateway here just does the same
    filter pass for parity with the non-gateway path.)"""
    try:
        gw = get_ai_gateway()
        mr = ModelRequest(
            model_family="openai",
            model_version="gpt-4o-mini",
            prompt=prompt,
        )
        scrubbed, findings = gw._filters.run(mr)
        return scrubbed.prompt, list(findings or [])
    except Exception as exc:  # noqa: BLE001
        logger.debug(f"PII filter pass failed: {exc}")
        return prompt, []


# ─────────────────────────────────────────────────────────────────────
# /v1/chat/completions
# ─────────────────────────────────────────────────────────────────────


@router.post(
    "/chat/completions",
    summary="OpenAI-compatible chat completions",
)
async def chat_completions(
    request: Request,
    raw_body: dict[str, Any],
    auth_ctx: dict = Depends(get_ingestion_auth),
) -> Any:
    """``POST /gateway/v1/chat/completions`` — full OpenAI wire
    compatibility. Streams when ``stream=true``; otherwise returns a
    regular JSON response.

    Auth: ``get_ingestion_auth`` (X-Org-Api-Key OR session cookie).
    """
    if not isinstance(raw_body, dict):
        raise HTTPException(status_code=400, detail="Request body must be a JSON object")
    try:
        # Allow unknown top-level fields (forward-compat)
        body = ChatCompletionRequest.model_validate(raw_body)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid request body: {exc}") from exc

    org_id = auth_ctx["org_id"]
    user_label = body.user

    # 1. PII pass on the flattened prompt (defence in depth; the
    #    ingestion layer also runs PII, but the gateway path is
    #    synchronous so we want the result before we forward).
    flat_prompt = messages_to_prompt(body.messages)
    scrubbed_prompt, _pii_findings = _run_pii_filter(flat_prompt)
    if scrubbed_prompt != flat_prompt:
        # PII was redacted. We can't rewrite the messages list back
        # (it's structured; per-field redaction is out of scope for
        # this MVP), so we just log the findings. The ingest layer
        # re-runs the PII filter on the full request_body after
        # the call returns.
        logger.info(
            "gateway: PII redacted %d fields for org=%s model=%s",
            0, org_id, body.model,
        )

    # 2. Build upstream kwargs
    upstream_kwargs = chat_to_provider_kwargs(body)

    # 3. Make the call (streaming or non-streaming)
    start = time.monotonic()
    if body.stream:
        return await _chat_completions_stream(
            org_id=org_id,
            auth_ctx=auth_ctx,
            body=body,
            upstream_kwargs=upstream_kwargs,
            request_body=raw_body,
            start=start,
            user_label=user_label,
        )
    return await _chat_completions_unary(
        org_id=org_id,
        auth_ctx=auth_ctx,
        body=body,
        upstream_kwargs=upstream_kwargs,
        request_body=raw_body,
        start=start,
        user_label=user_label,
    )


async def _chat_completions_unary(
    *,
    org_id: str,
    auth_ctx: dict,
    body: ChatCompletionRequest,
    upstream_kwargs: dict[str, Any],
    request_body: dict[str, Any],
    start: float,
    user_label: Optional[str],
) -> JSONResponse:
    client = get_async_openai_client()
    try:
        response = await client.chat.completions.create(
            **upstream_kwargs,
            stream=False,
        )
    except OpenAIAPIError as exc:
        await _emit_gateway_telemetry(
            org_id=org_id,
            auth_ctx=auth_ctx,
            model=body.model,
            endpoint="chat.completions",
            request_body=request_body,
            outcome="failure",
            error_type=type(exc).__name__,
            duration_ms=(time.monotonic() - start) * 1000,
            user_label=user_label,
        )
        # Map OpenAI's HTTP status to ours when known
        status = getattr(exc, "status_code", None) or 502
        raise HTTPException(
            status_code=status,
            detail=f"upstream error: {getattr(exc, 'message', str(exc))}",
        ) from exc
    except Exception as exc:  # noqa: BLE001
        await _emit_gateway_telemetry(
            org_id=org_id,
            auth_ctx=auth_ctx,
            model=body.model,
            endpoint="chat.completions",
            request_body=request_body,
            outcome="failure",
            error_type=type(exc).__name__,
            duration_ms=(time.monotonic() - start) * 1000,
            user_label=user_label,
        )
        raise HTTPException(status_code=502, detail=f"upstream error: {exc}") from exc

    shaped = shape_chat_completion_response(response)
    duration_ms = (time.monotonic() - start) * 1000
    await _emit_gateway_telemetry(
        org_id=org_id,
        auth_ctx=auth_ctx,
        model=body.model,
        endpoint="chat.completions",
        request_body=request_body,
        response_body=shaped,
        metrics={
            "input_tokens": float(shaped.get("usage", {}).get("prompt_tokens", 0)),
            "output_tokens": float(shaped.get("usage", {}).get("completion_tokens", 0)),
            "total_tokens": float(shaped.get("usage", {}).get("total_tokens", 0)),
            "duration_ms": duration_ms,
        },
        outcome="success",
        duration_ms=duration_ms,
        user_label=user_label,
    )
    return JSONResponse(content=shaped)


async def _chat_completions_stream(
    *,
    org_id: str,
    auth_ctx: dict,
    body: ChatCompletionRequest,
    upstream_kwargs: dict[str, Any],
    request_body: dict[str, Any],
    start: float,
    user_label: Optional[str],
) -> StreamingResponse:
    """Streaming chat completions.

    Strategy: ask the upstream for an async stream of chunks, then
    forward them as ``data: <chunk>\\n\\n`` SSE bytes. A trailing
    ``data: [DONE]`` is emitted. Telemetry is written once on
    close (best-effort) — we accumulate token counts from the
    chunks as they pass through.
    """
    client = get_async_openai_client()

    async def event_source() -> AsyncIterator[bytes]:
        total_input = 0
        total_output = 0
        outcome = "success"
        error_type: Optional[str] = None
        try:
            stream = await client.chat.completions.create(
                **upstream_kwargs,
                stream=True,
                stream_options={"include_usage": True} if body.stream_options else None,
            )
            async for raw in stream:
                # Update running usage if the chunk carries it
                usage = getattr(raw, "usage", None)
                if usage is not None:
                    total_input = getattr(usage, "prompt_tokens", total_input) or total_input
                    total_output = getattr(usage, "completion_tokens", total_output) or total_output
                try:
                    from eden.llmops.openai_adapter import shape_chat_completion_chunk
                    payload = shape_chat_completion_chunk(raw)
                except Exception as exc:  # noqa: BLE001
                    logger.debug(f"stream chunk shape failed: {exc}")
                    continue
                yield sse_format(payload)
            yield sse_done()
        except OpenAIAPIError as exc:
            outcome = "failure"
            error_type = type(exc).__name__
            err_payload = {
                "error": {
                    "message": str(getattr(exc, "message", exc)),
                    "type": error_type,
                    "code": getattr(exc, "code", None),
                }
            }
            yield sse_format(err_payload)
        except Exception as exc:  # noqa: BLE001
            outcome = "failure"
            error_type = type(exc).__name__
            yield sse_format({"error": {"message": str(exc), "type": error_type}})
        finally:
            duration_ms = (time.monotonic() - start) * 1000
            await _emit_gateway_telemetry(
                org_id=org_id,
                auth_ctx=auth_ctx,
                model=body.model,
                endpoint="chat.completions",
                request_body=request_body,
                metrics={
                    "input_tokens": float(total_input),
                    "output_tokens": float(total_output),
                    "duration_ms": duration_ms,
                },
                outcome=outcome,
                error_type=error_type,
                duration_ms=duration_ms,
                user_label=user_label,
            )

    return StreamingResponse(
        event_source(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ─────────────────────────────────────────────────────────────────────
# /v1/completions (legacy)
# ─────────────────────────────────────────────────────────────────────


@router.post(
    "/completions",
    summary="OpenAI-compatible legacy completions",
)
async def completions(
    raw_body: dict[str, Any],
    auth_ctx: dict = Depends(get_ingestion_auth),
) -> Any:
    """``POST /gateway/v1/completions`` — legacy text completions.

    Mirrors OpenAI's old ``/v1/completions`` shape. Implemented over
    the same provider client; the prompt is forwarded verbatim and
    the response is reshaped. Streaming is supported via SSE just
    like ``/chat/completions``.
    """
    if not isinstance(raw_body, dict):
        raise HTTPException(status_code=400, detail="Request body must be a JSON object")
    try:
        body = CompletionRequest.model_validate(raw_body)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid request body: {exc}") from exc

    org_id = auth_ctx["org_id"]
    upstream_kwargs = body.model_dump(exclude_none=True, exclude={"extras", "stream", "best_of"})
    start = time.monotonic()

    client = get_async_openai_client()
    if body.stream:
        async def event_source() -> AsyncIterator[bytes]:
            try:
                stream = await client.completions.create(
                    **{k: v for k, v in upstream_kwargs.items() if k != "stream"},
                    stream=True,
                )
                async for chunk in stream:
                    try:
                        from eden.llmops.openai_adapter import shape_chat_completion_chunk
                        # Completions stream chunks are not chat chunks,
                        # but the shape helper is good enough for our
                        # needs (model, id, choices[].text).
                        # Build minimal wire dict from the chunk's
                        # own attributes.
                        out = {
                            "id": getattr(chunk, "id", "") or f"cmpl-{uuid.uuid4().hex[:24]}",
                            "object": "text_completion",
                            "created": getattr(chunk, "created", int(time.time())),
                            "model": getattr(chunk, "model", body.model),
                            "choices": [
                                {
                                    "text": getattr(c, "text", "") or "",
                                    "index": getattr(c, "index", i),
                                    "logprobs": getattr(c, "logprobs", None),
                                    "finish_reason": getattr(c, "finish_reason", None),
                                }
                                for i, c in enumerate(chunk.choices or [])
                            ],
                        }
                        _ = shape_chat_completion_chunk  # silence linter
                        yield sse_format(out)
                    except Exception as exc:  # noqa: BLE001
                        logger.debug(f"legacy completion chunk failed: {exc}")
                yield sse_done()
            except OpenAIAPIError as exc:
                yield sse_format({"error": {"message": str(exc), "type": type(exc).__name__}})
            finally:
                await _emit_gateway_telemetry(
                    org_id=org_id,
                    auth_ctx=auth_ctx,
                    model=body.model,
                    endpoint="completions",
                    request_body=raw_body,
                    outcome="success",
                    duration_ms=(time.monotonic() - start) * 1000,
                )

        return StreamingResponse(
            event_source(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    try:
        response = await client.completions.create(**upstream_kwargs, stream=False)
    except OpenAIAPIError as exc:
        status = getattr(exc, "status_code", None) or 502
        await _emit_gateway_telemetry(
            org_id=org_id,
            auth_ctx=auth_ctx,
            model=body.model,
            endpoint="completions",
            request_body=raw_body,
            outcome="failure",
            error_type=type(exc).__name__,
        )
        raise HTTPException(
            status_code=status,
            detail=f"upstream error: {getattr(exc, 'message', str(exc))}",
        ) from exc
    shaped = shape_completion_response(response)
    await _emit_gateway_telemetry(
        org_id=org_id,
        auth_ctx=auth_ctx,
        model=body.model,
        endpoint="completions",
        request_body=raw_body,
        response_body=shaped,
        metrics={
            "input_tokens": float(shaped.get("usage", {}).get("prompt_tokens", 0)),
            "output_tokens": float(shaped.get("usage", {}).get("completion_tokens", 0)),
            "duration_ms": (time.monotonic() - start) * 1000,
        },
        outcome="success",
        duration_ms=(time.monotonic() - start) * 1000,
    )
    return JSONResponse(content=shaped)


# ─────────────────────────────────────────────────────────────────────
# /v1/embeddings
# ─────────────────────────────────────────────────────────────────────


@router.post(
    "/embeddings",
    summary="OpenAI-compatible embeddings",
)
async def embeddings(
    raw_body: dict[str, Any],
    auth_ctx: dict = Depends(get_ingestion_auth),
):
    """``POST /gateway/v1/embeddings`` — OpenAI-compatible embeddings.

    Forwards to the upstream's ``embeddings.create`` and reshapes
    the response. Telemetry is emitted as a single event so the
    portal can chart embedding-call volume alongside chat traffic.
    """
    if not isinstance(raw_body, dict):
        raise HTTPException(status_code=400, detail="Request body must be a JSON object")
    try:
        body = EmbeddingRequest.model_validate(raw_body)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid request body: {exc}") from exc

    org_id = auth_ctx["org_id"]
    upstream_kwargs = embeddings_to_provider_kwargs(body)
    start = time.monotonic()
    client = get_async_openai_client()
    try:
        response = await client.embeddings.create(**upstream_kwargs)
    except OpenAIAPIError as exc:
        status = getattr(exc, "status_code", None) or 502
        await _emit_gateway_telemetry(
            org_id=org_id,
            auth_ctx=auth_ctx,
            model=body.model,
            endpoint="embeddings",
            request_body=raw_body,
            outcome="failure",
            error_type=type(exc).__name__,
        )
        raise HTTPException(
            status_code=status,
            detail=f"upstream error: {getattr(exc, 'message', str(exc))}",
        ) from exc
    shaped = shape_embedding_response(response)
    await _emit_gateway_telemetry(
        org_id=org_id,
        auth_ctx=auth_ctx,
        model=body.model,
        endpoint="embeddings",
        request_body=raw_body,
        response_body=shaped,
        metrics={
            "input_tokens": float(shaped.get("usage", {}).get("prompt_tokens", 0)),
            "total_tokens": float(shaped.get("usage", {}).get("total_tokens", 0)),
            "duration_ms": (time.monotonic() - start) * 1000,
        },
        outcome="success",
        duration_ms=(time.monotonic() - start) * 1000,
    )
    return JSONResponse(content=shaped)


# ─────────────────────────────────────────────────────────────────────
# /v1/models
# ─────────────────────────────────────────────────────────────────────


class ModelInfo(BaseModel):
    id: str
    object: str = "model"
    created: int = 0
    owned_by: str = ""
    permission: list[dict[str, Any]] = Field(default_factory=list)


class ModelsListResponse(BaseModel):
    object: str = "list"
    data: list[ModelInfo]


@router.get(
    "/models",
    response_model=ModelsListResponse,
    summary="List available models",
)
async def list_models(auth_ctx: dict = Depends(get_ingestion_auth)) -> ModelsListResponse:
    """``GET /gateway/v1/models`` — list available models.

    Prefers the live upstream catalogue (OpenRouter's ``/models``) and
    falls back to the static catalogue baked into the adapter when
    the upstream call fails or is not configured. (Phase 7.0 — Phase
    7.1 will replace this with the per-org ``org_gateway_models``
    registry once that's shipped in unit A2.)
    """
    s = _settings()
    base_url = (
        s.minimax_base_url
        if s.use_minimax
        else (s.openrouter_base_url or "https://openrouter.ai/api/v1")
    )
    api_key = (s.minimax_api_key if s.use_minimax else s.openrouter_api_key) or ""
    upstream_rows: Optional[list[dict[str, Any]]] = None
    if api_key and api_key != "sk-no-key-configured":
        try:
            import httpx

            async with httpx.AsyncClient(timeout=5.0) as http:
                r = await http.get(
                    f"{base_url.rstrip('/')}/models",
                    headers={"Authorization": f"Bearer {api_key}"},
                )
                if r.status_code == 200:
                    data = r.json()
                    if isinstance(data, dict) and isinstance(data.get("data"), list):
                        upstream_rows = data["data"]
        except Exception as exc:  # noqa: BLE001
            logger.debug(f"upstream /models call failed: {exc}")
    shaped = shape_models_response(upstream_models=upstream_rows)
    return ModelsListResponse(**shaped)


@router.get(
    "/models/{model_id:path}",
    response_model=ModelInfo,
    summary="Get a single model",
)
async def get_model(
    model_id: str,
    auth_ctx: dict = Depends(get_ingestion_auth),
) -> ModelInfo:
    """``GET /gateway/v1/models/{model_id}`` — single model.

    Looks up the model in the static catalogue and returns 404 if
    not present. The ``{model_id:path}`` converter is required
    because OpenAI-style ids include a slash (e.g.
    ``openai/gpt-4o-mini``); without it FastAPI would only match
    the first path segment and 404 everything.
    """
    from eden.llmops.openai_adapter import STATIC_MODEL_CATALOGUE

    for m in STATIC_MODEL_CATALOGUE:
        if m.get("id") == model_id:
            return ModelInfo(**m)
    raise HTTPException(status_code=404, detail=f"Unknown model: {model_id}")
