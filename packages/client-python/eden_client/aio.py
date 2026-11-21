"""``AsyncEden``: :class:`EdenClient` for asyncio agents (weak-points-1111.md D5).

The client is synchronous (standard library only); called from an event loop it blocks it for its
``timeout_s`` + ``waitMs`` — up to 3.8 s on a user message. ``AsyncEden`` runs each call in a worker thread
(``asyncio.to_thread``) with the same signatures, the same fail-open contract (D14: ``None``, ``[]`` or
``proceed``, never an exception) and the same ``on_error`` semantics. Sharing one ``AsyncEden`` across tasks is
safe on the same terms as sharing an ``EdenClient`` across threads: each call is one POST and the only mutable
state is a set add.
"""

from __future__ import annotations

import asyncio
from typing import Any, Dict, List, Optional

from . import EdenClient


class AsyncEden:
    """An :class:`EdenClient` whose every call is a coroutine, run in a worker thread.

    Pass an existing client as ``sync`` to wrap it (a ``LocalEden`` endpoint's client, an ``on_error`` already
    wired); otherwise the arguments are :class:`EdenClient`'s own.
    """

    def __init__(self, *args: Any, sync: Optional[EdenClient] = None, **kwargs: Any) -> None:
        self._sync = sync if sync is not None else EdenClient(*args, **kwargs)

    @property
    def sync(self) -> EdenClient:
        """The wrapped client: the sync contract, and anything without an async form."""
        return self._sync

    async def observe(self, event: Dict[str, Any], wait_ms: Optional[float] = None) -> Dict[str, Any]:
        """``EdenClient.observe`` in a worker thread."""
        return await asyncio.to_thread(self._sync.observe, event, wait_ms)

    async def pending(self) -> List[Dict[str, Any]]:
        """``EdenClient.pending`` in a worker thread."""
        return await asyncio.to_thread(self._sync.pending)

    async def collect(self, injection: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """``EdenClient.collect`` in a worker thread."""
        return await asyncio.to_thread(self._sync.collect, injection)

    async def ask(self, question: str, max_items: Optional[int] = None,
                  timeout_s: Optional[float] = None,
                  item: Optional[str] = None) -> Optional[Dict[str, Any]]:
        """``EdenClient.ask`` in a worker thread."""
        return await asyncio.to_thread(self._sync.ask, question, max_items, timeout_s, item)

    async def check(self, tool: str, input: Any, timeout_s: Optional[float] = None) -> Dict[str, Any]:
        """``EdenClient.check`` in a worker thread."""
        return await asyncio.to_thread(self._sync.check, tool, input, timeout_s)

    async def feedback(self, injection_id: str, used: bool) -> None:
        """``EdenClient.feedback`` in a worker thread."""
        return await asyncio.to_thread(self._sync.feedback, injection_id, used)

    async def health(self, timeout_s: Optional[float] = None) -> Dict[str, Any]:
        """``EdenClient.health`` in a worker thread."""
        return await asyncio.to_thread(self._sync.health, timeout_s)

    async def explain(self, timeout_s: Optional[float] = None) -> List[Dict[str, Any]]:
        """``EdenClient.explain`` in a worker thread."""
        return await asyncio.to_thread(self._sync.explain, timeout_s)

    async def source_changed(self, source_id: str, items: Optional[List[Dict[str, Any]]] = None,
                             removed: Optional[List[str]] = None, refs: Optional[List[str]] = None) -> bool:
        """``EdenClient.source_changed`` in a worker thread."""
        return await asyncio.to_thread(self._sync.source_changed, source_id, items, removed, refs)

    async def source_notice(self, source_id: str) -> Optional[Dict[str, Any]]:
        """``EdenClient.source_notice`` in a worker thread."""
        return await asyncio.to_thread(self._sync.source_notice, source_id)
