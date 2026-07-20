"""Persist Layer A descriptors onto telemetry tags (best-effort)."""

from __future__ import annotations

import logging
from datetime import UTC, datetime
from typing import Any

from eden.evaluation.descriptors.engine import TraceDescriptorReport

logger = logging.getLogger(__name__)

# Axes Layer A writes as production float scores (not LLM).
_SCORE_AXES = (
    "tool_selection_quality",
    "action_completion",
    "groundedness",
    "safety",
    "efficiency",
    "trace_quality",
)


async def persist_descriptor_tags(
    org_id: str,
    trace_id: str,
    report: TraceDescriptorReport,
) -> None:
    """Merge ``eval:<descriptor_id>`` + ``eval:score:*`` into trace tags.

    Always writes aggregate scores (even on clean traces). Failures are
    logged and swallowed so finalize never blocks on descriptors.
    """
    new_tags: dict[str, str] = {}
    if report.descriptors:
        new_tags.update({d.tag: f"{d.confidence:.3f}" for d in report.descriptors})
        new_tags["eval:layer_a"] = ",".join(sorted(report.descriptor_ids))
    for k, v in (report.scores or {}).items():
        try:
            new_tags[f"eval:score:{k}"] = f"{float(v):.4f}"
        except (TypeError, ValueError):
            continue
    if not new_tags:
        return
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
    """Convert Layer A report to judge_scores-shaped dicts.

    Includes per-descriptor binary rows plus aggregate float axes that
    UnifiedJudge previously scored via LLM.
    """
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
    for axis in _SCORE_AXES:
        if axis not in (report.scores or {}):
            continue
        try:
            score = float(report.scores[axis])
        except (TypeError, ValueError):
            continue
        rows.append(
            {
                "org_id": org_id,
                "trace_id": trace_id,
                "judge_id": axis,
                "score": score,
                "rationale": f"Layer A aggregate ({axis})",
                "metadata": {
                    "source": "layer_a",
                    "axis": axis,
                    "detector_version": report.detector_version,
                },
            }
        )
    return rows


async def persist_layer_a_judge_scores(
    org_id: str,
    trace_id: str,
    report: TraceDescriptorReport,
) -> int:
    """Write Layer A aggregate axes into ``judge_scores`` ($0).

    Uses the same table UnifiedJudge wrote to so dashboards / production
    sampler / DecisionScorer consumers see Layer A as the score source.
    Returns number of rows attempted.
    """
    rows = [
        r
        for r in report_to_judge_score_rows(org_id, trace_id, report)
        if r.get("metadata", {}).get("axis") in _SCORE_AXES
        or r.get("judge_id") in _SCORE_AXES
    ]
    # Prefer only the aggregate float axes for the main judge_scores table
    # (descriptor binary rows stay as tags / optional).
    axis_rows = [r for r in rows if r.get("judge_id") in _SCORE_AXES]
    if not axis_rows:
        return 0
    try:
        from eden.storage.postgres import get_postgres_client

        client = await get_postgres_client()
    except Exception as exc:
        logger.debug("layer_a judge_scores: postgres unavailable: %s", exc)
        return 0
    if client is None:
        return 0

    # Skip axes already written for this trace so a consumer retry after a
    # partial insert does not duplicate Layer A rows (table is append-only).
    existing: set[str] = set()
    try:
        rows_existing = await client.fetch(
            """
            SELECT judge_name FROM judge_scores
            WHERE tenant_id = $1 AND trace_id = $2
              AND judge_version = 'layer_a'
              AND model = 'layer_a'
            """,
            org_id,
            trace_id,
        )
        for er in rows_existing or []:
            try:
                existing.add(str(er["judge_name"]))
            except Exception:
                continue
    except Exception as exc:
        logger.debug("layer_a judge_scores: existing lookup failed: %s", exc)

    now = datetime.now(UTC)
    written = 0
    for row in axis_rows:
        judge_name = str(row["judge_id"])
        if judge_name in existing:
            continue
        try:
            await client.execute(
                """
                INSERT INTO judge_scores (
                    judge_run_id, tenant_id, trace_id, span_id,
                    judge_name, judge_version, score, rationale,
                    model, scored_at, latency_ms,
                    cost_usd, cached, source_event_id
                )
                VALUES (
                    gen_random_uuid(), $1, $2, NULL, $3, $4, $5, $6, $7,
                    $8, $9, $10, $11, NULL
                )
                """,
                org_id,
                trace_id,
                judge_name,
                "layer_a",
                float(row["score"]),
                row.get("rationale") or "",
                "layer_a",
                now,
                float(getattr(report, "latency_ms", 0.0) or 0.0),
                0.0,
                True,
            )
            written += 1
            existing.add(judge_name)
        except Exception as exc:
            logger.debug("layer_a judge_scores insert failed: %s", exc)
            # Partial write: surface transient failures so the consumer can
            # retry the remaining axes instead of ACKing a half-done set.
            if _is_transient_persist_error(exc):
                raise
    return written


def _is_transient_persist_error(exc: BaseException) -> bool:
    if isinstance(exc, (ConnectionError, TimeoutError, OSError)):
        return True
    msg = str(exc).lower()
    return any(
        tok in msg
        for tok in (
            "connection",
            "timeout",
            "temporarily",
            "reset by peer",
            "broken pipe",
            "too many connections",
        )
    )
