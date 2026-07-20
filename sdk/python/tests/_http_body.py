"""Helpers for decoding gzip'd SDK ingest request bodies in tests."""

from __future__ import annotations

import gzip
import json
from typing import Any


def decode_ingest_body(content: bytes | str | None, headers: Any = None) -> Any:
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
    if "gzip" in encoding.lower() or (len(raw) >= 2 and raw[0] == 0x1F and raw[1] == 0x8B):
        raw = gzip.decompress(raw)
    return json.loads(raw.decode("utf-8"))
