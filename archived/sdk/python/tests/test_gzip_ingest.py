"""Wire Content-Encoding round-trip for SDK ingest (K35 + N2 zstd)."""

from __future__ import annotations

import asyncio
import gzip
import json
import sys
from pathlib import Path

import httpx

from eden_sdk import _wire_compress as wc
from eden_sdk.client import EdenClient, TraceEvent
from eden_sdk.config import EdenConfig
from tests._http_body import decode_ingest_body


def test_send_batch_sets_wire_content_encoding() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["encoding"] = request.headers.get("content-encoding")
        seen["body"] = bytes(request.content)
        seen["decoded"] = decode_ingest_body(request.content, request.headers)
        return httpx.Response(200, json={"accepted": 1})

    cfg = EdenConfig(
        org_id="o",
        api_key="k",
        base_url="https://api.example.com",
        timeout_s=2.0,
        flush_interval_ms=10000,
        batch_size=50,
    )
    transport = httpx.MockTransport(handler)
    client = EdenClient(cfg, transport=transport)
    client._http = httpx.AsyncClient(timeout=2.0, transport=transport)
    batch = [
        TraceEvent(
            payload={"event_id": "e1", "event_type": "agent.run"},
            source_format="openai",
        )
    ]
    asyncio.run(client._send_batch(batch))

    body = seen["body"]
    assert isinstance(body, (bytes, bytearray))
    encoding = seen["encoding"]
    if wc._HAVE_ZSTD:
        assert encoding == "zstd"
        assert bytes(body)[:4] == wc._ZSTD_MAGIC
    else:
        assert encoding == "gzip"
        assert bytes(body)[:2] == b"\x1f\x8b"
    decoded = seen["decoded"]
    assert isinstance(decoded, list)
    assert decoded[0]["event_id"] == "e1"


def test_maybe_gunzip_round_trip() -> None:
    # Prefer monorepo helper when available; else exercise stdlib parity.
    repo_root = Path(__file__).resolve().parents[3]
    src = repo_root / "src"
    if str(src) not in sys.path:
        sys.path.insert(0, str(src))
    try:
        from eden.observability.ingestion.providers import maybe_gunzip_body
    except ImportError:
        from eden_sdk._wire_compress import (
            WIRE_GZIP,
            compress_wire,
            is_zstd_body,
        )

        def maybe_gunzip_body(
            body: bytes, content_encoding: str | None = None
        ) -> bytes:
            """Local fallback mirroring the backend's decode logic."""
            encoding = (content_encoding or "").lower()
            if "zstd" in encoding or is_zstd_body(body):
                import zstandard

                return zstandard.ZstdDecompressor().decompress(body)
            if "gzip" in encoding or (
                len(body) >= 2 and body[0] == 0x1F and body[1] == 0x8B
            ):
                return gzip.decompress(body)
            return body

    payload = json.dumps([{"a": 1}]).encode()
    compressed = gzip.compress(payload)
    assert maybe_gunzip_body(compressed, "gzip") == payload
    assert maybe_gunzip_body(payload, None) == payload
    # N2: the backend must also accept the SDK's zstd wire encoding.
    z_body, z_enc = compress_wire(payload)
    if z_enc == WIRE_GZIP:
        return  # zstandard not installed in this env — nothing to verify
    assert maybe_gunzip_body(z_body, z_enc) == payload
    assert maybe_gunzip_body(z_body, None) == payload  # magic sniffing
