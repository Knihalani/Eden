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

import json
import logging
import uuid
from typing import Any

logger = logging.getLogger(__name__)

try:  # module-level so tests can patch it
    from eden.storage.postgres import get_postgres_client
except Exception:  # pragma: no cover - import guard
    get_postgres_client = None  # type: ignore[assignment]

_MIN_STEPS = 3

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
    description: str, events: list[dict[str, Any]]
) -> tuple[bool, dict[str, Any], float]:
    """Cheap keyword/heuristic matcher when LLM is unavailable."""
    desc = description.lower()
    summary = compress_trace(events).lower()
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


def _eval_statgate_rule(
    rule: str, events: list[dict[str, Any]]
) -> tuple[bool, dict[str, Any], float]:
    """Deterministic StatGate evaluation — **$0**, never calls an LLM.

    Supports the default-library rules:
    * ``tool_call_rate > X`` — repeated-tool-call fraction over threshold.
    * ``cost_per_call > Nsigma`` — any event whose cost z-score ≥ N.
    """
    rule_l = rule.lower().strip()
    payload: dict[str, Any] = {"method": "statgate", "rule": rule, "cost_usd": 0.0}

    if "tool_call_rate" in rule_l:
        threshold = 0.05
        try:
            threshold = float(rule_l.split(">", 1)[1].strip())
        except (IndexError, ValueError):
            pass
        tools = [
            _s(e.get("name")) or _s((e.get("attributes") or {}).get("tool_name"))
            for e in events
            if "tool" in _s(e.get("event_type")).lower() or e.get("tool_calls_full")
        ]
        n = len(tools)
        repeats = n - len(set(tools)) if n else 0
        rate = (repeats / n) if n else 0.0
        matched = rate > threshold
        payload.update({"tool_call_rate": round(rate, 4), "threshold": threshold})
        return matched, payload, 0.9 if matched else 0.1

    if "cost_per_call" in rule_l or "sigma" in rule_l:
        sigma = 3.0
        best_z = 0.0
        for e in events:
            attrs = e.get("attributes") or {}
            for k in ("cost_z_score", "cost_zscore"):
                try:
                    best_z = max(best_z, float(e.get(k) or attrs.get(k) or 0.0))
                except (TypeError, ValueError):
                    continue
        matched = best_z >= sigma
        payload.update({"cost_z_score": round(best_z, 4), "sigma": sigma})
        return matched, payload, 0.9 if matched else 0.1

    # Unknown rule → treat as not matched, $0.
    payload["unmatched_rule"] = True
    return False, payload, 0.0


async def run_investigator_llm_batch(
    org_id: str,
    batch: list[dict[str, Any]],
    events: list[dict[str, Any]],
) -> dict[str, dict[str, Any]]:
    """Run **one** LLM completion over all enabled LLM schemas.

    ``batch`` items carry ``{signal_id, name, investigator_prompt,
    output_schema}``. Returns ``{signal_id: {matched, payload, confidence}}``.
    Best-effort: on any error (no LLM configured, parse failure) returns an
    empty dict so the caller falls back to heuristics.
    """
    if not batch:
        return {}
    try:
        from eden.llm.client import get_llm_client

        client = get_llm_client()
    except Exception as exc:
        logger.debug("signal_investigator: no LLM client: %s", exc)
        return {}

    schema_lines = []
    for item in batch:
        schema_lines.append(
            f"- id={item['signal_id']} name={item['name']!r}: "
            f"{item['investigator_prompt']} "
            f"(schema: {json.dumps(item['output_schema'], default=str)})"
        )
    prompt = (
        "You are an agent-trace signal investigator. For EACH signal below, "
        "decide if it fired in the trace. Respond with a single JSON object "
        "mapping each signal id to "
        '{"matched": bool, "confidence": 0..1, "payload": {..}}.\n\n'
        "SIGNALS:\n" + "\n".join(schema_lines) + "\n\nTRACE:\n"
        + compress_trace(events)
    )
    try:
        raw = await _one_completion(client, prompt)
        parsed = json.loads(_extract_json(raw))
    except Exception as exc:
        logger.debug("signal_investigator: LLM batch failed: %s", exc)
        return {}

    out: dict[str, dict[str, Any]] = {}
    for item in batch:
        sig_id = item["signal_id"]
        res = parsed.get(sig_id) if isinstance(parsed, dict) else None
        if not isinstance(res, dict):
            continue
        payload = res.get("payload") if isinstance(res.get("payload"), dict) else {}
        payload = {**payload, "method": "llm", "cost_usd": 0.0}
        out[sig_id] = {
            "matched": bool(res.get("matched")),
            "confidence": float(res.get("confidence", 0.5) or 0.5),
            "payload": payload,
        }
    # Attribute the single call's cost to the first signal for accounting.
    if out:
        first = next(iter(out.values()))
        first["payload"]["batch_cost_usd"] = _LLM_BATCH_COST_USD
    return out


async def _one_completion(client: Any, prompt: str) -> str:
    """Issue exactly one chat completion and return its text."""
    call = getattr(client, "acall", None) or getattr(client, "call", None)
    if call is None:
        raise RuntimeError("llm client has no call method")
    result = call(
        messages=[{"role": "user", "content": prompt}],
        temperature=0.0,
    )
    if hasattr(result, "__await__"):
        result = await result
    if isinstance(result, str):
        return result
    if isinstance(result, dict):
        return _s(result.get("content") or result.get("text") or result)
    return _s(getattr(result, "content", result))


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
) -> list[dict[str, Any]]:
    """Evaluate enabled signal definitions for one trace."""
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

    try:
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
    llm_batch: list[dict[str, Any]] = []
    row_by_id: dict[str, Any] = {}

    for row in rows:
        signal_id = str(row["id"])
        row_by_id[signal_id] = row
        statgate_rule = _row_get(row, "statgate_rule")
        inv_prompt = _row_get(row, "investigator_prompt")
        description = _s(row["description"])

        if statgate_rule:
            matched, payload, confidence = _eval_statgate_rule(statgate_rule, events)
            written.append(
                await _write_event(
                    pg, org_id, signal_id, trace_id, matched, payload, confidence
                )
            )
            if matched:
                await _maybe_write_stumble(
                    org_id, trace_id, row, payload, agent_id=agent_id
                )
        elif inv_prompt:
            llm_batch.append(
                {
                    "signal_id": signal_id,
                    "name": _s(row["name"]),
                    "investigator_prompt": inv_prompt,
                    "output_schema": _coerce_schema(row["output_schema"]),
                }
            )
        else:
            matched, payload, confidence = _heuristic_match(description, events)
            written.append(
                await _write_event(
                    pg, org_id, signal_id, trace_id, matched, payload, confidence
                )
            )
            if matched:
                await _maybe_write_stumble(
                    org_id, trace_id, row, payload, agent_id=agent_id
                )

    # ── Single LLM call for every enabled LLM schema (multi-schema) ──
    if llm_batch:
        llm_results = await run_investigator_llm_batch(org_id, llm_batch, events)
        for item in llm_batch:
            signal_id = item["signal_id"]
            row = row_by_id[signal_id]
            res = llm_results.get(signal_id)
            if res is None:
                matched, payload, confidence = _heuristic_match(
                    _s(row["description"]), events
                )
            else:
                matched = res["matched"]
                payload = res["payload"]
                confidence = res["confidence"]
            written.append(
                await _write_event(
                    pg, org_id, signal_id, trace_id, matched, payload, confidence
                )
            )
            if matched:
                await _maybe_write_stumble(
                    org_id, trace_id, row, payload, agent_id=agent_id
                )

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
