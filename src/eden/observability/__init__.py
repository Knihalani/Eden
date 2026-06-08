"""Eden observability layer (Phase 7.0 stub).

This package is the canonical location for the OpenTelemetry-shaped
telemetry surfaces in Eden: the in-process ``TelemetryCollector``,
the source-format decoders, and the OTel gRPC receiver. The full
implementation lands in Phase 7.2 — for Batch A1 (the OpenAI-
compatible gateway) we only need the import surface so the gateway
and its tests can resolve ``eden.observability.telemetry_collector``.

Stubs here MUST be backwards-compatible with the in-flight Phase 7.0
ingestion code (see ``eden.api.routes.ingestion`` once it lands) so
the gateway's ``source_format="openai_gateway"`` events flow into the
same collector instance the SDK and OTel paths use.
"""
