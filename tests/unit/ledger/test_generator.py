"""Tests for LedgerEntry model."""

from eden.kb.ledger.models import LedgerEntry


def test_from_row():
    e = LedgerEntry.from_row(
        {
            "id": "1",
            "org_id": "o",
            "agent_id": "a",
            "ledger_id": "l",
            "chapter": "do_not_repeat",
            "text": "line",
            "citations": ["issue:1"],
            "weight": 2.0,
            "source_ids": ["artifact:1"],
            "version": 3,
        }
    )
    assert e.chapter == "do_not_repeat"
    assert e.citations == ["issue:1"]
