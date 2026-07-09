"""Tests for v1.8 Qdrant storage optimizations.

Covers:
- upsert() chunks at _UPSERT_BATCH_SIZE
- upsert() is a no-op on empty input (no Qdrant call)
- scroll_all() walks the full cursor (offset handling)
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from eden.storage import qdrant


class TestChunkedUpsert:
    def test_no_op_on_empty(self):
        wrapper = qdrant.QdrantClientWrapper.__new__(qdrant.QdrantClientWrapper)
        wrapper.collection_prefix = "eden_"
        wrapper._get_client = MagicMock()
        result = wrapper.upsert("foo", [])
        assert result is True
        wrapper._get_client.assert_not_called()

    def test_single_batch_for_small_input(self):
        wrapper = qdrant.QdrantClientWrapper.__new__(qdrant.QdrantClientWrapper)
        wrapper.collection_prefix = "eden_"
        fake_client = MagicMock()
        wrapper._get_client = MagicMock(return_value=fake_client)
        points = [{"id": str(i), "vector": [0.0] * 4, "payload": {"k": i}} for i in range(10)]
        wrapper.upsert("foo", points)
        # 10 points < 256 batch size → single upsert call.
        assert fake_client.upsert.call_count == 1

    def test_chunks_at_batch_size(self):
        wrapper = qdrant.QdrantClientWrapper.__new__(qdrant.QdrantClientWrapper)
        wrapper.collection_prefix = "eden_"
        fake_client = MagicMock()
        wrapper._get_client = MagicMock(return_value=fake_client)
        n = wrapper._UPSERT_BATCH_SIZE * 2 + 50  # 562 points → 3 chunks
        points = [{"id": str(i), "vector": [0.0] * 4, "payload": {}} for i in range(n)]
        wrapper.upsert("foo", points)
        assert fake_client.upsert.call_count == 3
        # First chunk has _UPSERT_BATCH_SIZE points.
        first_call = fake_client.upsert.call_args_list[0]
        assert len(first_call.kwargs["points"]) == wrapper._UPSERT_BATCH_SIZE
        # Last chunk has the remainder.
        last_call = fake_client.upsert.call_args_list[-1]
        assert len(last_call.kwargs["points"]) == 50


class TestScrollAll:
    def test_single_page(self):
        wrapper = qdrant.QdrantClientWrapper.__new__(qdrant.QdrantClientWrapper)
        wrapper.collection_prefix = "eden_"
        fake_client = MagicMock()
        # Single-page response: 3 points, no next offset.
        page1 = [
            MagicMock(id="a", vector=[0.0] * 4, payload={"i": 0}),
            MagicMock(id="b", vector=[0.0] * 4, payload={"i": 1}),
            MagicMock(id="c", vector=[0.0] * 4, payload={"i": 2}),
        ]
        fake_client.scroll = MagicMock(return_value=(page1, None))
        wrapper._get_client = MagicMock(return_value=fake_client)
        result = wrapper.scroll_all("foo")
        assert len(result) == 3
        assert fake_client.scroll.call_count == 1

    def test_multi_page(self):
        wrapper = qdrant.QdrantClientWrapper.__new__(qdrant.QdrantClientWrapper)
        wrapper.collection_prefix = "eden_"
        fake_client = MagicMock()
        # Two pages, offset cursor walks through.
        page1 = [MagicMock(id=str(i), vector=[0.0] * 4, payload={"i": i}) for i in range(3)]
        page2 = [MagicMock(id=str(i + 3), vector=[0.0] * 4, payload={"i": i + 3}) for i in range(2)]
        fake_client.scroll = MagicMock(side_effect=[(page1, "next-cursor"), (page2, None)])
        wrapper._get_client = MagicMock(return_value=fake_client)
        result = wrapper.scroll_all("foo")
        assert len(result) == 5
        assert fake_client.scroll.call_count == 2
        # Second call passes the offset from the first call.
        second_call = fake_client.scroll.call_args_list[1]
        assert second_call.kwargs["offset"] == "next-cursor"

    def test_empty_collection(self):
        wrapper = qdrant.QdrantClientWrapper.__new__(qdrant.QdrantClientWrapper)
        wrapper.collection_prefix = "eden_"
        fake_client = MagicMock()
        fake_client.scroll = MagicMock(return_value=([], None))
        wrapper._get_client = MagicMock(return_value=fake_client)
        result = wrapper.scroll_all("foo")
        assert result == []
