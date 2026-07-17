"""Ledger entry embeddings — BGE-small with hash fallback."""

from __future__ import annotations

import hashlib
import struct
from typing import Sequence


def embed_text(text: str, *, dims: int = 384) -> bytes:
    """Return float32 vector as bytes for BYTEA storage."""
    snippet = (text or "")[:2000]
    try:
        from supplementaries.phase_3_loops.real_embeddings import get_singleton

        vec = get_singleton().encode(snippet).embedding
        return struct.pack(f"{len(vec)}f", *vec)
    except Exception:
        return _hash_embedding(snippet, dims=dims)


def unpack_embedding(blob: bytes | None) -> list[float]:
    if not blob:
        return []
    n = len(blob) // 4
    if n <= 0:
        return []
    return list(struct.unpack(f"{n}f", blob[: n * 4]))


def cosine(a: Sequence[float], b: Sequence[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def _hash_embedding(text: str, *, dims: int) -> bytes:
    """Deterministic pseudo-embedding when model unavailable."""
    vec: list[float] = []
    seed = text.encode()
    for i in range(dims):
        h = hashlib.sha256(seed + i.to_bytes(2, "little")).digest()
        vec.append((int.from_bytes(h[:2], "little") / 65535.0) * 2 - 1)
    return struct.pack(f"{dims}f", *vec)
