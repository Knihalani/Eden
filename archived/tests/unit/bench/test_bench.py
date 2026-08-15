"""Unit tests for the ``bench/`` performance harness.

These tests confirm the harness produces well-shaped results in a
fixed number of calls. They run quickly (under a second each) so
they can live in the unit-test tree; the full bench (``python -m
bench.run_all``) is run on a weekly cron in CI, not on every PR.
"""

import asyncio

import pytest

from bench import kb_retrieval, latency, llm_provider
from bench.common import BenchResult, bench_async

# ────────────────────────────────────────────────────────────────────────
# bench.common
# ────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_bench_async_collects_latencies_and_percentiles():
    async def fast():
        await asyncio.sleep(0.001)
    res = await bench_async("test", fast, n=10, concurrency=1)
    assert isinstance(res, BenchResult)
    assert res.n == 10
    assert res.p50_ms > 0
    assert res.p95_ms >= res.p50_ms
    assert res.max_ms > 0
    d = res.to_dict()
    assert d["name"] == "test"
    assert d["n"] == 10


@pytest.mark.asyncio
async def test_bench_async_handles_exceptions():
    """An exception in the function shouldn't crash the harness — the
    latency just isn't recorded for that call."""
    counter = {"calls": 0}

    async def flaky():
        counter["calls"] += 1
        if counter["calls"] % 3 == 0:
            raise RuntimeError("nope")
        await asyncio.sleep(0.001)
    # The harness doesn't currently isolate exceptions; we just check
    # the basic call-count plumbing.
    with pytest.raises(RuntimeError):
        await bench_async("test", flaky, n=3, concurrency=1)
    assert counter["calls"] == 3


# ────────────────────────────────────────────────────────────────────────
# bench.latency
# ────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_bench_api_mock_runs_end_to_end():
    results = await latency.bench_api(n=20, concurrency=4)
    assert len(results) == len(latency.DEFAULT_ENDPOINTS)
    for r in results:
        assert r.n == 20
        # Mock simulates 5ms work; p95 should be well under 100ms.
        assert r.p95_ms < 100


@pytest.mark.asyncio
async def test_bench_api_p95_under_sanity_threshold():
    """Sanity check: the mock should comfortably meet the §11.1 SLO."""
    results = await latency.bench_api(n=20, concurrency=4)
    for r in results:
        assert r.p95_ms < 500, f"{r.name} p95 too high: {r.p95_ms}"


# ────────────────────────────────────────────────────────────────────────
# bench.llm_provider
# ────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_bench_llm_provider_returns_per_provider_results():
    results = await llm_provider.bench_llm_provider(
        providers=["openai"], n=20, concurrency=2,
    )
    assert len(results) == 1
    r = results[0]
    assert r.total == 20
    assert r.errors + r.bench.n == 20
    # Mock openai is ~250ms; allow wide range
    assert r.bench.p50_ms > 100
    # Error rate is at most the simulated rate (0.1%) but with n=20
    # we expect very few or zero errors
    assert r.error_rate() < 0.5  # very loose


# ────────────────────────────────────────────────────────────────────────
# bench.kb_retrieval
# ────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_bench_kb_retrieval_reports_three_tiers():
    results = await kb_retrieval.bench_kb_retrieval(n=200, concurrency=4)
    tiers = {r.tier for r in results}
    assert tiers == {"L1", "L2", "DB"}
    # Hit rates should sum to ~1.0
    total_hit_rate = sum(r.hit_rate for r in results)
    assert 0.99 <= total_hit_rate <= 1.01


@pytest.mark.asyncio
async def test_bench_kb_retrieval_l1_faster_than_l2_faster_than_db():
    results = await kb_retrieval.bench_kb_retrieval(n=200, concurrency=4)
    by_tier = {r.tier: r.bench.p50_ms for r in results}
    assert by_tier["L1"] < by_tier["L2"] < by_tier["DB"]


# ────────────────────────────────────────────────────────────────────────
# run_all — results JSON shape
# ────────────────────────────────────────────────────────────────────────


@pytest.fixture
def _stub_suites(monkeypatch):
    """Replace the real suites with stubs.

    The real suites import the whole app and shell out to subprocesses, which
    is right for a weekly cron and wrong for a unit test. What is under test
    here is the orchestrator's contract — which suites run by default, and how
    results are written — not the measurements themselves.
    """
    from bench import run_all

    async def _fake_real():
        return {"middleware": [{"name": "x", "n": 1, "p50_ms": 0.1}]}

    monkeypatch.setattr(run_all, "_run_real_suites", _fake_real)
    return run_all


@pytest.mark.asyncio
async def test_run_all_writes_results_json(tmp_path, monkeypatch, _stub_suites):
    """Smoke test: write to a temp dir, read the JSON back, check the shape."""
    import json

    monkeypatch.setattr(_stub_suites, "RESULTS_DIR", tmp_path)
    assert await _stub_suites.main([]) == 0

    files = list(tmp_path.glob("*.json"))
    assert len(files) == 1
    data = json.loads(files[0].read_text())
    assert "suites" in data and "started_at" in data and "duration_s" in data


@pytest.mark.asyncio
async def test_simulated_suites_are_off_by_default(tmp_path, monkeypatch, _stub_suites):
    """The default run must contain only suites that measure real code.

    Every historical file in ``bench/results/`` came from the three
    ``asyncio.sleep`` suites, so the recorded numbers described sleep
    resolution rather than Eden. They are opt-in now.
    """
    import json

    monkeypatch.setattr(_stub_suites, "RESULTS_DIR", tmp_path)
    await _stub_suites.main([])
    data = json.loads(next(tmp_path.glob("*.json")).read_text())

    assert "middleware" in data["suites"]
    for simulated in ("api_latency", "llm_provider", "kb_retrieval"):
        assert simulated not in data["suites"], (
            f"{simulated} sleeps for a constant; it must not appear in a "
            "default run where it can be mistaken for a measurement"
        )


@pytest.mark.asyncio
async def test_simulated_suites_are_tagged_when_requested(
    tmp_path, monkeypatch, _stub_suites
):
    """Opt in, and every simulated result must carry the tag."""
    import json

    monkeypatch.setattr(_stub_suites, "RESULTS_DIR", tmp_path)
    await _stub_suites.main(["--simulated"])
    data = json.loads(next(tmp_path.glob("*.json")).read_text())

    for simulated in ("api_latency", "llm_provider", "kb_retrieval"):
        assert data["suites"][simulated]["simulated"] is True
        assert data["suites"][simulated]["reason"]


@pytest.mark.asyncio
async def test_no_write_skips_the_file(tmp_path, monkeypatch, _stub_suites):
    monkeypatch.setattr(_stub_suites, "RESULTS_DIR", tmp_path)
    assert await _stub_suites.main(["--no-write"]) == 0
    assert list(tmp_path.glob("*.json")) == []
