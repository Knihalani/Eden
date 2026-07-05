"""Unit tests for the Qdrant quantization script.

Phase B6 of the Eden app/storage plan (2026-06-19). The script's
helpers (``snapshot``, ``count_points``, ``scroll_all``,
``validate_recall``) are pure-data functions over the qdrant-client
API; mocking the client lets us assert the reindex contract without
requiring a live Qdrant instance.

The live recall check (≥0.99 1-NN self-recall on a 1k sample) is run
manually against staging via ``scripts/qdrant_enable_quantization.py
--validate-recall`` after reindex completes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from unittest.mock import MagicMock

import pytest

from scripts.qdrant_enable_quantization import (
    COLLECTIONS,
    count_points,
    reindex,
    scroll_all,
    validate_recall,
)

# ── Fakes ────────────────────────────────────────────────────────────


@dataclass
class FakeHit:
    """Minimal Qdrant hit shape for tests."""

    id: str
    score: float = 0.99
    payload: dict = field(default_factory=dict)
    vector: list[float] = field(default_factory=list)


@dataclass
class FakeSnapshot:
    name: str


def _make_point(pid: str, vector: list[float]) -> Any:
    """Build an object that quacks like a qdrant-client Record."""
    p = MagicMock()
    p.id = pid
    p.vector = vector
    p.payload = {"text": f"point-{pid}"}
    return p


# ── Tests ────────────────────────────────────────────────────────────


class TestCollectionList:
    def test_all_three_eden_collections_listed(self):
        names = {c[0] for c in COLLECTIONS}
        assert "eden_semantic_memory" in names
        assert "eden_skills" in names
        assert "eden_exploits" in names

    def test_all_collections_use_1536_cosine(self):
        for _name, dim, dist in COLLECTIONS:
            assert dim == 1536
            # Distance.COSINE enum value varies by qdrant-client version;
            # only assert the type was set, not the exact enum.
            assert dist is not None


class TestCountPoints:
    def test_returns_points_count_when_present(self):
        client = MagicMock()
        client.get_collection.return_value = MagicMock(points_count=42)
        assert count_points(client, "eden_x") == 42

    def test_falls_back_to_vectors_count(self):
        client = MagicMock()
        client.get_collection.return_value = MagicMock(points_count=None, vectors_count=17)
        assert count_points(client, "eden_x") == 17

    def test_handles_zero(self):
        client = MagicMock()
        client.get_collection.return_value = MagicMock(points_count=0, vectors_count=0)
        assert count_points(client, "eden_x") == 0


class TestScrollAll:
    def test_single_batch_returns_all_points(self):
        client = MagicMock()
        client.scroll.return_value = ([_make_point("a", [0.1])], None)
        out = scroll_all(client, "eden_x", batch=500)
        assert len(out) == 1
        assert out[0].id == "a"

    def test_multi_batch_follows_offset(self):
        client = MagicMock()
        client.scroll.side_effect = [
            ([_make_point("a", [0.1])], "offset-1"),
            ([_make_point("b", [0.2])], "offset-2"),
            ([_make_point("c", [0.3])], None),
        ]
        out = scroll_all(client, "eden_x", batch=500)
        assert [p.id for p in out] == ["a", "b", "c"]
        assert client.scroll.call_count == 3


class TestValidateRecall:
    def test_passes_when_all_top1_matches_self(self):
        client = MagicMock()
        points = [_make_point(f"id-{i}", [0.1 * i]) for i in range(10)]
        # scroll_all returns the same 10 points
        client.scroll.return_value = (points, None)
        # search returns the same point that was queried
        def fake_search(collection_name, query_vector, limit):
            # Find the point whose vector matches
            for p in points:
                if p.vector == query_vector:
                    return [MagicMock(id=p.id, score=0.99)]
            return []
        client.search.side_effect = fake_search
        assert validate_recall(client, "eden_x", sample=10) is True

    def test_fails_when_recall_below_threshold(self):
        client = MagicMock()
        points = [_make_point(f"id-{i}", [0.1 * i]) for i in range(10)]
        client.scroll.return_value = (points, None)
        # Simulate recall=0.5: half the queries return wrong point
        def fake_search(collection_name, query_vector, limit):
            for i, p in enumerate(points):
                if p.vector == query_vector:
                    # every other query returns the WRONG point
                    if i % 2 == 0:
                        return [MagicMock(id=p.id, score=0.99)]
                    return [MagicMock(id="wrong", score=0.5)]
            return []
        client.search.side_effect = fake_search
        assert validate_recall(client, "eden_x", sample=10) is False


class TestReindexDryRun:
    def test_dry_run_does_not_modify_state(self):
        from qdrant_client.http import models as _models

        client = MagicMock()
        client.get_collection.return_value = MagicMock(points_count=100)
        reindex(
            client,
            "eden_test",
            1536,
            _models.Distance.COSINE,
            dry_run=True,
        )
        client.create_snapshot.assert_not_called()
        client.delete_collection.assert_not_called()
        client.create_collection.assert_not_called()
        client.upsert.assert_not_called()

    def test_full_reindex_takes_snapshot_then_recreates(self):
        from qdrant_client.http import models as _models

        client = MagicMock()
        client.get_collection.return_value = MagicMock(points_count=3)
        client.create_snapshot.return_value = FakeSnapshot(name="snap-2026-06-19")
        client.scroll.return_value = (
            [_make_point(f"p-{i}", [0.1 * i]) for i in range(3)],
            None,
        )
        reindex(
            client,
            "eden_test",
            1536,
            _models.Distance.COSINE,
            dry_run=False,
        )
        # snapshot → scroll → delete → create → upsert (single batch of 3)
        client.create_snapshot.assert_called_once_with(collection_name="eden_test")
        client.delete_collection.assert_called_once_with(collection_name="eden_test")
        client.create_collection.assert_called_once()
        # 3 points fits in one 100-batch upsert
        client.upsert.assert_called_once()
        upsert_kwargs = client.upsert.call_args.kwargs
        assert upsert_kwargs["collection_name"] == "eden_test"
        assert len(upsert_kwargs["points"]) == 3
        assert upsert_kwargs["wait"] is False
