"""Wave 8.5 — Qdrant feature soft-degrade (align Wave 1.3).

Qdrant is a soft dep: transport failures (Errno 99, timeout, 5xx)
must return empty/False with ``unavailable=True`` on search paths —
never raise into a portal 500. Health probes still call
``get_collections`` directly so ``/health`` stays degraded-503.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from qdrant_client.http.exceptions import UnexpectedResponse

from eden.storage.qdrant import QdrantClientWrapper, SearchResults


def _wrapper() -> QdrantClientWrapper:
    return QdrantClientWrapper(host="localhost", port=6333, collection_prefix="eden_")


def _errno99() -> OSError:
    return OSError(99, "Cannot assign requested address")


class TestSearchSoftDegrade:
    def test_transport_errno99_returns_unavailable_empty(self):
        w = _wrapper()
        client = MagicMock()
        client.search.side_effect = _errno99()
        with patch.object(w, "_get_client", return_value=client):
            out = w.search("semantic_memory", query_vector=[0.1, 0.2], limit=5)
        assert isinstance(out, SearchResults)
        assert out.results == []
        assert out.total == 0
        assert out.unavailable is True

    def test_unexpected_5xx_returns_unavailable_not_raise(self):
        w = _wrapper()
        client = MagicMock()
        client.search.side_effect = UnexpectedResponse(
            status_code=503,
            reason_phrase="Service Unavailable",
            content=b"down",
            headers={},
        )
        with patch.object(w, "_get_client", return_value=client):
            out = w.search("semantic_memory", query_vector=[0.1], limit=3)
        assert out.unavailable is True
        assert out.results == []

    def test_collection_404_empty_but_available(self):
        """Missing collection is empty index, not soft-dep outage."""
        w = _wrapper()
        client = MagicMock()
        client.search.side_effect = UnexpectedResponse(
            status_code=404,
            reason_phrase="Not Found",
            content=b"missing",
            headers={},
        )
        with patch.object(w, "_get_client", return_value=client):
            out = w.search("missing_coll", query_vector=[0.1], limit=3)
        assert out.results == []
        assert out.unavailable is False

    def test_hybrid_propagates_unavailable(self):
        w = _wrapper()
        with patch.object(
            w,
            "search",
            return_value=SearchResults(results=[], total=0, unavailable=True),
        ), patch.object(w, "_sparse_search", return_value=[]):
            out = w.search_hybrid(
                "semantic_memory",
                query_vector=[0.1],
                query_text="hello",
                limit=5,
            )
        assert out.unavailable is True
        assert out.results == []


class TestWriteSoftDegrade:
    def test_upsert_returns_false_on_transport_error(self):
        w = _wrapper()
        client = MagicMock()
        client.upsert.side_effect = _errno99()
        with patch.object(w, "_get_client", return_value=client):
            ok = w.upsert(
                "semantic_memory",
                [{"id": "1", "vector": [0.1], "payload": {}}],
            )
        assert ok is False

    def test_delete_returns_false_on_transport_error(self):
        w = _wrapper()
        client = MagicMock()
        client.delete.side_effect = ConnectionError("refused")
        with patch.object(w, "_get_client", return_value=client):
            assert w.delete("semantic_memory", ["a"]) is False

    def test_count_returns_zero_on_transport_error(self):
        w = _wrapper()
        client = MagicMock()
        client.count.side_effect = TimeoutError("qdrant timeout")
        with patch.object(w, "_get_client", return_value=client):
            assert w.count("semantic_memory") == 0

    def test_scroll_all_returns_empty_on_transport_error(self):
        w = _wrapper()
        client = MagicMock()
        client.scroll.side_effect = _errno99()
        with patch.object(w, "_get_client", return_value=client):
            assert w.scroll_all("semantic_memory") == []

    def test_initialize_collections_does_not_raise(self):
        w = _wrapper()
        client = MagicMock()
        client.get_collections.side_effect = _errno99()
        with patch.object(w, "_get_client", return_value=client):
            w.initialize_collections()  # must not raise


class TestHealthProbeStillSeesErrors:
    """Feature soft-fail must not swallow probe-visible failures."""

    def test_direct_get_collections_still_raises(self):
        w = _wrapper()
        client = MagicMock()
        client.get_collections.side_effect = _errno99()
        with patch.object(w, "_get_client", return_value=client):
            with pytest.raises(OSError):
                w._get_client().get_collections()
