"""Apply N16 :meth:`IntelligenceAwareSamplingPolicy.decide` on ingest.

Soft-launch default is ``sampling_profile=full`` (100% keep). When ops
set ``EDEN_SAMPLING_PROFILE=balanced|aggressive``, this gate drops
non-signal events before sink routing and records a metrics-only
summary row (best-effort). See ``docs/docs/explanation/sampling-and-retention.md``.

Fail-open: any exception → keep (never break ingest).
"""

from __future__ import annotations

import logging
from typing import Any

from eden.observability.sampling.policy import (
    KeepSignals,
    SamplingDecision,
    get_sampling_policy,
)
from eden.observability.sampling.summaries import (
    TraceSamplingSummary,
    get_sampling_summary_store,
    signals_from_attributes,
)

logger = logging.getLogger(__name__)

_ERROR_OUTCOMES = frozenset(
    {"failure", "error", "timeout", "crash", "partial"},
)


def _high_cost_threshold_usd() -> float:
    """Read ``Settings.sampling_high_cost_usd`` (fail-open to the default)."""
    try:
        from eden.config import get_settings

        return float(getattr(get_settings(), "sampling_high_cost_usd", None) or 0.50)
    except Exception:  # noqa: BLE001 — never break sampling over a bad setting
        return 0.50


def keep_signals_for_event(event: Any) -> KeepSignals:
    """Build :class:`KeepSignals` from a telemetry event (duck-typed).

    ``is_high_cost`` is wired from the event's real, enriched
    ``metrics.cost_usd`` (stamped by ``TelemetryCollector._stamp_cost_usd``
    in ``_enrich``, which always runs BEFORE this sampling gate) compared
    against ``Settings.sampling_high_cost_usd``. This used to only ever be
    true via an ``eden.high_cost`` *attribute* the caller had to set by
    hand — nothing computed it from cost, so a genuinely expensive trace
    with no such attribute sampled away exactly like a cheap one. The
    attribute is kept as an OR so an explicit caller override still works.
    """
    attrs = getattr(event, "attributes", None)
    flags = signals_from_attributes(dict(attrs) if isinstance(attrs, dict) else {})
    outcome = str(getattr(event, "outcome", None) or "").strip().lower()
    has_error = bool(flags.get("has_error")) or outcome in _ERROR_OUTCOMES
    duration = getattr(event, "duration_ms", None)
    try:
        duration_ms = float(duration) if duration is not None else 0.0
    except (TypeError, ValueError):
        duration_ms = 0.0
    is_high_cost = bool(flags.get("is_high_cost")) or (
        _cost_usd(event) >= _high_cost_threshold_usd()
    )
    return KeepSignals(
        has_error=has_error,
        is_loop=bool(flags.get("is_loop")),
        has_tool_error=bool(flags.get("has_tool_error")),
        has_stumble=bool(flags.get("has_stumble")),
        has_judge_failure=bool(flags.get("has_judge_failure")),
        has_stat_gate_fail=bool(flags.get("has_stat_gate_fail")),
        has_mcp_auth_failure=bool(flags.get("has_mcp_auth_failure")),
        is_high_cost=is_high_cost,
        force_trace=bool(flags.get("force_trace")),
        duration_ms=duration_ms,
    )


def decide_for_event(event: Any) -> SamplingDecision:
    """Run the process-wide N16 policy against ``event``.

    M14 (§8.3): if the org has an explicit ``sampling_profile_override``
    warmed into the sync cache, decide with that profile instead of the
    process default. Global default stays ``full``; override is opt-in
    only. Fail-open: on any error return a keep decision (full profile).
    """
    try:
        signals = keep_signals_for_event(event)
        org_id = str(getattr(event, "tenant_id", "") or "")
        override: str | None = None
        if org_id:
            try:
                from eden.preview.gates import sampling_profile_override_sync

                override = sampling_profile_override_sync(org_id)
            except Exception:
                override = None
        if override:
            # One-shot policy with the org override — do not mutate the
            # process singleton (other orgs still use the global default).
            base = get_sampling_policy()
            from eden.observability.sampling.policy import (
                IntelligenceAwareSamplingPolicy,
            )

            policy = IntelligenceAwareSamplingPolicy(
                profile=override,  # type: ignore[arg-type]
                enabled=base.enabled,
                keep_rate_override=base.keep_rate_override,
                slow_threshold_ms=base.slow_threshold_ms,
            )
            return policy.decide(signals)
        policy = get_sampling_policy()
        return policy.decide(signals)
    except Exception as exc:  # noqa: BLE001 — never break ingest
        logger.debug("n16 sampling decide failed (keeping): %s", exc)
        return SamplingDecision(
            keep=True,
            reason="sampling decide failed open",
            rule_matched=None,
            profile="full",
            metrics_only=False,
        )


def _cost_usd(event: Any) -> float:
    metrics = getattr(event, "metrics", None)
    if not isinstance(metrics, dict):
        return 0.0
    for key in ("cost_usd", "total_cost_usd", "eden.cost_usd"):
        raw = metrics.get(key)
        if raw is None:
            continue
        try:
            return float(raw)
        except (TypeError, ValueError):
            continue
    return 0.0


async def should_route_event(event: Any) -> bool:
    """Return True if the event should hit full sinks; False if sampled out.

    On drop, best-effort persists a metrics-only summary. Always fail-open
    (returns True) if summarization itself raises.
    """
    decision = decide_for_event(event)
    if decision.keep:
        return True
    try:
        summary = TraceSamplingSummary(
            org_id=str(getattr(event, "tenant_id", "") or ""),
            trace_id=str(getattr(event, "trace_id", "") or ""),
            agent_id=getattr(event, "agent_id", None),
            duration_ms=int(getattr(event, "duration_ms", 0) or 0),
            cost_usd=_cost_usd(event),
            span_count=1,
            drop_reason=decision.reason or "sampled_out",
        )
        store = get_sampling_summary_store()
        # Fire-and-forget persist; in-memory buffer always updated.
        await store.persist(summary)
    except Exception as exc:  # noqa: BLE001
        logger.debug("n16 sampling summary failed: %s", exc)
    return False
