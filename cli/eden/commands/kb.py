"""``/eden-kb`` — Knowledge Base query slash command.

Usage (inside the Eden chat):

    /eden-kb query "reward shaping"
    /eden-kb query --global "LangChain tool error"
    /eden-kb query --tenant "team convention: retry policy"
    /eden-kb stats
"""

from __future__ import annotations

import argparse
import logging
from typing import Any

logger = logging.getLogger("eden.cli.commands.kb")


def register(subparsers: Any) -> None:
    """Register ``/eden-kb`` subcommands with the chat command parser.

    Aider's chat command parser is built incrementally; this helper
    keeps KB argument wiring in one place.
    """
    p = subparsers.add_parser(
        "eden-kb",
        help="Query the Eden Knowledge Base (global + tenant)",
    )
    kb_sub = p.add_subparsers(dest="kb_cmd")

    q = kb_sub.add_parser("query", help="Run a KB query")
    q.add_argument("text", nargs="+", help="Search text")
    q.add_argument(
        "--global", dest="scope_global", action="store_true",
        help="Search global KB only"
    )
    q.add_argument(
        "--tenant", dest="scope_tenant", action="store_true",
        help="Search tenant KB only"
    )
    q.add_argument(
        "--limit", type=int, default=10, help="Max results (default: 10)"
    )

    s = kb_sub.add_parser("stats", help="Show KB health stats")
    s.add_argument("--window-days", type=int, default=30)


async def handle_kb_query(args: argparse.Namespace, ctx: Any) -> str:
    """Execute a KB query and return a markdown result string.

    ``ctx`` is the chat context — it must expose ``.eden_client`` and
    ``.eden_kb_context`` (built by ``EdenCoder.prime_context_async`` or
    by the chat bootstrap).
    """
    text = " ".join(args.text)
    if args.scope_global:
        scope = "global"
    elif args.scope_tenant:
        scope = "tenant"
    else:
        scope = "all"

    provider = getattr(ctx, "eden_kb_context", None)
    if provider is None:
        return "_KB context provider not initialized._"

    if scope == "all":
        result = await provider.get_combined_context(text, budget=4000)
    elif scope == "global":
        result = await provider.get_global_context(text)
    else:
        result = await provider.get_tenant_context(text)

    if not result.text:
        return f"_No KB results for **{text!r}** (scope={scope})._"

    header = (
        f"**KB query:** `{text}` _(scope={scope}, "
        f"hits={result.hit_count}, truncated={result.truncated})_"
    )
    return f"{header}\n\n{result.text}"


def cmd_eden_kb(self, args: str) -> None:  # noqa: ANN001 — Aider signature
    """Aider slash-command entry point.

    Aider invokes this method on the Commands instance with the
    argument string after ``/eden-kb``. We parse it ourselves with
    argparse so the UX matches the rest of the CLI.
    """
    import asyncio
    from eden.commands.kb import handle_kb_query

    parser = argparse.ArgumentParser(prog="/eden-kb", add_help=False)
    sub = parser.add_subparsers(dest="action")

    q = sub.add_parser("query")
    q.add_argument("text", nargs="+")
    q.add_argument("--global", dest="scope_global", action="store_true")
    q.add_argument("--tenant", dest="scope_tenant", action="store_true")
    q.add_argument("--limit", type=int, default=10)

    s = sub.add_parser("stats")
    s.add_argument("--window-days", type=int, default=30)

    try:
        ns = parser.parse_args(args.split())
    except SystemExit:
        return

    if ns.action == "query":
        out = asyncio.run(handle_kb_query(ns, self.coder))
        self.io.tool_output(out)
    elif ns.action == "stats":
        # Stats are best-effort; show whatever the KB API exposes.
        self.io.tool_output(
            "_KB stats: see `eden-kb stats` backend response "
            "(not yet wired in this build)._"
        )
    else:
        self.io.tool_output(
            "Usage: /eden-kb query [--global|--tenant] \"text\" | /eden-kb stats"
        )


# Tell Aider's Commands auto-discovery this is a slash command.
cmd_eden_kb.__doc__ = "/eden-kb — Query the Eden Knowledge Base"
