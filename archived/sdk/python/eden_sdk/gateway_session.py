"""High-level convenience helpers for talking to the Eden gateway.

Most customers want a configured OpenAI client in one call, with
the right auth + per-filter headers pre-baked. :func:`openai_client`
wraps the OpenAI SDK constructor with that wiring so callers can
go straight from a configured :class:`EdenConfig` to a working
chat completion.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from openai import OpenAI

    from eden_sdk.config import EdenConfig
    from eden_sdk.filters import FilterConfig

logger = logging.getLogger("eden_sdk.gateway_session")


def openai_client(
    config: EdenConfig,
    *,
    filters: FilterConfig | None = None,
    upstream_base_url: str | None = None,
    upstream_api_key: str | None = None,
    upstream_provider: str | None = None,
    pii_bypass: bool | None = None,
) -> OpenAI:
    """Build a configured :class:`openai.OpenAI` client.

    The returned client points at Eden's OpenAI-compatible gateway
    (URL derived from ``config.resolved_gateway_url()``) and carries
    the right ``default_headers`` so every chat completion goes
    through the configured filter chain.

    Parameters
    ----------
    config
        A configured :class:`EdenConfig`. ``config.org_id`` and
        ``config.api_key`` are required.
    filters
        Per-call filter overrides. When ``None``, uses
        ``config.filters``. Use this to layer one-off overrides on
        top of the process-wide default.
    upstream_base_url, upstream_api_key, upstream_provider
        Per-request upstream routing. See
        :meth:`EdenConfig.gateway_headers` for semantics.
    pii_bypass
        Per-request PII bypass. Equivalent to setting
        ``X-PII-Bypass: true``. Wins over both the per-call
        ``filters`` and the process-wide ``config.filters``.

    Returns
    -------
    openai.OpenAI
        A client ready to call ``.chat.completions.create(...)``.

    Notes
    -----
    The OpenAI SDK is an optional dependency; this helper imports
    it lazily so the SDK works for users that only need the
    non-OpenAI surface (the tracer, the auto-instrumentations for
    Anthropic / LangChain, etc.).
    """
    try:
        from openai import OpenAI  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError(
            "openai_client() requires the openai package; install "
            "it with `pip install openai>=1.0.0`."
        ) from exc

    headers = config.gateway_headers(
        upstream_base_url=upstream_base_url,
        upstream_api_key=upstream_api_key,
        upstream_provider=upstream_provider,
        pii_bypass=pii_bypass,
        filters=filters,
    )

    return OpenAI(
        api_key=config.api_key or "sk-no-key",
        base_url=config.resolved_gateway_url(),
        default_headers=headers,
    )


def chat_completion(
    config: EdenConfig,
    *,
    model: str,
    messages: list[dict[str, Any]],
    filters: FilterConfig | None = None,
    upstream_base_url: str | None = None,
    upstream_api_key: str | None = None,
    upstream_provider: str | None = None,
    pii_bypass: bool | None = None,
    stream: bool = False,
    **kwargs: Any,
) -> Any:
    """One-shot chat completion through the Eden gateway.

    Builds the client via :func:`openai_client`, makes the call,
    and returns the response. Use this when you don't need to keep
    the client around — for a long-lived session prefer building
    the client once via :func:`openai_client` and reusing it.

    Returns either a ``ChatCompletion`` or, when ``stream=True``,
    a streaming response object the caller iterates.
    """
    client = openai_client(
        config,
        filters=filters,
        upstream_base_url=upstream_base_url,
        upstream_api_key=upstream_api_key,
        upstream_provider=upstream_provider,
        pii_bypass=pii_bypass,
    )
    return client.chat.completions.create(
        model=model,
        messages=messages,
        stream=stream,
        **kwargs,
    )
