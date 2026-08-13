"""MCP Prompts capability (F04 extension — 6.3).

Exposes reusable Eden workflow prompts following the MCP ``prompts/list`` and
``prompts/get`` protocol.  Three prompts ship in this wave:

* ``triage_issue``    — find issue → triage → fixture → replay
* ``explain_trace``   — narrative cost + latency + error explanation for a trace
* ``summarize_cost``  — FinOps cost breakdown with optimisation suggestions

Pattern mirrors ``TOOL_CATALOG`` / ``list_tools()`` in ``server.py``.
"""

from __future__ import annotations

from typing import Any

# ── Prompt catalog ───────────────────────────────────────────────────

PROMPT_CATALOG: list[dict[str, Any]] = [
    {
        "name": "triage_issue",
        "description": (
            "Step-by-step workflow for triaging an agent issue: "
            "retrieve issue detail, export a failure fixture, replay from a "
            "checkpoint, and propose an improvement plan. Mirrors the 9.11 "
            "improve-loop runbook."
        ),
        "arguments": [
            {
                "name": "org_id",
                "description": "Eden org ID (e.g. org_abc123).",
                "required": True,
            },
            {
                "name": "issue_id",
                "description": "Issue ID to triage (e.g. iss_abc123).",
                "required": True,
            },
        ],
    },
    {
        "name": "explain_trace",
        "description": (
            "Generate a human-readable explanation of a trace: cost, latency "
            "breakdown, tool-call sequence, stumble annotations, and judge "
            "scores where available."
        ),
        "arguments": [
            {
                "name": "org_id",
                "description": "Eden org ID.",
                "required": True,
            },
            {
                "name": "trace_id",
                "description": "Trace ID to explain (e.g. trc_abc123).",
                "required": True,
            },
        ],
    },
    {
        "name": "summarize_cost",
        "description": (
            "Produce a FinOps summary for the org: top cost lanes by feature, "
            "change vs prior window, and ranked optimisation suggestions "
            "(model swap, sampling, truncation)."
        ),
        "arguments": [
            {
                "name": "org_id",
                "description": "Eden org ID.",
                "required": True,
            },
            {
                "name": "window_hours",
                "description": "Look-back window in hours (default 24).",
                "required": False,
            },
        ],
    },
]

_PROMPT_BY_NAME: dict[str, dict[str, Any]] = {
    p["name"]: p for p in PROMPT_CATALOG
}


def list_prompts() -> list[dict[str, Any]]:
    """Return MCP-shaped prompt descriptors."""
    return [
        {
            "name": p["name"],
            "description": p["description"],
            "arguments": p["arguments"],
        }
        for p in PROMPT_CATALOG
    ]


def get_prompt(
    name: str,
    arguments: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Render a prompt template with the supplied *arguments*.

    Returns the MCP ``prompts/get`` response shape (``description`` +
    ``messages`` list), or an error dict if *name* is unknown.
    """
    prompt = _PROMPT_BY_NAME.get(name)
    if prompt is None:
        return {"status": "error", "error": f"Unknown prompt: {name!r}"}

    args = arguments or {}
    org_id = str(args.get("org_id") or "<org_id>")
    text = _render(name, org_id, args)

    return {
        "description": prompt["description"],
        "messages": [
            {
                "role": "user",
                "content": {"type": "text", "text": text},
            }
        ],
    }


# ── Prompt renderers ─────────────────────────────────────────────────


def _render(name: str, org_id: str, args: dict[str, Any]) -> str:
    if name == "triage_issue":
        return _render_triage_issue(org_id, args)
    if name == "explain_trace":
        return _render_explain_trace(org_id, args)
    if name == "summarize_cost":
        return _render_summarize_cost(org_id, args)
    return f"Prompt: {name}"


def _render_triage_issue(org_id: str, args: dict[str, Any]) -> str:
    issue_id = str(args.get("issue_id") or "<issue_id>")
    return f"""\
You are an Eden improve-loop operator. Follow this runbook to triage and resolve issue **{issue_id}** in org **{org_id}**.

## Step 1 — Retrieve the issue
Call `get_issue` with org_id="{org_id}" and issue_id="{issue_id}".
Inspect: severity, affected trace IDs, existing triage, root cause if any.

## Step 2 — Export a failure fixture
Call `export_fixture` with org_id="{org_id}" and issue_id="{issue_id}".
Save the returned fixture JSON for local replay.

## Step 3 — Replay from a checkpoint
Call `list_checkpoints` for the primary affected trace.
Then call `rerun_debugger` from the earliest failing checkpoint (from_step=<n>).
If prompt_override is useful, supply it; otherwise leave it blank.

## Step 4 — Review stumbles
Call `get_trace_stumbles` for the affected trace. Note the stumble kinds and positions.

## Step 5 — Run triage agent
Call `triage_issue` with force=false. Review the root_cause field.

## Step 6 — Check improvement queue
Call `get_improvement_queue` for the org. If a plan already exists for this issue, review it with `get_improvement_plan`.

## Step 7 — Propose or approve a plan
If no plan exists, call `run_autofix` with dry_run=true to preview a patch.
If a plan exists and the eval delta looks favourable, call `approve_improvement_plan`.

## Done
Report back: root cause, checkpoint that was replayed, plan ID or patch summary, and whether the plan was approved.
"""


def _render_explain_trace(org_id: str, args: dict[str, Any]) -> str:
    trace_id = str(args.get("trace_id") or "<trace_id>")
    return f"""\
Explain trace **{trace_id}** in org **{org_id}** in plain language.

## Data to gather
1. Call `get_trace` to retrieve the full trace tree and metadata.
2. Call `get_transcript` for the step-by-step timeline (limit=100).
3. Call `get_trace_stumbles` to list annotated stumble events.
4. Call `get_judge_scores` to retrieve Layer A / judge scores.

## What to explain
- **What happened**: summarise the agent's goal, tool sequence, and outcome.
- **Cost**: total token spend, which steps were most expensive, and whether caching fired.
- **Latency**: wall-clock breakdown by step; highlight the slowest span.
- **Errors / stumbles**: describe each stumble by kind, step index, and impact.
- **Quality**: summarise judge scores and flag any score below 0.7.
- **Suggested next actions**: if quality is low, suggest `triage_issue` or `rerun_debugger`.
"""


def _render_summarize_cost(org_id: str, args: dict[str, Any]) -> str:
    window_hours = int(args.get("window_hours") or 24)
    return f"""\
Produce a FinOps cost summary for org **{org_id}** over the last **{window_hours} hours**.

## Data to gather
Call `get_cost_breakdown` with org_id="{org_id}" and window_hours={window_hours}.

## What to report
1. **Total spend** this window vs prior window (delta %).
2. **Top 5 lanes** by cost: feature name, model, token spend, % of total.
3. **Anomalies**: lanes with >50 % increase vs prior window.
4. **Optimisation suggestions** (ranked by potential saving):
   - Model swap: identify lanes using an expensive model that could use a cheaper one.
   - Sampling: lanes with sampling >10 % and low per-trace value.
   - Truncation: context_blob or digest_chars that could be cut.
   - Caching: lanes that could use prompt-prefix caching.
5. **Projected monthly spend** at current burn rate.

Keep the output concise; use a markdown table for the top-5 lanes.
"""
