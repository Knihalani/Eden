"""N4 — pgvector storage wrapper (replaces Qdrant)."""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.storage import pgvector
from eden.storage.pgvector import (
    SearchResult,
    SearchResults,
    VectorDimensionError,
    get_pgvector_client,
)


@pytest.fixture(autouse=True)
def _reset_singleton():
    pgvector._pgvector_client = None
    yield
    pgvector._pgvector_client = None


def _client() -> MagicMock:
    return MagicMock()


def _v(seed: float = 0.1) -> list[float]:
    """A 1536-dim vector (the column's fixed dimension)."""
    return [seed] * pgvector._EMBEDDING_DIM


@pytest.mark.asyncio
async def test_search_builds_hnsw_sql_with_score():
    client = _client()
    client.fetch = AsyncMock(
        return_value=[
            {"point_id": "a", "payload": {"name": "x"}, "score": 0.92},
            {"point_id": "b", "payload": {"name": "y"}, "score": 0.81},
        ]
    )
    with patch.object(pgvector, "_pg", AsyncMock(return_value=client)):
        out = await get_pgvector_client().search(
            "skills",
            _v(),
            limit=10,
            query_filter={"name": "x"},
            score_threshold=0.8,
        )

    assert isinstance(out, SearchResults)
    assert out.unavailable is False
    assert [r.id for r in out.results] == ["a", "b"]
    sql = client.fetch.await_args.args[0]
    assert "FROM vector_documents" in sql
    assert "embedding <=> $1" in sql
    assert "collection = $2" in sql
    assert "embedding IS NOT NULL" in sql
    assert "payload->>'name' = $3 OR payload->'name' ? $3::text" in sql
    assert "1 - (embedding <=> $1) >= $4" in sql
    assert "ORDER BY embedding <=> $1" in sql
    assert "LIMIT $5" in sql


@pytest.mark.asyncio
async def test_search_soft_fails_when_pg_down():
    with patch.object(pgvector, "_pg", AsyncMock(return_value=None)):
        out = await get_pgvector_client().search("skills", _v())

    assert out.unavailable is True
    assert out.results == []


@pytest.mark.asyncio
async def test_search_array_eq_and_in_filters():
    client = _client()
    client.fetch = AsyncMock(return_value=[])
    filters = {
        "applicable_env_classes": {"$eq": "ant"},
        "tags": {"$in": ["a", "b"]},
        "old": {"$ne": "gone"},
    }
    with patch.object(pgvector, "_pg", AsyncMock(return_value=client)):
        await get_pgvector_client().search("exploits", _v(), query_filter=filters)

    sql = client.fetch.await_args.args[0]
    params = client.fetch.await_args.args[1:]
    assert "payload->>'applicable_env_classes' = $3 OR payload->'applicable_env_classes' ? $3::text" in sql
    assert "payload->'tags' ?| $4::text[]" in sql
    assert "NOT (payload->'old' ?| $5::text[])" in sql
    assert params[2] == "ant"
    assert params[3] == ["a", "b"]


@pytest.mark.asyncio
async def test_denied_filter_keys_dropped():
    client = _client()
    client.fetch = AsyncMock(return_value=[])
    filters = {"__proto__": "x", "safe key": "y", "name": "ok"}
    with patch.object(pgvector, "_pg", AsyncMock(return_value=client)):
        await get_pgvector_client().search("skills", _v(), query_filter=filters)

    sql = client.fetch.await_args.args[0]
    assert "__proto__" not in sql
    assert "safe key" not in sql
    assert "name" in sql


@pytest.mark.asyncio
async def test_upsert_executemany_on_conflict():
    client = _client()
    client.executemany = AsyncMock()
    points = [
        {"id": "a", "vector": _v(0.1), "payload": {"name": "x"}},
        {"id": "b", "vector": _v(0.3), "payload": {"name": "y"}},
    ]
    with patch.object(pgvector, "_pg", AsyncMock(return_value=client)):
        ok = await get_pgvector_client().upsert("skills", points)

    assert ok is True
    sql = client.executemany.await_args.args[0]
    assert "INSERT INTO vector_documents" in sql
    assert "ON CONFLICT (collection, point_id) DO UPDATE" in sql
    args = client.executemany.await_args.args[1]
    assert len(args) == 2
    assert args[0][:3] == ("skills", "a", None)
    assert args[1][0] == "skills"


@pytest.mark.asyncio
async def test_upsert_empty_is_noop():
    with patch.object(pgvector, "_pg", AsyncMock()):
        assert await get_pgvector_client().upsert("skills", []) is True


@pytest.mark.asyncio
async def test_delete_by_ids():
    client = _client()
    client.execute = AsyncMock()
    with patch.object(pgvector, "_pg", AsyncMock(return_value=client)):
        assert await get_pgvector_client().delete("skills", ["a", "b"]) is True

    sql, collection, ids = client.execute.await_args.args
    assert "DELETE FROM vector_documents" in sql
    assert "point_id = ANY($2::text[])" in sql
    assert collection == "skills"
    assert ids == ["a", "b"]


@pytest.mark.asyncio
async def test_count_with_filter():
    client = _client()
    client.fetchrow = AsyncMock(return_value={"n": 3})
    with patch.object(pgvector, "_pg", AsyncMock(return_value=client)):
        assert await get_pgvector_client().count("skills", {"name": "x"}) == 3

    sql = client.fetchrow.await_args.args[0]
    assert "COUNT(*) AS n" in sql
    assert "collection = $1" in sql
    assert "payload->>'name' = $2 OR payload->'name' ? $2::text" in sql


@pytest.mark.asyncio
async def test_scroll_all_paginates():
    client = _client()
    row = {"point_id": "a", "embedding": [0.1], "payload": {"p": 1}}
    client.fetch = AsyncMock(side_effect=[[row], [row], []])
    with patch.object(pgvector, "_pg", AsyncMock(return_value=client)):
        out = await get_pgvector_client().scroll_all(
            "skills", limit=1, with_vectors=True
        )

    assert len(out) == 2
    assert out[0]["id"] == "a"
    assert out[0]["vector"] == [0.1]
    assert client.fetch.await_count == 3  # full page → next page → empty terminates


@pytest.mark.asyncio
async def test_search_hybrid_fuses_dense_and_keyword():
    client = _client()
    client.fetch = AsyncMock(
        side_effect=[
            # dense rows
            [
                {"point_id": "a", "payload": {"name": "alpha"}, "score": 0.9},
                {"point_id": "b", "payload": {"name": "beta"}, "score": 0.7},
            ],
            # keyword rows
            [{"point_id": "b", "payload": {"name": "beta"}}],
        ]
    )
    with patch.object(pgvector, "_pg", AsyncMock(return_value=client)):
        out = await get_pgvector_client().search_hybrid(
            "skills", _v(), query_text="beta term"
        )

    assert len(out.results) >= 1
    ids = {r.id for r in out.results}
    assert "b" in ids  # matched dense + keyword


@pytest.mark.asyncio
async def test_initialize_collections_is_noop():
    await get_pgvector_client().initialize_collections_async()


@pytest.mark.asyncio
async def test_search_rejects_wrong_dimension():
    """A non-1536 query vector must raise a clear, catchable error — not
    soft-degrade into "no results" (that would silently empty every
    search for a changed embed model)."""
    with pytest.raises(VectorDimensionError, match="1536"):
        await get_pgvector_client().search("skills", [0.1, 0.2])


@pytest.mark.asyncio
async def test_upsert_rejects_wrong_dimension():
    with pytest.raises(VectorDimensionError, match=r"upsert\('skills'\)\[0\]"):
        await get_pgvector_client().upsert(
            "skills", [{"id": "a", "vector": [0.1, 0.2]}]
        )


@pytest.mark.asyncio
async def test_upsert_validates_all_points_before_any_insert():
    """Dimension validation happens before the first executemany — a bad
    point mid-batch cannot leave a half-applied chunk."""
    client = _client()
    client.executemany = AsyncMock()
    points = [
        {"id": "a", "vector": _v(0.1)},  # good
        {"id": "bad", "vector": [0.9]},  # bad — must abort everything
    ]
    with patch.object(pgvector, "_pg", AsyncMock(return_value=client)):
        with pytest.raises(VectorDimensionError):
            await get_pgvector_client().upsert("skills", points)
    client.executemany.assert_not_awaited()
