"""AutoIssueScanner — zero-config auto issue detection (F20).

Runs a set of always-on detectors over a finalized trace's events and
writes any hits as stumbles (which promote into issues). v1 ships four
detectors — ``tool_error``, ``loop`` (loop_detected), ``task_failure``,
and ``slow_trace`` — matching the closed-loop DoD; the remaining F20
detectors (hallucination, user_frustration, confusion_loop, high_cost)
are deferred and slot into the same detector table.

Detectors reuse the RCA event fetch (``_fetch_trace_events``) and the
telemetry row shape, so no new ingestion coupling is introduced.
"""

from __future__ import annotations

import logging
from typing import Any

from eden.issues.models import StumbleCreate
from eden.issues.stumble_writer import StumbleWriter

logger = logging.getLogger(__name__)

# Detectors enabled per detection profile (F20). ``minimal`` runs the two
# cheapest high-signal detectors; ``standard``/``advanced`` run all v1
# detectors. Unknown profiles fall back to ``standard``.
_PROFILE_DETECTORS: dict[str, set[str]] = {
    "minimal": {"tool_error", "task_failure"},
    "standard": {"tool_error", "loop", "task_failure", "slow_trace"},
    "advanced": {"tool_error", "loop", "task_failure", "slow_trace"},
}

_FAILURE_OUTCOMES = {"failure", "error", "timeout", "crash", "failed"}
_LOOP_REPEAT_THRESHOLD = 3
_ETEC_LOOP_THRESHOLD = 0.85
_MAX_SPANS = 500
_SLOW_TRACE_MS_DEFAULT = 30_000.0
_MAX_STUMBLES_PER_KIND = 3


def _s(v: Any) -> str:
    return "" if v is None else str(v)


class AutoIssueScanner:
    def __init__(self, writer: StumbleWriter | None = None) -> None:
        self._writer = writer or StumbleWriter()

    async def scan(
        self,
        org_id: str,
        trace_id: str,
        *,
        agent_id: str | None = None,
        session_id: str | None = None,
        user_id: str | None = None,
        detection_profile: str = "standard",
        events: list[dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        """Scan one trace and write any detected stumbles.

        Returns the list of ``StumbleWriter.create`` results (one per
        stumble written)."""
        enabled = _PROFILE_DETECTORS.get(
            detection_profile, _PROFILE_DETECTORS["standard"]
        )
        if not enabled:
            return []

        if events is None:
            events = await self._fetch_events(org_id, trace_id)
        if not events:
            return []

        # Cost guard: very large traces sample loop detection only.
        big_trace = len(events) > _MAX_SPANS

        agent_id = agent_id or self._infer_agent_id(events)
        stumbles: list[StumbleCreate] = []

        if "tool_error" in enabled and not big_trace:
            stumbles += self._detect_tool_errors(
                org_id, trace_id, agent_id, session_id, user_id, events
            )
        if "loop" in enabled:
            stumbles += self._detect_loops(
                org_id, trace_id, agent_id, session_id, user_id, events
            )
        if "task_failure" in enabled and not big_trace:
            stumbles += self._detect_task_failure(
                org_id, trace_id, agent_id, session_id, user_id, events
            )
        if "slow_trace" in enabled:
            stumbles += self._detect_slow_trace(
                org_id, trace_id, agent_id, session_id, user_id, events
            )

        results: list[dict[str, Any]] = []
        for sc in stumbles:
            try:
                results.append(await self._writer.create(sc))
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning("auto_scanner: write failed: %s", exc)
        return results

    async def _fetch_events(
        self, org_id: str, trace_id: str
    ) -> list[dict[str, Any]]:
        try:
            from eden.insights.rca._common import _fetch_trace_events

            return await _fetch_trace_events(org_id, trace_id)
        except Exception as exc:
            logger.debug("auto_scanner: fetch events failed: %s", exc)
            return []

    @staticmethod
    def _infer_agent_id(events: list[dict[str, Any]]) -> str | None:
        for e in events:
            if e.get("agent_id"):
                return str(e["agent_id"])
        return None

    # ── detectors ───────────────────────────────────────────────────

    def _detect_tool_errors(
        self,
        org_id: str,
        trace_id: str,
        agent_id: str | None,
        session_id: str | None,
        user_id: str | None,
        events: list[dict[str, Any]],
    ) -> list[StumbleCreate]:
        seen: set[str] = set()
        out: list[StumbleCreate] = []
        for e in events:
            outcome = _s(e.get("outcome")).lower()
            err = e.get("error")
            is_tool = (
                "tool" in _s(e.get("event_type")).lower()
                or bool(e.get("tool_calls_full"))
                or bool(e.get("tool_results"))
            )
            if not (err or outcome in _FAILURE_OUTCOMES):
                continue
            if not is_tool:
                continue
            tool_name = (
                _s(e.get("name"))
                or _s((e.get("attributes") or {}).get("tool_name"))
                or self._first_tool_name(e)
                or "unknown"
            )
            error_text = _s(err) or outcome or "tool_error"
            sig = f"{tool_name}|{error_text}"
            if sig in seen:
                continue
            seen.add(sig)
            out.append(
                StumbleCreate(
                    org_id=org_id,
                    trace_id=trace_id,
                    kind="tool_error",
                    title=f"Tool '{tool_name}' failed",
                    detail={
                        "tool_name": tool_name,
                        "error": error_text,
                        "span_id": e.get("span_id"),
                        "outcome": outcome or None,
                    },
                    detected_by="auto_scanner",
                    agent_id=agent_id,
                    session_id=session_id,
                    user_id=user_id,
                    span_id=e.get("span_id"),
                )
            )
            if len(out) >= _MAX_STUMBLES_PER_KIND:
                break
        return out

    @staticmethod
    def _first_tool_name(e: dict[str, Any]) -> str:
        for tc in e.get("tool_calls_full") or []:
            if isinstance(tc, dict) and tc.get("name"):
                return str(tc["name"])
        return ""

    def _detect_loops(
        self,
        org_id: str,
        trace_id: str,
        agent_id: str | None,
        session_id: str | None,
        user_id: str | None,
        events: list[dict[str, Any]],
    ) -> list[StumbleCreate]:
        # 1) explicit ETEC loop score from trace-quality attrs.
        best_score = 0.0
        for e in events:
            attrs = e.get("attributes") or {}
            for k in ("etec_loop_score", "loop_score", "etec"):
                v = attrs.get(k)
                try:
                    best_score = max(best_score, float(v))
                except (TypeError, ValueError):
                    continue

        # 2) hash-repetition fallback: identical tool call signatures.
        counts: dict[str, int] = {}
        for e in events:
            if not (
                "tool" in _s(e.get("event_type")).lower()
                or e.get("tool_calls_full")
            ):
                continue
            sig = _s(e.get("name")) or self._first_tool_name(e)
            args = _s((e.get("attributes") or {}).get("tool_args"))
            key = f"{sig}|{args}"
            counts[key] = counts.get(key, 0) + 1
        repeated = max(counts.items(), key=lambda kv: kv[1], default=(None, 0))

        if best_score >= _ETEC_LOOP_THRESHOLD or repeated[1] >= _LOOP_REPEAT_THRESHOLD:
            detail: dict[str, Any] = {}
            if best_score >= _ETEC_LOOP_THRESHOLD:
                detail["etec_loop_score"] = round(best_score, 4)
            if repeated[0] is not None and repeated[1] >= _LOOP_REPEAT_THRESHOLD:
                detail["repeated_step"] = repeated[0]
                detail["repeat_count"] = repeated[1]
                detail["loop_hash"] = repeated[0]
            return [
                StumbleCreate(
                    org_id=org_id,
                    trace_id=trace_id,
                    kind="loop",
                    title="Agent loop detected",
                    detail=detail,
                    detected_by="auto_scanner",
                    agent_id=agent_id,
                    session_id=session_id,
                    user_id=user_id,
                )
            ]
        return []

    def _detect_task_failure(
        self,
        org_id: str,
        trace_id: str,
        agent_id: str | None,
        session_id: str | None,
        user_id: str | None,
        events: list[dict[str, Any]],
    ) -> list[StumbleCreate]:
        reason: str | None = None
        for e in events:
            attrs = e.get("attributes") or {}
            if _s(attrs.get("session_success")).lower() == "false":
                reason = _s(attrs.get("failure_reason")) or "session marked unsuccessful"
                break
            if attrs.get("failure_reason"):
                reason = _s(attrs.get("failure_reason"))
                break
            # Root-span terminal failure.
            if e.get("parent_span_id") is None and _s(e.get("outcome")).lower() in (
                "failure",
                "crash",
                "failed",
            ):
                reason = _s(e.get("error")) or _s(e.get("outcome")) or "task failed"
                break
        if reason is None:
            return []
        return [
            StumbleCreate(
                org_id=org_id,
                trace_id=trace_id,
                kind="task_failure",
                title="Task failed",
                detail={"failure_reason": reason},
                detected_by="auto_scanner",
                agent_id=agent_id,
                session_id=session_id,
                user_id=user_id,
            )
        ]

    def _detect_slow_trace(
        self,
        org_id: str,
        trace_id: str,
        agent_id: str | None,
        session_id: str | None,
        user_id: str | None,
        events: list[dict[str, Any]],
    ) -> list[StumbleCreate]:
        # v1 heuristic: max span duration over a fixed threshold. The
        # spec's "agent p99 × 2" needs the ClickHouse rollup (deferred);
        # the threshold is a safe stand-in that never fires on healthy
        # sub-30s traces.
        max_ms = 0.0
        for e in events:
            try:
                max_ms = max(max_ms, float(e.get("duration_ms") or 0.0))
            except (TypeError, ValueError):
                continue
        if max_ms <= _SLOW_TRACE_MS_DEFAULT:
            return []
        return [
            StumbleCreate(
                org_id=org_id,
                trace_id=trace_id,
                kind="timeout",
                title="Slow trace",
                detail={
                    "max_duration_ms": max_ms,
                    "threshold_ms": _SLOW_TRACE_MS_DEFAULT,
                    "heuristic": "fixed_threshold_v1",
                },
                detected_by="auto_scanner",
                agent_id=agent_id,
                session_id=session_id,
                user_id=user_id,
            )
        ]
