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

Per-request upstream routing
----------------------------
Each request may carry its own upstream configuration via headers:

* ``X-Upstream-Base-Url`` — overrides the upstream base URL (e.g.
  ``https://openrouter.ai/api/v1``).
* ``X-Upstream-Api-Key`` — overrides the upstream API key. Never
  forwarded back to the caller; stripped from any outbound headers.
* ``X-Upstream-Provider`` — optional hint (``openai``, ``openrouter``,
  ``anthropic``, ``minimax``, ``ollama``, ``vllm``, ``lmstudio``,
  ``llamacpp``) used for telemetry labelling and provider-specific
  header forwarding (e.g. Anthropic's ``anthropic-version``).

When absent, the gateway falls back to server config (``Settings``).
The ``use_minimax`` flag picks MiniMax; otherwise OpenRouter. This
preserves the original "swap your ``base_url`` to Eden's gateway,
keep your existing client" UX.

All other ``X-*`` headers are forwarded to the upstream (OpenRouter
``HTTP-Referer`` / ``X-Title``, Anthropic ``anthropic-version`` /
``anthropic-beta``, OpenRouter ``X-OpenRouter-Beta`` for structured
outputs, etc.). ``X-Upstream-Api-Key`` and ``X-Org-Api-Key`` are
explicitly stripped from the outbound request to avoid leaking
credentials to a third-party LLM provider.

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

import contextlib
import logging
import time
import uuid
from collections import OrderedDict
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    # Audit 2026-07-06 — only imported for type checking. The
    # runtime value is resolved lazily via the PEP 562
    # ``__getattr__`` on this module so the openai SDK doesn't
    # have to be loaded at gateway import time. Importing here
    # satisfies F821 (undefined name) for type annotations
    # without paying the import cost.
    from openai import AsyncOpenAI

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

# Audit 2026-07-06 - lazy-import the openai SDK. ``APIError`` is
# only used in except clauses inside route handlers, and
# ``AsyncOpenAI`` is only used in helper functions that build the
# upstream client. PEP 562 ``__getattr__`` on this module resolves
# the names on first attribute access so the SDK import only
# happens on the first request.


def __getattr__(name: str):
    """PEP 562 - lazy openai symbol resolution.

    ``OpenAIAPIError`` is the ``openai.APIError`` class used in
    ``except`` clauses; ``AsyncOpenAI`` is the upstream client
    builder. Both are loaded on first use and cached in the
    module's globals so ``patch("eden.api.routes.gateway
    .OpenAIAPIError")`` still works (mock writes to __dict__)."""
    if name in ("OpenAIAPIError", "AsyncOpenAI"):
        from openai import APIError, AsyncOpenAI
        value = APIError if name == "OpenAIAPIError" else AsyncOpenAI
        globals()[name] = value
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def _get_openai_api_error():
    """Resolve and return ``openai.APIError`` lazily.

    Python's ``except`` clause requires the caught class to
    inherit from ``BaseException`` (see CPython compile.c), so we
    can't use a transparent proxy. Instead, every ``except
    OpenAIAPIError`` clause in this module was rewritten to
    ``except _get_openai_api_error() as exc:`` so the openai
    SDK is only loaded on the first error path that hits it.
    The cost is one function call per error path; the win is
    the cold-import cost of the full openai SDK (~140ms) is
    avoided entirely on the import path of this router.
    """
    from openai import APIError
    return APIError
from pydantic import BaseModel, Field  # noqa: E402

from eden.api.deps import get_ingestion_auth  # noqa: E402
from eden.api.utils.redact import redact_all
from eden.api.utils.safe_error import redact_upstream_error, safe_detail  # noqa: E402
from eden.config import get_settings  # noqa: E402
from eden.data_platform.pii import PIIPolicy  # noqa: E402
from eden.llmops.ai_gateway import AIGateway, ModelRequest  # noqa: E402
from eden.llmops.openai_adapter import (  # noqa: E402
    ChatCompletionRequest,
    CompletionRequest,
    EmbeddingRequest,
    chat_to_provider_kwargs,
    embeddings_to_provider_kwargs,
    messages_to_prompt,
    redact_pii_in_messages,
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


def _redact_upstream_error(exc: BaseException) -> str:
    """Return a safe upstream-error string for the client 502 body.

    Raw ``str(exc)`` from openai/asyncpg/etc. can leak provider API
    keys embedded in error messages, model-name fingerprinting hints,
    the upstream provider URL or hostname, and traceback tails from
    their SDKs. None of that belongs in an HTTP response body — log
    the full exc with its traceback via logger.exception() at the
    catch site and surface a generic text instead. Clients can use
    the request_id from the existing error envelope to triage.

    Use this for the 502 path of the gateway; the 4xx path can keep
    a curated subset of provider info (status + safe message) because
    those errors are user-actionable and don't carry credentials.
    """
    return redact_upstream_error(exc)


def _redact_sse_error_message(exc: BaseException) -> str:
    """Same intent as ``_redact_upstream_error`` but for the SSE
    ``data:`` payload the streaming gateway emits when an upstream
    raises mid-flight. Historically the wire format echoed
    ``str(exc)`` as JSON in the ``message`` field, leaking provider
    keys, hostnames, model-fingerprint strings, and SDK tracebacks
    to the EventSource consumer. Returns a fixed safe string. The
    ``type`` field (exception class name) and ``code`` field are
    forwarded unchanged so clients can choose retry/backoff policy
    without exposing credentials or internal names. July 2026 fix.
    """
    return safe_detail(exc, fallback="Upstream provider returned an error during streaming.")
router = APIRouter(prefix="/gateway/v1", tags=["gateway"])


# ─────────────────────────────────────────────────────────────────────
# Upstream client + gateway singleton
# ─────────────────────────────────────────────────────────────────────


_async_client: AsyncOpenAI | None = None
_gateway: AIGateway | None = None


def _settings():
    return get_settings()


def get_async_openai_client() -> AsyncOpenAI:
    """Return the async OpenAI client for the server-configured upstream.

    Legacy entrypoint kept for compatibility with code that didn't
    migrate to per-request clients. Honours the ``_async_client``
    test stub if one has been set; otherwise falls back to the
    per-request cache with the server-default ``base_url`` + ``api_key``.

    New code should call :func:`_resolve_upstream` instead so the
    caller's ``X-Upstream-Base-Url`` / ``X-Upstream-Api-Key`` headers
    actually take effect.
    """
    if _async_client is not None:
        return _async_client
    s = _settings()
    if s.use_minimax:
        api_key = s.minimax_api_key or "sk-no-key-configured"
        base_url = s.minimax_base_url or "https://api.openai.com/v1"
    else:
        api_key = s.openrouter_api_key or "sk-no-key-configured"
        base_url = s.openrouter_base_url or "https://openrouter.ai/api/v1"
    return _get_or_build_upstream_client(base_url, api_key)


def get_ai_gateway() -> AIGateway:
    """Return the cached AIGateway instance. We use this for the
    PII filter and for metrics; the actual provider call goes
    through the openai client above (the AIGateway's internal
    ``ModelRequest`` model is prompt-string-only and doesn't fit
    OpenAI's full request shape).

    On first construction, kicks off a background pricing refresh
    against OpenRouter so the first real request can route on live
    data. The refresh is best-effort and never blocks this call.
    """
    global _gateway
    if _gateway is None:
        _gateway = AIGateway()
        # Schedule a background refresh; safe to fire-and-forget
        # because both refresh helpers deduplicate concurrent calls
        # via the catalog's in-flight task. We swallow any exception
        # at the edge (logging happens inside the refresh methods).
        # Two parallel fetches - models.dev for native vendor pricing,
        # OpenRouter for the router-specific markup. Each has its
        # own TTL so they don't fight over the inflight slot.
        try:
            import asyncio as _asyncio
            _loop = _asyncio.get_event_loop()
            if _loop.is_running():
                _asyncio.create_task(_gateway.refresh_pricing_from_models_dev())
                _asyncio.create_task(_gateway.refresh_pricing())
            else:
                # Synchronous startup path (rare): just skip - the
                # next request will trigger it via ``refresh_pricing``.
                pass
        except RuntimeError:
            # No event loop yet (very early startup); next request
            # will pick this up.
            pass
    return _gateway


# ─────────────────────────────────────────────────────────────────────
# Telemetry emission
# ─────────────────────────────────────────────────────────────────────


def _scrub_request_body(body: dict[str, Any]) -> dict[str, Any]:
    """PII-scrub the request body before persistence to telemetry_events.

    Audit 2026-07-02 S-17 — the raw ``request_body`` contains user
    PII (free-form ``messages[*].content``). Scrub via the shared
    PIIMasker before the event hits the collector. Best-effort: on
    any scrubber failure, return the unscrubbed body and let the
    downstream fail-closed logic decide. Empty/None body is a
    no-op (no masker instantiation).
    """
    if not body:
        return body
    try:
        from eden.data_platform.pii import PIIMasker
        return PIIMasker().mask(body) or body  # ponytail: mask() may return None for some inputs
    except Exception:
        return body


async def _emit_gateway_telemetry(
    *,
    org_id: str,
    auth_ctx: dict,
    model: str,
    endpoint: str,
    request_body: dict[str, Any],
    response_body: dict[str, Any] | None = None,
    metrics: dict[str, float] | None = None,
    outcome: str = "success",
    error_type: str | None = None,
    duration_ms: float | None = None,
    user_label: str | None = None,
    extra_tags: list[str] | None = None,
    extra_payload: dict[str, Any] | None = None,
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

        request_body = _scrub_request_body(request_body)  # Audit 2026-07-02 S-17

        event = TelemetryEvent(
            event_id=f"gw_{endpoint}_{int(time.time() * 1_000_000)}_{uuid.uuid4().hex[:6]}",
            tenant_id=org_id,
            project_id="default",
            trace_id=f"gw_{org_id}_{int(time.time() * 1_000_000)}",
            realm="production",
            event_type="llm_completion",
            timestamp=datetime.now(UTC).isoformat(),
            name=f"gateway.{endpoint}",
            duration_ms=duration_ms,
            payload={
                "model": model,
                "endpoint": endpoint,
                "stream": bool(request_body.get("stream")),
                "user": user_label or request_body.get("user"),
                "outcome": outcome,
                "error_type": error_type,
                **(extra_payload or {}),
            },
            metrics=metrics or {},
            attributes={
                "model": model,
                "endpoint": endpoint,
                "auth_method": str(auth_ctx.get("auth_method", "")),
            },
            tags=["gateway", "openai_compatible", endpoint, *(extra_tags or [])],
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
# PII pre-flight (run gateway filters + structured message redaction)
# ─────────────────────────────────────────────────────────────────────


# Headers that the gateway strips from outbound upstream calls so the
# caller-supplied Eden credentials don't leak to a third-party LLM
# provider. ``X-Upstream-Api-Key`` is the most obvious one — sending
# an Eden API key to OpenRouter would be a serious breach. We also
# strip ``X-Org-Api-Key`` and ``X-Org-Id`` because those are Eden's
# own auth headers and have no meaning to the upstream.
_UPSTREAM_HEADER_DENYLIST = frozenset({
    "x-upstream-api-key",
    "x-org-api-key",
    "x-org-id",
    "x-project-id",
    "host",
    "content-length",
})


def _resolve_upstream(
    request: Request,
) -> tuple[AsyncOpenAI, dict[str, str], str]:
    """Build (or fetch cached) AsyncOpenAI client + outbound headers.

    Returns ``(client, outbound_headers, provider_label)``.

    * ``X-Upstream-Base-Url`` + ``X-Upstream-Api-Key`` from the request
      take precedence over server config (the whole point of the
      gateway per the user-facing contract).
    * Outbound headers are the request's ``X-*`` headers minus the
      denylist (so credentials don't leak to the upstream).
    * ``provider_label`` is the upstream name for telemetry
      (``"openrouter"`` / ``"openai"`` / ``"custom"`` etc.).

    Test injection: if the module-level ``_async_client`` has been
    monkey-patched to a non-OpenAI object (e.g. a ``MagicMock``), we
    short-circuit and return it as the client. This keeps the legacy
    test fixtures working while still exercising the new code paths
    in production.
    """
    # Lazy-resolve AsyncOpenAI (audit 2026-07-06). The isinstance
    # check below needs the class object, not a forward reference.
    # Goes through the module's PEP 562 __getattr__ so the openai
    # SDK import only happens on the first request that hits
    # this helper.
    import sys as _sys
    _this_mod = _sys.modules[__name__]
    AsyncOpenAI = getattr(_this_mod, "AsyncOpenAI")  # noqa: B009, N806

    # Honour test stub before doing any URL resolution.
    if _async_client is not None and not isinstance(
        _async_client, AsyncOpenAI
    ):
        # Tests stub ``_async_client`` to a MagicMock that intercepts
        # every call. Return it untouched; the outbound headers and
        # provider label still need to be computed so production
        # code paths are exercised, but we don't actually use them.
        settings = _settings()
        provider = (
            "minimax" if settings.use_minimax
            else _infer_provider_from_base_url(
                settings.minimax_base_url if settings.use_minimax
                else (settings.openrouter_base_url or "https://openrouter.ai/api/v1")
            )
        )
        return _async_client, {}, provider

    settings = _settings()
    in_base = request.headers.get("X-Upstream-Base-Url", "").strip()
    in_key = request.headers.get("X-Upstream-Api-Key", "").strip()
    in_provider = request.headers.get("X-Upstream-Provider", "").strip().lower()

    if in_base or in_key:
        base_url = in_base or (
            settings.minimax_base_url if settings.use_minimax
            else settings.openrouter_base_url
        )
        api_key = in_key or (
            settings.minimax_api_key if settings.use_minimax
            else settings.openrouter_api_key
        ) or "sk-no-key-configured"
        provider = in_provider or ("minimax" if settings.use_minimax else "openrouter")
        if in_base and not in_provider:
            # Caller passed a custom URL — infer the provider from it.
            provider = _infer_provider_from_base_url(in_base)
    else:
        if settings.use_minimax:
            base_url = settings.minimax_base_url or "https://api.openai.com/v1"
            api_key = settings.minimax_api_key or "sk-no-key-configured"
            provider = "minimax"
        else:
            base_url = settings.openrouter_base_url or "https://openrouter.ai/api/v1"
            api_key = settings.openrouter_api_key or "sk-no-key-configured"
            provider = "openrouter"

    client = _get_or_build_upstream_client(base_url, api_key)

    # Build outbound headers. We forward:
    #  * every X-* caller header (provider attribution, app hints)
    #  * a small allowlist of non-X headers that LLM providers care
    #    about (OpenRouter's ``HTTP-Referer``/``HTTP-Title``/``User-Agent``
    #    trio, Anthropic's ``anthropic-version`` / ``anthropic-beta``)
    #
    # The denylist excludes Eden-internal auth headers so an Eden key
    # never reaches a third-party LLM provider as a request header.
    outbound: dict[str, str] = {}
    # Local allowlist of non-X headers we forward (OpenRouter attribution,
    # Anthropic version headers). Defined inside the function to keep
    # ruff happy (N806) and so it's a one-line edit when a new
    # provider-specific header shows up.
    passthrough_non_x = frozenset({
        "http-referer", "referer", "http-title", "title",
        "user-agent", "anthropic-version", "anthropic-beta",
    })
    for name, value in request.headers.items():
        lower = name.lower()
        if lower in _UPSTREAM_HEADER_DENYLIST:
            continue
        if lower.startswith("x-") or lower in passthrough_non_x:
            outbound[name] = value
    return client, outbound, provider


def _infer_provider_from_base_url(base_url: str) -> str:
    """Best-effort provider label from the base URL. Used for
    telemetry when the caller didn't set ``X-Upstream-Provider``.

    Local providers are identified by their canonical port (Ollama
    11434, vLLM 8000, LM Studio 1234, llama.cpp 8080) since they
    typically run on ``http://localhost:<port>/v1`` with no
    provider-identifying hostname.
    """
    lower = base_url.lower()
    if "openrouter" in lower:
        return "openrouter"
    if "anthropic" in lower:
        return "anthropic"
    if "minimax" in lower:
        return "minimax"
    if "ollama" in lower or ":11434" in lower:
        return "ollama"
    if "vllm" in lower or ":8000" in lower:
        return "vllm"
    if "lmstudio" in lower or ":1234" in lower:
        return "lmstudio"
    if "llamacpp" in lower or "llama.cpp" in lower or ":8080" in lower:
        return "llamacpp"
    if "api.openai.com" in lower:
        return "openai"
    return "custom"


# F62 — cap the per-(base_url, api_key) ``AsyncOpenAI`` client
# cache. Pre-F62 the cache was a plain dict that grew unbounded
# against BYOK traffic: every unique ``X-Upstream-Api-Key`` header
# added an entry, each entry holding its own ``httpx.AsyncClient``
# with a connection pool. A malicious caller spamming unique keys
# could multiply the API's RSS by ~50 KB per entry. The cap is
# generous (1024) — a healthy multi-tenant process sees < 10
# entries total — but it bounds the worst case to a small
# multiple of normal traffic.
_MAX_UPSTREAM_CLIENT_CACHE = 1024


def _get_or_build_upstream_client(base_url: str, api_key: str):
    """Cache one ``AsyncOpenAI`` per ``(base_url, api_key)`` tuple.

    Module-level cache so a single process shares one socket pool
    across requests. Pre-F62 the cache was unbounded; F62 caps it
    at ``_MAX_UPSTREAM_CLIENT_CACHE`` entries with FIFO eviction.
    Insertion order is bumped on every hit so an active provider
    is never dropped while a stale provider with one historical
    request gets evicted.

    Tests inject a stub by monkey-patching ``_async_client`` — this
    function deliberately bypasses that cache (it always builds a
    fresh client unless the URL/key pair has been seen before) so
    a test that sets ``base_url="https://openrouter.ai/api/v1"``
    with a dummy key still gets the stub. The compatibility shim
    is in ``_get_async_client_for_legacy_tests``.

    Audit 2026-07-06 — return type is a runtime-resolved class,
    not a forward reference, so callers can isinstance() it.
    """
    import sys as _sys
    AsyncOpenAI = getattr(_sys.modules[__name__], "AsyncOpenAI")  # noqa: B009, N806
    cache_key = (base_url.rstrip("/"), api_key)
    if cache_key in _upstream_client_cache:
        # F62: bump LRU so an active provider survives a
        # cache-pressure-eviction sweep triggered by churning
        # one-off keys.
        _upstream_client_cache.move_to_end(cache_key)
        return _upstream_client_cache[cache_key]
    client = AsyncOpenAI(api_key=api_key, base_url=base_url)
    _upstream_client_cache[cache_key] = client
    # F62: enforce the cap. Evict FIFO until we're back
    # under the limit. Fresh inserts always succeed.
    while len(_upstream_client_cache) > _MAX_UPSTREAM_CLIENT_CACHE:
        _upstream_client_cache.popitem(last=False)
    return client


# Per-``(base_url, api_key)`` cache of ``AsyncOpenAI`` clients.
# Module-level so a single process shares one socket pool across
# requests. ``OrderedDict`` so the F62 FIFO cap can drop the
# least-recently-inserted key under pressure.
_upstream_client_cache: OrderedDict[tuple[str, str], AsyncOpenAI] = OrderedDict()


class _PIIFailClosedError(Exception):
    """Raised when the per-tenant PII policy is fail-closed and the
    request contains a credential-like value.

    Caught by the chat / completions / embeddings handlers and
    translated into a 422 response.
    """


_TRUTHY = frozenset({"1", "true", "yes", "on"})
_FALSY = frozenset({"0", "false", "no", "off", ""})


def _parse_bool_header(value: str) -> bool:
    """Parse a header value into a boolean.

    Accepts the common spellings used by HTTP clients (``true``,
    ``1``, ``yes``, ``on``). Empty / unknown values default to
    ``False`` so an unrelated ``X-PII-Bypass: <something else>``
    doesn't accidentally opt the request out.
    """
    if not value:
        return False
    lowered = value.strip().lower()
    if lowered in _TRUTHY:
        return True
    if lowered in _FALSY:
        return False
    return False


def _get_async_client_for_legacy_tests() -> AsyncOpenAI | None:
    """Return the module-level ``_async_client`` if it has been set
    (by tests) — otherwise ``None``.

    The legacy tests stub ``_async_client`` to a ``MagicMock`` to
    intercept every gateway call regardless of per-request URL. This
    helper exists so those tests keep passing while the production
    path uses ``_get_or_build_upstream_client``. Tests should keep
    stubbing ``_async_client``; this helper is the read-side bridge.
    """
    return _async_client


def _resolve_request_pii_policy(
    request: Request | None,
    raw_body: dict[str, Any] | None,
    *,
    org_id: str = "",
    bypass: bool = False,
) -> tuple[PIIPolicy | None, list[str], bool]:
    """Build the effective per-request PII policy.

    Layers in priority order (highest first):

      1. Per-request bypass flag (``X-PII-Bypass: true`` header
         or ``pii_filter_enabled: false`` body field) — skip masking
         and emit ``pii_bypassed:per_request``.

      2. Per-request override headers (``X-PII-Mode``,
         ``X-PII-Disabled-Categories``) — applied on top of the
         tenant policy so a single call can change the mode or
         drop a category without touching the tenant policy.

      3. Per-tenant policy from ``org_pii_policies`` (cached 60s).

      4. Default policy (``mode="redact"``, all categories active).

    Returns ``(policy, findings, bypassed)``:

      * ``policy`` is the effective :class:`PIIPolicy` for this
        request, or ``None`` when ``bypassed`` is True.
      * ``findings`` is a list of human-readable tags describing
        the resolution path (``"pii_bypassed:per_request"``,
        ``"pii_mode:fail_closed"``, etc.).
      * ``bypassed`` is True when the redactor should skip masking
        entirely.
    """
    findings: list[str] = []

    # 1. Per-request bypass wins over everything.
    if bypass:
        findings.append("pii_bypassed:per_request")
        return None, findings, True

    # 2. Resolve tenant policy from cache.
    tenant_policy: PIIPolicy | None = None
    try:
        from eden.llmops.policy_cache import get_policy_for_tenant
        tenant_policy = _run_async(get_policy_for_tenant, org_id)
    except Exception as exc:  # noqa: BLE001
        logger.debug(
            "gateway: per-tenant PII policy resolver failed for "
            "org=%s: %s",
            org_id, redact_all(str(exc)),
        )

    # 3. Apply per-request overrides on top of the tenant policy.
    effective_policy = tenant_policy if tenant_policy is not None else PIIPolicy()

    if request is not None:
        header_mode = (request.headers.get("X-PII-Mode") or "").strip().lower()
        header_disabled = (
            request.headers.get("X-PII-Disabled-Categories") or ""
        ).strip()

        if header_mode in ("off", "redact", "fail_closed"):
            if header_mode != effective_policy.mode:
                findings.append(f"pii_mode:{header_mode}")
            # Re-build the policy with the requested mode. We
            # start from the tenant policy's category set so the
            # disable list is preserved.
            effective_policy = PIIPolicy(
                mode=header_mode,
                enabled_categories=set(effective_policy.enabled_categories),
                disabled_categories=set(effective_policy.disabled_categories),
                fail_closed_on_credentials=effective_policy.fail_closed_on_credentials,
            )

        if header_disabled:
            new_disabled = {
                c.strip() for c in header_disabled.split(",") if c.strip()
            }
            if new_disabled != effective_policy.disabled_categories:
                findings.append(
                    "pii_disabled_categories:" + ",".join(sorted(new_disabled))
                )
            effective_policy = PIIPolicy(
                mode=effective_policy.mode,
                enabled_categories=set(effective_policy.enabled_categories),
                disabled_categories=new_disabled,
                fail_closed_on_credentials=effective_policy.fail_closed_on_credentials,
            )

    # Also accept the same fields as request-body overrides (OpenAI-
    # compatible clients that can't easily add headers).
    if raw_body is not None:
        body_mode = (raw_body.get("pii_mode") or "").strip().lower()
        body_disabled = raw_body.get("pii_disabled_categories")
        if body_mode in ("off", "redact", "fail_closed"):
            if body_mode != effective_policy.mode:
                findings.append(f"pii_mode:{body_mode}_via_body")
            effective_policy = PIIPolicy(
                mode=body_mode,
                enabled_categories=set(effective_policy.enabled_categories),
                disabled_categories=set(effective_policy.disabled_categories),
                fail_closed_on_credentials=effective_policy.fail_closed_on_credentials,
            )
        if isinstance(body_disabled, list):
            new_disabled = {str(c) for c in body_disabled if c}
            if new_disabled != effective_policy.disabled_categories:
                findings.append(
                    "pii_disabled_categories:" + ",".join(sorted(new_disabled))
                )
            effective_policy = PIIPolicy(
                mode=effective_policy.mode,
                enabled_categories=set(effective_policy.enabled_categories),
                disabled_categories=new_disabled,
                fail_closed_on_credentials=effective_policy.fail_closed_on_credentials,
            )

    return effective_policy, findings, False


def _apply_pii_filter_to_messages(
    messages: list[dict[str, Any]],
    *,
    org_id: str = "",
    request: Request | None = None,
    raw_body: dict[str, Any] | None = None,
    bypass: bool = False,
) -> tuple[list[dict[str, Any]], list[str]]:
    """Run the gateway's PII filter against an OpenAI messages list.

    Returns ``(messages, findings)`` where ``messages`` is the same
    list (mutated in place) and ``findings`` is a list of
    human-readable descriptions of what was redacted.

    Policy resolution (highest priority first):

      1. ``bypass=True`` (set by the ``X-PII-Bypass: true`` header
         or a ``pii_filter_enabled: false`` field in the request
         body) — the caller is asserting that the system is designed
         to use the raw PII. We skip masking and emit a
         ``pii_bypassed:per_request`` finding for telemetry.

      2. Per-request overrides via ``X-PII-Mode`` /
         ``X-PII-Disabled-Categories`` headers (or the equivalent
         ``pii_mode`` / ``pii_disabled_categories`` body fields).
         Lets a single call change the mode or drop a category
         without touching the tenant policy.

      3. Per-tenant policy resolved from ``org_pii_policies``
         (cached 60s via :mod:`eden.llmops.policy_cache`). When the
         policy's ``mode == "off"`` we skip masking (system-designed
         for raw PII) and emit ``pii_bypassed:mode_off``. When
         ``mode == "fail_closed"`` and a credential is detected, we
         raise ``PIIMaskingError`` so the route handler can return
         a 422 instead of a silently-masked payload.

      4. Default policy (``mode="redact"``, all categories active).

    Implementation: we walk the structured messages with
    :func:`eden.llmops.openai_adapter.redact_pii_in_messages`, which
    uses the same ``PIIMasker`` the rest of the platform uses. We
    additionally run the gateway's filter pipeline (PII, plus any
    registered custom filters) against the flattened prompt as a
    sanity check; if any filter fires there, we know to attribute
    the redaction to that filter for logging.
    """
    if not messages:
        return messages, []

    effective_policy, findings, bypassed = _resolve_request_pii_policy(
        request,
        raw_body,
        org_id=org_id,
        bypass=bypass,
    )

    if bypassed:
        logger.info(
            "gateway: PII bypassed per-request for org=%s",
            org_id,
        )
        return messages, findings

    # ``mode == "off"`` — the system is designed to use the raw PII
    # values, so we don't mask.
    if effective_policy is not None and effective_policy.mode == "off":
        logger.info(
            "gateway: PII mode=off for org=%s; bypassing mask",
            org_id,
        )
        return messages, findings + ["pii_bypassed:mode_off"]

    try:
        messages, count, redact_findings = redact_pii_in_messages(
            messages, policy=effective_policy,
        )
    except Exception as exc:  # noqa: BLE001
        # Fail-closed: the masker raises ``PIIMaskingError`` when
        # the tenant policy is fail-closed and a credential was
        # detected. Translate to our gateway-level exception so
        # the route handler can return 422.
        from eden.data_platform.pii import PIIMaskingError
        if isinstance(exc, PIIMaskingError):
            logger.info(
                "gateway: PII fail-closed for org=%s: %s",
                org_id, redact_all(str(exc)),
            )
            raise _PIIFailClosedError(str(exc)) from exc
        logger.debug("PII redactor raised %s; passing through", redact_all(str(exc)))
        return messages, findings

    # Run the gateway filter chain on the flattened prompt so any
    # custom filters (e.g. tenant policy) get a chance to fire.
    # The structured redactor already handled the actual rewrite;
    # this is purely for telemetry attribution.
    if count > 0:
        findings = findings + redact_findings + [
            f"pii_redacted:{count}_fields"
        ]
        try:
            gw = get_ai_gateway()
            mr = ModelRequest(
                model_family="openai",
                model_version="gpt-4o-mini",
                prompt=messages_to_prompt(messages),
                tenant_id=org_id,
            )
            _, filter_findings = gw._filters.run(mr)
            findings.extend(filter_findings)
        except Exception as exc:  # noqa: BLE001
            logger.debug("filter pipeline attribution failed: %s", redact_all(str(exc)))
    else:
        # No redactions — still surface the resolution-path findings.
        findings = findings + redact_findings

    if any(f.startswith("pii_redacted") for f in findings):
        logger.info(
            "gateway: PII redacted for org=%s: %s",
            org_id,
            findings,
        )
    return messages, findings


def _run_async(coro_factory, *args):
    """Run an async coroutine from sync context.

    The gateway's per-tenant policy cache is async (so it can
    share a Postgres connection pool with the rest of the route
    stack) but the PII redactor calls it from a sync code path.
    This helper runs the coroutine on a dedicated thread with its
    own event loop so we don't block the request handler.

    For requests that already have a running event loop (the
    FastAPI handler), we still use ``asyncio.run`` on a worker
    thread — the cache entries are stored at module scope, so
    cross-loop access is safe.
    """
    import asyncio
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as ex:
        future = ex.submit(lambda: asyncio.run(coro_factory(*args)))
        return future.result(timeout=2.0)


def _apply_pii_filter_to_flat_string(
    prompt: str,
    *,
    org_id: str = "",
    request: Request | None = None,
    raw_body: dict[str, Any] | None = None,
    bypass: bool = False,
) -> tuple[str, list[str]]:
    """Run the gateway's PII filter against a flat prompt string.

    Used by the legacy ``/v1/completions`` endpoint and the
    ``/v1/embeddings`` endpoint, where the request body carries a
    flat string (or a list of strings) rather than the structured
    messages list the chat path uses.

    Policy resolution mirrors
    :func:`_apply_pii_filter_to_messages`: per-request bypass →
    per-request overrides (``X-PII-Mode`` / ``X-PII-Disabled-Categories``
    headers or the equivalent body fields) → tenant policy →
    default.

    Fail-closed: when the resolved policy's mode is ``fail_closed``
    and the masker detects a credential category, raise
    :class:`_PIIFailClosedError` so the route handler returns 422.

    Returns ``(scrubbed, findings)``.
    """
    effective_policy, findings, bypassed = _resolve_request_pii_policy(
        request,
        raw_body,
        org_id=org_id,
        bypass=bypass,
    )
    if bypassed:
        logger.info(
            "gateway: PII bypassed per-request for org=%s (flat)",
            org_id,
        )
        return prompt, findings
    if effective_policy is not None and effective_policy.mode == "off":
        logger.info(
            "gateway: PII mode=off for org=%s; bypassing mask (flat)",
            org_id,
        )
        return prompt, findings + ["pii_bypassed:mode_off"]

    try:
        from eden.data_platform.pii import PIIMasker, PIIMaskingError
        scrubbed = PIIMasker(policy=effective_policy).mask(prompt)
    except PIIMaskingError as exc:
        # Fail-closed path. Translate to the gateway-level exception
        # so the route handler returns 422 instead of silently
        # forwarding the credential.
        logger.info(
            "gateway: PII fail-closed for org=%s (flat): %s",
            org_id, redact_all(str(exc)),
        )
        raise _PIIFailClosedError(str(exc)) from exc
    except Exception as exc:  # noqa: BLE001
        logger.debug("PII flat-string filter pass failed: %s", redact_all(str(exc)))
        return prompt, findings

    if scrubbed != prompt:
        return scrubbed, findings + ["pii_redacted"]
    return prompt, findings


def _run_pii_filter(prompt: str) -> tuple[str, list[str]]:
    """Backwards-compat wrapper: redact PII in a single prompt string.

    Kept for callers that still pass a flat string with the default
    tenant policy (legacy test fixtures, ad-hoc call sites). The
    /completions and /embeddings endpoints use
    :func:`_apply_pii_filter_to_flat_string` instead so they honor
    per-request overrides and fail-closed.
    """
    try:
        from eden.data_platform.pii import PIIMasker
        scrubbed = PIIMasker().mask(prompt)
        if scrubbed != prompt:
            return scrubbed, ["pii_redacted"]
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

    Per-request upstream is resolved from ``X-Upstream-Base-Url`` /
    ``X-Upstream-Api-Key`` headers (falls back to server config).

    PII is redacted in-place across the structured messages list
    before the call leaves the platform — see
    :func:`_apply_pii_filter_to_messages`.
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

    # 1. PII redactor — walks the structured messages list and
    #    replaces text fields with their masked equivalent. The
    #    redactor honours:
    #
    #      * ``X-PII-Bypass: true`` request header (per-request
    #        opt-out — the system is designed to use the PII)
    #      * ``pii_filter_enabled: false`` field in the request body
    #        (OpenAI-compatible clients that prefer a body field)
    #      * per-tenant ``org_pii_policies`` row (mode, enabled /
    #        disabled categories, fail_closed_on_credentials)
    #
    # Fail-closed: when the resolved policy's ``mode == "fail_closed"``
    # and a credential category is detected, the masker raises
    # ``PIIMaskingError`` which we translate to a 422.
    bypass_header = _parse_bool_header(
        request.headers.get("X-PII-Bypass", ""),
    )
    bypass_body = bool(
        (raw_body.get("pii_filter_enabled") is False)
        or (body.extras.get("pii_filter_enabled") is False)
    )
    bypass = bypass_header or bypass_body
    try:
        body.messages, pii_findings = _apply_pii_filter_to_messages(
            body.messages,
            org_id=org_id,
            request=request,
            raw_body=raw_body,
            bypass=bypass,
        )
    except _PIIFailClosedError as exc:
        # Fail-closed path: tenant policy says credentials must
        # abort the request. Return 422 with a structured error
        # so the caller knows to retry without the credential.
        await _emit_gateway_telemetry(
            org_id=org_id,
            auth_ctx=auth_ctx,
            model=body.model,
            endpoint="chat.completions",
            request_body=raw_body,
            outcome="failure",
            error_type="pii_fail_closed",
            user_label=user_label,
            extra_tags=[f"provider:{_infer_provider_from_base_url(_resolve_upstream(request)[0].base_url or '')}"] if False else None,
            extra_payload={"pii_findings": ["pii_fail_closed:credential_detected"]},
        )
        raise HTTPException(
            status_code=422,
            detail={
                "error": "pii_fail_closed",
                "message": (
                    "PII policy is fail-closed for this tenant and "
                    "the request contains a credential-like value. "
                    "Remove the credential or set 'pii_filter_enabled': "
                    "false in the request body to opt out per-request."
                ),
            },
        ) from exc

    # 2. Resolve per-request upstream (X-Upstream-* headers honored,
    #    falls back to server-configured OpenRouter or MiniMax).
    client, outbound_headers, provider = _resolve_upstream(request)

    # 3. Build upstream kwargs + thread extra_headers so the caller's
    #    X-* headers (HTTP-Referer, X-Title, anthropic-version, ...)
    #    land on the outbound HTTP request.
    upstream_kwargs = chat_to_provider_kwargs(body)
    if outbound_headers:
        upstream_kwargs["extra_headers"] = outbound_headers

    # 4. Make the call (streaming or non-streaming)
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
            client=client,
            provider=provider,
            pii_findings=pii_findings,
        )
    return await _chat_completions_unary(
        org_id=org_id,
        auth_ctx=auth_ctx,
        body=body,
        upstream_kwargs=upstream_kwargs,
        request_body=raw_body,
        start=start,
        user_label=user_label,
        client=client,
        provider=provider,
        pii_findings=pii_findings,
    )


async def _chat_completions_unary(
    *,
    org_id: str,
    auth_ctx: dict,
    body: ChatCompletionRequest,
    upstream_kwargs: dict[str, Any],
    request_body: dict[str, Any],
    start: float,
    user_label: str | None,
    client: AsyncOpenAI | None = None,
    provider: str = "",
    pii_findings: list[str] | None = None,
) -> JSONResponse:
    # ``client`` is injected by chat_completions after per-request
    # upstream resolution. Falls back to the legacy module-level
    # stub for tests that haven't been migrated.
    if client is None:
        client = get_async_openai_client()
    try:
        response = await client.chat.completions.create(
            **upstream_kwargs,
            stream=False,
        )
    except _get_openai_api_error() as exc:
        await _emit_gateway_telemetry(
            org_id=org_id,
            auth_ctx=auth_ctx,
            model=body.model,
            endpoint="chat.completions",
            request_body=request_body,
            extra_tags=[f"provider:{provider}"] if provider else None,
            extra_payload={"pii_findings": pii_findings or []},
            outcome="failure",
            error_type=type(exc).__name__,
            duration_ms=(time.monotonic() - start) * 1000,
            user_label=user_label,
        )
        # Map OpenAI's HTTP status to ours when known
        status = getattr(exc, "status_code", None) or 502
        raise HTTPException(
            status_code=status,
            detail=_redact_upstream_error(exc),
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
        raise HTTPException(status_code=502, detail=_redact_upstream_error(exc)) from exc

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
        extra_tags=[f"provider:{provider}"] if provider else None,
        extra_payload={"pii_findings": pii_findings or []},
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
    user_label: str | None,
    client: AsyncOpenAI | None = None,
    provider: str = "",
    pii_findings: list[str] | None = None,
) -> StreamingResponse:
    """Streaming chat completions.

    Strategy: ask the upstream for an async stream of chunks, then
    forward them as ``data: <chunk>\\n\\n`` SSE bytes. A trailing
    ``data: [DONE]`` is emitted. Telemetry is written once on
    close (best-effort) — we accumulate token counts from the
    chunks as they pass through.
    """
    if client is None:
        client = get_async_openai_client()

    async def event_source() -> AsyncIterator[bytes]:
        total_input = 0
        total_output = 0
        outcome = "success"
        error_type: str | None = None
        stream = None
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
        except _get_openai_api_error() as exc:
            outcome = "failure"
            error_type = type(exc).__name__
            err_payload = {
                "error": {
                    "message": str(getattr(exc, "message", exc)),
                    "type": error_type,
                    "code": getattr(exc, "code", None),
                }
            }
            # P39 audit (2026-07-06): the SDK ``message`` attribute can
            # carry the provider URL, a prefix of the API key, and the
            # model name. Surface a fixed safe string instead; clients
            # use ``type`` (class name) to drive retry/backoff policy.
            logger.warning(
                "gateway chat.completions stream failed: %s: %s",
                error_type, redact_all(str(exc)),
            )
            yield sse_format(err_payload)
        except Exception as exc:  # noqa: BLE001
            outcome = "failure"
            error_type = type(exc).__name__
            logger.exception(
                "gateway chat.completions stream raised: %s",
                redact_all(str(exc)),
            )
            yield sse_format({"error": {"message": _redact_sse_error_message(exc), "type": error_type}})
        finally:
            # Audit 2026-06-22 B1.26 — close upstream stream on disconnect
            # to avoid leaking OpenRouter connections.
            if stream is not None:
                with contextlib.suppress(Exception):
                    await stream.close()
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
                extra_tags=[f"provider:{provider}"] if provider else None,
                extra_payload={"pii_findings": pii_findings or []},
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
    request: Request,
    raw_body: dict[str, Any],
    auth_ctx: dict = Depends(get_ingestion_auth),
) -> Any:
    """``POST /gateway/v1/completions`` — legacy text completions.

    Mirrors OpenAI's old ``/v1/completions`` shape. The prompt is
    forwarded verbatim and the response is reshaped. Streaming is
    supported via SSE just like ``/chat/completions``.

    Per-request upstream headers (``X-Upstream-Base-Url``,
    ``X-Upstream-Api-Key``) are honoured. ``prompt`` is a flat
    string here so PII is redacted via the flat-prompt helper; the
    chat endpoint's structured redactor does not apply.
    """
    if not isinstance(raw_body, dict):
        raise HTTPException(status_code=400, detail="Request body must be a JSON object")
    try:
        body = CompletionRequest.model_validate(raw_body)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid request body: {exc}") from exc

    org_id = auth_ctx["org_id"]

    # PII on flat prompt string (legacy /v1/completions shape).
    # Honours the same headers + body overrides as /chat/completions:
    # ``X-PII-Bypass``, ``X-PII-Mode``, ``X-PII-Disabled-Categories``,
    # plus the equivalent body fields. Fail-closed → 422.
    bypass_header = _parse_bool_header(
        request.headers.get("X-PII-Bypass", ""),
    )
    bypass_body = bool(
        (raw_body.get("pii_filter_enabled") is False)
        or (body.extras.get("pii_filter_enabled") is False)
    )
    bypass = bypass_header or bypass_body
    prompt = body.prompt
    try:
        if isinstance(prompt, str):
            scrubbed, _findings = _apply_pii_filter_to_flat_string(
                prompt,
                org_id=org_id,
                request=request,
                raw_body=raw_body,
                bypass=bypass,
            )
            if scrubbed != prompt:
                body.prompt = scrubbed
        elif isinstance(prompt, list):
            scrubbed_list: list[Any] = []
            for item in prompt:
                if isinstance(item, str):
                    scrubbed, _ = _apply_pii_filter_to_flat_string(
                        item,
                        org_id=org_id,
                        request=request,
                        raw_body=raw_body,
                        bypass=bypass,
                    )
                    scrubbed_list.append(scrubbed)
                else:
                    scrubbed_list.append(item)
            body.prompt = scrubbed_list
    except _PIIFailClosedError as exc:
        await _emit_gateway_telemetry(
            org_id=org_id,
            auth_ctx=auth_ctx,
            model=body.model,
            endpoint="completions",
            request_body=raw_body,
            outcome="failure",
            error_type="pii_fail_closed",
            extra_payload={"pii_findings": ["pii_fail_closed:credential_detected"]},
        )
        raise HTTPException(
            status_code=422,
            detail={
                "error": "pii_fail_closed",
                "message": (
                    "PII policy is fail-closed for this tenant and the "
                    "request contains a credential-like value. Remove "
                    "the credential or set 'pii_filter_enabled': false "
                    "in the request body to opt out per-request."
                ),
            },
        ) from exc

    client, outbound_headers, provider = _resolve_upstream(request)
    upstream_kwargs = body.model_dump(
        exclude_none=True, exclude={"extras", "stream", "best_of"},
    )
    if outbound_headers:
        upstream_kwargs["extra_headers"] = outbound_headers
    start = time.monotonic()
    if body.stream:
        async def event_source() -> AsyncIterator[bytes]:
            # Audit 2026-06-22 B1.27 — cache chunk id once per stream;
            # previously regenerated each chunk, breaking client-side dedup.
            stream_id = f"cmpl-{uuid.uuid4().hex[:24]}"
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
                            "id": getattr(chunk, "id", "") or stream_id,
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
            except _get_openai_api_error() as exc:
                # P39 audit (2026-07-06): redact upstream error in SSE
                # payload — same redaction as the chat.completions path.
                logger.warning(
                    "gateway legacy completions stream failed: %s: %s",
                    type(redact_all(str(exc))).__name__, redact_all(str(exc)),
                )
                yield sse_format({"error": {"message": _redact_sse_error_message(exc), "type": type(exc).__name__}})
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
    except _get_openai_api_error() as exc:
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
            detail=_redact_upstream_error(exc),
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
    request: Request,
    raw_body: dict[str, Any],
    auth_ctx: dict = Depends(get_ingestion_auth),
):
    """``POST /gateway/v1/embeddings`` — OpenAI-compatible embeddings.

    Forwards to the upstream's ``embeddings.create`` and reshapes
    the response. Per-request upstream headers are honoured. PII
    is scrubbed from the ``input`` field before the call lands
    upstream.

    Telemetry is emitted as a single event so the portal can chart
    embedding-call volume alongside chat traffic.
    """
    if not isinstance(raw_body, dict):
        raise HTTPException(status_code=400, detail="Request body must be a JSON object")
    try:
        body = EmbeddingRequest.model_validate(raw_body)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Invalid request body: {exc}") from exc

    org_id = auth_ctx["org_id"]

    # PII on input (string or list-of-strings). Token-array inputs
    # are passed through (those are pre-tokenised; redacting the
    # raw ids would corrupt the token sequence).
    #
    # Honours the same headers + body overrides as /chat/completions:
    # ``X-PII-Bypass``, ``X-PII-Mode``, ``X-PII-Disabled-Categories``,
    # plus the equivalent body fields. Fail-closed → 422.
    bypass_header = _parse_bool_header(
        request.headers.get("X-PII-Bypass", ""),
    )
    bypass_body = bool(
        (raw_body.get("pii_filter_enabled") is False)
        or (body.extras.get("pii_filter_enabled") is False)
    )
    bypass = bypass_header or bypass_body
    inp = body.input
    try:
        if isinstance(inp, str):
            scrubbed, _ = _apply_pii_filter_to_flat_string(
                inp,
                org_id=org_id,
                request=request,
                raw_body=raw_body,
                bypass=bypass,
            )
            if scrubbed != inp:
                body.input = scrubbed
        elif isinstance(inp, list):
            scrubbed_list: list[Any] = []
            for item in inp:
                if isinstance(item, str):
                    scrubbed, _ = _apply_pii_filter_to_flat_string(
                        item,
                        org_id=org_id,
                        request=request,
                        raw_body=raw_body,
                        bypass=bypass,
                    )
                    scrubbed_list.append(scrubbed)
                else:
                    scrubbed_list.append(item)
            body.input = scrubbed_list
    except _PIIFailClosedError as exc:
        await _emit_gateway_telemetry(
            org_id=org_id,
            auth_ctx=auth_ctx,
            model=body.model,
            endpoint="embeddings",
            request_body=raw_body,
            outcome="failure",
            error_type="pii_fail_closed",
            extra_payload={"pii_findings": ["pii_fail_closed:credential_detected"]},
        )
        raise HTTPException(
            status_code=422,
            detail={
                "error": "pii_fail_closed",
                "message": (
                    "PII policy is fail-closed for this tenant and the "
                    "request contains a credential-like value. Remove "
                    "the credential or set 'pii_filter_enabled': false "
                    "in the request body to opt out per-request."
                ),
            },
        ) from exc

    client, outbound_headers, provider = _resolve_upstream(request)
    upstream_kwargs = embeddings_to_provider_kwargs(body)
    if outbound_headers:
        upstream_kwargs["extra_headers"] = outbound_headers
    start = time.monotonic()
    try:
        response = await client.embeddings.create(**upstream_kwargs)
    except _get_openai_api_error() as exc:
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
            detail=_redact_upstream_error(exc),
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
async def list_models(
    request: Request,
    auth_ctx: dict = Depends(get_ingestion_auth),
) -> ModelsListResponse:
    """``GET /gateway/v1/models`` — list available models.

    Per-request upstream (``X-Upstream-Base-Url`` + ``X-Upstream-Api-Key``)
    overrides the server-configured base URL when fetching the live
    catalogue. Falls back to the static catalogue baked into the
    adapter when the upstream call fails or is not configured.

    (Phase 7.0 — Phase 7.1 will replace this with the per-org
    ``org_gateway_models`` registry once that's shipped in unit A2.)
    """
    s = _settings()
    # Per-request upstream resolution (same logic as the chat path).
    in_base = request.headers.get("X-Upstream-Base-Url", "").strip()
    in_key = request.headers.get("X-Upstream-Api-Key", "").strip()
    if in_base or in_key:
        base_url = in_base or (
            s.minimax_base_url if s.use_minimax else s.openrouter_base_url
        )
        api_key = in_key or (
            s.minimax_api_key if s.use_minimax else s.openrouter_api_key
        ) or ""
    else:
        base_url = (
            s.minimax_base_url
            if s.use_minimax
            else (s.openrouter_base_url or "https://openrouter.ai/api/v1")
        )
        api_key = (s.minimax_api_key if s.use_minimax else s.openrouter_api_key) or ""

    upstream_rows: list[dict[str, Any]] | None = None
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
