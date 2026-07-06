"""Tests for the DedupeIndex (read-side only — DB writes need an integration env)."""

from __future__ import annotations

import pytest

from eden.code_change.discipline.dedupe import (
    DEFAULT_WINDOW_DAYS,
    DedupeHit,
    DedupeIndex,
)


class TestDedupeIndexDefaults:
    """The default dedupe window is 14d."""

    def test_default_window(self):
        index = DedupeIndex()
        assert index._window_days == 14
        assert DEFAULT_WINDOW_DAYS == 14

    def test_custom_window(self):
        index = DedupeIndex(window_days=7)
        assert index._window_days == 7


class TestDedupeHit:
    """The DedupeHit dataclass is well-formed."""

    def test_default_not_duplicate(self):
        hit = DedupeHit(is_duplicate=False)
        assert hit.is_duplicate is False
        assert hit.occurrences == 0

    def test_duplicate_hit_carries_outcome(self):
        hit = DedupeHit(
            is_duplicate=True,
            last_outcome="allowed",
            occurrences=2,
        )
        assert hit.is_duplicate is True
        assert hit.last_outcome == "allowed"
        assert hit.occurrences == 2


class TestInvalidTableRejected:
    """SQL injection guards are enforced at the constructor."""

    def test_sql_injection_rejected(self):
        with pytest.raises(ValueError, match="invalid SQL identifier"):
            DedupeIndex(table="pr_dedupe_index; DROP TABLE users")

    def test_valid_table_accepted(self):
        index = DedupeIndex(table="pr_dedupe_index")
        assert index._table == "pr_dedupe_index"


class TestEmptyFingerprintReturnsFalse:
    """A blank fingerprint short-circuits to not-duplicate."""

    @pytest.mark.asyncio
    async def test_blank_fingerprint(self):
        index = DedupeIndex()
        hit = await index.is_duplicate("org_test", "")
        assert hit.is_duplicate is False

    @pytest.mark.asyncio
    async def test_blank_org_id(self):
        index = DedupeIndex()
        hit = await index.is_duplicate("", "fp_123")
        assert hit.is_duplicate is False
