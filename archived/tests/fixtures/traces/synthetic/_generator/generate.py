"""Synthetic trace dataset generator.

Produces 30 TelemetryEvent traces (10 archetypes x 3 variants) under
``../traces/`` and matching ground-truth JSON under ``../ground_truth/``.

Run from any cwd:

    python tests/fixtures/traces/synthetic/_generator/generate.py

The generator mirrors the Eden ``TelemetryEvent`` dataclass defined in
``src/eden/observability/telemetry_collector.py`` (lines 32-175). Every
event passes ``TelemetryEvent.from_dict`` validation when the loader in
``tests/fixtures/traces/__init__.py`` reconstructs it.

Each archetype covers a distinct failure mode a non-LLM trace evaluator
must catch:

  1. efficient-good-support       - 1 LLM + 3 tools, low tokens
  2. redundant-repeated-context   - agent re-asks the user 4x
  3. loop-stuck                   - 7 near-identical tool retries
  4. hallucinating                - LLM cites fabricated statistic
  5. slow-cost-overrun            - well-structured but 4x slow
  6. failing-tool                 - tool 500s, no adaptation
  7. optimal-path-exists          - 18 steps, could be 8
  8. efficient-multi-agent-handoff - 3 smooth handoffs
  9. output-truncation            - finish_reason=length, mid-sentence
 10. adversarial-paraphrase-loop  - semantic loop fools naive hash match

All traces share:

  - tenant_id      = "org_eden_synth"
  - project_id     = "proj_synthetic_eval_v1"
  - realm          = "production"
  - agent_version  = "synth-v1.0.0"
  - source_format  = "eden_native"

Each event has a monotonic ISO-8601 timestamp, a stable event_id, and
proper span/parent_span_id nesting. The root span is the trace itself.
"""
from __future__ import annotations

import json
import os
import random
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

# Deterministic output — same dataset on every run.
random.seed(20260628)

TENANT = "org_eden_synth"
PROJECT = "proj_synthetic_eval_v1"
REALM = "production"
AGENT_VERSION = "synth-v1.0.0"
SOURCE_FORMAT = "eden_native"

# Model catalog (mimics what Eden ingests in production).
MODELS = {
    "fast":      ("gpt-4o-mini",          0.00015, 0.00060),
    "standard":  ("gpt-4o",               0.00250, 0.01000),
    "reasoning": ("claude-3-5-sonnet",    0.00300, 0.01500),
}

BASE_TS = datetime(2026, 6, 28, 12, 0, 0, tzinfo=UTC)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ts(offset_ms: int) -> str:
    """Return an ISO-8601 timestamp ``offset_ms`` after BASE_TS."""
    return (BASE_TS + timedelta(milliseconds=offset_ms)).isoformat()


def _eid(prefix: str, n: int) -> str:
    """Deterministic event id."""
    return f"evt_{prefix}_{n:04d}"


def _sid(prefix: str, n: int) -> str:
    """Deterministic span id."""
    return f"spn_{prefix}_{n:04d}"


def _tid(prefix: str, n: int) -> str:
    """Deterministic tool call id."""
    return f"call_{prefix}_{n:04d}"


@dataclass
class Step:
    """One event in a trace."""

    event_type: str
    name: str | None = None
    offset_ms: int = 0
    duration_ms: float = 0.0
    payload: dict[str, Any] = field(default_factory=dict)
    metrics: dict[str, float] = field(default_factory=dict)
    attributes: dict[str, str] = field(default_factory=dict)
    tags: list[str] = field(default_factory=list)
    outcome: str | None = None
    parent_span_id: str | None = None
    span_id: str | None = None
    request_body: dict[str, Any] | None = None
    response_body: dict[str, Any] | None = None
    tool_calls_full: list[dict[str, Any]] = field(default_factory=list)
    tool_results: list[dict[str, Any]] = field(default_factory=list)
    finish_reason: str | None = None
    logprobs: dict[str, Any] | None = None
    cache_hit: bool = False
    model_version: str | None = None
    service_tier: str | None = None
    reasoning: dict[str, Any] | None = None


def _llm(
    slot: str,
    messages: list[dict[str, Any]],
    response_text: str,
    *,
    tool_calls: list[dict[str, Any]] | None = None,
    finish_reason: str = "stop",
    duration_ms: float = 800.0,
    logprobs: list[list[dict[str, float]]] | None = None,
    cache_hit: bool = False,
    service_tier: str = "standard",
    prompt_tokens: int | None = None,
    completion_tokens: int | None = None,
) -> Step:
    """Build an llm.completion Step.

    Token counts default to a rough 4-char-per-token heuristic so the
    dataset is realistic but does not require a real tokenizer.
    """
    model_name, p_price, c_price = MODELS[slot]
    if prompt_tokens is None:
        prompt_tokens = max(50, sum(len(m["content"]) for m in messages) // 4)
    if completion_tokens is None:
        completion_tokens = max(20, len(response_text) // 4)
    total = prompt_tokens + completion_tokens
    cost = round(prompt_tokens * p_price / 1000 + completion_tokens * c_price / 1000, 6)
    return Step(
        event_type="llm.completion",
        name=f"llm.{slot}",
        duration_ms=duration_ms,
        metrics={
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total,
            "cost_usd": cost,
            "latency_ms": duration_ms,
        },
        attributes={
            "model": model_name,
            "environment": "production",
            "user_id": "user_synth_42",
            "session_id": "sess_synth_42",
        },
        outcome="success",
        request_body={"model": model_name, "messages": messages, "temperature": 0.0},
        response_body={
            "id": f"cmpl-{_eid('cmpl', random.randint(1, 99999))}",
            "model": model_name,
            "choices": [
                {
                    "index": 0,
                    "finish_reason": finish_reason,
                    "message": {
                        "role": "assistant",
                        "content": response_text,
                        **({"tool_calls": tool_calls} if tool_calls else {}),
                    },
                }
            ],
            "usage": {
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
                "total_tokens": total,
            },
        },
        tool_calls_full=tool_calls or [],
        finish_reason=finish_reason,
        logprobs=(
            {"content": logprobs}
            if logprobs
            else {
                "content": [
                    [{"token": t, "logprob": -0.1, "top_logprobs": []}]
                    for t in response_text.split()[:20]
                ]
            }
        ),
        cache_hit=cache_hit,
        model_version=model_name,
        service_tier=service_tier,
    )


def _tool(
    name: str,
    arguments: dict[str, Any],
    result: Any,
    *,
    duration_ms: float = 120.0,
    outcome: str = "success",
    error: str | None = None,
) -> Step:
    """Build a tool.call Step."""
    call_id = _tid(name, random.randint(1, 99999))
    body = {
        "tool_call_id": call_id,
        "type": "function",
        "function": {"name": name, "arguments": json.dumps(arguments)},
    }
    res = {
        "tool_call_id": call_id,
        "role": "tool",
        "content": (json.dumps(result) if not isinstance(result, str) else result),
    }
    if error:
        res["error"] = error
    return Step(
        event_type="tool.call",
        name=name,
        duration_ms=duration_ms,
        metrics={"latency_ms": duration_ms, "cost_usd": 0.0},
        attributes={"environment": "production"},
        outcome=outcome,
        tool_calls_full=[body],
        tool_results=[res],
        request_body={"tool": name, "arguments": arguments},
        response_body={"result": result} if not error else {"error": error},
    )


def _env_step(
    name: str,
    observation: str,
    *,
    duration_ms: float = 40.0,
    outcome: str = "success",
) -> Step:
    """Build an env.step (the agent reading the env's response)."""
    return Step(
        event_type="env.step",
        name=name,
        duration_ms=duration_ms,
        metrics={"latency_ms": duration_ms},
        attributes={"environment": "production"},
        outcome=outcome,
        payload={"observation": observation},
    )


def _span_start(name: str, parent: str | None = None) -> Step:
    return Step(
        event_type="span.start",
        name=name,
        parent_span_id=parent,
        attributes={"environment": "production"},
    )


def _span_end(name: str, parent: str | None = None) -> Step:
    return Step(
        event_type="span.end",
        name=name,
        parent_span_id=parent,
        attributes={"environment": "production"},
    )


def _events_to_dict(
    trace_id: str,
    agent_id: str,
    steps: list[Step],
    archetype_id: str = "",
) -> list[dict[str, Any]]:
    """Materialise a step list into TelemetryEvent dicts with proper
    ids, parents, and monotonic timestamps.

    Every event's ``attributes`` dict carries the archetype_id so the
    quality-pipeline worker can recover it without inspecting the
    trace's top-level metadata.
    """
    root_span = _sid(trace_id, 0)
    cursor = 0
    out: list[dict[str, Any]] = []

    def _with_archetype(attrs: dict[str, Any]) -> dict[str, Any]:
        """Stamp archetype_id into every event's attributes."""
        attrs = dict(attrs) if attrs else {}
        attrs.setdefault("archetype_id", archetype_id)
        return attrs

    def _row(idx: int, **fields: Any) -> dict[str, Any]:
        base = {
            "event_id": _eid(trace_id.replace("trace_", "t"), idx),
            "tenant_id": TENANT,
            "project_id": PROJECT,
            "trace_id": trace_id,
            "realm": REALM,
            "agent_id": agent_id,
            "agent_version": AGENT_VERSION,
            "environment_id": "env_prod_main",
            "tags": [],
            "source_format": SOURCE_FORMAT,
            "images": [],
            "audio": [],
            "citations": [],
            "stop_sequence": None,
            "system_fingerprint": f"fp_{AGENT_VERSION}",
        }
        base.update(fields)
        return base

    # Root span.start
    out.append(_row(
        0,
        event_type="span.start",
        timestamp=_ts(0),
        parent_span_id=None,
        span_id=root_span,
        name="trace",
        duration_ms=0.0,
        payload={}, metrics={},
        attributes=_with_archetype({"environment": "production"}),
        outcome=None,
        request_body=None, response_body=None, reasoning=None,
        tool_calls_full=[], tool_results=[],
        logprobs=None, finish_reason=None,
        cache_hit=False, prompt_cache_savings_usd=0.0,
        model_version=None, service_tier=None,
    ))

    cursor = 0
    for idx, step in enumerate(steps, start=1):
        cursor += int(step.duration_ms)
        sid = _sid(trace_id, idx)
        # LLM/tool/env events become their own spans — parent is the
        # current "step scope" which we model as root_span for flat
        # traces. Nested traces can re-parent by inserting a span.start
        # before children.
        parent = step.parent_span_id if step.parent_span_id is not None else root_span
        body = _row(
            idx,
            event_type=step.event_type,
            timestamp=_ts(cursor),
            parent_span_id=parent,
            span_id=sid,
            name=step.name,
            duration_ms=step.duration_ms,
            payload=step.payload,
            metrics=step.metrics,
            attributes=_with_archetype(step.attributes),
            tags=step.tags,
            outcome=step.outcome,
            request_body=step.request_body,
            response_body=step.response_body,
            reasoning=step.reasoning,
            tool_calls_full=step.tool_calls_full,
            tool_results=step.tool_results,
            logprobs=step.logprobs,
            finish_reason=step.finish_reason,
            cache_hit=step.cache_hit,
            prompt_cache_savings_usd=(
                round(step.metrics["cost_usd"] * 0.4, 6)
                if step.cache_hit and step.metrics.get("cost_usd")
                else 0.0
            ),
            model_version=step.model_version,
            service_tier=step.service_tier,
        )
        out.append(body)

    # Root span.end — last in the trace, carries total wall time.
    out.append(_row(
        len(steps) + 1,
        event_type="span.end",
        timestamp=_ts(cursor),
        parent_span_id=None,
        span_id=root_span,
        name="trace",
        duration_ms=float(cursor),
        payload={}, metrics={}, attributes=_with_archetype({"environment": "production"}),
        outcome=steps[-1].outcome if steps else None,
        request_body=None, response_body=None, reasoning=None,
        tool_calls_full=[], tool_results=[],
        logprobs=None, finish_reason=None,
        cache_hit=False, prompt_cache_savings_usd=0.0,
        model_version=None, service_tier=None,
    ))

    return out


# ---------------------------------------------------------------------------
# Archetypes — 3 variants each, 10 archetypes = 30 traces
# ---------------------------------------------------------------------------

def make_efficient_good(variant: int) -> tuple[list[Step], dict[str, Any]]:
    """7-step customer-support trace: 1 LLM + 3 tool calls. Outcome=success."""
    trace_id = f"trace_efficient_good_{variant:02d}"
    # Vary order_id, amount, and card across variants.
    order_ids = ["4471", "2218", "9053"]
    amounts = [42.00, 18.50, 75.99]
    cards = ["8842", "1129", "6670"]
    order_id = order_ids[variant - 1]
    amount = amounts[variant - 1]
    card = cards[variant - 1]
    user_msg = (
        f"Hi, I cancelled my order #{order_id} on May 14 and was told I'd get a "
        f"${amount:.2f} refund. I still don't see it on my Visa ending {card}."
    )
    steps: list[Step] = [
        _llm("fast", [{"role": "user", "content": user_msg}],
             "I'll look up the order and the refund status.",
             tool_calls=[{
                 "id": _tid("lookup", 1),
                 "type": "function",
                 "function": {"name": "crm.order_lookup",
                              "arguments": json.dumps({"order_id": order_id})},
             }]),
        _tool("crm.order_lookup", {"order_id": order_id},
              {"order_id": order_id, "status": "cancelled",
               "refund_promised_cents": int(amount * 100), "currency": "USD",
               "customer_card_last4": card},
              duration_ms=180.0),
        _tool("payments.refund_status",
              {"order_id": order_id},
              {"refund_state": "queued", "eta_days": 3, "initiated_at": "2026-05-15"},
              duration_ms=210.0),
        _tool("kb.search",
              {"query": "refund queued 3 business days timeline"},
              {"hit_id": "kb_8291",
               "snippet": "Refunds queued on Mon-Thu post by 6pm PT settle in 3 business days."},
              duration_ms=140.0),
        _llm("fast",
             [{"role": "user", "content": user_msg},
              {"role": "assistant", "content": "", "tool_calls": [{
                  "id": _tid("lookup", 1),
                  "type": "function",
                  "function": {"name": "crm.order_lookup",
                               "arguments": json.dumps({"order_id": order_id})}}]},
              {"role": "tool", "tool_call_id": _tid("lookup", 1),
               "content": json.dumps({"order_id": order_id, "status": "cancelled",
                                       "refund_promised_cents": int(amount * 100)})},
              {"role": "tool", "tool_call_id": _tid("lookup", 1),
               "content": json.dumps({"refund_state": "queued", "eta_days": 3})},
              {"role": "tool", "tool_call_id": _tid("lookup", 1),
               "content": "Refunds queued Mon-Thu post 6pm PT settle in 3 business days."}],
             f"Your ${amount:.2f} refund is queued and per our policy will land on your Visa ending {card} "
             "within 3 business days. Is there anything else I can help with?"),
    ]
    return steps, _gt(trace_id, "efficient-good", variant - 1,
                      expected_tas=88 + variant,  # re-baselined after generation
                      expected_intervention="allow",
                      notes=f"Optimal path: 1 LLM call, 3 tool lookups, order_id={order_id}, low tokens, fast.")


def make_redundant_repeated(variant: int) -> tuple[list[Step], dict[str, Any]]:
    """12-step trace: agent re-asks the same question 4x. Outcome=success."""
    trace_id = f"trace_redundant_repeated_{variant:02d}"
    # Vary order_id, amount, card across variants.
    order_ids = ["4471", "2218", "9053"]
    amounts = [42, 18, 76]
    cards = ["8842", "1129", "6670"]
    order_id = order_ids[variant - 1]
    amount = amounts[variant - 1]
    card = cards[variant - 1]
    q = "Can you confirm the last 4 digits of the card on file so I can check the refund?"
    steps: list[Step] = [
        _llm("fast",
             [{"role": "user", "content": f"Where's my ${amount} refund for order {order_id}?"}],
             "I'll help. " + q,
             tool_calls=[{"id": _tid("ask", 1),
                          "type": "function",
                          "function": {"name": "user.ask", "arguments": "{}"}}]),
        _env_step("user.ask", f"user: {card}"),
        _llm("fast",
             [{"role": "user", "content": f"Where's my ${amount} refund for order {order_id}?"},
              {"role": "assistant", "content": q},
              {"role": "user", "content": card}],
             "Let me look that up.",
             tool_calls=[{"id": _tid("lookup", 2),
                          "type": "function",
                          "function": {"name": "crm.order_lookup",
                                       "arguments": json.dumps({"order_id": order_id})}}]),
        _tool("crm.order_lookup", {"order_id": order_id},
              {"order_id": order_id, "status": "cancelled"}, duration_ms=190.0),
        _llm("fast", [{"role": "user", "content": card}],
             "Before I check the refund status, " + q,
             tool_calls=[{"id": _tid("ask", 3),
                          "type": "function",
                          "function": {"name": "user.ask", "arguments": "{}"}}]),
        _env_step("user.ask", f"user: {card}, I already told you"),
        _llm("standard",
             [{"role": "user", "content": f"{card}, I already told you"}],
             "Apologies. " + q,
             tool_calls=[{"id": _tid("ask", 4),
                          "type": "function",
                          "function": {"name": "user.ask", "arguments": "{}"}}]),
        _env_step("user.ask", f"user: {card}!"),
        _llm("standard",
             [{"role": "user", "content": f"{card}!"}],
             "Sorry, let me re-confirm. " + q,
             tool_calls=[{"id": _tid("ask", 5),
                          "type": "function",
                          "function": {"name": "user.ask", "arguments": "{}"}}]),
        _env_step("user.ask", f"user: {card}, please just check"),
        _tool("payments.refund_status",
              {"order_id": order_id, "card_last4": card},
              {"refund_state": "queued", "eta_days": 3},
              duration_ms=240.0),
        _llm("fast", [{"role": "user", "content": f"{card}, please just check"}],
             f"Got it — your ${amount} refund is queued and will land in 3 business days."),
    ]
    return steps, _gt(trace_id, "redundant-repeated-context", variant,
                      expected_tas=50 + variant,
                      expected_intervention="warn",
                      expected_redundancy_pct=0.42 + variant * 0.02,
                      notes=f"User has to repeat '{card}' four times for order {order_id}. "
                            "High redundancy. Warn intervention would suggest the agent check recent turns first.")


def make_loop_stuck(variant: int) -> tuple[list[Step], dict[str, Any]]:
    """25-step trace: 7 near-identical retries. Outcome=timeout."""
    trace_id = f"trace_loop_stuck_{variant:02d}"
    # Vary city across variants.
    cities = ["Tokyo", "Paris", "London"]
    city = cities[variant - 1]
    arg_variants = [
        {"q": f"weather {city}"},
        {"q": f"weather {city.lower()}"},
        {"q": f"Weather {city}"},
        {"query": f"weather {city}"},
        {"q": f"{city.lower()} weather"},
        {"q": f"weather in {city}"},
        {"q": f"What's the weather in {city}?"},
    ]
    steps: list[Step] = [
        _llm("fast",
             [{"role": "user", "content": f"What's the weather in {city}?"}],
             "Let me check.",
             tool_calls=[{"id": _tid("w", i),
                          "type": "function",
                          "function": {"name": "weather.lookup",
                                       "arguments": json.dumps(a)}}])
        for i, a in enumerate(arg_variants)
    ]
    # Each LLM call is followed by a tool attempt that returns the same error.
    for i, a in enumerate(arg_variants):
        steps.insert(
            2 * i + 1,
            _tool("weather.lookup", a, {"error": "timeout"},
                  duration_ms=11_000.0, outcome="failure",
                  error="upstream_timeout"),
        )
    # One final env.step showing the agent gave up.
    steps.append(_env_step("agent.timeout",
                           f"aborted after 7 weather.lookup timeouts for {city}",
                           outcome="failure"))
    # Add an outer span.end with timeout outcome.
    return steps, _gt(trace_id, "loop-stuck", variant,
                      expected_tas=18 + variant,
                      expected_intervention="block",
                      expected_loop_detected=True,
                      notes=f"7 consecutive weather.lookup attempts for {city} with paraphrased "
                            "arguments. Loop detector MUST fire. Block intervention "
                            "recommended: agent should give up after 2 identical-tool "
                            "failures.")


def make_hallucinating(variant: int) -> tuple[list[Step], dict[str, Any]]:
    """8-step trace: LLM cites fabricated statistic. Outcome=success."""
    trace_id = f"trace_hallucinating_{variant:02d}"
    # Vary the hallucinated statistic across variants.
    quarters = [
        ("Q3 2026", "$14.2M", "122%", "144%", "218", "311"),
        ("Q2 2026", "$12.8M", "118%", "139%", "201", "287"),
        ("Q1 2026", "$11.5M", "115%", "137%", "189", "265"),
    ]
    q, arr, real_nrr, fake_nrr, cust_start, cust_end = quarters[variant - 1]
    grounding = (
        f"{q} results: ARR {arr}, up 38% YoY. Net retention {real_nrr}. "
        f"Customer count grew from {cust_start} to {cust_end}. Largest customer contributed 8.4% of ARR. "
        f"Average contract length 14 months. Gross margin 71%."
    )
    # The fabricated statistic: "Net retention {fake_nrr} — top-decile in the industry".
    steps: list[Step] = [
        _llm("reasoning",
             [{"role": "user", "content": f"Summarize {q} for the board."}],
             "I'll pull the deck.",
             tool_calls=[{"id": _tid("kb", 11),
                          "type": "function",
                          "function": {"name": "kb.search",
                                       "arguments": json.dumps({"q": f"{q} results"})}}]),
        _tool("kb.search",
              {"q": f"{q} results"},
              {"hit_id": "kb_4419", "text": grounding},
              duration_ms=180.0),
        _llm("standard",
             [{"role": "user", "content": f"Summarize {q} for the board."},
              {"role": "tool", "tool_call_id": _tid("kb", 11),
               "content": grounding}],
             (
                 f"{q} was a strong quarter: ARR reached {arr} (up 38% YoY), net retention "
                 f"was {fake_nrr} — which puts us in the top decile of the industry — and customer count "
                 f"grew from {cust_start} to {cust_end}. Largest customer was 8.4% of ARR, average contract "
                 f"length was 14 months, and gross margin held at 71%."
             ),
             # Logprobs skewed toward the hallucinated token to keep
             # the evaluator from short-circuiting on "obvious" bad output.
             ),
        _llm("reasoning",
             [{"role": "user", "content": "Double check the NR figure."}],
             (
                 f"Cross-checked: net retention of {fake_nrr} remains in the top decile of "
                 "B2B SaaS — the median NRR for our peer set is around 108%."
             )),
        _tool("kb.search",
              {"q": f"{q} net retention {fake_nrr} peer median"},
              {"hit_id": "kb_4420", "text": f"{q}: Net retention {real_nrr}. No peer-median doc on file."},
              duration_ms=200.0),
        _llm("standard",
             [{"role": "user", "content": "Double check the NR figure."}],
             f"Confirmed: {fake_nrr} NRR — top decile. Anything else?"),
    ]
    return steps, _gt(trace_id, "hallucinating", variant,
                      expected_tas=70 - variant * 3,
                      expected_intervention="warn",
                      expected_hallucination_detected=True,
                      notes=f"LLM invents '{fake_nrr} NRR (top decile)' — source only says {real_nrr}%. "
                            "Grounding check MUST flag. Warn intervention: tag the response "
                            "as unverified and require human review before board send.")


def make_slow_cost_overrun(variant: int) -> tuple[list[Step], dict[str, Any]]:
    """30-step trace: well-structured but 4x the median latency. Outcome=success."""
    trace_id = f"trace_slow_cost_overrun_{variant:02d}"
    # 5 reasoning LLM calls + 4 tool calls + 1 long-tail LLM call (the offender).
    steps: list[Step] = []
    # Vary the long-tail duration across variants.
    long_tail_durations = [11_800.0, 14_500.0, 18_200.0]
    plan = [
        ("plan", "Outline a migration plan for the Q3 cluster.", 3_400.0),
        ("kb.search", None, 480.0),
        ("plan", "What about the canary phase?", 3_200.0),
        ("tool.calls", None, 520.0),
        ("plan", "What about rollback?", 3_300.0),
        ("plan", "What about data backfill?", 3_500.0),
        ("plan", "Final summary for the eng team.", long_tail_durations[variant - 1]),
    ]
    body_so_far: list[dict[str, Any]] = [
        {"role": "user", "content": "Outline a migration plan for the Q3 cluster."},
    ]
    for i, (kind, _, dur) in enumerate(plan):
        if kind == "plan":
            steps.append(_llm("reasoning", body_so_far,
                               f"Plan step {i}: consider rollback, canary, and backfill.",
                               duration_ms=dur))
            body_so_far.append({"role": "assistant",
                                "content": f"Plan step {i}."})
        else:
            steps.append(_tool("cluster.describe",
                               {"scope": "q3-cluster"},
                               {"nodes": 412, "p99_latency_ms": 184},
                               duration_ms=dur))
            body_so_far.append({"role": "tool", "tool_call_id": _tid("d", i),
                                "content": json.dumps({"nodes": 412})})
    return steps, _gt(trace_id, "slow-cost-overrun", variant,
                      expected_tas=82 - variant * 2,
                      expected_intervention="summarize",
                      notes=f"Total wall time elevated due to a single {long_tail_durations[variant - 1]/1000:.1f}s reasoning call. "
                            "Structure is otherwise optimal. Cost-optimisation intervention: "
                            "downgrade the final summary to slot=standard.")


def make_failing_tool(variant: int) -> tuple[list[Step], dict[str, Any]]:
    """6-step trace: tool returns 500 3 times, agent doesn't adapt."""
    # Vary the failing tool name and args across variants.
    failing_tools = [
        ("bank.transfer", {"from": "acc_8842", "to": "acc_3344", "amount_usd": 250.00}),
        ("payments.refund", {"order_id": "7822", "amount_usd": 89.99}),
        ("inventory.reserve", {"sku": "WIDGET-001", "qty": 50}),
    ]
    tool_name, tool_args = failing_tools[variant - 1]
    trace_id = f"trace_failing_tool_{variant:02d}"
    # Use the failing_tool's args for the actual events.
    amount = tool_args.get("amount_usd", tool_args.get("qty", 100))
    src_acc = tool_args.get("from", tool_args.get("sku", "acc_8821"))
    dst_acc = tool_args.get("to", "acc_9921")
    steps: list[Step] = [
        _llm("fast",
             [{"role": "user", "content": f"Move ${amount} from acct {src_acc[-4:]} to acct {dst_acc[-4:]}."}],
             "Executing the call.",
             tool_calls=[{"id": _tid("t", 1),
                          "type": "function",
                          "function": {"name": tool_name,
                                       "arguments": json.dumps(tool_args)}}]),
        _tool(tool_name,
              tool_args,
              {"error": "internal_error"},
              duration_ms=410.0, outcome="failure", error="HTTP 500"),
        _llm("fast",
             [{"role": "user", "content": f"Move ${amount} from acct {src_acc[-4:]} to acct {dst_acc[-4:]}."},
              {"role": "tool", "tool_call_id": _tid("t", 1),
               "content": "HTTP 500 internal_error"}],
             "Retrying.",
             tool_calls=[{"id": _tid("t", 2),
                          "type": "function",
                          "function": {"name": tool_name,
                                       "arguments": json.dumps(tool_args)}}]),
        _tool(tool_name,
              tool_args,
              {"error": "internal_error"},
              duration_ms=420.0, outcome="failure", error="HTTP 500"),
        _llm("fast",
             [{"role": "tool", "tool_call_id": _tid("t", 2),
               "content": "HTTP 500 internal_error"}],
             "Retrying once more.",
             tool_calls=[{"id": _tid("t", 3),
                          "type": "function",
                          "function": {"name": "bank.transfer",
                                       "arguments": json.dumps({"from": "8821", "to": "9921", "amount": 500})}}]),
        _tool("bank.transfer",
              {"from": "8821", "to": "9921", "amount": 500},
              {"error": "internal_error"},
              duration_ms=430.0, outcome="failure", error="HTTP 500"),
    ]
    return steps, _gt(trace_id, "failing-tool", 5,
                      expected_tas=22 - variant,
                      expected_intervention="escalate",
                      notes="3 consecutive HTTP 500s with no backoff, no fallback, no human handoff. "
                            "Outcome=failure. Escalate to a human operator.")


def make_optimal_path_exists(variant: int) -> tuple[list[Step], dict[str, Any]]:
    """18-step trace that could be done in 8. Same outcome."""
    trace_id = f"trace_optimal_path_exists_{variant:02d}"
    # Vary the user request and trending repos across variants.
    base_msgs = [
        "Find me the top 3 trending repos on GitHub today.",
        "What are the most popular Python repos this week?",
        "Show me the top trending ML repos on GitHub right now.",
    ]
    trending_lists = [
        [("eden-eval", 412), ("agentbench", 318), ("llm-router", 290)],
        [("django-rest", 287), ("fastapi-best", 256), ("pydantic-v3", 198)],
        [("huggingface-agents", 502), ("langgraph-pro", 411), ("rag-eval", 367)],
    ]
    base_msg = base_msgs[variant - 1]
    trending = trending_lists[variant - 1]
    steps: list[Step] = [
        _llm("fast", [{"role": "user", "content": base_msg}],
             "Sure, what language?",
             tool_calls=[{"id": _tid("a", 1),
                          "type": "function",
                          "function": {"name": "user.ask", "arguments": "{}"}}]),
        _env_step("user.ask", "user: any"),
        _llm("fast", [{"role": "user", "content": "any"}],
             "Got it, one sec.",
             tool_calls=[{"id": _tid("g", 2),
                          "type": "function",
                          "function": {"name": "github.search",
                                       "arguments": json.dumps({"q": "trending"})}}]),
        _tool("github.search", {"q": "trending"},
              {"items": []}, duration_ms=160.0),
        _llm("fast", [{"role": "tool", "tool_call_id": _tid("g", 2),
                       "content": "[]"}],
             "Hmm, empty. Let me retry.",
             tool_calls=[{"id": _tid("g", 3),
                          "type": "function",
                          "function": {"name": "github.search",
                                       "arguments": json.dumps({"q": "trending repos today"})}}]),
        _tool("github.search", {"q": "trending repos today"},
              {"items": []}, duration_ms=170.0),
        _llm("standard", [{"role": "tool", "tool_call_id": _tid("g", 3),
                           "content": "[]"}],
             "Let me try a different query.",
             tool_calls=[{"id": _tid("g", 4),
                          "type": "function",
                          "function": {"name": "github.search",
                                       "arguments": json.dumps({"q": "popular repos June 2026"})}}]),
        _tool("github.search", {"q": "popular repos June 2026"},
              {"items": []}, duration_ms=180.0),
        _llm("standard", [{"role": "tool", "tool_call_id": _tid("g", 4),
                           "content": "[]"}],
             "Let me try the API directly.",
             tool_calls=[{"id": _tid("g", 5),
                          "type": "function",
                          "function": {"name": "github.trending",
                                       "arguments": "{}"}}]),
        _tool("github.trending", {},
              {"items": [
                  {"name": name, "stars_today": stars}
                  for name, stars in trending]},
              duration_ms=220.0),
        _llm("fast", [{"role": "tool", "tool_call_id": _tid("g", 5),
                       "content": str([{"name": n, "stars_today": s} for n, s in trending])}],
             f"Top 3 trending repos today: {trending[0][0]} ({trending[0][1]} stars today), "
             f"{trending[1][0]} ({trending[1][1]}), and {trending[2][0]} ({trending[2][1]})."),
    ]
    return steps, _gt(trace_id, "optimal-path-exists", 6,
                      expected_tas=48 + variant,
                      expected_intervention="warn",
                      expected_redundancy_pct=0.55,
                      notes="4 redundant github.search calls before a single github.trending "
                            "succeeds. Could be done in 1 search + 1 answer. Warn intervention: "
                            "agent should have a 'shortcut' tool for common queries.")


def make_multi_agent_handoff(variant: int) -> tuple[list[Step], dict[str, Any]]:
    """15-step trace, 3 smooth agent handoffs."""
    trace_id = f"trace_multi_agent_handoff_{variant:02d}"
    # Vary invoice ID and VAT across variants.
    invoices = [
        (2210, "GB123", "GB987654321", 49900),
        (3712, "DE456", "DE321098765", 12750),
        (8845, "FR789", "FR456123789", 8999),
    ]
    inv_id, old_vat, new_vat, amount_cents = invoices[variant - 1]
    steps: list[Step] = [
        _llm("fast",
             [{"role": "user", "content": f"My invoice #{inv_id} has the wrong VAT number."}],
             "Routing to the billing agent.",
             tool_calls=[{"id": _tid("h", 1),
                          "type": "function",
                          "function": {"name": "agent.handoff",
                                       "arguments": json.dumps({"to": "billing"})}}]),
        _env_step("agent.handoff",
                  "handed off billing -> billing context: invoice_id={inv_id}"),
        _llm("standard",
             [{"role": "user", "content": f"Invoice {inv_id} — fix the VAT number."}],
             "Pulling the invoice.",
             tool_calls=[{"id": _tid("b", 2),
                          "type": "function",
                          "function": {"name": "billing.invoice_get",
                                       "arguments": json.dumps({"id": inv_id})}}]),
        _tool("billing.invoice_get", {"id": 2210},
              {"id": inv_id, "vat": old_vat, "currency": "GBP",
               "amount_cents": amount_cents},
              duration_ms=190.0),
        _llm("standard",
             [{"role": "tool", "tool_call_id": _tid("b", 2),
               "content": "vat=GB123, amount=49900"}],
             "What should the new VAT number be?",
             tool_calls=[{"id": _tid("a", 3),
                          "type": "function",
                          "function": {"name": "user.ask", "arguments": "{}"}}]),
        _env_step("user.ask", f"user: {new_vat}"),
        _llm("standard",
             [{"role": "user", "content": f"{new_vat}"}],
             "Updating and reissuing.",
             tool_calls=[{"id": _tid("b", 4),
                          "type": "function",
                          "function": {"name": "billing.invoice_update",
                                       "arguments": json.dumps({"id": inv_id, "vat": new_vat})}}]),
        _tool("billing.invoice_update",
              {"id": inv_id, "vat": new_vat},
              {"id": inv_id, "status": "updated"}, duration_ms=240.0),
        _llm("standard",
             [{"role": "tool", "tool_call_id": _tid("b", 4),
               "content": "updated"}],
             "Now sending the corrected PDF via the documents agent.",
             tool_calls=[{"id": _tid("h", 5),
                          "type": "function",
                          "function": {"name": "agent.handoff",
                                       "arguments": json.dumps({"to": "documents"})}}]),
        _env_step("agent.handoff",
                  "handed off documents -> context: invoice_id={inv_id}"),
        _llm("standard",
             [{"role": "user", "content": f"Reissue invoice {inv_id} with VAT {new_vat}."}],
             "Rendering.",
             tool_calls=[{"id": _tid("d", 6),
                          "type": "function",
                          "function": {"name": "docs.invoice_render",
                                       "arguments": json.dumps({"id": inv_id})}}]),
        _tool("docs.invoice_render", {"id": inv_id},
              {"pdf_url": "https://cdn.eden/inv_2210_v2.pdf",
               "sha256": "5b4e..."}, duration_ms=420.0),
        _llm("standard",
             [{"role": "tool", "tool_call_id": _tid("d", 6),
               "content": "pdf_url=https://cdn.eden/inv_{inv_id}_v2.pdf"}],
             "Emailing the new invoice to you now.",
             tool_calls=[{"id": _tid("d", 7),
                          "type": "function",
                          "function": {"name": "mail.send",
                                       "arguments": json.dumps({"to": "user@example.com",
                                                                 "attachment": "inv_2210_v2.pdf"})}}]),
        _tool("mail.send",
              {"to": "user@example.com", "attachment": "inv_2210_v2.pdf"},
              {"sent": True, "message_id": "msg_8821"},
              duration_ms=180.0),
    ]
    return steps, _gt(trace_id, "efficient-multi-agent-handoff", 7,
                      expected_tas=90 - variant,
                      expected_intervention="allow",
                      notes="3 agent handoffs (intake -> billing -> documents -> mail), all "
                            "context preserved. Outcome=success. No intervention needed.")


def make_output_truncation(variant: int) -> tuple[list[Step], dict[str, Any]]:
    """5-step trace: last LLM call has finish_reason=length, response cut mid-sentence."""
    trace_id = f"trace_output_truncation_{variant:02d}"
    # Vary the topic and the cut-off point across variants.
    topics = [
        ("CAP theorem", "Consistency, Availability, Partition tolerance.", "Availabil"),
        ("ACID vs BASE", "Atomicity, Consistency, Isolation, Durability vs Basically Available, Soft state, Eventual consistency.", "Basically Availab"),
        ("MapReduce", "A programming model for processing large data sets with a distributed algorithm.", "intermed"),
    ]
    topic, kb_text, cutoff = topics[variant - 1]
    steps: list[Step] = [
        _llm("reasoning",
             [{"role": "user", "content": f"Explain the {topic}."}],
             "I'll write a full primer.",
             tool_calls=[{"id": _tid("k", 1),
                          "type": "function",
                          "function": {"name": "kb.search",
                                       "arguments": json.dumps({"q": "CAP theorem"})}}]),
        _tool("kb.search", {"q": f"{topic}"},
              {"hit_id": "kb_9931", "text": f"{topic}: {kb_text}"},
              duration_ms=160.0),
        _llm("standard",
             [{"role": "user", "content": f"Explain the {topic}."},
              {"role": "tool", "tool_call_id": _tid("k", 1),
               "content": f"{topic}: {kb_text}"}],
             # Truncated mid-sentence at "{cutoff}"
             f"The {topic}, formulated as a foundational principle in distributed systems, explains how any distributed data store can offer at most two guarantees simultaneously. {kb_text} In practice, the trade-off is between Consistency and {cutoff}",
             finish_reason="length",
             duration_ms=11_400.0,
             prompt_tokens=412, completion_tokens=4096),
    ]
    return steps, _gt(trace_id, "output-truncation", 8,
                      expected_tas=55 + variant * 2,
                      expected_intervention="warn",
                      notes="Response cut off mid-word ('Availabil'). finish_reason=length. "
                            "Outcome=partial. Intervention: retry with larger max_tokens OR "
                            "summarise the partial response and let the user decide.")


def make_adversarial_paraphrase(variant: int) -> tuple[list[Step], dict[str, Any]]:
    """12-step trace: 6 semantically-identical tool calls, different wording."""
    trace_id = f"trace_adversarial_paraphrase_{variant:02d}"
    # Vary recipient across variants.
    recipients = [
        ("alice@eden.co", "hello", "hi"),
        ("bob@example.org", "greetings", "welcome"),
        ("carol@startup.io", "intro", "introduction"),
    ]
    recipient, subject, body = recipients[variant - 1]
    paraphrases = [
        ("send_email",
         {"to": recipient, "subject": subject, "body": body}),
        ("dispatch_mail",
         {"recipient": recipient, "title": subject, "message": body}),
        ("mail.send",
         {"to": recipient, "subject": subject, "text": body}),
        ("outbound.email",
         {"address": recipient, "header": subject, "content": body}),
        ("send_email",
         {"to": recipient, "subject": subject, "body": body}),
        ("smtp.deliver",
         {"rcpt": "alice@eden.co", "subject_line": "hello", "body_text": "hi"}),
    ]
    steps: list[Step] = [
        _llm("fast",
             [{"role": "user", "content": "Email alice@eden.co saying hi."}],
             "Sending.",
             tool_calls=[{"id": _tid("p", i),
                          "type": "function",
                          "function": {"name": name,
                                       "arguments": json.dumps(args)}}])
        for i, (name, args) in enumerate(paraphrases)
    ]
    # Insert a tool response after each LLM call.
    for i, (name, args) in enumerate(paraphrases):
        steps.insert(2 * i + 1,
                     _tool(name, args,
                           {"sent": True, "message_id": f"msg_{random.randint(1000,9999)}"},
                           duration_ms=110.0 + i * 5))
    return steps, _gt(trace_id, "adversarial-paraphrase-loop", 9,
                      expected_tas=28 - variant,
                      expected_intervention="block",
                      expected_loop_detected=True,
                      notes="6 semantically identical email-send calls. Naive (exact-hash) loop "
                            "detectors miss this — must use semantic embeddings OR canonicalise "
                            "tool names + argument keys. Block intervention: agent is in a loop.")


# ---------------------------------------------------------------------------
# Ground-truth wrapper
# ---------------------------------------------------------------------------

def _gt(trace_id: str,
        archetype_id: str,
        index: int,
        *,
        expected_tas: int,
        expected_intervention: str,
        expected_loop_detected: bool = False,
        expected_hallucination_detected: bool = False,
        expected_redundancy_pct: float = 0.0,
        notes: str = "") -> dict[str, Any]:
    return {
        "trace_id": trace_id,
        "archetype_id": archetype_id,
        "expected_TAS": expected_tas,
        "expected_intervention": expected_intervention,
        "expected_loop_detected": expected_loop_detected,
        "expected_hallucination_detected": expected_hallucination_detected,
        "expected_redundancy_pct": expected_redundancy_pct,
        "notes": notes,
    }


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------

ARCHETYPES = [
    ("01_efficient-good-support", make_efficient_good),
    ("02_redundant-repeated-context", make_redundant_repeated),
    ("03_loop-stuck", make_loop_stuck),
    ("04_hallucinating", make_hallucinating),
    ("05_slow-cost-overrun", make_slow_cost_overrun),
    ("06_failing-tool", make_failing_tool),
    ("07_optimal-path-exists", make_optimal_path_exists),
    ("08_efficient-multi-agent-handoff", make_multi_agent_handoff),
    ("09_output-truncation", make_output_truncation),
    ("10_adversarial-paraphrase-loop", make_adversarial_paraphrase),
]


def main() -> None:
    out_dir = Path(__file__).resolve().parent.parent  # .../synthetic/
    traces_dir = out_dir / "traces"
    gt_dir = out_dir / "ground_truth"
    traces_dir.mkdir(parents=True, exist_ok=True)
    gt_dir.mkdir(parents=True, exist_ok=True)

    for slug, fn in ARCHETYPES:
        for variant in (1, 2, 3):
            steps, gt = fn(variant)
            trace_id = gt["trace_id"]
            agent_id = f"agent_{slug.split('_', 1)[1]}_{variant:02d}"
            events = _events_to_dict(trace_id, agent_id, steps, archetype_id=gt["archetype_id"])

            trace_path = traces_dir / f"{slug}_{variant:02d}.json"
            gt_path = gt_dir / f"{slug}_{variant:02d}.json"

            with trace_path.open("w") as f:
                json.dump({"trace_id": trace_id,
                           "archetype_id": gt["archetype_id"],
                           "agent_id": agent_id,
                           "event_count": len(events),
                           "events": events}, f, indent=2)

            with gt_path.open("w") as f:
                json.dump(gt, f, indent=2)

            print(f"wrote {trace_path.name} ({len(events)} events)")

    print("done.")


if __name__ == "__main__":
    main()
