"""Persist Layer A descriptors onto telemetry tags (best-effort)."""

from __future__ import annotations

import logging
from typing import Any

from eden.evaluation.descriptors.engine import TraceDescriptorReport

logger = logging.getLogger(__name__)


async def persist_descriptor_tags(
    org_id: str,
    trace_id: str,
    report: TraceDescriptorReport,
) -> None:
    """Merge ``eval:<descriptor_id>`` into the trace's JSONB tags.

    Uses the existing ``merge_trace_tags`` helper (dict form). Failures
    are logged and swallowed so finalize never blocks on descriptors.
    """
    if not report.descriptors:
        return
    new_tags = {d.tag: f"{d.confidence:.3f}" for d in report.descriptors}
    new_tags["eval:layer_a"] = ",".join(sorted(report.descriptor_ids))
    for k, v in (report.scores or {}).items():
        new_tags[f"eval:score:{k}"] = f"{v:.4f}"
    try:
        from eden.observability._trace_common import merge_trace_tags

        await merge_trace_tags(org_id, trace_id, new_tags)
    except Exception as exc:
        logger.debug("layer_a persist_descriptor_tags failed: %s", exc)


def report_to_judge_score_rows(
    org_id: str,
    trace_id: str,
    report: TraceDescriptorReport,
) -> list[dict[str, Any]]:
    """Convert descriptors to judge_scores-shaped dicts (binary)."""
    rows: list[dict[str, Any]] = []
    for d in report.descriptors:
        rows.append(
            {
                "org_id": org_id,
                "trace_id": trace_id,
                "judge_id": f"layer_a:{d.descriptor_id}",
                "score": float(d.confidence),
                "rationale": d.rationale,
                "metadata": {
                    "source": "layer_a",
                    "descriptor_id": d.descriptor_id,
                    "evidence": d.evidence,
                    "detector_version": report.detector_version,
                },
            }
        )
    return rows
