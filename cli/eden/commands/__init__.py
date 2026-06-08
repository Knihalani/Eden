"""Eden slash commands.

We follow Aider's ``cmd_*`` method-prefix convention: every method
named ``cmd_*`` is auto-discovered as a slash command. **No central
registry** — that's the C1+C2 union-friendly contract from the plan.

This package contains the C1-owned commands:

    /eden-kb       — query the Knowledge Base
    /eden-traces   — list recent observability traces
    /eden-improve  — flagship multi-pass sweep

C2 owns: /eden-pr, /integrate-eden, /eden-bench, /eden-pipeline
(see ``cli/eden/commands/{pr,integrate,bench,pipeline}.py``).
"""

from __future__ import annotations

from eden.commands import improve, kb, traces

__all__ = ["improve", "kb", "traces"]
