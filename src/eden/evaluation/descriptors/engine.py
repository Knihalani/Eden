"""DescriptorEngine — multi-detector Layer A with arbitration + scoring."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from eden.evaluation.descriptors.detectors import ALL_DETECTORS
from eden.evaluation.descriptors.parse import build_trajectory
from eden.evaluation.descriptors.taxonomy import (
    DESCRIPTOR_IDS,
    LAYER_A_PRIMARY,
    ONLINE_CRITICAL,
    SUPPRESS_WHEN,
)

# Online default: process at most this many trailing events (keeps long agents cheap).
_ONLINE_MAX_EVENTS = 180
_ONLINE_MAX_TOOL_CALLS_SCAN = 80


@dataclass(frozen=True)
class DescriptorResult:
    descriptor_id: str
    display_name: str
    confidence: float
    rationale: str
    evidence: dict[str, Any] = field(default_factory=dict)
    span_id: str | None = None
    source: str = "layer_a"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @property
    def tag(self) -> str:
        return f"eval:{self.descriptor_id}"


@dataclass
class TraceDescriptorReport:
    trace_id: str | None
    descriptors: list[DescriptorResult]
    latency_ms: float = 0.0
    tool_call_count: int = 0
    detector_version: str = "layer_a.v3"
    scores: dict[str, float] = field(default_factory=dict)

    @property
    def descriptor_ids(self) -> set[str]:
        return {d.descriptor_id for d in self.descriptors}

    @property
    def tags(self) -> list[str]:
        return [d.tag for d in self.descriptors]

    def has(self, descriptor_id: str) -> bool:
        return descriptor_id in self.descriptor_ids

    def to_dict(self) -> dict[str, Any]:
        return {
            "trace_id": self.trace_id,
            "descriptors": [d.to_dict() for d in self.descriptors],
            "latency_ms": self.latency_ms,
            "tool_call_count": self.tool_call_count,
            "detector_version": self.detector_version,
            "tags": self.tags,
            "scores": self.scores,
        }


def _events_to_dicts(events: list[Any]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for e in events or []:
        if isinstance(e, dict):
            out.append(e)
            continue
        if hasattr(e, "model_dump"):
            out.append(e.model_dump())
        elif hasattr(e, "__dataclass_fields__"):
            out.append(asdict_safe(e))
        elif hasattr(e, "__dict__"):
            out.append(dict(e.__dict__))
    return out


def asdict_safe(obj: Any) -> dict[str, Any]:
    from dataclasses import asdict as _asdict

    return _asdict(obj)


def arbitrate(raw: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep highest-confidence per id, then apply SUPPRESS_WHEN rules."""
    best: dict[str, dict[str, Any]] = {}
    for r in raw:
        did = r["descriptor_id"]
        prev = best.get(did)
        if prev is None or float(r.get("confidence", 0)) > float(prev.get("confidence", 0)):
            best[did] = r

    changed = True
    while changed:
        changed = False
        winners = sorted(
            best.keys(),
            key=lambda k: -float(best[k].get("confidence", 0)),
        )
        for winner in winners:
            if winner not in best:
                continue
            for loser in SUPPRESS_WHEN.get(winner, frozenset()):
                if loser in best:
                    best.pop(loser, None)
                    changed = True
    return list(best.values())


def aggregate_scores(descriptors: list[DescriptorResult]) -> dict[str, float]:
    """Derive float quality scores from descriptor set (Luna-ish proxies)."""
    ids = {d.descriptor_id for d in descriptors}
    conf = {d.descriptor_id: d.confidence for d in descriptors}

    def _penalize(*keys: str, weight: float = 1.0) -> float:
        hit = [conf[k] for k in keys if k in conf]
        if not hit:
            return 1.0
        return max(0.0, 1.0 - weight * max(hit))

    tool_selection = min(
        _penalize(
            "wrong_tool",
            "bad_tool_args",
            "tool_skip",
            "unnecessary_tool_call",
            "extra_tool_call",
        ),
        _penalize("tool_error", "mcp_auth_failure", weight=0.5),
    )
    action_completion = _penalize(
        "action_incomplete",
        "goal_abandoned",
        "dead_end",
        "tool_skip",
        "error_swallow",
        "timeout",
    )
    groundedness = _penalize(
        "result_ignore",
        "output_fabrication",
        "inaccuracy",
        "stale_tool_result",
        "partial_result_use",
    )
    safety = _penalize("jailbreak_attempt", "pii_leak_risk", "mcp_auth_failure")
    efficiency = _penalize(
        "looping",
        "repetitive_tool_call",
        "retry_storm",
        "sliding_window_loop",
        "tool_thrash",
        "assistant_echo_loop",
        "excessive_steps",
        "no_progress",
        "cost_spike",
        "confusion_loop",
        "excessive_clarification",
    )
    trace_quality = (
        0.30 * action_completion
        + 0.25 * tool_selection
        + 0.25 * groundedness
        + 0.10 * safety
        + 0.10 * efficiency
    )
    return {
        "tool_selection_quality": round(tool_selection, 4),
        "action_completion": round(action_completion, 4),
        "groundedness": round(groundedness, 4),
        "safety": round(safety, 4),
        "efficiency": round(efficiency, 4),
        "trace_quality": round(trace_quality, 4),
        "negative_descriptor_mass": round(sum(conf.values()), 4) if conf else 0.0,
        "descriptor_count": float(len(ids)),
    }


class DescriptorEngine:
    """Run deterministic + heuristic Layer A graders on agent traces.

    ``online=True`` (production default) enables:
    - trailing event window for long agents
    - critical-detector-first ordering
    - skip heavy grounding on short no-tool chats
    """

    def __init__(
        self,
        *,
        enabled: set[str] | frozenset[str] | None = None,
        min_confidence: float = 0.0,
        repeat_threshold: int = 3,
        primary_only: bool = False,
        online: bool = True,
        max_events: int | None = None,
        critical_only: bool = False,
    ) -> None:
        if critical_only:
            base: frozenset[str] = ONLINE_CRITICAL
        elif primary_only:
            base = LAYER_A_PRIMARY
        else:
            base = DESCRIPTOR_IDS
        self.enabled = frozenset(enabled) if enabled is not None else frozenset(base)
        self.min_confidence = min_confidence
        self.repeat_threshold = repeat_threshold
        self.online = online
        self.max_events = (
            max_events
            if max_events is not None
            else (_ONLINE_MAX_EVENTS if online else None)
        )

    def describe(
        self,
        events: list[Any],
        *,
        trace_id: str | None = None,
        tool_schemas: dict[str, dict[str, Any]] | None = None,
        expected_tools: list[str] | None = None,
        max_tool_calls: int | None = None,
        timeout_ms: float | None = None,
    ) -> TraceDescriptorReport:
        import time

        t0 = time.perf_counter()
        dicts = _events_to_dicts(events)
        truncated = False
        if self.max_events is not None and len(dicts) > self.max_events:
            head = dicts[:3]
            tail = dicts[-(self.max_events - len(head)) :]
            seen = {id(x) for x in head}
            dicts = head + [e for e in tail if id(e) not in seen]
            truncated = True

        view = build_trajectory(
            dicts,
            tool_schemas=tool_schemas,
            expected_tools=expected_tools,
            max_tool_calls=max_tool_calls,
            timeout_ms=timeout_ms,
        )

        if self.online and len(view.tool_calls) > _ONLINE_MAX_TOOL_CALLS_SCAN:
            view.tool_calls = view.tool_calls[-_ONLINE_MAX_TOOL_CALLS_SCAN:]
            view.tool_results = view.tool_results[-_ONLINE_MAX_TOOL_CALLS_SCAN:]

        skip_heavy = (
            self.online
            and not view.tool_calls
            and len(view.assistant_messages) <= 2
            and len(dicts) <= 8
        )

        ordered = list(ALL_DETECTORS)
        if self.online:

            def _prio(det: Any) -> int:
                name = det.__name__
                if name in {
                    "detect_loops",
                    "detect_retry_storm",
                    "detect_sliding_window_loop",
                    "detect_tool_thrash",
                    "detect_tool_errors",
                    "detect_bad_tool_args",
                }:
                    return 0
                if name in {
                    "detect_result_ignore",
                    "detect_output_fabrication",
                    "detect_inaccuracy",
                    "detect_stale_tool_result",
                    "detect_plan_drift",
                    "detect_contradiction",
                }:
                    return 2
                return 1

            ordered.sort(key=_prio)

        raw: list[dict[str, Any]] = []
        heavy = {
            "detect_result_ignore",
            "detect_output_fabrication",
            "detect_inaccuracy",
            "detect_stale_tool_result",
            "detect_plan_drift",
            "detect_extra_tool_call",
            "detect_wrong_tool",
            "detect_partial_result_use",
            "detect_contradiction",
        }
        critical_hit = False
        for det in ordered:
            if skip_heavy and det.__name__ in heavy:
                continue
            # Online: once a critical damage label fires, skip expensive grounding
            if (
                self.online
                and critical_hit
                and det.__name__ in heavy
                and len(view.tool_calls) > 12
            ):
                continue
            if det.__name__ in {"detect_loops", "detect_sliding_window_loop"}:
                hits = det(view, repeat_threshold=self.repeat_threshold)
            else:
                hits = det(view)
            raw.extend(hits)
            if self.online and hits:
                for h in hits:
                    if h.get("descriptor_id") in ONLINE_CRITICAL:
                        critical_hit = True
                        break

        raw = [
            r
            for r in raw
            if r["descriptor_id"] in self.enabled
            and float(r.get("confidence", 0)) >= self.min_confidence
        ]
        chosen = arbitrate(raw)
        descriptors = [
            DescriptorResult(
                descriptor_id=r["descriptor_id"],
                display_name=r["display_name"],
                confidence=float(r["confidence"]),
                rationale=r["rationale"],
                evidence=dict(r.get("evidence") or {}),
                span_id=r.get("span_id"),
                source=r.get("source", "layer_a"),
            )
            for r in sorted(
                chosen, key=lambda x: (-float(x["confidence"]), x["descriptor_id"])
            )
        ]
        scores = aggregate_scores(descriptors)
        if truncated:
            scores["events_truncated"] = 1.0
        elapsed = (time.perf_counter() - t0) * 1000.0
        tid = trace_id
        if tid is None and dicts:
            tid = dicts[0].get("trace_id")
        return TraceDescriptorReport(
            trace_id=tid,
            descriptors=descriptors,
            latency_ms=round(elapsed, 3),
            tool_call_count=len(view.tool_calls),
            scores=scores,
            detector_version="layer_a.v3",
        )


def describe_trace(events: list[Any], **kwargs: Any) -> TraceDescriptorReport:
    online = kwargs.pop("online", True)
    return DescriptorEngine(online=online).describe(events, **kwargs)


def structural_only(report: TraceDescriptorReport) -> TraceDescriptorReport:
    keep = [d for d in report.descriptors if d.descriptor_id in LAYER_A_PRIMARY]
    return TraceDescriptorReport(
        trace_id=report.trace_id,
        descriptors=keep,
        latency_ms=report.latency_ms,
        tool_call_count=report.tool_call_count,
        detector_version=report.detector_version,
        scores=aggregate_scores(keep),
    )
