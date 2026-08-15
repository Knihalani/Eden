"""AutoIssueScanner — zero-config auto issue detection (F20).

Runs a set of always-on detectors over a finalized trace's events and
writes any hits as stumbles (which promote into issues). Seven detectors
ship in the standard profile — ``tool_error``, ``loop``, ``task_failure``,
``slow_trace``, ``hallucination``, ``user_frustration``, ``confusion_loop``,
and ``high_cost``.

Detectors reuse the RCA event fetch (``_fetch_trace_events``) and the
telemetry row shape, so no new ingestion coupling is introduced.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from eden.issues.metrics import record_scan
from eden.issues.models import StumbleCreate
from eden.issues.stumble_writer import StumbleWriter

logger = logging.getLogger(__name__)

# Detectors enabled per detection profile (F20). ``minimal`` runs the two
# cheapest high-signal detectors; ``standard``/``advanced`` run all eight
# shipped detectors ($0 LLM). Unknown profiles fall back to ``standard``.
_ALL_DETECTORS: frozenset[str] = frozenset(
    {
        "tool_error",
        "loop",
        "task_failure",
        "slow_trace",
        "hallucination",
        "user_frustration",
        "confusion_loop",
        "high_cost",
    }
)
_PROFILE_DETECTORS: dict[str, set[str]] = {
    "minimal": {"tool_error", "task_failure"},
    "standard": set(_ALL_DETECTORS),
    "advanced": set(_ALL_DETECTORS),
}

_FAILURE_OUTCOMES = {"failure", "error", "timeout", "crash", "failed"}
_LOOP_REPEAT_THRESHOLD = 3
_ETEC_LOOP_THRESHOLD = 0.85
_MAX_SPANS = 500
_SLOW_TRACE_MS_DEFAULT = 30_000.0
_HALLUCINATION_JUDGE_THRESHOLD = 0.3
_HIGH_COST_USD_DEFAULT = 1.0
_CONFUSION_REPEAT_THRESHOLD = 2
_FRUSTRATION_KEYWORDS = (
    "try again",
    "wrong",
    "not helpful",
    "doesn't work",
    "does not work",
    "frustrated",
    "useless",
    "broken",
    "still wrong",
)
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
        threshold_multiplier: float = 1.0,
        events: list[dict[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        """Scan one trace and write any detected stumbles.

        ``threshold_multiplier`` (Wave 3, 3.2) scales the fixed detector
        thresholds per agent: <1.0 detects more (confirm-heavy agent),
        >1.0 detects less (dismiss-heavy agent). Derived by
        ``detection_settings.resolve_agent_threshold_multiplier``.

        Returns the list of ``StumbleWriter.create`` results (one per
        stumble written)."""
        started = time.perf_counter()
        enabled = _PROFILE_DETECTORS.get(
            detection_profile, _PROFILE_DETECTORS["standard"]
        )
        if not enabled:
            return []

        if events is None:
            events = await self._fetch_events(org_id, trace_id)
        if not events:
            return []

        mult = float(threshold_multiplier or 1.0)
        slow_ms = _SLOW_TRACE_MS_DEFAULT * mult
        high_cost = _HIGH_COST_USD_DEFAULT * mult
        loop_repeat = max(2, round(_LOOP_REPEAT_THRESHOLD * mult))
        confusion_repeat = max(2, round(_CONFUSION_REPEAT_THRESHOLD * mult))

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
                org_id, trace_id, agent_id, session_id, user_id, events,
                repeat_threshold=loop_repeat,
            )
        if "task_failure" in enabled and not big_trace:
            stumbles += self._detect_task_failure(
                org_id, trace_id, agent_id, session_id, user_id, events
            )
        if "slow_trace" in enabled:
            stumbles += self._detect_slow_trace(
                org_id, trace_id, agent_id, session_id, user_id, events,
                slow_ms=slow_ms,
            )
        if "hallucination" in enabled and not big_trace:
            stumbles += await self._detect_hallucination(
                org_id, trace_id, agent_id, session_id, user_id, events
            )
        if "user_frustration" in enabled and not big_trace:
            stumbles += self._detect_user_frustration(
                org_id, trace_id, agent_id, session_id, user_id, events
            )
        if "confusion_loop" in enabled:
            stumbles += self._detect_confusion_loop(
                org_id, trace_id, agent_id, session_id, user_id, events,
                repeat_threshold=confusion_repeat,
            )
        if "high_cost" in enabled:
            stumbles += self._detect_high_cost(
                org_id, trace_id, agent_id, session_id, user_id, events,
                high_cost_usd=high_cost,
            )

        detector_hits: dict[str, int] = {}
        for sc in stumbles:
            detector_hits[sc.kind] = detector_hits.get(sc.kind, 0) + 1

        results: list[dict[str, Any]] = []
        for sc in stumbles:
            try:
                results.append(await self._writer.create(sc))
            except Exception as exc:  # pragma: no cover - defensive
                logger.warning("auto_scanner: write failed: %s", exc)

        record_scan(
            (time.perf_counter() - started) * 1000.0, detector_hits=detector_hits
        )
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
        *,
        repeat_threshold: int = _LOOP_REPEAT_THRESHOLD,
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

        if best_score >= _ETEC_LOOP_THRESHOLD or repeated[1] >= repeat_threshold:
            detail: dict[str, Any] = {}
            if best_score >= _ETEC_LOOP_THRESHOLD:
                detail["etec_loop_score"] = round(best_score, 4)
            if repeated[0] is not None and repeated[1] >= repeat_threshold:
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
        *,
        slow_ms: float = _SLOW_TRACE_MS_DEFAULT,
    ) -> list[StumbleCreate]:
        # v1 heuristic: max span duration over a threshold. The spec's
        # "agent p99 × 2" needs the ClickHouse rollup (deferred); the
        # threshold is a safe stand-in that never fires on healthy
        # sub-30s traces. ``slow_ms`` is per-agent scaled (Wave 3, 3.2).
        max_ms = 0.0
        for e in events:
            try:
                max_ms = max(max_ms, float(e.get("duration_ms") or 0.0))
            except (TypeError, ValueError):
                continue
        if max_ms <= slow_ms:
            return []
        return [
            StumbleCreate(
                org_id=org_id,
                trace_id=trace_id,
                kind="timeout",
                title="Slow trace",
                detail={
                    "max_duration_ms": max_ms,
                    "threshold_ms": round(slow_ms, 2),
                    "heuristic": "fixed_threshold_v1",
                },
                detected_by="auto_scanner",
                agent_id=agent_id,
                session_id=session_id,
                user_id=user_id,
            )
        ]

    async def _detect_hallucination(
        self,
        org_id: str,
        trace_id: str,
        agent_id: str | None,
        session_id: str | None,
        user_id: str | None,
        events: list[dict[str, Any]],
    ) -> list[StumbleCreate]:
        """Judge score first; heuristic fallback when no judge rows."""
        try:
            from eden.insights.rca._common import _fetch_judge_scores

            judge_rows = await _fetch_judge_scores(org_id, trace_id)
        except Exception:
            judge_rows = []

        for row in judge_rows:
            if _s(row.get("judge_name")).lower() != "hallucination":
                continue
            try:
                score = float(row.get("score"))
            except (TypeError, ValueError):
                continue
            if score < _HALLUCINATION_JUDGE_THRESHOLD:
                return [
                    StumbleCreate(
                        org_id=org_id,
                        trace_id=trace_id,
                        kind="hallucination",
                        title="Hallucination detected",
                        detail={
                            "judge_score": score,
                            "source": "judge",
                        },
                        detected_by="auto_scanner",
                        agent_id=agent_id,
                        session_id=session_id,
                        user_id=user_id,
                    )
                ]

        for e in events:
            attrs = e.get("attributes") or {}
            for k in ("hallucination_score", "hhe_score"):
                try:
                    hs = float(attrs.get(k))
                except (TypeError, ValueError):
                    continue
                if hs > 0.5:
                    return [
                        StumbleCreate(
                            org_id=org_id,
                            trace_id=trace_id,
                            kind="hallucination",
                            title="Hallucination detected",
                            detail={
                                "hallucination_score": round(hs, 4),
                                "source": "trace_quality",
                            },
                            detected_by="auto_scanner",
                            agent_id=agent_id,
                            session_id=session_id,
                            user_id=user_id,
                        )
                    ]

        tool_outputs: list[str] = []
        assistant_texts: list[str] = []
        for e in events:
            et = _s(e.get("event_type")).lower()
            if "tool" in et and e.get("tool_results"):
                for tr in e.get("tool_results") or []:
                    if isinstance(tr, dict):
                        tool_outputs.append(_s(tr.get("content") or tr.get("output")))
            if et in ("llm.completion", "chat.completion", "message"):
                assistant_texts.append(
                    _s(e.get("output_text") or e.get("content") or e.get("response"))
                )

        empty_tool = any(not t.strip() or t.strip() in ("{}", "[]", "null") for t in tool_outputs)
        claims_data = any(
            any(w in t.lower() for w in ("found", "according to", "shows that", "%"))
            for t in assistant_texts
            if t
        )
        if empty_tool and claims_data:
            return [
                StumbleCreate(
                    org_id=org_id,
                    trace_id=trace_id,
                    kind="hallucination",
                    title="Possible hallucination",
                    detail={
                        "heuristic": "empty_tool_result_with_claims",
                        "source": "heuristic",
                    },
                    detected_by="auto_scanner",
                    agent_id=agent_id,
                    session_id=session_id,
                    user_id=user_id,
                )
            ]
        return []

    def _detect_user_frustration(
        self,
        org_id: str,
        trace_id: str,
        agent_id: str | None,
        session_id: str | None,
        user_id: str | None,
        events: list[dict[str, Any]],
    ) -> list[StumbleCreate]:
        user_msgs: list[str] = []
        regen_count = 0
        for e in events:
            attrs = e.get("attributes") or {}
            role = _s(attrs.get("role") or attrs.get("message_role")).lower()
            text = _s(
                e.get("input_text")
                or e.get("content")
                or attrs.get("user_message")
                or attrs.get("text")
            )
            if attrs.get("regeneration") or attrs.get("is_regeneration"):
                regen_count += 1
            if role == "user" and text:
                user_msgs.append(text.lower())

        frustrated = regen_count >= 2 or any(
            kw in msg for msg in user_msgs for kw in _FRUSTRATION_KEYWORDS
        )
        if not frustrated:
            return []
        return [
            StumbleCreate(
                org_id=org_id,
                trace_id=trace_id,
                kind="user_frustration",
                title="User frustration detected",
                detail={
                    "regeneration_count": regen_count,
                    "matched_keywords": [
                        kw
                        for kw in _FRUSTRATION_KEYWORDS
                        if any(kw in m for m in user_msgs)
                    ],
                },
                detected_by="auto_scanner",
                agent_id=agent_id,
                session_id=session_id,
                user_id=user_id,
            )
        ]

    def _detect_confusion_loop(
        self,
        org_id: str,
        trace_id: str,
        agent_id: str | None,
        session_id: str | None,
        user_id: str | None,
        events: list[dict[str, Any]],
        *,
        repeat_threshold: int = _CONFUSION_REPEAT_THRESHOLD,
    ) -> list[StumbleCreate]:
        questions: list[str] = []
        for e in events:
            attrs = e.get("attributes") or {}
            role = _s(attrs.get("role") or attrs.get("message_role")).lower()
            text = _s(e.get("output_text") or e.get("content") or attrs.get("text"))
            if role in ("assistant", "agent") and "?" in text:
                norm = " ".join(text.lower().split())[:200]
                if norm:
                    questions.append(norm)

        counts: dict[str, int] = {}
        for q in questions:
            counts[q] = counts.get(q, 0) + 1
        repeated = [q for q, n in counts.items() if n >= repeat_threshold]
        if not repeated:
            return []
        return [
            StumbleCreate(
                org_id=org_id,
                trace_id=trace_id,
                kind="loop",
                title="Confusion loop detected",
                detail={
                    "repeated_question": repeated[0],
                    "repeat_count": counts[repeated[0]],
                    "detector": "confusion_loop",
                },
                detected_by="auto_scanner",
                agent_id=agent_id,
                session_id=session_id,
                user_id=user_id,
            )
        ]

    def _detect_high_cost(
        self,
        org_id: str,
        trace_id: str,
        agent_id: str | None,
        session_id: str | None,
        user_id: str | None,
        events: list[dict[str, Any]],
        *,
        high_cost_usd: float = _HIGH_COST_USD_DEFAULT,
    ) -> list[StumbleCreate]:
        total = 0.0
        for e in events:
            for key in ("cost_usd", "estimated_cost_usd"):
                try:
                    total += float(e.get(key) or (e.get("attributes") or {}).get(key) or 0.0)
                except (TypeError, ValueError):
                    continue
        if total <= high_cost_usd:
            return []
        return [
            StumbleCreate(
                org_id=org_id,
                trace_id=trace_id,
                kind="custom",
                title="High-cost trace",
                detail={
                    "total_cost_usd": round(total, 6),
                    "threshold_usd": round(high_cost_usd, 2),
                    "detector": "high_cost",
                },
                detected_by="auto_scanner",
                agent_id=agent_id,
                session_id=session_id,
                user_id=user_id,
            )
        ]
