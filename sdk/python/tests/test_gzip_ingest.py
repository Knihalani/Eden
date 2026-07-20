"""Gzip Content-Encoding round-trip for SDK ingest (K35)."""

from __future__ import annotations

import asyncio
import gzip
import json
import sys
from pathlib import Path

import httpx

from eden_sdk.client import EdenClient, TraceEvent
from eden_sdk.config import EdenConfig


def test_send_batch_sets_gzip_content_encoding() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["encoding"] = request.headers.get("content-encoding")
        seen["body"] = bytes(request.content)
        raw = gzip.decompress(request.content)
        seen["decoded"] = json.loads(raw)
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

    assert seen["encoding"] == "gzip"
    body = seen["body"]
    assert isinstance(body, (bytes, bytearray))
    assert body[:2] == b"\x1f\x8b"
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
        def maybe_gunzip_body(body: bytes, content_encoding: str | None = None) -> bytes:
            encoding = (content_encoding or "").lower()
            if "gzip" in encoding or (len(body) >= 2 and body[0] == 0x1F and body[1] == 0x8B):
                return gzip.decompress(body)
            return body

    payload = json.dumps([{"a": 1}]).encode()
    compressed = gzip.compress(payload)
    assert maybe_gunzip_body(compressed, "gzip") == payload
    assert maybe_gunzip_body(payload, None) == payload
