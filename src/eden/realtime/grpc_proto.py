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

from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable

# ─────────────────────────────────────────────────────────────────────────────
# Message types
# ─────────────────────────────────────────────────────────────────────────────


@dataclass
class StreamRequest:
    topic: str = ""
    last_event_id: str = ""


@dataclass
class Event:
    event_id: str = ""
    event_type: str = ""
    entity_id: str = ""
    source_format: str = ""
    timestamp_ms: int = 0
    tags: dict[str, str] = field(default_factory=dict)
    payload: bytes = b""


@dataclass
class Ack:
    ok: bool = False
    event_id: str = ""
    error: str = ""


# ─────────────────────────────────────────────────────────────────────────────
# Servicer registration
# ─────────────────────────────────────────────────────────────────────────────

# A real protoc-generated ``grpc_proto`` module would expose
# ``add_RealtimeServicer_to_server`` which wires the servicer into a
# server. The runtime in :mod:`eden.realtime.grpc_server` calls this
# function. We provide a no-op shim that records the servicer for
# future use; when actual generated bindings replace this file, the
# shim is removed and the real function takes over.

_servicers: list[Any] = []


def add_RealtimeServicer_to_server(servicer: Any, server: Any) -> None:
    """Register ``servicer`` on ``server``.

    Placeholder: stores the servicer so we can introspect registered
    services from tests. A real implementation would wrap each
    servicer method into a gRPC ``rpc_method_handler``.
    """
    _servicers.append(servicer)
    return None
