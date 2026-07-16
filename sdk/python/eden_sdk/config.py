"""Runtime configuration for the Eden SDK.

Configuration is a process-wide singleton: calling :func:`configure`
updates the global config; :func:`get_config` returns it. Tests can
call :func:`reset_config` to drop state between cases.

All settings are read from environment variables first (so the SDK
plays nicely with ``.env``-driven deployment), then overridden by any
explicit keyword arguments passed to :func:`configure`.
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from eden_sdk.filters import FilterConfig

# Forward reference for the optional httpx transport used in
# tests + custom integrations.
_HTTPX_TRANSPORT = "httpx.AsyncBaseTransport"

logger = logging.getLogger("eden_sdk.config")

# Org id env vars. ``EDEN_ORG_ID`` is the canonical name;
# ``EDEN_DEFAULT_ORG`` is the TS SDK's fallback. We accept both so
# a single .env file works for the Python and TypeScript SDKs.
_ENV_ORG_ID_CANDIDATES = ("EDEN_ORG_ID", "EDEN_DEFAULT_ORG")
# API key env vars. ``EDEN_ORG_API_KEY`` is the more explicit alias
# used by the TypeScript SDK; ``EDEN_API_KEY`` remains the canonical
# Python-side name for backwards compatibility. Both are accepted.
_ENV_API_KEY_CANDIDATES = ("EDEN_API_KEY", "EDEN_ORG_API_KEY")
_ENV_BASE_URL = "EDEN_BASE_URL"
_ENV_PROJECT = "EDEN_PROJECT_ID"
_ENV_BATCH_SIZE = "EDEN_BATCH_SIZE"
_ENV_FLUSH_INTERVAL_MS = "EDEN_FLUSH_INTERVAL_MS"
_ENV_DISABLED = "EDEN_DISABLED"
# Env var for opt-in dry-run mode. The Python SDK historically
# read EDEN_DEBUG for this — but the SDK never mirrored
# anything to stderr (dry_run only logs at DEBUG and increments
# a counter), so the name was a doc-vs-code mismatch that
# confused users who set EDEN_DEBUG=1 expecting stderr
# output. EDEN_DRY_RUN is the canonical name now; we keep
# EDEN_DEBUG as a backward-compat alias for users that
# copied the older README into their env file.
_ENV_DRY_RUN = "EDEN_DRY_RUN"
_ENV_DEBUG = "EDEN_DEBUG"


def _env_opt_bool(name: str, *, default: bool = True) -> bool:
    """Parse an env var as an optimization on/off switch."""
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class EdenConfig:
    """Holds runtime configuration for the SDK.

    Attributes
    ----------
    org_id
        The organization ID the events are attributed to. Required
        for the SDK to actually ship anything; if absent the SDK runs
        in ``dry_run`` mode and logs to ``stderr`` instead.
    api_key
        Programmatic API key. Sent as ``X-Org-Api-Key`` header.
    base_url
        Gateway or ingestion base URL. The default
        ``"https://api.edenobservability.com"`` is production.
        Override with ``EDEN_BASE_URL`` for staging.
    project_id
        Multi-tenant project label. Defaults to ``"default"`` which is
        what the ingestion route uses when ``X-Project-Id`` is missing.
    batch_size
        Maximum number of events to buffer before a flush.
    flush_interval_ms
        Maximum time to keep a batch in memory before flushing.
    timeout_s
        Per-request HTTP timeout.
    dry_run
        If ``True``, events are logged but not posted. Useful for tests.
    disabled
        If ``True``, the SDK is a complete no-op. Set via the
        ``EDEN_DISABLED`` env var to make deployment off-switches easy.
    max_queue
        Backpressure cap. When the queue is full, oldest events are
        dropped (with a warning) to keep the SDK non-blocking.
    extra_headers
        Additional headers to send on every request (e.g. routing tags).
    redact_on_client
        If ``True`` (the default), the SDK runs a small regex pass
        over every outgoing payload to mask obvious emails, phone
        numbers, US SSNs, and credit-card numbers. This is a
        *safety net* — the gateway is the authoritative redaction
        layer and the source of truth for tenant policy. Disable
        only when the gateway is configured to handle redaction
        and you have verified the patterns the regex catches are
        not legitimate values in your payloads.
    """

    org_id: str | None = None
    api_key: str | None = None
    base_url: str = "https://api.edenobservability.com"
    # Convenience alias for the OpenAI-compatible gateway. Defaults
    # to ``"{base_url}/gateway/v1"`` when not set, so customers can
    # call ``EdenConfig(base_url="https://api.edenobservability.com")``
    # and have :meth:`gateway_headers` + :meth:`openai_client` do the
    # right thing without a second URL.
    gateway_url: str | None = None
    project_id: str = "default"
    batch_size: int = 32
    flush_interval_ms: int = 250
    timeout_s: float = 5.0
    dry_run: bool = False
    disabled: bool = False
    max_queue: int = 4096
    extra_headers: dict[str, str] = field(default_factory=dict)
    redact_on_client: bool = True
    # Per-filter configuration. When unset, the gateway applies
    # the tenant's :class:`org_pii_policies` defaults. When set,
    # the values override the tenant policy on a per-call basis
    # (rendered as ``X-PII-Mode`` / ``X-PII-Disabled-Categories``
    # headers).
    filters: FilterConfig | None = None
    # Gateway optimizations (default on). Set to ``False`` to opt out
    # of a specific server-side feature; rendered as
    # ``X-Eden-<Feature>: false`` on gateway calls.
    exact_cache: bool = True
    coalesce: bool = True
    provider_cache_layout: bool = True
    response_repair: bool = True
    # Optional httpx async transport. When set, the EdenClient
    # built by :func:`configure` uses this transport instead
    # of the default network stack. Used by tests (mock
    # transport) and by advanced integrations that need
    # custom TLS or metrics. Mutating this field after the
    # client is started has no effect on the in-flight
    # AsyncClient.
    transport: Any | None = None

    @property
    def enabled(self) -> bool:
        return not self.disabled

    def ingest_url(self, source_format: str = "openai") -> str:
        """Build the canonical ingestion URL for a source format.

        Matches the FastAPI route registered at
        ``/orgs/{org_id}/ingest/{format}`` in
        ``src/eden/api/routes/ingestion.py``.
        """
        if not self.org_id:
            raise ValueError("EdenConfig.org_id is required to build the ingest URL")
        base = self.base_url.rstrip("/")
        return f"{base}/orgs/{self.org_id}/ingest/{source_format}"

    def auth_headers(self) -> dict[str, str]:
        """Headers for any ingestion request.

        Matches ``get_ingestion_auth`` in ``src/eden/api/deps.py``:
        ``X-Org-Id`` must match the URL, ``X-Org-Api-Key`` is the
        programmatic credential.
        """
        if not self.org_id:
            return {}
        headers = {
            "X-Org-Id": self.org_id,
            "X-Project-Id": self.project_id,
        }
        if self.api_key:
            headers["X-Org-Api-Key"] = self.api_key
        headers.update(self.extra_headers)
        return headers

    def gateway_headers(
        self,
        *,
        upstream_base_url: str | None = None,
        upstream_api_key: str | None = None,
        upstream_provider: str | None = None,
        pii_bypass: bool | None = None,
        filters: FilterConfig | None = None,
    ) -> dict[str, str]:
        """Headers for talking to the OpenAI-compatible gateway.

        Returned headers include the standard Eden auth headers
        (``X-Org-Api-Key``) plus the optional per-request upstream
        routing headers (``X-Upstream-Base-Url``,
        ``X-Upstream-Api-Key``, ``X-Upstream-Provider``) and the
        per-filter configuration headers (``X-PII-Mode``,
        ``X-PII-Disabled-Categories``). Pass the result as
        ``default_headers`` to the OpenAI SDK so any call through
        the gateway lands on the chosen upstream.

        The gateway strips the credentials (``X-Upstream-Api-Key``,
        ``X-Org-Api-Key``, ``X-Org-Id``) before forwarding to the
        upstream so they never leak to a third-party provider.

        ``pii_bypass=True`` sets ``X-PII-Bypass: true``, which
        tells the gateway to skip PII redaction for this request —
        use when your system is designed to use the raw PII values
        (e.g. an internal credential-management flow that needs the
        API key to authenticate downstream). Pass ``False`` (or
        omit) to use the tenant's configured PII policy.

        ``filters`` overrides ``self.filters`` for this call. Use
        the ``EdenConfig.filters`` field for a process-wide default
        and pass ``filters=...`` here for one-off overrides.
        """
        headers = self.auth_headers()
        if upstream_base_url:
            headers["X-Upstream-Base-Url"] = upstream_base_url
        if upstream_api_key:
            headers["X-Upstream-Api-Key"] = upstream_api_key
        if upstream_provider:
            headers["X-Upstream-Provider"] = upstream_provider
        if pii_bypass is not None:
            headers["X-PII-Bypass"] = "true" if pii_bypass else "false"
        active_filters = filters if filters is not None else self.filters
        if active_filters is not None:
            headers.update(active_filters.to_headers())
        from eden_sdk.gateway_optimizations import optimization_opt_out_headers

        headers.update(
            optimization_opt_out_headers(
                exact_cache=self.exact_cache,
                coalesce=self.coalesce,
                provider_cache_layout=self.provider_cache_layout,
                response_repair=self.response_repair,
            )
        )
        return headers

    def resolved_gateway_url(self) -> str:
        """Return the OpenAI-compatible gateway URL.

        Falls back to ``"{base_url}/gateway/v1"`` when ``gateway_url``
        is unset. The default ``base_url`` of
        ``https://api.edenobservability.com`` therefore resolves to
        ``https://api.edenobservability.com/gateway/v1``.
        """
        if self.gateway_url:
            return self.gateway_url
        base = self.base_url.rstrip("/")
        if base.endswith("/gateway/v1") or base.endswith("/v1"):
            return base
        return f"{base}/gateway/v1"

    def validate(self) -> None:
        """Raise ``ValueError`` if the config can't ship events.

        Called automatically by :func:`configure` so misconfigurations
        fail at startup rather than silently dropping the first
        batch. A no-op when ``disabled`` or ``dry_run`` is set, since
        both code paths discard the queue anyway.
        """
        if self.disabled or self.dry_run:
            return
        if not self.org_id:
            raise ValueError(
                "EdenConfig.org_id is required to send events. "
                "Set it via EdenConfig(org_id=...) or the EDEN_ORG_ID env var. "
                "Pass dry_run=True to capture events in-process without shipping."
            )
        if not self.api_key and not self.extra_headers.get("X-Org-Api-Key"):
            # api_key is optional when the gateway uses another auth
            # scheme (mTLS, signed URL, etc.) — but the absence is
            # worth flagging in CI.
            import logging as _l
            _l.getLogger("eden_sdk.config").warning(
                "eden sdk: api_key is not set; auth will rely on extra_headers"
            )


# ── Singleton management ──────────────────────────────────────────────

_lock = threading.Lock()
_config: EdenConfig | None = None


def _from_env() -> EdenConfig:
    """Build a config from environment variables.

    Validation is deferred to the first call to :func:`get_config`
    because the env may not be populated at import time. The validate
    hook is invoked there, so a missing ``EDEN_ORG_ID`` will raise
    a clear ``ValueError`` instead of silently swallowing events.

    EDEN_DRY_RUN is the canonical opt-in for dry-run mode;
    EDEN_DEBUG is a back-compat alias (the older README
    documented it). EDEN_DRY_RUN wins when both are set so a
    user that explicitly sets EDEN_DRY_RUN=0 does not have
    their intent overridden by a stale EDEN_DEBUG=1.
    """
    _dry_run_raw = os.getenv(_ENV_DRY_RUN)
    if _dry_run_raw is not None:
        dry_run = _dry_run_raw.lower() in {"1", "true", "yes"}
    else:
        dry_run = os.getenv(_ENV_DEBUG, "").lower() in {"1", "true", "yes"}
    return EdenConfig(
        org_id=(
            next((v for k in _ENV_ORG_ID_CANDIDATES if (v := os.getenv(k))), None)
        ),
        api_key=(
            next((v for k in _ENV_API_KEY_CANDIDATES if (v := os.getenv(k))), None)
        ),
        base_url=os.getenv(_ENV_BASE_URL, "https://api.edenobservability.com"),
        project_id=os.getenv(_ENV_PROJECT, "default"),
        batch_size=int(os.getenv(_ENV_BATCH_SIZE, "32")),
        flush_interval_ms=int(os.getenv(_ENV_FLUSH_INTERVAL_MS, "250")),
        disabled=os.getenv(_ENV_DISABLED, "").lower() in {"1", "true", "yes"},
        dry_run=dry_run,
        exact_cache=_env_opt_bool("EDEN_EXACT_CACHE"),
        coalesce=_env_opt_bool("EDEN_COALESCE"),
        provider_cache_layout=_env_opt_bool("EDEN_PROVIDER_CACHE_LAYOUT"),
        response_repair=_env_opt_bool("EDEN_RESPONSE_REPAIR"),
    )


def configure(
    org_id: str | None = None,
    api_key: str | None = None,
    base_url: str | None = None,
    gateway_url: str | None = None,
    project_id: str | None = None,
    batch_size: int | None = None,
    flush_interval_ms: int | None = None,
    timeout_s: float | None = None,
    disabled: bool | None = None,
    dry_run: bool | None = None,
    max_queue: int | None = None,
    extra_headers: dict[str, str] | None = None,
    filters: FilterConfig | None = None,
    exact_cache: bool | None = None,
    coalesce: bool | None = None,
    provider_cache_layout: bool | None = None,
    response_repair: bool | None = None,
    **overrides: object,
) -> EdenConfig:
    """Update the global config and return it.

    Reads from the environment first, then applies overrides. Calling
    this multiple times incrementally updates the config. Pass
    ``None`` for any kwarg you don't want to change; passing the
    field's default value still counts as an explicit override.

    Recognised keyword args (in addition to ``EdenConfig`` field
    names via ``**overrides``):
        org_id, api_key, base_url, gateway_url, project_id,
        batch_size, flush_interval_ms, timeout_s, disabled,
        dry_run, max_queue, extra_headers, filters
    """
    global _config
    with _lock:
        if _config is None:
            _config = _from_env()
        # Apply overrides (only non-None values win).
        if org_id is not None:
            _config.org_id = org_id
        if api_key is not None:
            _config.api_key = api_key
        if base_url is not None:
            _config.base_url = base_url
        if gateway_url is not None:
            _config.gateway_url = gateway_url
        if project_id is not None:
            _config.project_id = project_id
        if batch_size is not None:
            _config.batch_size = batch_size
        if flush_interval_ms is not None:
            _config.flush_interval_ms = flush_interval_ms
        if timeout_s is not None:
            _config.timeout_s = timeout_s
        if disabled is not None:
            _config.disabled = disabled
        if dry_run is not None:
            _config.dry_run = dry_run
        if max_queue is not None:
            _config.max_queue = max_queue
        if extra_headers is not None:
            _config.extra_headers.update(extra_headers)
        if filters is not None:
            _config.filters = filters
        if exact_cache is not None:
            _config.exact_cache = exact_cache
        if coalesce is not None:
            _config.coalesce = coalesce
        if provider_cache_layout is not None:
            _config.provider_cache_layout = provider_cache_layout
        if response_repair is not None:
            _config.response_repair = response_repair
        for k, v in overrides.items():
            if hasattr(_config, k) and v is not None:
                setattr(_config, k, v)
        # Loud failure on misconfiguration so missing org_id / api_key
        # trips an explicit error at startup rather than silently
        # dropping events for the entire process lifetime.
        try:
            _config.validate()
        except ValueError:
            # Re-raise so the caller sees the failure immediately.
            raise
    return _config


def get_config() -> EdenConfig:
    """Return the current config, loading from env on first call.

    Permissive by default (no validation): the SDK is widely used
    for trace *capture* in environments where shipping is disabled,
    and we don't want every test / notebook import to raise.

    Call :meth:`EdenConfig.validate` explicitly (or use
    :func:`configure`) if you want startup-time validation.
    """
    global _config
    if _config is None:
        with _lock:
            if _config is None:
                _config = _from_env()
    return _config


def reset_config() -> None:
    """Drop the singleton — for tests."""
    global _config
    with _lock:
        _config = None
