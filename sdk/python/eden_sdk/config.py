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
from typing import Optional

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

    org_id: Optional[str] = None
    api_key: Optional[str] = None
    base_url: str = "http://localhost:8000"
    project_id: str = "default"
    batch_size: int = 32
    flush_interval_ms: int = 250
    timeout_s: float = 5.0
    dry_run: bool = False
    disabled: bool = False
    max_queue: int = 4096
    extra_headers: dict[str, str] = field(default_factory=dict)

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


# ── Singleton management ──────────────────────────────────────────────

_lock = threading.Lock()
_config: Optional[EdenConfig] = None


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
    org_id: Optional[str] = None,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
    project_id: Optional[str] = None,
    batch_size: Optional[int] = None,
    flush_interval_ms: Optional[int] = None,
    disabled: Optional[bool] = None,
    dry_run: Optional[bool] = None,
    max_queue: Optional[int] = None,
    extra_headers: Optional[dict[str, str]] = None,
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
