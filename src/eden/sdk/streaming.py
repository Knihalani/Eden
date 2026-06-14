"""Server-Sent Events (SSE) streaming parser.

Converts an async text iterator into StreamEvent objects.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from eden.sdk.models import StreamEvent


class SSEStream:
    """Async iterator over SSE events."""

    def __init__(self, text_iterator: AsyncIterator[str]):
        self._iterator = text_iterator
        self._buffer = ""

    def __aiter__(self) -> SSEStream:
        return self

    async def __anext__(self) -> StreamEvent:
        while True:
            # Try to find a complete event in the buffer
            if "\n\n" in self._buffer:
                raw, self._buffer = self._buffer.split("\n\n", 1)
                event = self._parse_event(raw)
                if event:
                    return event
                continue

            # Need more data
            try:
                chunk = await self._iterator.__anext__()
                self._buffer += chunk
            except StopAsyncIteration:
                # Flush remaining buffer
                if self._buffer.strip():
                    event = self._parse_event(self._buffer)
                    self._buffer = ""
                    if event:
                        return event
                raise StopAsyncIteration from None

    def _parse_event(self, raw: str) -> StreamEvent | None:
        """Parse a single SSE event block."""
        lines = raw.strip().split("\n")
        event_type = "message"
        data_lines: list[str] = []

        for line in lines:
            if line.startswith("event:"):
                event_type = line[len("event:"):].strip()
            elif line.startswith("data:"):
                data_lines.append(line[len("data:"):].strip())
            elif line.startswith("id:"):
                pass  # We could track IDs for resume
            elif line.startswith(":"):
                pass  # Comment line

        if not data_lines:
            return None

        data_str = "\n".join(data_lines)
        try:
            data = json.loads(data_str)
        except json.JSONDecodeError:
            data = {"text": data_str}

        return StreamEvent(event=event_type, data=data)


async def stream_to_completion(
    stream: AsyncIterator[StreamEvent],
) -> dict[str, Any]:
    """Consume a stream until completion and return the final complete event.

    Useful for simple scripts that want blocking-style behaviour
    while still using the streaming endpoint under the hood.
    """
    final: dict[str, Any] = {}
    async for event in stream:
        if event.event == "complete":
            final = event.data
            break
    return final
