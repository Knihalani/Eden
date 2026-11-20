"""Eden's gptme tool: ask_context, answered by the shared plugin client."""

import sys
from pathlib import Path

_VENDOR = Path(__file__).resolve().parents[1] / "vendor"
if _VENDOR.is_dir() and str(_VENDOR) not in sys.path:
    sys.path.insert(0, str(_VENDOR))

from gptme.tools.base import ToolSpec

from eden_client import ASK_CONTEXT_DESCRIPTION
from eden_client.gptme import plugin


def ask_context(question: str) -> str:
    """Ask Eden for context about the user, workspace or world."""
    return plugin().ask(question)


tool = ToolSpec(
    name="eden",
    desc="Eden context partner",
    instructions=ASK_CONTEXT_DESCRIPTION,
    functions=[ask_context],
)
