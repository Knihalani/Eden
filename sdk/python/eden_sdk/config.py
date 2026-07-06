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
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from eden_sdk.filters import FilterConfig

logger = logging.getLogger("eden_sdk.config")

_ENV_ORG_ID = "EDEN_ORG_ID"
_ENV_API_KEY = "EDEN_API_KEY"
_ENV_BASE_URL = "EDEN_BASE_URL"
_ENV_PROJECT = "EDEN_PROJECT_ID"
_ENV_BATCH_SIZE = "EDEN_BATCH_SIZE"
_ENV_FLUSH_INTERVAL_MS = "EDEN_FLUSH_INTERVAL_MS"
_ENV_DISABLED = "EDEN_DISABLED"
_ENV_DEBUG = "EDEN_DEBUG"


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
        ``"http://localhost:8000"`` matches the Eden FastAPI dev
        server (override in production).
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
    """

    org_id: str | None = None
    api_key: str | None = None
    base_url: str = "http://localhost:8000"
    # Convenience alias for the OpenAI-compatible gateway. Defaults
    # to ``"{base_url}/v1"`` when not set, so customers can call
    # ``EdenConfig(base_url="https://api.eden.ai")`` and have
    # :meth:`gateway_headers` + :meth:`openai_client` do the right
    # thing without a second URL.
    gateway_url: str | None = None
    project_id: str = "default"
    batch_size: int = 32
    flush_interval_ms: int = 250
    timeout_s: float = 5.0
    dry_run: bool = False
    disabled: bool = False
    max_queue: int = 4096
    extra_headers: dict[str, str] = field(default_factory=dict)
    # Per-filter configuration. When unset, the gateway applies
    # the tenant's :class:`org_pii_policies` defaults. When set,
    # the values override the tenant policy on a per-call basis
    # (rendered as ``X-PII-Mode`` / ``X-PII-Disabled-Categories``
    # headers).
    filters: FilterConfig | None = None

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
        return headers

    def resolved_gateway_url(self) -> str:
        """Return the OpenAI-compatible gateway URL.

        Falls back to ``"{base_url}/v1"`` when ``gateway_url`` is
        unset. The default ``base_url`` of ``http://localhost:8000``
        therefore resolves to ``http://localhost:8000/v1``.
        """
        if self.gateway_url:
            return self.gateway_url
        base = self.base_url.rstrip("/")
        if base.endswith("/v1"):
            return base
        return f"{base}/v1"


# ── Singleton management ──────────────────────────────────────────────

_lock = threading.Lock()
_config: EdenConfig | None = None


def _from_env() -> EdenConfig:
    """Build a config from environment variables, never raising."""
    return EdenConfig(
        org_id=os.getenv(_ENV_ORG_ID) or None,
        api_key=os.getenv(_ENV_API_KEY) or None,
        base_url=os.getenv(_ENV_BASE_URL, "http://localhost:8000"),
        project_id=os.getenv(_ENV_PROJECT, "default"),
        batch_size=int(os.getenv(_ENV_BATCH_SIZE, "32")),
        flush_interval_ms=int(os.getenv(_ENV_FLUSH_INTERVAL_MS, "250")),
        disabled=os.getenv(_ENV_DISABLED, "").lower() in {"1", "true", "yes"},
        dry_run=os.getenv(_ENV_DEBUG, "").lower() in {"1", "true", "yes"},
    )


def configure(
    org_id: str | None = None,
    api_key: str | None = None,
    base_url: str | None = None,
    project_id: str | None = None,
    batch_size: int | None = None,
    flush_interval_ms: int | None = None,
    disabled: bool | None = None,
    dry_run: bool | None = None,
    max_queue: int | None = None,
    extra_headers: dict[str, str] | None = None,
    **overrides: object,
) -> EdenConfig:
    """Update the global config and return it.

    Reads from the environment first, then applies overrides. Calling
    this multiple times incrementally updates the config.
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
        if project_id is not None:
            _config.project_id = project_id
        if batch_size is not None:
            _config.batch_size = batch_size
        if flush_interval_ms is not None:
            _config.flush_interval_ms = flush_interval_ms
        if disabled is not None:
            _config.disabled = disabled
        if dry_run is not None:
            _config.dry_run = dry_run
        if max_queue is not None:
            _config.max_queue = max_queue
        if extra_headers is not None:
            _config.extra_headers.update(extra_headers)
        for k, v in overrides.items():
            if hasattr(_config, k) and v is not None:
                setattr(_config, k, v)
    return _config


def get_config() -> EdenConfig:
    """Return the current config, loading from env on first call."""
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
