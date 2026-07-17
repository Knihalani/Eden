"""Tests for LedgerRetriever sync cache."""

from eden.kb.ledger.retrieve import LedgerRetriever


def test_pack_sync_from_cache():
    LedgerRetriever.cache_packed("org", "agent", "do not repeat X")
    text, audit = LedgerRetriever().pack_sync("org", "agent")
    assert "do not repeat" in text
    assert audit.get("inject_tokens", 0) > 0
