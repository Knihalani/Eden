"""Request coalescing and deduplication for LLM calls.

When multiple identical or near-identical requests arrive within a short window,
only one actual LLM call is made and all waiters receive the same response."""

import asyncio
import hashlib
import logging
import time
from dataclasses import dataclass
from typing import Optional

from eden.llm.client import LLMResponse

logger = logging.getLogger(__name__)


@dataclass
class _InflightRequest:
    """Internal tracking for an in-flight coalesced request."""

    future: asyncio.Future
    created_at: float
    key: str


class RequestCoalescer:
    """Deduplicates concurrent identical LLM requests.

    Uses an asyncio.Future so that multiple callers waiting for the same
    underlying request all receive the result simultaneously.
    """

    def __init__(self, window_ms: float = 100.0):
        self.window_ms = window_ms
        self._inflight: dict[str, _InflightRequest] = {}
        self._lock = asyncio.Lock()
        self._hits = 0
        self._coalesced = 0

    def _make_key(
        self,
        prompt: str,
        model: str,
        temperature: float,
        max_tokens: int,
        system_prompt: Optional[str] = None,
    ) -> str:
        """Create a deterministic coalescing key."""
        normalized = " ".join(prompt.split()).strip().lower()
        content = f"{normalized}:{model}:{temperature}:{max_tokens}"
        if system_prompt:
            content += f":{hashlib.sha256(system_prompt.encode()).hexdigest()[:16]}"
        return hashlib.sha256(content.encode()).hexdigest()

    async def execute(
        self,
        prompt: str,
        model: str,
        temperature: float = 0.7,
        max_tokens: int = 4096,
        system_prompt: Optional[str] = None,
        call_fn=None,
    ) -> LLMResponse:
        """Execute a deduplicated LLM call.

        If an identical request is already in flight within the window,
        wait for its result instead of making a new call.

        Args:
            call_fn: Async callable that performs the actual LLM call.
                     Must return an LLMResponse.
        """
        key = self._make_key(prompt, model, temperature, max_tokens, system_prompt)

        async with self._lock:
            now = time.time()
            # Clean up expired entries
            expired = [
                k for k, v in self._inflight.items()
                if (now - v.created_at) * 1000 > self.window_ms
            ]
            for k in expired:
                if not self._inflight[k].future.done():
                    self._inflight[k].future.cancel()
                del self._inflight[k]

            # Check if identical request is in flight
            if key in self._inflight:
                self._coalesced += 1
                future = self._inflight[key].future
                # Release lock before waiting on the future
                try:
                    return await future
                except asyncio.CancelledError:
                    raise

            # Create a new future for this request
            future = asyncio.get_event_loop().create_future()
            self._inflight[key] = _InflightRequest(
                future=future,
                created_at=now,
                key=key,
            )

        # We are the leader — perform the actual call (outside the lock)
        try:
            if call_fn is None:
                raise ValueError("call_fn is required for the leader request")
            result = await call_fn()
            future.set_result(result)
            return result
        except Exception as e:
            future.set_exception(e)
            raise
        finally:
            async with self._lock:
                self._inflight.pop(key, None)

    def get_stats(self) -> dict:
        """Return coalescing statistics."""
        return {
            "coalesced_requests": self._coalesced,
            "window_ms": self.window_ms,
            "active_inflight": len(self._inflight),
        }
