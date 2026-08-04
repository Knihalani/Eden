"""Stub for the gRPC protobuf bindings used by the gRPC server.

This file is checked in so the gRPC server module can import without
requiring a separate ``protoc`` build step. When you update the
schema in :mod:`eden.realtime.grpc_server` (PROTO_SCHEMA), regenerate
this stub with::

    python scripts/generate_grpc_stubs.py

For now we provide a pure-Python representation that is structurally
equivalent to the generated protobuf code. ``add_RealtimeServicer_to_server``
binds the servicer into a gRPC server.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass, field, fields
from typing import Any, Self

# ─────────────────────────────────────────────────────────────────────────────
# Message types
# ─────────────────────────────────────────────────────────────────────────────


class _Message:
    """JSON-over-bytes wire codec shared by all message classes.

    Stands in for protobuf's ``SerializeToString``/``FromString`` so the
    generic handlers built by :func:`add_RealtimeServicer_to_server` can
    move real bytes over the wire. The encoding is Eden-internal (JSON,
    with ``bytes`` fields base64-encoded) — it is *not* protobuf wire
    format, so clients must use these same message classes (or the
    matching codec) to talk to the server.
    """

    def SerializeToString(self) -> bytes:  # noqa: N802 - protobuf-compatible name
        data: dict[str, Any] = {}
        for f in fields(self):  # type: ignore[arg-type]
            value = getattr(self, f.name)
            if isinstance(value, bytes):
                value = base64.b64encode(value).decode("ascii")
            data[f.name] = value
        return json.dumps(data, separators=(",", ":")).encode("utf-8")

    @classmethod
    def FromString(cls, data: bytes) -> Self:  # noqa: N802 - protobuf-compatible name
        raw: dict[str, Any] = json.loads(data.decode("utf-8")) if data else {}
        kwargs: dict[str, Any] = {}
        for f in fields(cls):  # type: ignore[arg-type]
            if f.name not in raw:
                continue
            value = raw[f.name]
            if f.type in ("bytes", bytes) and isinstance(value, str):
                value = base64.b64decode(value)
            kwargs[f.name] = value
        return cls(**kwargs)


@dataclass
class StreamRequest(_Message):
    topic: str = ""
    last_event_id: str = ""


@dataclass
class Event(_Message):
    event_id: str = ""
    event_type: str = ""
    entity_id: str = ""
    source_format: str = ""
    timestamp_ms: int = 0
    tags: dict[str, str] = field(default_factory=dict)
    payload: bytes = b""


@dataclass
class Ack(_Message):
    ok: bool = False
    event_id: str = ""
    error: str = ""


# ─────────────────────────────────────────────────────────────────────────────
# Servicer registration
# ─────────────────────────────────────────────────────────────────────────────

# Mirrors the shape of a protoc-generated ``add_RealtimeServicer_to_server``:
# each servicer method is wrapped in a gRPC ``rpc_method_handler`` and
# registered under the ``eden.internal.v1.Realtime`` service name, using
# the JSON-over-bytes codec above for (de)serialization. The runtime in
# :mod:`eden.realtime.grpc_server` calls this function.

SERVICE_NAME = "eden.internal.v1.Realtime"

_servicers: list[Any] = []


def add_RealtimeServicer_to_server(servicer: Any, server: Any) -> None:
    """Register ``servicer`` on ``server`` with real RPC method handlers.

    Wires the three ``Realtime`` RPCs (``StreamEvents``, ``PublishEvent``,
    ``BidiStream``) into ``server`` via a generic handler, matching the
    streaming shapes declared in ``PROTO_SCHEMA``. Requires ``grpcio``;
    imported lazily so this module stays importable without it.
    """
    import grpc

    rpc_method_handlers = {
        "StreamEvents": grpc.unary_stream_rpc_method_handler(
            servicer.StreamEvents,
            request_deserializer=StreamRequest.FromString,
            response_serializer=Event.SerializeToString,
        ),
        "PublishEvent": grpc.unary_unary_rpc_method_handler(
            servicer.PublishEvent,
            request_deserializer=Event.FromString,
            response_serializer=Ack.SerializeToString,
        ),
        "BidiStream": grpc.stream_stream_rpc_method_handler(
            servicer.BidiStream,
            request_deserializer=Event.FromString,
            response_serializer=Event.SerializeToString,
        ),
    }
    generic_handler = grpc.method_handlers_generic_handler(SERVICE_NAME, rpc_method_handlers)
    server.add_generic_rpc_handlers((generic_handler,))
    _servicers.append(servicer)
