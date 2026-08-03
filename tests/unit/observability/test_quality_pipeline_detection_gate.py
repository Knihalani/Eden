"""Phase 5 — Detection step is gated off by default.

``compute_trace_reports``'s Detection sub-step
(``supplementaries.phase_7_detection.detectors.run_all_detectors``, ~200ms
CPU/trace) has no ``_TABLES`` entry in ``persist_reports`` — every
computed report has always been silently discarded. This gates the
compute itself behind ``Settings.quality_pipeline_detection_enabled``
(default ``False``) so traces stop paying that CPU cost for a report
that is never persisted.
"""

from __future__ import annotations

import asyncio
from unittest.mock import patch

import pytest


def _events() -> list[dict]:
    return [
        {"event_type": "user.prompt", "text": "hi"},
        {"event_type": "llm.completion", "text": "hello"},
        {"event_type": "span.end", "duration_ms": 10},
    ]


def test_detection_setting_defaults_to_disabled() -> None:
    from eden.config import Settings

    assert Settings().quality_pipeline_detection_enabled is False


def test_detection_not_invoked_when_disabled() -> None:
    """``run_all_detectors`` must not even be imported/called when the
    flag is off — the step should short-circuit before importing the
    supplementaries module at all."""
    from eden.observability.quality_pipeline import worker

    with patch.object(worker, "_detection_enabled", return_value=False):
        with patch(
            "supplementaries.phase_7_detection.detectors.run_all_detectors"
        ) as mock_run:
            reports = asyncio.new_event_loop().run_until_complete(
                worker.compute_trace_reports(
                    tenant_id="t1", trace_id="tr1", events=_events()
                )
            )

    mock_run.assert_not_called()
    assert reports["detection"]["status"] == "disabled"


def test_detection_invoked_when_enabled() -> None:
    """Sanity check for the other side of the gate: flipping the flag
    on restores the previous behaviour (detection actually runs)."""
    from eden.observability.quality_pipeline import worker

    with patch.object(worker, "_detection_enabled", return_value=True):
        reports = asyncio.new_event_loop().run_until_complete(
            worker.compute_trace_reports(
                tenant_id="t1", trace_id="tr1", events=_events()
            )
        )

    assert reports["detection"].get("status") != "disabled"


def test_detection_has_no_persist_table() -> None:
    """Documents the reason for the gate: even if detection ran, there
    is no table to persist it to, so ``persist_reports`` always drops
    it on the floor. If this ever changes, the gate's default should
    likely flip to True alongside adding the table."""
    from eden.observability.quality_pipeline.worker import _TABLES

    assert "detection" not in _TABLES
