"""Wave 5/6 — bedrock/gemini stubs, sampling, offline queue."""

from __future__ import annotations

from pathlib import Path

import eden
from eden_sdk.offline_queue import OfflineQueue
from eden_sdk.sampling import ClientSampler, SampleSignals


def test_bedrock_gemini_in_instrumentation_registry() -> None:
    from eden_sdk import instrumentations

    assert "bedrock" in instrumentations.__all__
    assert "gemini" in instrumentations.__all__


def test_mastra_install_is_noop_stub() -> None:
    from eden_sdk.instrumentations import mastra

    mastra.install()  # must not raise
    mastra.uninstall()


def test_sampler_keep_errors_override() -> None:
    # ``client_probabilistic_sampling=True`` opts into the probabilistic
    # drop this test exercises -- the SDK x server compounding guard
    # (see ``ClientSampler``'s docstring) makes that ``False`` by
    # default, so a non-``full`` profile alone no longer probabilistically
    # drops anything on the client.
    s = ClientSampler(
        profile="aggressive",
        keep_errors=True,
        rng_seed=1,
        client_probabilistic_sampling=True,
    )
    assert s.should_keep(SampleSignals(has_error=True)) is True
    # Forced drop for clean events under aggressive with seed
    kept = sum(
        1 for _ in range(200) if s.should_keep(SampleSignals(has_error=False))
    )
    assert kept < 50  # ~5% of 200


def test_sampler_full_keeps_all() -> None:
    s = ClientSampler(profile="full")
    assert all(s.should_keep(SampleSignals()) for _ in range(20))


def test_offline_queue_roundtrip(tmp_path: Path) -> None:
    q = OfflineQueue(tmp_path / "q.sqlite3", max_rows=100)
    q.enqueue("openai", {"event_id": "e1"})
    q.enqueue("openai", {"event_id": "e2"})
    assert q.size() == 2
    drained = q.drain(limit=10)
    assert len(drained) == 2
    q.ack([drained[0][0], drained[1][0]])
    assert q.size() == 0


def test_offline_queue_enqueue_many_single_txn(tmp_path: Path) -> None:
    """Batch spill inserts N rows with one commit (not N commits)."""
    q = OfflineQueue(tmp_path / "q_batch.sqlite3", max_rows=1000)
    items = [("openai", {"event_id": f"e{i}"}) for i in range(50)]
    q.enqueue_many(items)
    assert q.size() == 50
    drained = q.drain(limit=100)
    assert [p["event_id"] for _, _, p in drained] == [f"e{i}" for i in range(50)]
    q.ack([rid for rid, _, _ in drained])
    assert q.size() == 0
    q.close()


def test_detect_includes_bedrock_gemini_keys() -> None:
    detected = eden.detect_installed_frameworks()
    assert "bedrock" in detected
    assert "gemini" in detected
