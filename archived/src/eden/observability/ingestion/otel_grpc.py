"""OTel gRPC receiver for OTLP trace exports.

Phase 7.2c: stand up a small gRPC server on
``settings.ingestion_otlp_grpc_port`` (default 4317) that accepts
``opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest``
and routes every span through the existing ``OtelDecoder.decode``
pipeline.

This is the path collectors / SDKs use when they speak OTLP/gRPC
instead of OTLP/HTTP. Both protocols now land in the same place.

Lifecycle: the server is started in the FastAPI lifespan (see
``api/app.py``) and shut down on app close. Per-tenant rate limits
and PII pre-mask happen downstream in the decoder.
"""

from __future__ import annotations

import logging

import grpc
from google.protobuf import json_format
from opentelemetry.proto.collector.trace.v1 import (
    trace_service_pb2,
    trace_service_pb2_grpc,
)

from eden.config import get_settings

logger = logging.getLogger(__name__)


class TraceExportServicer(trace_service_pb2_grpc.TraceServiceServicer):
    """gRPC servicer that converts OTLP proto → JSON → ingest."""

    async def Export(
        self,
        request: trace_service_pb2.ExportTraceServiceRequest,
        context: grpc.aio.ServicerContext,
    ) -> trace_service_pb2.ExportTraceServiceResponse:
        # Serialize the entire ExportTraceServiceRequest to JSON; the
        # existing OtelDecoder already handles the JSON shape (with
        # any-wrapped values already decoded by ``_decode_any_value``).
        try:
            payload = json_format.MessageToJson(request)
        except Exception as exc:
            logger.warning(f"OTel gRPC: failed to serialize request: {exc}")
            await context.abort(
                grpc.StatusCode.INVALID_ARGUMENT,
                f"failed to serialize OTLP request: {exc}",
            )
            return trace_service_pb2.ExportTraceServiceResponse()

        try:
            await _ingest_otlp_json(payload)
        except Exception as exc:
            logger.exception(f"OTel gRPC: ingest failed: {exc}")
            # Don't abort — best-effort, like the rest of the collector.
        return trace_service_pb2.ExportTraceServiceResponse()


async def _ingest_otlp_json(payload: str) -> None:
    """Pipe a serialized ExportTraceServiceRequest through the existing
    HTTP ingest path. The OtelDecoder handles the same JSON shape."""
    from eden.api.routes.ingestion import _handle_otel_ingest
    from eden.observability.ingestion.attribution import Attribution
    from eden.observability.ingestion.errors import IngestError

    get_settings()
    # gRPC clients don't carry an explicit tenant_id — we use a header
    # sent via gRPC metadata. Production deployments would route via
    # an auth interceptor. The metadata dict is currently a no-op
    # (the grpc context isn't wired into the request handler).
    attribution = Attribution(
        tenant_id="otel_grpc",
        project_id="otel_grpc",
        source_format="otel",
        user_id=None,
        api_key_id=None,
        auth_method="grpc",
    )
    try:
        await _handle_otel_ingest(payload.encode("utf-8"), attribution)
    except IngestError as exc:
        logger.debug(f"OTel gRPC ingest rejected: {exc}")
    except Exception as exc:
        logger.debug(f"OTel gRPC ingest error: {exc}")


# ── Server lifecycle ─────────────────────────────────────────────────

_server: grpc.aio.Server | None = None


async def start_otel_grpc_server() -> None:
    """Start the OTLP gRPC receiver. Idempotent — safe to call multiple
    times; only the first call starts the server."""
    global _server
    if _server is not None:
        return
    settings = get_settings()
    if not settings.ingestion_otlp_enabled:
        logger.info("OTel gRPC receiver disabled (ingestion_otlp_enabled=False)")
        return

    server = grpc.aio.server(
        options=[
            ("grpc.max_receive_message_length", 8 * 1024 * 1024),
            ("grpc.max_send_message_length", 8 * 1024 * 1024),
        ]
    )
    trace_service_pb2_grpc.add_TraceServiceServicer_to_server(
        TraceExportServicer(), server
    )
    bind = f"{settings.ingestion_otlp_grpc_host}:{settings.ingestion_otlp_grpc_port}"
    server.add_insecure_port(bind)
    await server.start()
    _server = server
    logger.info(f"OTel gRPC receiver listening on {bind}")


async def stop_otel_grpc_server() -> None:
    """Stop the OTLP gRPC receiver. Called from the FastAPI lifespan
    on shutdown."""
    global _server
    if _server is None:
        return
    logger.info("Stopping OTel gRPC receiver...")
    await _server.stop(grace=2.0)
    _server = None
