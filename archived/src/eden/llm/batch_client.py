"""Anthropic Messages Batch API client (OOM W4-3 / L12).

Offline lanes (CLHF metric generation, synthetic data, rubric synthesis) are
eligible for a 50% cost discount when routed Anthropic-direct via the Messages
Batches API instead of the real-time Messages API.  This module provides a
minimal, self-contained client that covers the full batch lifecycle:

  1. ``submit``  — POST /v1/messages/batches with a list of requests.
  2. ``poll``    — GET  /v1/messages/batches/{id} until status is terminal.
  3. ``results`` — GET  /v1/messages/batches/{id}/results (NDJSON stream).
  4. ``run``     — convenience: submit → poll → results in one call.

The client is intentionally thin — it uses ``httpx`` directly rather than the
Anthropic SDK so the single dependency (already present for other reasons) is
sufficient.  Authentication uses ``settings.anthropic_api_key``; when the key
is empty the module is *disabled* — every call raises
``BatchClientDisabledError`` so callers can gracefully fall back to the normal
real-time path.

Reference integration
---------------------
``RubricSynthesiser.from_examples`` (``eden.metric_studio.synthesiser``) is
wired to optionally use this client when
``settings.rubric_synthesis_batch_v1 = True`` **and**
``settings.anthropic_api_key`` is non-empty.  This gate defaults to ``False``
so production behaviour is unchanged until the flag is flipped.

Usage (offline lane)::

    from eden.llm.batch_client import AnthropicBatchClient, BatchRequest

    client = AnthropicBatchClient()        # reads settings automatically
    requests = [
        BatchRequest(
            custom_id="req-0",
            model="claude-haiku-4-5",
            max_tokens=512,
            messages=[{"role": "user", "content": "Hello"}],
        ),
    ]
    results = await client.run(requests, poll_interval=5.0)
    for r in results:
        print(r["custom_id"], r.get("content"))

See ``docs/specs/OOM-IMPROVEMENT-PLAN-2026-08-12.md`` §7.6 / L12.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

# Anthropic Messages Batches API base URL and version header.
_BASE_URL = "https://api.anthropic.com"
_ANTHROPIC_VERSION = "2023-06-01"
_BATCHES_PATH = "/v1/messages/batches"

# Terminal statuses from the Anthropic API spec.
_TERMINAL_STATUSES = frozenset({"ended"})

# Default poll interval (seconds) and maximum number of poll attempts before
# giving up with a TimeoutError.  A batch that contains <100 requests usually
# completes within a few minutes.
_DEFAULT_POLL_INTERVAL = 60.0
_DEFAULT_MAX_POLLS = 120  # 2 hours at 60 s intervals


class BatchClientDisabledError(RuntimeError):
    """Raised when the Anthropic Batch client is used without an API key.

    Callers should catch this and fall back to the normal real-time path.
    """


class BatchTimeoutError(TimeoutError):
    """Raised when a batch does not reach a terminal status within the
    configured number of poll attempts."""


@dataclass
class BatchRequest:
    """A single request to include in a Messages Batch.

    ``custom_id`` is an opaque string echoed back in every result row so
    callers can correlate responses without relying on ordering.
    """

    custom_id: str
    model: str
    max_tokens: int
    messages: list[dict[str, Any]]
    system: str | None = None
    temperature: float | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_api_dict(self) -> dict[str, Any]:
        """Serialise to the shape expected by POST /v1/messages/batches."""
        params: dict[str, Any] = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            "messages": self.messages,
        }
        if self.system:
            params["system"] = self.system
        if self.temperature is not None:
            params["temperature"] = self.temperature
        return {
            "custom_id": self.custom_id,
            "params": params,
        }


class AnthropicBatchClient:
    """Minimal Anthropic Messages Batches API client.

    Reads ``settings.anthropic_api_key`` at construction time.  If the key is
    empty the instance is in *disabled* mode and every method raises
    ``BatchClientDisabledError``.
    """

    def __init__(self, api_key: str | None = None) -> None:
        if api_key is None:
            try:
                from eden.config import get_settings

                api_key = (get_settings().anthropic_api_key or "").strip()
            except Exception:
                api_key = ""
        self._api_key = api_key or ""
        self._disabled = not self._api_key

    # ── internal helpers ──────────────────────────────────────────────────

    def _headers(self) -> dict[str, str]:
        return {
            "x-api-key": self._api_key,
            "anthropic-version": _ANTHROPIC_VERSION,
            "content-type": "application/json",
        }

    def _require_enabled(self) -> None:
        if self._disabled:
            raise BatchClientDisabledError(
                "AnthropicBatchClient is disabled: settings.anthropic_api_key "
                "is empty.  Set ANTHROPIC_API_KEY to enable Batch API usage."
            )

    # ── public API ────────────────────────────────────────────────────────

    async def submit(self, requests: list[BatchRequest]) -> str:
        """Submit a batch and return the batch ID.

        Args:
            requests: One or more :class:`BatchRequest` objects.  The Anthropic
                API accepts up to 10,000 requests per batch.

        Returns:
            The opaque ``batch_id`` string (e.g. ``"msgbatch_01abc..."``).

        Raises:
            BatchClientDisabledError: if ``api_key`` is empty.
            httpx.HTTPStatusError: on a non-2xx response from the API.
        """
        self._require_enabled()
        import httpx

        body = {"requests": [r.to_api_dict() for r in requests]}
        async with httpx.AsyncClient(base_url=_BASE_URL, timeout=30.0) as client:
            resp = client.post(
                _BATCHES_PATH,
                headers=self._headers(),
                json=body,
            )
            # Support both sync and async httpx clients in tests.
            if asyncio.iscoroutine(resp):
                resp = await resp
            resp.raise_for_status()
            data = resp.json()
        batch_id: str = data["id"]
        logger.info("batch_client: submitted batch %s (%d requests)", batch_id, len(requests))
        return batch_id

    async def poll(
        self,
        batch_id: str,
        *,
        poll_interval: float = _DEFAULT_POLL_INTERVAL,
        max_polls: int = _DEFAULT_MAX_POLLS,
    ) -> dict[str, Any]:
        """Poll until the batch reaches a terminal status.

        Args:
            batch_id: Returned by :meth:`submit`.
            poll_interval: Seconds between status checks.
            max_polls: Raise :class:`BatchTimeoutError` after this many polls.

        Returns:
            The final batch status object from the API.

        Raises:
            BatchClientDisabledError: if ``api_key`` is empty.
            BatchTimeoutError: if the batch does not finish in time.
            httpx.HTTPStatusError: on a non-2xx response.
        """
        self._require_enabled()
        import httpx

        for attempt in range(max_polls):
            async with httpx.AsyncClient(base_url=_BASE_URL, timeout=15.0) as client:
                resp = client.get(
                    f"{_BATCHES_PATH}/{batch_id}",
                    headers=self._headers(),
                )
                if asyncio.iscoroutine(resp):
                    resp = await resp
                resp.raise_for_status()
                data = resp.json()
            status: str = data.get("processing_status", "")
            logger.debug(
                "batch_client: poll %d/%d batch=%s status=%s",
                attempt + 1,
                max_polls,
                batch_id,
                status,
            )
            if status in _TERMINAL_STATUSES:
                return data
            await asyncio.sleep(poll_interval)

        raise BatchTimeoutError(
            f"Batch {batch_id!r} did not finish after {max_polls} polls "
            f"(~{max_polls * poll_interval / 60:.0f} min)."
        )

    async def results(self, batch_id: str) -> list[dict[str, Any]]:
        """Fetch and parse all result rows for a completed batch.

        The Anthropic API returns NDJSON (one JSON object per line).  Each
        object has the shape::

            {
                "custom_id": "req-0",
                "result": {
                    "type": "succeeded" | "errored" | "expired",
                    "message": { ... }   # present on "succeeded"
                    "error": { ... }     # present on "errored"
                }
            }

        This method flattens the result into dicts with the following keys for
        convenience:

        - ``custom_id``: the caller-supplied ID.
        - ``status``: ``"succeeded"`` | ``"errored"`` | ``"expired"``.
        - ``content``: first text content block, or ``None`` on non-success.
        - ``error``: error object on ``"errored"``, else ``None``.
        - ``raw``: the full raw row dict.

        Args:
            batch_id: The batch whose results to fetch.

        Returns:
            List of flattened result dicts, one per request.

        Raises:
            BatchClientDisabledError: if ``api_key`` is empty.
            httpx.HTTPStatusError: on a non-2xx response.
        """
        self._require_enabled()
        import httpx

        async with httpx.AsyncClient(base_url=_BASE_URL, timeout=60.0) as client:
            resp = client.get(
                f"{_BATCHES_PATH}/{batch_id}/results",
                headers=self._headers(),
            )
            if asyncio.iscoroutine(resp):
                resp = await resp
            resp.raise_for_status()
            raw_text: str = resp.text

        out: list[dict[str, Any]] = []
        for line in raw_text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                import json

                row: dict[str, Any] = json.loads(line)
            except Exception:
                logger.warning("batch_client: malformed NDJSON line: %r", line[:120])
                continue
            result = row.get("result") or {}
            status = result.get("type", "unknown")
            content: str | None = None
            if status == "succeeded":
                message = result.get("message") or {}
                for block in message.get("content", []):
                    if isinstance(block, dict) and block.get("type") == "text":
                        content = block.get("text")
                        break
            out.append(
                {
                    "custom_id": row.get("custom_id"),
                    "status": status,
                    "content": content,
                    "error": result.get("error") if status == "errored" else None,
                    "raw": row,
                }
            )
        logger.info(
            "batch_client: fetched %d results for batch %s", len(out), batch_id
        )
        return out

    async def run(
        self,
        requests: list[BatchRequest],
        *,
        poll_interval: float = _DEFAULT_POLL_INTERVAL,
        max_polls: int = _DEFAULT_MAX_POLLS,
    ) -> list[dict[str, Any]]:
        """Submit, poll, and collect results in one call.

        Convenience wrapper around :meth:`submit` + :meth:`poll` +
        :meth:`results`.  Suitable for offline callers that block on the full
        lifecycle.

        Returns:
            The same list as :meth:`results`.
        """
        batch_id = await self.submit(requests)
        await self.poll(batch_id, poll_interval=poll_interval, max_polls=max_polls)
        return await self.results(batch_id)
