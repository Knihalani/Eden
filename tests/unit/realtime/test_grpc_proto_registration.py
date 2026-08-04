"""Regression tests: ``add_RealtimeServicer_to_server`` must register real handlers.

The original shim appended the servicer to a module-level list and
registered nothing on the server, so ``grpc_server.serve()`` started,
logged "listening", and answered every RPC with UNIMPLEMENTED. These
tests pin the honest behaviour: handlers for all three ``Realtime``
RPCs are installed with working (de)serializers, and a real call over
a real channel succeeds.
"""

from __future__ import annotations

from collections import namedtuple
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.realtime.grpc_proto import (
    SERVICE_NAME,
    Ack,
    Event,
    StreamRequest,
    add_RealtimeServicer_to_server,
)

# ─────────────────────────────────────────────────────────────────────────────
# Wire codec
# ─────────────────────────────────────────────────────────────────────────────


def test_event_round_trips_through_wire_codec() -> None:
    ev = Event(
        event_id="e1",
        event_type="trace",
        entity_id="tenant-1",
        source_format="grpc",
        timestamp_ms=1234,
        tags={"env": "test"},
        payload=b'{"a": 1}',
    )
    assert Event.FromString(ev.SerializeToString()) == ev


def test_ack_and_stream_request_round_trip() -> None:
    ack = Ack(ok=False, event_id="e1", error="boom")
    req = StreamRequest(topic="eden-trace", last_event_id="e9")
    assert Ack.FromString(ack.SerializeToString()) == ack
    assert StreamRequest.FromString(req.SerializeToString()) == req


def test_from_string_of_empty_bytes_yields_defaults() -> None:
    assert Event.FromString(b"") == Event()
    assert StreamRequest.FromString(b"") == StreamRequest()


# ─────────────────────────────────────────────────────────────────────────────
# Handler registration
# ─────────────────────────────────────────────────────────────────────────────

_CallDetails = namedtuple("_CallDetails", ["method", "invocation_metadata"])


def test_registration_installs_handlers_for_all_rpcs() -> None:
    pytest.importorskip("grpc")

    server = MagicMock()
    add_RealtimeServicer_to_server(MagicMock(), server)

    server.add_generic_rpc_handlers.assert_called_once()
    (handlers,) = server.add_generic_rpc_handlers.call_args.args
    handler = handlers[0]

    # (request_streaming, response_streaming, request message class)
    expectations = {
        "StreamEvents": (False, True, StreamRequest),
        "PublishEvent": (False, False, Event),
        "BidiStream": (True, True, Event),
    }
    for method, (req_streaming, resp_streaming, request_cls) in expectations.items():
        rpc = handler.service(
            _CallDetails(method=f"/{SERVICE_NAME}/{method}", invocation_metadata=())
        )
        assert rpc is not None, f"{method} is not registered on the server"
        assert rpc.request_streaming is req_streaming
        assert rpc.response_streaming is resp_streaming
        assert rpc.request_deserializer == request_cls.FromString


# ─────────────────────────────────────────────────────────────────────────────
# End to end: a real RPC over a real channel must not be UNIMPLEMENTED
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_publish_event_over_real_channel_returns_ack() -> None:
    grpc = pytest.importorskip("grpc")

    from eden.realtime import grpc_server as mod

    store = MagicMock()
    store.append = AsyncMock()

    # ``get_trace_event_store`` is imported locally inside
    # ``_build_servicer`` (fresh each call), so patch it at its source
    # module rather than on ``grpc_server`` itself.
    with patch(
        "eden.realtime.trace_store.get_trace_event_store",
        new=AsyncMock(return_value=store),
    ):
        servicer_cls = mod._build_servicer()
        server = grpc.aio.server()
        add_RealtimeServicer_to_server(servicer_cls(), server)
        port = server.add_insecure_port("127.0.0.1:0")
        await server.start()
        try:
            async with grpc.aio.insecure_channel(f"127.0.0.1:{port}") as channel:
                publish = channel.unary_unary(
                    f"/{SERVICE_NAME}/PublishEvent",
                    request_serializer=Event.SerializeToString,
                    response_deserializer=Ack.FromString,
                )
                ack = await publish(
                    Event(event_id="e1", event_type="trace", entity_id="t1", payload=b"{}")
                )
        finally:
            await server.stop(grace=None)

    assert isinstance(ack, Ack)
    assert ack.ok is True
    assert ack.event_id == "e1"
    store.append.assert_awaited_once()
