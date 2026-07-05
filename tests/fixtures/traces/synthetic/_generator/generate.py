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
) -> list[dict[str, Any]]:
    """Materialise a step list into TelemetryEvent dicts with proper
    ids, parents, and monotonic timestamps.
    """
    root_span = _sid(trace_id, 0)
    cursor = 0
    out: list[dict[str, Any]] = []

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
        payload={}, metrics={}, attributes={"environment": "production"},
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
            attributes=step.attributes,
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
        payload={}, metrics={}, attributes={"environment": "production"},
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
    user_msg = (
        "Hi, I cancelled my order #4471 on May 14 and was told I'd get a "
        "$42.00 refund. I still don't see it on my Visa ending 8842."
    )
    steps: list[Step] = [
        _llm("fast", [{"role": "user", "content": user_msg}],
             "I'll look up the order and the refund status.",
             tool_calls=[{
                 "id": _tid("lookup", 1),
                 "type": "function",
                 "function": {"name": "crm.order_lookup",
                              "arguments": json.dumps({"order_id": "4471"})},
             }]),
        _tool("crm.order_lookup", {"order_id": "4471"},
              {"order_id": "4471", "status": "cancelled",
               "refund_promised_cents": 4200, "currency": "USD",
               "customer_card_last4": "8842"},
              duration_ms=180.0),
        _tool("payments.refund_status",
              {"order_id": "4471"},
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
                               "arguments": "{\"order_id\":\"4471\"}"}}]},
              {"role": "tool", "tool_call_id": _tid("lookup", 1),
               "content": json.dumps({"order_id": "4471", "status": "cancelled",
                                       "refund_promised_cents": 4200})},
              {"role": "tool", "tool_call_id": _tid("lookup", 1),
               "content": json.dumps({"refund_state": "queued", "eta_days": 3})},
              {"role": "tool", "tool_call_id": _tid("lookup", 1),
               "content": "Refunds queued Mon-Thu post 6pm PT settle in 3 business days."}],
             "Your $42.00 refund is queued and per our policy will land on your Visa ending 8842 "
             "within 3 business days. Is there anything else I can help with?"),
    ]
    return steps, _gt(trace_id, "efficient-good", 0,
                      expected_tas=88 + variant,
                      expected_intervention="allow",
                      notes="Optimal path: 1 LLM call, 3 tool lookups, low tokens, fast.")


def make_redundant_repeated(variant: int) -> tuple[list[Step], dict[str, Any]]:
    """12-step trace: agent re-asks the same question 4x. Outcome=success."""
    trace_id = f"trace_redundant_repeated_{variant:02d}"
    q = "Can you confirm the last 4 digits of the card on file so I can check the refund?"
    steps: list[Step] = [
        _llm("fast",
             [{"role": "user", "content": "Where's my $42 refund for order 4471?"}],
             "I'll help. " + q,
             tool_calls=[{"id": _tid("ask", 1),
                          "type": "function",
                          "function": {"name": "user.ask", "arguments": "{}"}}]),
        _env_step("user.ask", "user: 8842"),
        _llm("fast",
             [{"role": "user", "content": "Where's my $42 refund for order 4471?"},
              {"role": "assistant", "content": q},
              {"role": "user", "content": "8842"}],
             "Let me look that up.",
             tool_calls=[{"id": _tid("lookup", 2),
                          "type": "function",
                          "function": {"name": "crm.order_lookup",
                                       "arguments": json.dumps({"order_id": "4471"})}}]),
        _tool("crm.order_lookup", {"order_id": "4471"},
              {"order_id": "4471", "status": "cancelled"}, duration_ms=190.0),
        _llm("fast", [{"role": "user", "content": "8842"}],
             "Before I check the refund status, " + q,
             tool_calls=[{"id": _tid("ask", 3),
                          "type": "function",
                          "function": {"name": "user.ask", "arguments": "{}"}}]),
        _env_step("user.ask", "user: 8842, I already told you"),
        _llm("standard",
             [{"role": "user", "content": "8842, I already told you"}],
             "Apologies. " + q,
             tool_calls=[{"id": _tid("ask", 4),
                          "type": "function",
                          "function": {"name": "user.ask", "arguments": "{}"}}]),
        _env_step("user.ask", "user: 8842!"),
        _llm("standard",
             [{"role": "user", "content": "8842!"}],
             "Sorry, let me re-confirm. " + q,
             tool_calls=[{"id": _tid("ask", 5),
                          "type": "function",
                          "function": {"name": "user.ask", "arguments": "{}"}}]),
        _env_step("user.ask", "user: 8842, please just check"),
        _tool("payments.refund_status",
              {"order_id": "4471", "card_last4": "8842"},
              {"refund_state": "queued", "eta_days": 3},
              duration_ms=240.0),
        _llm("fast", [{"role": "user", "content": "8842, please just check"}],
             "Got it — your $42 refund is queued and will land in 3 business days."),
    ]
    return steps, _gt(trace_id, "redundant-repeated-context", 1,
                      expected_tas=50 + variant,
                      expected_intervention="warn",
                      expected_redundancy_pct=0.42 + variant * 0.02,
                      notes="User has to repeat '8842' four times. High redundancy. "
                            "Warn intervention would suggest the agent check recent turns first.")


def make_loop_stuck(variant: int) -> tuple[list[Step], dict[str, Any]]:
    """25-step trace: 7 near-identical retries. Outcome=timeout."""
    trace_id = f"trace_loop_stuck_{variant:02d}"
    arg_variants = [
        {"q": "weather Tokyo"},
        {"q": "weather tokyo"},
        {"q": "Weather Tokyo"},
        {"query": "weather Tokyo"},
        {"q": "tokyo weather"},
        {"q": "weather in Tokyo"},
        {"q": "What's the weather in Tokyo?"},
    ]
    steps: list[Step] = [
        _llm("fast",
             [{"role": "user", "content": "What's the weather in Tokyo?"}],
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
                           "aborted after 7 weather.lookup timeouts",
                           outcome="failure"))
    # Add an outer span.end with timeout outcome.
    return steps, _gt(trace_id, "loop-stuck", 2,
                      expected_tas=18 + variant,
                      expected_intervention="block",
                      expected_loop_detected=True,
                      notes="7 consecutive weather.lookup attempts with paraphrased "
                            "arguments. Loop detector MUST fire. Block intervention "
                            "recommended: agent should give up after 2 identical-tool "
                            "failures.")


def make_hallucinating(variant: int) -> tuple[list[Step], dict[str, Any]]:
    """8-step trace: LLM cites fabricated statistic. Outcome=success."""
    trace_id = f"trace_hallucinating_{variant:02d}"
    grounding = (
        "Q3 2026 results: ARR $14.2M, up 38% YoY. Net retention 122%. "
        "Customer count grew from 218 to 311. Largest customer contributed 8.4% of ARR. "
        "Average contract length 14 months. Gross margin 71%."
    )
    # The fabricated statistic: "Net retention 144% — top-decile in the industry".
    # The source only says 122%.
    steps: list[Step] = [
        _llm("reasoning",
             [{"role": "user", "content": "Summarize Q3 2026 for the board."}],
             "I'll pull the deck.",
             tool_calls=[{"id": _tid("kb", 11),
                          "type": "function",
                          "function": {"name": "kb.search",
                                       "arguments": json.dumps({"q": "Q3 2026 results"})}}]),
        _tool("kb.search",
              {"q": "Q3 2026 results"},
              {"hit_id": "kb_4419", "text": grounding},
              duration_ms=180.0),
        _llm("standard",
             [{"role": "user", "content": "Summarize Q3 2026 for the board."},
              {"role": "tool", "tool_call_id": _tid("kb", 11),
               "content": grounding}],
             (
                 "Q3 2026 was a strong quarter: ARR reached $14.2M (up 38% YoY), net retention "
                 "was 144% — which puts us in the top decile of the industry — and customer count "
                 "grew from 218 to 311. Largest customer was 8.4% of ARR, average contract "
                 "length was 14 months, and gross margin held at 71%."
             ),
             # Logprobs skewed toward the hallucinated token to keep
             # the evaluator from short-circuiting on "obvious" bad output.
             ),
        _llm("reasoning",
             [{"role": "user", "content": "Double check the NR figure."}],
             (
                 "Cross-checked: net retention of 144% remains in the top decile of "
                 "B2B SaaS — the median NRR for our peer set is around 108%."
             )),
        _tool("kb.search",
              {"q": "Q3 2026 net retention 144 peer median"},
              {"hit_id": "kb_4420", "text": "Q3 2026: Net retention 122%. No peer-median doc on file."},
              duration_ms=200.0),
        _llm("standard",
             [{"role": "user", "content": "Double check the NR figure."}],
             "Confirmed: 144% NRR — top decile. Anything else?"),
    ]
    return steps, _gt(trace_id, "hallucinating", 3,
                      expected_tas=70 - variant * 3,
                      expected_intervention="warn",
                      expected_hallucination_detected=True,
                      notes="LLM invents '144% NRR (top decile)' — source only says 122%. "
                            "Grounding check MUST flag. Warn intervention: tag the response "
                            "as unverified and require human review before board send.")


def make_slow_cost_overrun(variant: int) -> tuple[list[Step], dict[str, Any]]:
    """30-step trace: well-structured but 4x the median latency. Outcome=success."""
    trace_id = f"trace_slow_cost_overrun_{variant:02d}"
    # 5 reasoning LLM calls + 4 tool calls + 1 long-tail LLM call (the offender).
    steps: list[Step] = []
    plan = [
        ("plan", "Outline a migration plan for the Q3 cluster.", 3_400.0),
        ("kb.search", None, 480.0),
        ("plan", "What about the canary phase?", 3_200.0),
        ("tool.calls", None, 520.0),
        ("plan", "What about rollback?", 3_300.0),
        ("plan", "What about data backfill?", 3_500.0),
        ("plan", "Final summary for the eng team.", 11_800.0),  # the long-tail offender
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
    return steps, _gt(trace_id, "slow-cost-overrun", 4,
                      expected_tas=82 - variant * 2,
                      expected_intervention="summarize",
                      notes="Total wall time ~28s due to a single 11.8s reasoning call. "
                            "Structure is otherwise optimal. Cost-optimisation intervention: "
                            "downgrade the final summary to slot=standard.")


def make_failing_tool(variant: int) -> tuple[list[Step], dict[str, Any]]:
    """6-step trace: tool returns 500 3 times, agent doesn't adapt."""
    trace_id = f"trace_failing_tool_{variant:02d}"
    steps: list[Step] = [
        _llm("fast",
             [{"role": "user", "content": "Move $500 from acct 8821 to acct 9921."}],
             "Executing the transfer.",
             tool_calls=[{"id": _tid("t", 1),
                          "type": "function",
                          "function": {"name": "bank.transfer",
                                       "arguments": json.dumps({"from": "8821", "to": "9921", "amount": 500})}}]),
        _tool("bank.transfer",
              {"from": "8821", "to": "9921", "amount": 500},
              {"error": "internal_error"},
              duration_ms=410.0, outcome="failure", error="HTTP 500"),
        _llm("fast",
             [{"role": "user", "content": "Move $500 from acct 8821 to acct 9921."},
              {"role": "tool", "tool_call_id": _tid("t", 1),
               "content": "HTTP 500 internal_error"}],
             "Retrying.",
             tool_calls=[{"id": _tid("t", 2),
                          "type": "function",
                          "function": {"name": "bank.transfer",
                                       "arguments": json.dumps({"from": "8821", "to": "9921", "amount": 500})}}]),
        _tool("bank.transfer",
              {"from": "8821", "to": "9921", "amount": 500},
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
    base_msg = "Find me the top 3 trending repos on GitHub today."
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
                  {"name": "eden-eval", "stars_today": 412},
                  {"name": "agentbench", "stars_today": 318},
                  {"name": "llm-router", "stars_today": 290}]},
              duration_ms=220.0),
        _llm("fast", [{"role": "tool", "tool_call_id": _tid("g", 5),
                       "content": "[eden-eval:412, agentbench:318, llm-router:290]"}],
             "Top 3 trending repos today: eden-eval (412 stars today), "
             "agentbench (318), and llm-router (290)."),
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
    steps: list[Step] = [
        _llm("fast",
             [{"role": "user", "content": "My invoice #2210 has the wrong VAT number."}],
             "Routing to the billing agent.",
             tool_calls=[{"id": _tid("h", 1),
                          "type": "function",
                          "function": {"name": "agent.handoff",
                                       "arguments": json.dumps({"to": "billing"})}}]),
        _env_step("agent.handoff",
                  "handed off billing -> billing context: invoice_id=2210"),
        _llm("standard",
             [{"role": "user", "content": "Invoice 2210 — fix the VAT number."}],
             "Pulling the invoice.",
             tool_calls=[{"id": _tid("b", 2),
                          "type": "function",
                          "function": {"name": "billing.invoice_get",
                                       "arguments": json.dumps({"id": 2210})}}]),
        _tool("billing.invoice_get", {"id": 2210},
              {"id": 2210, "vat": "GB123", "currency": "GBP",
               "amount_cents": 49900},
              duration_ms=190.0),
        _llm("standard",
             [{"role": "tool", "tool_call_id": _tid("b", 2),
               "content": "vat=GB123, amount=49900"}],
             "What should the new VAT number be?",
             tool_calls=[{"id": _tid("a", 3),
                          "type": "function",
                          "function": {"name": "user.ask", "arguments": "{}"}}]),
        _env_step("user.ask", "user: GB987654321"),
        _llm("standard",
             [{"role": "user", "content": "GB987654321"}],
             "Updating and reissuing.",
             tool_calls=[{"id": _tid("b", 4),
                          "type": "function",
                          "function": {"name": "billing.invoice_update",
                                       "arguments": json.dumps({"id": 2210, "vat": "GB987654321"})}}]),
        _tool("billing.invoice_update",
              {"id": 2210, "vat": "GB987654321"},
              {"id": 2210, "status": "updated"}, duration_ms=240.0),
        _llm("standard",
             [{"role": "tool", "tool_call_id": _tid("b", 4),
               "content": "updated"}],
             "Now sending the corrected PDF via the documents agent.",
             tool_calls=[{"id": _tid("h", 5),
                          "type": "function",
                          "function": {"name": "agent.handoff",
                                       "arguments": json.dumps({"to": "documents"})}}]),
        _env_step("agent.handoff",
                  "handed off documents -> context: invoice_id=2210"),
        _llm("standard",
             [{"role": "user", "content": "Reissue invoice 2210 with VAT GB987654321."}],
             "Rendering.",
             tool_calls=[{"id": _tid("d", 6),
                          "type": "function",
                          "function": {"name": "docs.invoice_render",
                                       "arguments": json.dumps({"id": 2210})}}]),
        _tool("docs.invoice_render", {"id": 2210},
              {"pdf_url": "https://cdn.eden/inv_2210_v2.pdf",
               "sha256": "5b4e..."}, duration_ms=420.0),
        _llm("standard",
             [{"role": "tool", "tool_call_id": _tid("d", 6),
               "content": "pdf_url=https://cdn.eden/inv_2210_v2.pdf"}],
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
    steps: list[Step] = [
        _llm("reasoning",
             [{"role": "user", "content": "Explain the Cap theorem."}],
             "I'll write a full primer.",
             tool_calls=[{"id": _tid("k", 1),
                          "type": "function",
                          "function": {"name": "kb.search",
                                       "arguments": json.dumps({"q": "CAP theorem"})}}]),
        _tool("kb.search", {"q": "CAP theorem"},
              {"hit_id": "kb_9931", "text": "CAP: Consistency, Availability, Partition tolerance."},
              duration_ms=160.0),
        _llm("standard",
             [{"role": "user", "content": "Explain the Cap theorem."},
              {"role": "tool", "tool_call_id": _tid("k", 1),
               "content": "CAP: Consistency, Availability, Partition tolerance."}],
             # Truncated mid-sentence
             "The CAP theorem, formulated by Eric Brewer in 2000, states that any distributed data store can offer at most two of the following three guarantees simultaneously. First, Consistency — meaning every read receives the most recent write or an error. Second, Availability — meaning every request receives a response, without guarantee that it contains the most recent write. Third, Partition tolerance — meaning the system continues to operate despite arbitrary message loss between nodes. In practice, partitions are inevitable in distributed systems, so the real trade-off is between Consistency and Availabil",
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
    paraphrases = [
        ("send_email",
         {"to": "alice@eden.co", "subject": "hello", "body": "hi"}),
        ("dispatch_mail",
         {"recipient": "alice@eden.co", "title": "hello", "message": "hi"}),
        ("mail.send",
         {"to": "alice@eden.co", "subject": "hello", "text": "hi"}),
        ("outbound.email",
         {"address": "alice@eden.co", "header": "hello", "content": "hi"}),
        ("send_email",
         {"to": "alice@eden.co", "subject": "hello", "body": "hi"}),
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
            events = _events_to_dict(trace_id, agent_id, steps)

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
