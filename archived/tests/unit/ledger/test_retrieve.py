"""Tests for LedgerRetriever sync cache."""

from eden.kb.ledger import retrieve as retrieve_mod
from eden.kb.ledger.retrieve import LedgerRetriever


def _clear_ledger_caches() -> None:
    retrieve_mod._LEDGER_SYNC_CACHE.clear()
    retrieve_mod._LEDGER_SYNC_READY.clear()
    retrieve_mod._PACK_CACHE.clear()
    retrieve_mod._PACK_CACHE_BY_AGENT.clear()


def test_pack_sync_from_cache():
    _clear_ledger_caches()
    LedgerRetriever.cache_packed("org", "agent", "do not repeat X")
    text, audit = LedgerRetriever().pack_sync("org", "agent")
    assert "do not repeat" in text
    assert audit.get("inject_tokens", 0) > 0
    assert audit.get("cache_hit") is True


def test_pack_sync_cold_miss_vs_warmed_empty():
    _clear_ledger_caches()
    text, audit = LedgerRetriever().pack_sync("org", "agent")
    assert text == ""
    assert audit == {"cache_miss": True}

    LedgerRetriever.cache_packed("org", "agent", "")
    text, audit = LedgerRetriever().pack_sync("org", "agent")
    assert text == ""
    assert audit == {"cache_hit": True}
    assert "cache_miss" not in audit


def test_invalidate_clears_sync_and_pack_via_reverse_index():
    _clear_ledger_caches()
    LedgerRetriever.cache_packed("org", "agent", "packed text")
    pack_key = "deadbeefcafebabe01234567"
    retrieve_mod._PACK_CACHE[pack_key] = ("packed text", 3, False)
    retrieve_mod._PACK_CACHE_BY_AGENT["org:agent"] = {pack_key}
    # Unrelated agent must survive.
    LedgerRetriever.cache_packed("org", "other", "keep me")
    other_key = "aaaaaaaaaaaaaaaaaaaaaaaa"
    retrieve_mod._PACK_CACHE[other_key] = ("keep me", 2, False)
    retrieve_mod._PACK_CACHE_BY_AGENT["org:other"] = {other_key}

    LedgerRetriever.invalidate("org", "agent")

    text, audit = LedgerRetriever().pack_sync("org", "agent")
    assert audit == {"cache_miss": True}
    assert pack_key not in retrieve_mod._PACK_CACHE
    assert "org:agent" not in retrieve_mod._PACK_CACHE_BY_AGENT
    assert "org:agent" not in retrieve_mod._LEDGER_SYNC_READY

    keep, keep_audit = LedgerRetriever().pack_sync("org", "other")
    assert keep == "keep me"
    assert keep_audit.get("cache_hit") is True
    assert other_key in retrieve_mod._PACK_CACHE
