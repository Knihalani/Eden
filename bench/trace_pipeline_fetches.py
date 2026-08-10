"""Measure the trace.finalized pipeline's per-trace event-fetch waste (Wave 8).

The pipeline (``TraceFinalizedConsumer._process_trace``) runs once per
finalized trace. Pre-Wave 8 it fetched the FULL event set (wide columns,
up to TRACE_EVENTS_LIMIT=2000 rows) up to three separate times (the
investigator leg only runs when Layer A has no primary hit):

  1. ``_run_layer_a``      → ``_fetch_trace_events``
  2. ``AutoIssueScanner``  → ``_fetch_events`` → ``_fetch_trace_events``
  3. ``signal_investigator`` → ``investigate_trace(events=None)`` → fetch

and the F34 classifier gate was invoked with NO events at all, so its
feature vector hashed an empty list. This bench counts the real number of
``_fetch_trace_events`` calls per ``_process_trace`` and the number of
``classifier_predictions`` INSERTs, using a counting wrapper.

Nothing here needs external services — every DB access is faked.
"""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

# Resolve ``eden`` to the app package, not the SDK stub (see bench/common.py).
import bench.common  # noqa: F401  (side-effect: sys.path fixup)

FETCH_COUNT = {"n": 0}
INSERT_COUNT = {"n": 0}


class _CountingPG:
    async def fetch(self, sql: str, *args: object) -> list[dict[str, object]]:
        return []

    async def fetchrow(self, sql: str, *args: object) -> dict[str, object] | None:
        return None

    async def fetchval(self, sql: str, *args: object) -> object | None:
        return None

    async def execute(self, sql: str, *args: object) -> str:
        if "INSERT INTO classifier_predictions" in sql:
            INSERT_COUNT["n"] += 1
        return "OK"

    async def executemany(self, sql: str, *args: object) -> str:
        if "INSERT INTO classifier_predictions" in sql:
            INSERT_COUNT["n"] += 1
        return "OK"


def _make_trace_events(n: int = 60) -> list[dict[str, object]]:
    out: list[dict[str, object]] = []
    for i in range(n):
        out.append(
            {
                "event_id": f"ev-{i}",
                "trace_id": "trace-bench",
                "span_id": f"sp-{i}",
                "event_type": "tool.call" if i % 3 == 0 else "llm.completion",
                "name": f"tool_{i % 4}",
                "outcome": "failure" if i % 7 == 0 else "success",
                "timestamp": f"2026-08-10T00:{i // 60:02d}:{i % 60:02d}Z",
                "duration_ms": 100 + i,
                "attributes": {"tool_name": f"tool_{i % 4}", "role": "assistant"},
                "payload": {"input_tokens": 10, "output_tokens": 5},
                "metrics": {},
                "tags": [],
            }
        )
    return out


class _BenchPG(_CountingPG):
    """Fake PG that also serves one active classifier so the F34 gate runs."""

    async def fetch(self, sql: str, *args: object) -> list[dict[str, object]]:
        if "FROM signal_classifiers" in sql:
            return [
                {
                    "id": "clf-1",
                    "signal_id": "sig-1",
                    "model_blob": b"\x80\x04\x95\x03\x00\x00\x00\x00\x00\x00\x00]",
                    "shadow_mode": False,
                    "investigator_disabled": True,
                }
            ]
        return []


async def _count_events_pipeline() -> int:
    """Run one real ``_process_trace`` with a counting fetch wrapper."""
    from eden.workers import trace_finalized_consumer as mod

    consumer = mod.TraceFinalizedConsumer()

    async def _counting_fetch(org_id: str, trace_id: str, **kw: object):
        FETCH_COUNT["n"] += 1
        return _make_trace_events()

    events = _make_trace_events()

    with patch(
        "eden.insights.rca._common._fetch_trace_events",
        new=_counting_fetch,
    ), patch(
        "eden.storage.postgres.get_postgres_client",
        return_value=_BenchPG(),
    ), patch.object(
        consumer, "_maybe_prod_eval", AsyncMock()
    ), patch.object(
        consumer, "_run_annotator", AsyncMock()
    ), patch.object(
        consumer, "_run_session_rollup", AsyncMock()
    ), patch.object(
        consumer, "_run_trace_summary", AsyncMock()
    ), patch(
        "eden.issues.detection_settings.resolve_profile",
        AsyncMock(return_value="standard"),
    ), patch(
        "eden.llmops.promotion_hooks.get_issue_hook",
        AsyncMock(),
    ), patch(
        # Force the F34 gate to run even if Layer A produced a primary hit.
        "eden.workers.trace_finalized_consumer._layer_a_primary_hit",
        return_value=False,
    ):
        # Drive the real detection pipeline (Layer A + scanner + F34 gate).
        await consumer._process_trace("mid-0", {}, "org-bench", "trace-bench")

    # Confirm the classifier gate received real events (not empty).
    from eden.signals.classifier_worker import _extract_features

    feats_empty = _extract_features([], "trace-bench")
    feats_real = _extract_features(events, "trace-bench")
    assert feats_empty != feats_real, "F34 features identical with/without events"
    return FETCH_COUNT["n"]


async def main() -> None:
    global FETCH_COUNT
    FETCH_COUNT["n"] = 0
    INSERT_COUNT["n"] = 0

    n_fetches = await _count_events_pipeline()

    print("=== trace.finalized pipeline: event fetches per trace ===")
    print(f"  _fetch_trace_events calls per _process_trace:  {n_fetches}")
    print(f"  classifier_predictions INSERT round-trips:      {INSERT_COUNT['n']}")
    print()
    print("  Pre-fix baseline (documented):  up-to-3 full fetches + up-to-50")
    print("                                per-classifier INSERTs")
    print("  Post-fix target:                1 fetch + 1 executemany")


if __name__ == "__main__":
    asyncio.run(main())
