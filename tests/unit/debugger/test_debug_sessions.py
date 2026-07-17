"""F74 — debugger session continuity tests."""

from __future__ import annotations

import pytest

from eden.debugger.session import DebugSessionService


@pytest.mark.asyncio
async def test_debug_session_multi_run_compare() -> None:
    svc = DebugSessionService(pg=None)
    session = await svc.create("org_1", title="loop fix", source_trace_id="trc_a")
    run_a = await svc.add_run(
        "org_1",
        session.id,
        source_trace_id="trc_a",
        from_step=5,
        rerun_mode="cached_live",
        diff_summary=[{"step_number": 6, "mode": "cached_prefix"}],
    )
    run_b = await svc.add_run(
        "org_1",
        session.id,
        source_trace_id="trc_a",
        from_step=8,
        rerun_mode="cached_live",
        diff_summary=[{"step_number": 9, "mode": "cached_prefix"}],
    )
    assert run_a is not None and run_b is not None
    cmp = await svc.compare_runs(
        "org_1", session.id, run_a_id=run_a.id, run_b_id=run_b.id
    )
    assert cmp is not None
    assert cmp["comparison"]["from_step_delta"] == 3
    loaded = await svc.get("org_1", session.id)
    assert loaded is not None
    assert len(loaded.runs) == 2
