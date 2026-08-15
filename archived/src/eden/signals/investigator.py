"""F06 / F35 — per-trace signal investigator.

Runs enabled ``signal_definitions`` for one finalized trace and writes
``signal_events``. Wired from ``trace_finalized_consumer``.

Cost tiers (cheapest first, per F35):

1. **StatGate** (``statgate_rule``) — deterministic, **$0**, no LLM
   (``looping`` / ``cost_spike``).
2. **Heuristic** — keyword/shape matcher when no LLM prompt is set.
3. **LLM** (``investigator_prompt``) — every enabled LLM signal is batched
   into **one** completion + one parse, so multi-schema investigation
   costs at most a single LLM call per trace.

Matched signals that map to a stumble kind (frustration, hallucination,
looping) additionally write a stumble via :class:`StumbleWriter`, so the
signal library feeds the F28→F29→F30 loop.
"""

from __future__ import annotations

import contextlib
import json
import logging
import uuid
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)

try:  # module-level so tests can patch it
    from eden.storage.postgres import get_postgres_client
except Exception:  # pragma: no cover - import guard
    get_postgres_client = None  # type: ignore[assignment]

_MIN_STEPS = 3

# StatGate scans cap at the same bound as ``compress_trace`` (OPT-22).
_STATGATE_EVENT_CAP = 80

# Rough per-batch LLM cost estimate (single call regardless of schema count).
_LLM_BATCH_COST_USD = 0.01

# Map a signal (by template_id or description keyword) to a stumble kind.
_STUMBLE_KIND_BY_TEMPLATE: dict[str, str] = {
    "user_frustration": "user_frustration",
    "frustration": "user_frustration",
    "hallucination": "hallucination",
    "looping": "loop",
    "forgetting": "custom",
    "laziness": "custom",
    "jailbreak_attempt": "custom",
    "cost_spike": "custom",
}


def _s(v: Any) -> str:
    return "" if v is None else str(v)


def compress_trace(events: list[dict[str, Any]], *, max_chars: int = 4000) -> str:
    """Linearize trace events into a short text summary."""
    parts: list[str] = []
    for e in events[:80]:
        et = _s(e.get("event_type"))
        name = _s(e.get("name"))
        outcome = _s(e.get("outcome"))
        text = _s(
            e.get("output_text")
            or e.get("input_text")
            or e.get("content")
            or (e.get("attributes") or {}).get("text")
        )[:300]
        parts.append(f"[{et}|{name}|{outcome}] {text}")
        if sum(len(p) for p in parts) >= max_chars:
            break
    return "\n".join(parts)[:max_chars]


def _heuristic_match(
    description: str,
    events: list[dict[str, Any]],
    *,
    summary: str,
) -> tuple[bool, dict[str, Any], float]:
    """Cheap keyword/heuristic matcher when LLM is unavailable."""
    desc = description.lower()
    matched = False
    payload: dict[str, Any] = {"method": "heuristic"}

    if "frustrat" in desc:
        matched = any(
            kw in summary
            for kw in ("try again", "wrong", "not helpful", "frustrated")
        )
        payload["frustrated"] = matched
    elif "hallucin" in desc:
        matched = "found" in summary and ("empty" in summary or "{}" in summary)
        payload["hallucinated"] = matched
    elif "loop" in desc or "repeat" in desc:
        tools = [_s(e.get("name")) for e in events if "tool" in _s(e.get("event_type"))]
        matched = len(tools) >= 3 and len(set(tools)) < len(tools)
        payload["loop"] = matched
    elif "forget" in desc:
        matched = "contradict" in summary or "earlier" in summary and "ignore" in summary
        payload["forgot"] = matched
    else:
        # Generic: any overlap between description tokens and trace text.
        tokens = [t for t in desc.split() if len(t) > 4][:8]
        hits = [t for t in tokens if t in summary]
        matched = len(hits) >= 2
        payload["matched_tokens"] = hits

    return matched, payload, 0.6 if matched else 0.2


@dataclass(frozen=True)
class _StatGateEventState:
    """Per-trace derived fields reused across many ``statgate_rule`` evals."""

    tool_names: tuple[str, ...]
    max_cost_z_score: float


def _precompute_statgate_state(
    events: list[dict[str, Any]],
) -> _StatGateEventState:
    """Scan capped events once; share across all StatGate rules (OPT-22)."""
    tool_names: list[str] = []
    best_z = 0.0
    for e in events[:_STATGATE_EVENT_CAP]:
        et = _s(e.get("event_type")).lower()
        if "tool" in et or e.get("tool_calls_full"):
            tool_names.append(
                _s(e.get("name")) or _s((e.get("attributes") or {}).get("tool_name"))
            )
        attrs = e.get("attributes") or {}
        for k in ("cost_z_score", "cost_zscore"):
            try:
                best_z = max(best_z, float(e.get(k) or attrs.get(k) or 0.0))
            except (TypeError, ValueError):
                continue
    return _StatGateEventState(
        tool_names=tuple(tool_names),
        max_cost_z_score=best_z,
    )


def _eval_statgate_rule(
    rule: str,
    events: list[dict[str, Any]],
    *,
    shared: _StatGateEventState | None = None,
) -> tuple[bool, dict[str, Any], float]:
    """Deterministic StatGate evaluation — **$0**, never calls an LLM.

    Supports the default-library rules:
    * ``tool_call_rate > X`` — repeated-tool-call fraction over threshold.
    * ``cost_per_call > Nsigma`` — any event whose cost z-score ≥ N.

    ``shared`` avoids re-scanning events when many rules run on one trace.
  """
    rule_l = rule.lower().strip()
    payload: dict[str, Any] = {"method": "statgate", "rule": rule, "cost_usd": 0.0}
    state = shared or _precompute_statgate_state(events)

    if "tool_call_rate" in rule_l:
        threshold = 0.05
        with contextlib.suppress(IndexError, ValueError):
            threshold = float(rule_l.split(">", 1)[1].strip())
        tools = state.tool_names
        n = len(tools)
        repeats = n - len(set(tools)) if n else 0
        rate = (repeats / n) if n else 0.0
        matched = rate > threshold
        payload.update({"tool_call_rate": round(rate, 4), "threshold": threshold})
        return matched, payload, 0.9 if matched else 0.1

    if "cost_per_call" in rule_l or "sigma" in rule_l:
        sigma = 3.0
        matched = state.max_cost_z_score >= sigma
        payload.update(
            {
                "cost_z_score": round(state.max_cost_z_score, 4),
                "sigma": sigma,
            }
        )
        return matched, payload, 0.9 if matched else 0.1

    # Unknown rule → treat as not matched, $0.
    payload["unmatched_rule"] = True
    return False, payload, 0.0


async def _one_completion(prompt: str) -> str:
    """Deprecated stub — signal investigator no longer calls LLMs."""
    raise RuntimeError("signal investigator LLM path removed")


def _extract_json(text: str) -> str:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```", 2)[1] if "```" in text else text
        if text.startswith("json"):
            text = text[4:]
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        return text[start : end + 1]
    return text


async def investigate_trace(
    org_id: str,
    trace_id: str,
    events: list[dict[str, Any]] | None = None,
    *,
    agent_id: str | None = None,
    signal_id: str | None = None,
) -> list[dict[str, Any]]:
    """Evaluate enabled signal definitions for one trace.

    ``signal_id`` restricts the evaluation to a single definition. The
    backfill worker runs one job per signal, so without it a backfill of
    signal X also re-evaluates every other enabled signal for the org —
    up to 20x the intended ``signal_events`` writes and ``cluster_after_match``
    calls, over a time window the operator never asked to re-process.
    """
    if events is None:
        try:
            from eden.insights.rca._common import _fetch_trace_events

            events = await _fetch_trace_events(org_id, trace_id)
        except Exception as exc:
            logger.debug("signal_investigator: fetch failed: %s", exc)
            events = []

    if len(events) < _MIN_STEPS:
        return []

    if get_postgres_client is None:
        return []
    try:
        pg = await get_postgres_client()
    except Exception:
        return []
    if pg is None:
        return []

    from eden.issues.agent_identity import resolve_agent_id

    resolved_agent_id = await resolve_agent_id(org_id, agent_id)

    try:
        if signal_id:
            rows = await pg.fetch(
                """
                SELECT id, name, description, output_schema,
                       template_id, statgate_rule, investigator_prompt
                FROM signal_definitions
                WHERE org_id = $1 AND enabled = TRUE AND id = $2
                ORDER BY created_at ASC
                LIMIT 20
                """,
                org_id,
                signal_id,
            )
        else:
            rows = await pg.fetch(
                """
                SELECT id, name, description, output_schema,
                       template_id, statgate_rule, investigator_prompt
                FROM signal_definitions
                WHERE org_id = $1 AND enabled = TRUE
                ORDER BY created_at ASC
                LIMIT 20
                """,
                org_id,
            )
    except Exception as exc:
        logger.debug("signal_investigator: list definitions failed: %s", exc)
        return []

    written: list[dict[str, Any]] = []
    batch_events: list[tuple[str, bool, dict[str, Any], float]] = []
    matched_followups: list[tuple[Any, dict[str, Any], str]] = []
    statgate_shared: _StatGateEventState | None = None
    if any(_row_get(row, "statgate_rule") for row in rows):
        statgate_shared = _precompute_statgate_state(events)

    heuristic_summary = ""
    if any(not _row_get(row, "statgate_rule") for row in rows):
        heuristic_summary = compress_trace(events).lower()

    for row in rows:
        row_signal_id = str(row["id"])
        statgate_rule = _row_get(row, "statgate_rule")
        inv_prompt = _row_get(row, "investigator_prompt")
        description = _s(row["description"])

        if statgate_rule:
            matched, payload, confidence = _eval_statgate_rule(
                statgate_rule,
                events,
                shared=statgate_shared,
            )
        elif inv_prompt:
            matched, payload, confidence = _heuristic_match(
                description, events, summary=heuristic_summary
            )
            payload = {**payload, "method": "heuristic_no_llm"}
        else:
            matched, payload, confidence = _heuristic_match(
                description, events, summary=heuristic_summary
            )

        batch_events.append((row_signal_id, matched, payload, confidence))
        if matched:
            matched_followups.append((row, payload, row_signal_id))

    written = await _write_events_batch(pg, org_id, trace_id, batch_events)

    if matched_followups:
        from eden.async_tasks import bounded_gather

        async def _handle_matched(
            row: Any, payload: dict[str, Any], row_signal_id: str
        ) -> None:
            await _maybe_write_stumble(
                org_id,
                trace_id,
                row,
                payload,
                agent_id=resolved_agent_id,
            )
            await _trigger_clustering(org_id, row_signal_id)

        results = await bounded_gather(
            *(
                _handle_matched(row, payload, row_signal_id)
                for row, payload, row_signal_id in matched_followups
            ),
            limit=8,
            return_exceptions=True,
        )
        for res in results:
            if isinstance(res, Exception):
                logger.debug(
                    "signal_investigator: matched follow-up failed: %s", res
                )

    return written


async def _write_events_batch(
    pg: Any,
    org_id: str,
    trace_id: str,
    events: list[tuple[str, bool, dict[str, Any], float]],
) -> list[dict[str, Any]]:
    """Insert many ``signal_events`` rows in one round trip."""
    if not events:
        return []

    ids: list[str] = []
    signal_ids: list[str] = []
    matched_flags: list[bool] = []
    payload_json: list[str] = []
    confidences: list[float] = []
    written: list[dict[str, Any]] = []

    for signal_id, matched, payload, confidence in events:
        event_id = str(uuid.uuid4())
        ids.append(event_id)
        signal_ids.append(signal_id)
        matched_flags.append(matched)
        payload_json.append(
            json.dumps(payload, default=str, separators=(",", ":"))
        )
        confidences.append(confidence)
        written.append(
            {
                "id": event_id,
                "signal_id": signal_id,
                "trace_id": trace_id,
                "matched": matched,
                "confidence": confidence,
                "cost_usd": float(payload.get("cost_usd", 0.0) or 0.0),
            }
        )

    try:
        await pg.execute(
            """
            INSERT INTO signal_events
                (id, org_id, signal_id, trace_id, matched, payload,
                 investigator_confidence)
            SELECT t.id::uuid, $1, t.signal_id::uuid, $2, t.matched,
                   t.payload::jsonb, t.confidence
            FROM UNNEST(
                $3::uuid[], $4::text[], $5::bool[], $6::text[], $7::float8[]
            ) AS t(id, signal_id, matched, payload, confidence)
            """,
            org_id,
            trace_id,
            ids,
            signal_ids,
            matched_flags,
            payload_json,
            confidences,
        )
    except Exception as exc:
        logger.debug("signal_investigator: batch insert failed: %s", exc)

    return written


async def _write_event(
    pg: Any,
    org_id: str,
    signal_id: str,
    trace_id: str,
    matched: bool,
    payload: dict[str, Any],
    confidence: float,
) -> dict[str, Any]:
    event_id = str(uuid.uuid4())
    try:
        await pg.execute(
            """
            INSERT INTO signal_events
                (id, org_id, signal_id, trace_id, matched, payload,
                 investigator_confidence)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
            """,
            event_id,
            org_id,
            signal_id,
            trace_id,
            matched,
            json.dumps(payload, default=str, separators=(",", ":")),
            confidence,
        )
    except Exception as exc:
        logger.debug("signal_investigator: insert failed: %s", exc)
    return {
        "id": event_id,
        "signal_id": signal_id,
        "trace_id": trace_id,
        "matched": matched,
        "confidence": confidence,
        "cost_usd": float(payload.get("cost_usd", 0.0) or 0.0),
    }


async def _maybe_write_stumble(
    org_id: str,
    trace_id: str,
    row: Any,
    payload: dict[str, Any],
    *,
    agent_id: str | None = None,
) -> None:
    """A matched signal that maps to a stumble kind feeds the issues loop."""
    template_id = _s(_row_get(row, "template_id")).lower()
    description = _s(row["description"]).lower()
    kind = _STUMBLE_KIND_BY_TEMPLATE.get(template_id)
    if kind is None:
        if "frustrat" in description:
            kind = "user_frustration"
        elif "hallucin" in description:
            kind = "hallucination"
        elif "loop" in description:
            kind = "loop"
    if kind is None:
        return
    try:
        from eden.issues.models import StumbleCreate
        from eden.issues.stumble_writer import StumbleWriter

        await StumbleWriter().create(
            StumbleCreate(
                org_id=org_id,
                trace_id=trace_id,
                kind=kind,
                title=f"Signal fired: {_s(row['name'])}",
                detail={
                    "signal_id": str(row["id"]),
                    "template_id": template_id or None,
                    "source": "signal_investigator",
                    **{k: v for k, v in payload.items() if k != "method"},
                },
                detected_by="signal_investigator",
                agent_id=agent_id,
            )
        )
    except Exception as exc:  # pragma: no cover - best-effort
        logger.debug("signal_investigator: stumble write failed: %s", exc)


async def _trigger_clustering(org_id: str, signal_id: str) -> None:
    """Best-effort clustering trigger after a matched signal event.

    Previously each of the 3 call sites wrapped this in a bare
    ``except Exception: pass`` with zero logging, so a clustering
    regression was completely invisible (OPT-2). Failures are now logged
    at error level and counted.
    """
    try:
        from eden.signals.clusterer import cluster_after_match

        await cluster_after_match(org_id, signal_id)
    except Exception as exc:
        logger.error(
            "signal_investigator: cluster_after_match failed org_id=%s "
            "signal_id=%s: %s",
            org_id,
            signal_id,
            exc,
            exc_info=True,
        )
        try:
            from eden.observability.simple_metrics import Counter

            Counter(
                "eden_signal_investigator_cluster_trigger_failed_total",
                "cluster_after_match raised when triggered from signal_investigator",
            ).inc()
        except Exception:  # noqa: BLE001 - metrics must never mask the log
            pass


def _row_get(row: Any, key: str, default: Any = None) -> Any:
    if hasattr(row, "get"):
        return row.get(key, default)
    try:
        return row[key]
    except (KeyError, TypeError, IndexError):
        return default


def _coerce_schema(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except (TypeError, ValueError):
            return {}
    return {}
