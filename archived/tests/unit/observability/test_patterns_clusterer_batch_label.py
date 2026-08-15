"""Unit tests for OOM-7.4 W1-8 batch-label path in PatternsClusterer.

Verifies:
- batched happy path: N clusters → exactly 1 LLM call, labels index-aligned
- malformed-JSON fallback: per-cluster calls used when response is not parseable
- non-array JSON fallback: dict response also triggers per-cluster fallback
- count mismatch: use labels we have, fall back for the remainder
- chunking: >BATCH_LABEL_MAX clusters → multiple LLM calls, each ≤ BATCH_LABEL_MAX
- exactly BATCH_LABEL_MAX clusters fits in one call
- no LLM client: heuristic path used for each cluster
- preamble text: JSON array extracted even when model adds surrounding prose
- label normalisation: surrounding whitespace/quotes stripped identically to _label_cluster
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from eden.observability.patterns_clusterer import BATCH_LABEL_MAX, PatternsClusterer


def _make_llm(return_value: str) -> MagicMock:
    """Return a fake LLM client whose ``complete()`` always returns *return_value*."""
    client = MagicMock()
    client.complete = AsyncMock(return_value=return_value)
    return client


# ── Happy path ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_batch_label_happy_path_single_call() -> None:
    """N clusters → exactly 1 LLM call, labels returned index-aligned."""
    n = 5
    expected = [f"topic label {i}" for i in range(n)]
    llm = _make_llm(json.dumps(expected))

    clusterer = PatternsClusterer(llm_client=llm)
    cluster_samples = [(i, [f"sample query {i}"]) for i in range(n)]
    result = await clusterer._batch_label_clusters(cluster_samples)

    assert llm.complete.call_count == 1
    assert result == {i: expected[i] for i in range(n)}


@pytest.mark.asyncio
async def test_batch_label_strips_label_whitespace_and_quotes() -> None:
    """Labels with extra quotes/whitespace are cleaned the same way ``_label_cluster`` does."""
    raw_labels = ['  "password reset" ', "'billing'", "  api setup  "]
    llm = _make_llm(json.dumps(raw_labels))
    clusterer = PatternsClusterer(llm_client=llm)
    cluster_samples = [(i, [f"sample {i}"]) for i in range(3)]
    result = await clusterer._batch_label_clusters(cluster_samples)

    assert result[0] == "password reset"
    assert result[1] == "billing"
    assert result[2] == "api setup"


# ── Malformed-JSON fallback ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_batch_label_malformed_json_falls_back_to_per_cluster() -> None:
    """Non-JSON batch response → per-cluster calls used for every cluster."""
    per_cluster_labels = ["fallback label 0", "fallback label 1", "fallback label 2"]
    call_count = 0

    async def _mock_complete(prompt: str, **kwargs: object) -> str:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return "Not valid JSON at all!"
        # Subsequent calls are per-cluster; return labels in order.
        return per_cluster_labels[call_count - 2]

    client = MagicMock()
    client.complete = _mock_complete

    clusterer = PatternsClusterer(llm_client=client)
    cluster_samples = [(i, [f"sample {i}"]) for i in range(3)]
    result = await clusterer._batch_label_clusters(cluster_samples)

    # 1 batch call + 3 per-cluster fallback calls = 4 total
    assert call_count == 4
    assert result == {0: "fallback label 0", 1: "fallback label 1", 2: "fallback label 2"}


@pytest.mark.asyncio
async def test_batch_label_non_array_json_falls_back() -> None:
    """Batch response that is a JSON object (not array) also triggers fallback."""
    fallback_label = "single fallback"
    call_count = 0

    async def _mock_complete(prompt: str, **kwargs: object) -> str:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            # Valid JSON but not an array — no `[...]` to match
            return '{"label": "oops, a dict"}'
        return fallback_label

    client = MagicMock()
    client.complete = _mock_complete

    clusterer = PatternsClusterer(llm_client=client)
    cluster_samples = [(0, ["some query"])]
    result = await clusterer._batch_label_clusters(cluster_samples)

    assert call_count == 2  # 1 batch attempt + 1 per-cluster fallback
    assert result == {0: fallback_label}


@pytest.mark.asyncio
async def test_batch_label_llm_exception_falls_back() -> None:
    """An exception raised by the LLM client also triggers per-cluster fallback."""
    fallback_label = "exception fallback"
    call_count = 0

    async def _mock_complete(prompt: str, **kwargs: object) -> str:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            raise RuntimeError("LLM exploded")
        return fallback_label

    client = MagicMock()
    client.complete = _mock_complete

    clusterer = PatternsClusterer(llm_client=client)
    cluster_samples = [(0, ["sample"])]
    result = await clusterer._batch_label_clusters(cluster_samples)

    assert call_count == 2
    assert result == {0: fallback_label}


# ── Count mismatch ────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_batch_label_count_mismatch_labels_partial_then_fallback() -> None:
    """LLM returns fewer labels than clusters → use what we have, fall back for the rest."""
    # 5 clusters but only 3 labels returned
    batch_response = json.dumps(["label a", "label b", "label c"])
    fallback_label = "fallback"
    call_count = 0

    async def _mock_complete(prompt: str, **kwargs: object) -> str:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return batch_response
        return fallback_label

    client = MagicMock()
    client.complete = _mock_complete

    clusterer = PatternsClusterer(llm_client=client)
    cluster_samples = [(i, [f"sample {i}"]) for i in range(5)]
    result = await clusterer._batch_label_clusters(cluster_samples)

    # 1 batch call + 2 per-cluster fallback calls (for indices 3 and 4)
    assert call_count == 3
    assert result[0] == "label a"
    assert result[1] == "label b"
    assert result[2] == "label c"
    assert result[3] == fallback_label
    assert result[4] == fallback_label


# ── Chunking ──────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_batch_label_chunks_when_above_max() -> None:
    """More than BATCH_LABEL_MAX clusters → multiple LLM calls, each ≤ BATCH_LABEL_MAX."""
    total = BATCH_LABEL_MAX + 5  # e.g. 45 when MAX=40
    all_labels = [f"label {i}" for i in range(total)]
    llm_call_count = 0

    async def _mock_complete(prompt: str, **kwargs: object) -> str:
        nonlocal llm_call_count
        chunk_start = llm_call_count * BATCH_LABEL_MAX
        chunk_end = min(chunk_start + BATCH_LABEL_MAX, total)
        chunk_labels = all_labels[chunk_start:chunk_end]
        llm_call_count += 1
        return json.dumps(chunk_labels)

    client = MagicMock()
    client.complete = _mock_complete

    clusterer = PatternsClusterer(llm_client=client)
    cluster_samples = [(i, [f"sample {i}"]) for i in range(total)]
    result = await clusterer._batch_label_clusters(cluster_samples)

    # ceil(total / BATCH_LABEL_MAX) calls
    import math
    expected_calls = math.ceil(total / BATCH_LABEL_MAX)
    assert llm_call_count == expected_calls
    assert len(result) == total
    assert result == {i: f"label {i}" for i in range(total)}


@pytest.mark.asyncio
async def test_batch_label_exactly_at_max_is_one_call() -> None:
    """Exactly BATCH_LABEL_MAX clusters fits in a single call."""
    total = BATCH_LABEL_MAX
    labels = [f"label {i}" for i in range(total)]
    llm = _make_llm(json.dumps(labels))

    clusterer = PatternsClusterer(llm_client=llm)
    cluster_samples = [(i, [f"sample {i}"]) for i in range(total)]
    result = await clusterer._batch_label_clusters(cluster_samples)

    assert llm.complete.call_count == 1
    assert len(result) == total
    assert result == {i: f"label {i}" for i in range(total)}


@pytest.mark.asyncio
async def test_batch_label_chunk_boundary_preserves_cluster_ids() -> None:
    """Cluster IDs are preserved correctly across chunk boundaries."""
    total = BATCH_LABEL_MAX + 3
    # Use non-contiguous cluster IDs to verify mapping is by position, not id
    cluster_ids = list(range(100, 100 + total))
    all_labels = [f"label for {cid}" for cid in cluster_ids]
    llm_call_count = 0

    async def _mock_complete(prompt: str, **kwargs: object) -> str:
        nonlocal llm_call_count
        chunk_start = llm_call_count * BATCH_LABEL_MAX
        chunk_end = min(chunk_start + BATCH_LABEL_MAX, total)
        chunk_labels = all_labels[chunk_start:chunk_end]
        llm_call_count += 1
        return json.dumps(chunk_labels)

    client = MagicMock()
    client.complete = _mock_complete

    clusterer = PatternsClusterer(llm_client=client)
    cluster_samples = [(cid, [f"query {cid}"]) for cid in cluster_ids]
    result = await clusterer._batch_label_clusters(cluster_samples)

    assert len(result) == total
    for idx, cid in enumerate(cluster_ids):
        assert result[cid] == f"label for {cid}"


# ── No LLM client ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_batch_label_no_llm_uses_heuristic() -> None:
    """Without an LLM client the heuristic path runs for every cluster."""
    clusterer = PatternsClusterer(llm_client=None)
    cluster_samples = [
        (0, ["reset password help", "forgot password", "reset my password"]),
        (1, ["billing invoice question", "billing issue", "invoice not received"]),
    ]
    result = await clusterer._batch_label_clusters(cluster_samples)

    assert set(result.keys()) == {0, 1}
    assert result[0] and isinstance(result[0], str)
    assert result[1] and isinstance(result[1], str)


@pytest.mark.asyncio
async def test_batch_label_empty_input_returns_empty_dict() -> None:
    """Empty input returns an empty dict without calling the LLM."""
    llm = _make_llm("should never be called")
    clusterer = PatternsClusterer(llm_client=llm)
    result = await clusterer._batch_label_clusters([])
    assert result == {}
    llm.complete.assert_not_called()


# ── Preamble text in batch response ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_batch_label_extracts_array_from_surrounding_prose() -> None:
    """JSON array is extracted correctly even when the model adds preamble text."""
    labels = ["password reset", "billing help"]
    response = f"Here are the topic labels for your clusters:\n{json.dumps(labels)}\n"
    llm = _make_llm(response)

    clusterer = PatternsClusterer(llm_client=llm)
    cluster_samples = [(0, ["forgot password"]), (1, ["invoice question"])]
    result = await clusterer._batch_label_clusters(cluster_samples)

    assert llm.complete.call_count == 1
    assert result == {0: "password reset", 1: "billing help"}
