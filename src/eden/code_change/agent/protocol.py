"""Protocol for the PR-agent layer."""

from __future__ import annotations

from typing import Any, Protocol


class PRAgent(Protocol):
    """The contract every PR-agent backend implements."""

    name: str

    async def run(
        self,
        candidate: Any,
        *,
        decision: Any | None = None,
    ) -> Any | None:
        """Run the agent on ``candidate`` + return a structured result.

        Returns ``None`` on backend failure. Otherwise a
        :class:`PRResult`-shaped dict with ``kind`` +
        ``title`` + ``body`` + ``diff`` (or
        ``reason`` for ``report_only``).
        """
        ...
