"""``/eden-traces`` — list recent observability traces.

Usage (inside the Eden chat):

    /eden-traces --limit 5
    /eden-traces --agent-id <uuid> --limit 10
    /eden-traces show <trace_id>
"""

from __future__ import annotations

import argparse
import logging
from typing import Any

logger = logging.getLogger("eden.cli.commands.traces")


def register(subparsers: Any) -> None:
    """Register ``/eden-traces`` subcommands with the chat command parser."""
    p = subparsers.add_parser(
        "eden-traces",
        help="List / inspect observability traces"
    )
    sub = p.add_subparsers(dest="traces_cmd")

    l = sub.add_parser("list", help="List recent traces (default)")
    l.add_argument("--limit", type=int, default=10)
    l.add_argument("--agent-id", default=None)
    l.add_argument("--realm", default=None, choices=[None, "env", "prod"])

    s = sub.add_parser("show", help="Show a single trace")
    s.add_argument("trace_id")


def _format_trace_row(t: dict[str, Any]) -> str:
    tid = t.get("trace_id") or t.get("id") or "?"
    dur = t.get("duration_ms") or t.get("latency_ms")
    err = t.get("error") or t.get("status")
    agent = t.get("agent_id") or "-"
    span = t.get("span_count") or t.get("spans")
    dur_s = f"{dur:.0f}ms" if isinstance(dur, (int, float)) else "-"
    err_s = "ERR" if err and err != "ok" else "ok"
    span_s = f"{span}" if isinstance(span, int) else "-"
    return f"- `{tid[:12]}` · {dur_s} · {err_s} · spans={span_s} · agent={agent}"


async def handle_traces_list(args: argparse.Namespace, ctx: Any) -> str:
    provider = getattr(ctx, "eden_obs_context", None)
    if provider is None:
        return "_Observability context provider not initialized._"

    traces = await provider.list_recent_traces(limit=args.limit)
    if not traces:
        return "_No traces in the selected window._"

    rows = "\n".join(_format_trace_row(t) for t in traces[: args.limit])
    return f"**Recent traces** (n={len(traces)}):\n\n{rows}"


async def handle_traces_show(args: argparse.Namespace, ctx: Any) -> str:
    # We currently only have list; show is a TODO that returns a stub
    # so the user sees a graceful message rather than an error.
    return (
        f"_Trace detail for `{args.trace_id}`: full span tree not yet "
        "rendered in the CLI. Open the portal for the rich view._"
    )


def cmd_eden_traces(self, args: str) -> None:  # noqa: ANN001
    """Aider slash-command entry point for ``/eden-traces``."""
    import asyncio

    parser = argparse.ArgumentParser(prog="/eden-traces", add_help=False)
    sub = parser.add_subparsers(dest="action")

    l = sub.add_parser("list")
    l.add_argument("--limit", type=int, default=10)
    l.add_argument("--agent-id", default=None)
    l.add_argument("--realm", default=None)

    s = sub.add_parser("show")
    s.add_argument("trace_id")

    # Backwards-compat: bare "/eden-traces --limit 5" → list
    bare = argparse.ArgumentParser(prog="/eden-traces", add_help=False)
    bare.add_argument("--limit", type=int, default=10)
    bare.add_argument("--agent-id", default=None)
    bare.add_argument("--realm", default=None)

    try:
        ns = parser.parse_args(args.split())
    except SystemExit:
        # Fall back to bare-list form
        ns = bare.parse_args(args.split())
        ns.action = "list"

    if ns.action == "list" or ns.action is None:
        out = asyncio.run(handle_traces_list(ns, self.coder))
        self.io.tool_output(out)
    elif ns.action == "show":
        out = asyncio.run(handle_traces_show(ns, self.coder))
        self.io.tool_output(out)
    else:
        self.io.tool_output(
            "Usage: /eden-traces [--limit N] | /eden-traces show <trace_id>"
        )


cmd_eden_traces.__doc__ = "/eden-traces — List recent observability traces"
