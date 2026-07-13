"""OpenTelemetry bridge — forward OTLP spans to Eden ingest."""

from __future__ import annotations

import logging
from typing import Any

from eden_sdk.config import get_config

logger = logging.getLogger("eden_sdk.otel")

_configured = False


def configure_exporter(
    *,
    service_name: str = "eden-sdk",
    framework: str | None = None,
    **kwargs: Any,
) -> None:
    """Configure an OTLP HTTP exporter that posts to Eden ``/ingest/otel``.

  Requires optional deps: ``opentelemetry-sdk`` and
  ``opentelemetry-exporter-otlp-proto-http``.
  """
    global _configured
    cfg = get_config()
    if not cfg.org_id:
        raise RuntimeError("eden.configure(org_id=...) is required before configure_exporter()")

    try:
        from opentelemetry import trace
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError as exc:
        raise RuntimeError(
            "OpenTelemetry bridge requires: pip install opentelemetry-sdk "
            "opentelemetry-exporter-otlp-proto-http"
        ) from exc

    endpoint = f"{cfg.base_url.rstrip('/')}/orgs/{cfg.org_id}/ingest/otel"
    headers: dict[str, str] = {}
    if cfg.api_key:
        headers["X-Org-Api-Key"] = cfg.api_key
    if cfg.project_id:
        headers["X-Project-Id"] = cfg.project_id
    if framework:
        headers["X-Source-Framework"] = framework
    headers.update(cfg.extra_headers or {})

    resource = Resource.create({"service.name": service_name, **kwargs})
    provider = TracerProvider(resource=resource)
    exporter = OTLPSpanExporter(endpoint=endpoint, headers=headers)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    _configured = True
    logger.debug("eden: OTLP exporter configured -> %s", endpoint)


def is_configured() -> bool:
    return _configured
