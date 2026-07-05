"""gRPC server for service-to-service streaming.

Phase 6.2.2: exposes a binary-streaming API for high-throughput
service-to-service communication. Pairs with :mod:`.grpc_client`.

Why gRPC (vs JSON-over-HTTP) here:
- Protobuf schema is type-safe and self-documenting.
- Bidirectional streaming over a single HTTP/2 connection.
- Schema evolution via field tags.

Service: ``eden.internal.v1.Realtime``
    - ``StreamEvents(Empty) returns (stream Event)`` — server-stream
    - ``PublishEvent(Event) returns (Ack)`` — unary
    - ``BidiStream(stream Event) returns (stream Event)`` — bidi

If the ``grpcio`` package is not installed (it's optional), the server
prints a clear error and exits. The rest of the platform keeps
working over JSON.

Run with::

    python -m eden.realtime.grpc_server
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import sys
from datetime import UTC, datetime
from typing import Any

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Proto schema (inline — keep all gRPC stubs in this file for simplicity)
# ─────────────────────────────────────────────────────────────────────────────
# If we later switch to .proto file generation, replace this section
# with `import eden_realtime_pb2` etc.

PROTO_SCHEMA = """
syntax = "proto3";
package eden.internal.v1;

service Realtime {
  // Server streaming — clients receive every event as it's published
  rpc StreamEvents(StreamRequest) returns (stream Event);

  // Unary — single event publish
  rpc PublishEvent(Event) returns (Ack);

  // Bidirectional — clients publish and receive on the same stream
  rpc BidiStream(stream Event) returns (stream Event);
}

message StreamRequest {
  string topic = 1;          // eden-trace, eden-alert, eden-benchmark, …
  string last_event_id = 2;  // resume token (optional)
}

message Event {
  string event_id = 1;
  string event_type = 2;
  string entity_id = 3;
  string source_format = 4;
  int64  timestamp_ms = 5;
  map<string, string> tags = 6;
  bytes  payload = 7;        // JSON-encoded payload
}

message Ack {
  bool   ok = 1;
  string event_id = 2;
  string error = 3;
}
"""


# ─────────────────────────────────────────────────────────────────────────────
# gRPC servicer
# ─────────────────────────────────────────────────────────────────────────────


def _build_servicer():
    """Build the servicer. Imported lazily so missing grpcio is a
    clear error at runtime, not at import time."""
    from eden.realtime.trace_store import get_trace_event_store  # noqa: F401

    class RealtimeServicer:
        """Implements the Realtime service.

        Backed by the same :class:`TraceEventStore` used by the
        WebSocket and SSE endpoints, so behaviour is identical
        regardless of transport.
        """

        async def StreamEvents(self, request, context):  # type: ignore[no-untyped-def]
            store = await get_trace_event_store()
            topic = request.topic or "eden-trace"
            last_event_id = request.last_event_id or ""

            # Replay missed events
            if last_event_id:
                async for ev in store.get_events_after(topic, last_event_id):
                    yield _to_proto_event(ev)

            # Then live stream
            queue: asyncio.Queue = asyncio.Queue(maxsize=200)

            async def publish_loop():
                # In production, subscribe to a Redis pub/sub channel
                # backed by the Kafka consumer. For now, sleep and
                # surface new events from the store periodically.
                while True:
                    await asyncio.sleep(1.0)
                    for ev in await store.get_events_after(topic, last_event_id, limit=10):
                        ev.get("event_id", last_event_id)
                        await queue.put(ev)

            task = asyncio.create_task(publish_loop())
            try:
                while True:
                    ev = await queue.get()
                    yield _to_proto_event(ev)
            finally:
                task.cancel()

        async def PublishEvent(self, request, context):  # type: ignore[no-untyped-def]
            try:
                store = await get_trace_event_store()
                # Decode JSON payload
                try:
                    payload = json.loads(request.payload.decode() or "{}")
                except Exception:
                    payload = {"_raw": request.payload.hex()}

                # TraceEventStore.append takes a TraceEvent — but to
                # avoid circular imports we just insert into the
                # underlying store via the public append path.
                from eden.realtime.trace_store import TraceEvent

                ev = TraceEvent(
                    event_id=request.event_id,
                    event_type=request.event_type,
                    entity_id=request.entity_id,
                    payload=payload,
                    timestamp=datetime.now(UTC),
                )
                await store.append(request.entity_id, ev)
                return _to_proto_ack(ok=True, event_id=request.event_id)
            except Exception as exc:
                return _to_proto_ack(ok=False, event_id=request.event_id, error=str(exc))

        async def BidiStream(self, request_iterator, context):  # type: ignore[no-untyped-def]
            store = await get_trace_event_store()
            upstream: asyncio.Queue = asyncio.Queue(maxsize=200)

            async def pump_in():
                async for ev in request_iterator:
                    try:
                        payload = json.loads(ev.payload.decode() or "{}")
                    except Exception:
                        payload = {}
                    from eden.realtime.trace_store import TraceEvent

                    await store.append(
                        ev.entity_id,
                        TraceEvent(
                            event_id=ev.event_id,
                            event_type=ev.event_type,
                            entity_id=ev.entity_id,
                            payload=payload,
                            timestamp=datetime.now(UTC),
                        ),
                    )
                    await upstream.put(ev)

            task = asyncio.create_task(pump_in())
            try:
                # Echo upstream events back to the client
                while True:
                    ev = await upstream.get()
                    yield _to_proto_event({
                        "event_id": ev.event_id,
                        "event_type": ev.event_type,
                        "entity_id": ev.entity_id,
                        "payload": {},
                        "timestamp_ms": int(datetime.now(UTC).timestamp() * 1000),
                    })
            finally:
                task.cancel()

    return RealtimeServicer


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────


def _to_proto_event(ev: dict[str, Any]) -> Any:
    """Build a proto Event message from a dict."""
    from eden.realtime import grpc_proto as pb

    timestamp = ev.get("timestamp")
    if isinstance(timestamp, str):
        try:
            dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            ts_ms = int(dt.timestamp() * 1000)
        except Exception:
            ts_ms = 0
    elif isinstance(timestamp, (int, float)):
        ts_ms = int(timestamp)
    else:
        ts_ms = 0

    payload_dict = ev.get("payload") or {}
    if not isinstance(payload_dict, dict):
        payload_dict = {"_value": str(payload_dict)}

    return pb.Event(
        event_id=ev.get("event_id", ""),
        event_type=ev.get("event_type", ""),
        entity_id=ev.get("entity_id", ""),
        source_format=ev.get("source_format", "grpc"),
        timestamp_ms=ts_ms,
        tags={k: str(v) for k, v in (ev.get("tags") or {}).items()},
        payload=json.dumps(payload_dict).encode(),
    )


def _to_proto_ack(*, ok: bool, event_id: str, error: str = "") -> Any:
    from eden.realtime import grpc_proto as pb

    return pb.Ack(ok=ok, event_id=event_id, error=error)


# ─────────────────────────────────────────────────────────────────────────────
# Server entrypoint
# ─────────────────────────────────────────────────────────────────────────────


async def serve() -> None:
    """Start the gRPC server. Reads GRPC_HOST/GRPC_PORT/GRPC_TLS_* from env."""
    try:
        import grpc  # type: ignore
    except ImportError:
        logger.error(
            "grpcio not installed. Run `pip install grpcio grpcio-tools` "
            "and re-run `python scripts/generate_grpc_stubs.py`."
        )
        sys.exit(1)

    # Ensure proto stubs exist
    from eden.realtime import grpc_proto  # noqa: F401

    host = os.environ.get("GRPC_HOST", "0.0.0.0")
    port = int(os.environ.get("GRPC_PORT", "50051"))

    servicer = _build_servicer()
    add_RealtimeServicer_to_server = grpc_proto.add_RealtimeServicer_to_server

    server = grpc.aio.server()
    add_RealtimeServicer_to_server(servicer(), server)
    bind = f"{host}:{port}"

    tls_enabled = os.environ.get("GRPC_TLS_ENABLED", "").lower() in ("1", "true", "yes", "on")
    if tls_enabled:
        cert_path = os.environ.get("GRPC_TLS_CERT_PATH")
        key_path = os.environ.get("GRPC_TLS_KEY_PATH")
        if not (cert_path and key_path):
            raise RuntimeError("GRPC_TLS_ENABLED=true but cert/key paths are missing")
        with open(cert_path, "rb") as f:
            cert = f.read()
        with open(key_path, "rb") as f:
            key = f.read()
        creds = grpc.ssl_server_credentials([(key, cert)])
        server.add_secure_port(bind, creds)
    else:
        server.add_insecure_port(bind)

    await server.start()
    logger.info(f"gRPC server listening on {bind} (TLS={tls_enabled})")

    # Graceful shutdown
    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    def _stop(*_):
        stop_event.set()

    try:
        loop.add_signal_handler(signal.SIGTERM, _stop)
        loop.add_signal_handler(signal.SIGINT, _stop)
    except NotImplementedError:
        # Windows / restricted env
        pass

    await stop_event.wait()
    await server.stop(grace=5.0)
    logger.info("gRPC server stopped")


def main() -> None:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    )
    asyncio.run(serve())


if __name__ == "__main__":
    main()
