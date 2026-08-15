"""Ledger vector embedding helpers."""

from eden.kb.ledger.embeddings import cosine, embed_text, unpack_embedding


def test_embed_roundtrip():
    blob = embed_text("do not repeat failed SQL on empty table")
    vec = unpack_embedding(blob)
    assert len(vec) >= 64
    sim = cosine(vec, vec)
    assert sim > 0.99
