"""Helpers for decoding gzip/zstd'd SDK ingest request bodies in tests."""

from __future__ import annotations

import gzip
import json
from typing import Any


def decode_ingest_body(content: bytes | str | None, headers: Any = None) -> Any:
    """Decode an SDK ingest request body regardless of wire encoding.

    The SDK sends ``Content-Encoding: zstd`` when zstandard is installed
    (N2) and gzip otherwise; both are decompressed here so assertions
    don't depend on which optional extra CI installed.
    """
    if content is None:
        return None
    raw: bytes
    if isinstance(content, str):
        raw = content.encode("utf-8")
    else:
        raw = bytes(content)
    encoding = ""
    if headers is not None:
        try:
            encoding = str(headers.get("content-encoding") or headers.get("Content-Encoding") or "")
        except Exception:
            encoding = ""
    lower = encoding.lower()
    if "zstd" in lower or _is_zstd(raw):
        import zstandard

        raw = zstandard.ZstdDecompressor().decompress(raw)
    elif "gzip" in lower or (len(raw) >= 2 and raw[0] == 0x1F and raw[1] == 0x8B):
        raw = gzip.decompress(raw)
    return json.loads(raw.decode("utf-8"))


def _is_zstd(raw: bytes) -> bool:
    return len(raw) >= 4 and raw[:4] == b"\x28\xb5\x2f\xfd"
