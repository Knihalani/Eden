"""Typesense client for span full-text search (Phase B).

Laminar parity: their "fast text search" surface is one of the 3
headline features on the landing page (transcript / SQL / search).
This module indexes every ingested span so users can grep across
all traces — input text, output text, tool names, agent IDs.

Why Typesense vs Postgres FTS or Elasticsearch?
  * Single binary, <50MB RAM at default scale → fits the existing
    Docker stack without a Java heap.
  * Native typo tolerance + faceting built in (no plugin chain).
  * Sub-50ms p95 even at 10M docs on commodity hardware.
  * HTTP API → no client-driver version-skew pain.

Schema (one collection ``eden_spans``):

    {
      "id":                "<tenant>:<event_id>",   # primary key
      "tenant_id":         "t-1",                    # filter
      "project_id":        "p-1",                    # filter
      "trace_id":          "tr-1",                   # filter + join
      "realm":             "production",             # filter
      "event_type":        "llm.completion",         # filter
      "agent_id":          "a-1",                    # filter (facet)
      "agent_version":     "0.1.0",
      "span_id":           "span-1",                 # join to PG
      "parent_span_id":    "span-0",                 # tree builder
      "name":              "tool.bash",              # filter (facet)
      "outcome":           "failure",                # filter (facet)
      "model":             "claude-opus-4-8",        # filter (facet)
      "input_text":        "the user's prompt...",   # full-text
      "output_text":       "the assistant's reply",  # full-text
      "tool_names":        ["bash", "read"],         # filter (facet)
      "tags":              ["failure", "retry"],     # filter
      "duration_ms":       1234,                     # sort
      "prompt_tokens":     250,                      # sort
      "completion_tokens": 500,                      # sort
      "cost_usd":          0.0123,                   # sort
      "created_at":        1747536000,               # filter + sort (epoch s)
    }

Per-org isolation: every filter expression forces
``tenant_id: <org>`` so cross-tenant data is unreachable
even if the search layer is misconfigured.

The client is best-effort: when Typesense is unreachable
(network error, startup race, missing API key) all methods
return safe no-op values instead of raising. The trace view
falls back to Postgres in those cases.
"""

from __future__ import annotations

import json
import logging
import time
from collections.abc import Iterable
from typing import Any

logger = logging.getLogger(__name__)

# Single source of truth for the span schema. The fields used for
# ``q`` (full-text search) are weighted: input_text gets a higher
# weight than output_text so a query like "python3" surfaces
# spans where the user asked about it before spans where the
# assistant mentioned it in passing.
SPAN_SCHEMA: dict[str, Any] = {
    "name": "eden_spans",
    "fields": [
        {"name": "tenant_id", "type": "string", "facet": True},
        {"name": "project_id", "type": "string", "facet": True},
        {"name": "trace_id", "type": "string", "facet": True},
        {"name": "realm", "type": "string", "facet": True},
        {"name": "event_type", "type": "string", "facet": True},
        {"name": "agent_id", "type": "string", "facet": True, "optional": True},
        {"name": "agent_version", "type": "string", "optional": True},
        {"name": "span_id", "type": "string", "optional": True},
        {"name": "parent_span_id", "type": "string", "optional": True},
        {"name": "name", "type": "string", "facet": True, "optional": True},
        {"name": "outcome", "type": "string", "facet": True, "optional": True},
        {"name": "model", "type": "string", "facet": True, "optional": True},
        {"name": "input_text", "type": "string", "optional": True},
        {"name": "output_text", "type": "string", "optional": True},
        {"name": "tool_names", "type": "string[]", "facet": True, "optional": True},
        {"name": "tags", "type": "string[]", "facet": True, "optional": True},
        {"name": "duration_ms", "type": "float", "optional": True},
        {"name": "prompt_tokens", "type": "int32", "optional": True},
        {"name": "completion_tokens", "type": "int32", "optional": True},
        {"name": "cost_usd", "type": "float", "optional": True},
        {"name": "created_at", "type": "int64", "optional": True},
    ],
    "default_sorting_field": "created_at",
}

# Max payload size Typesense accepts per document. We truncate the
# input/output text fields to stay well below this on the safe side.
_MAX_TEXT_CHARS = 8_000


def _extract_text(payload: dict[str, Any] | None) -> str:
    """Best-effort text extraction from a request/response body.

    Used by the collector to populate ``input_text`` / ``output_text``
    for indexing. We don't try to be perfect — a rough concatenation
    of all string values is enough for full-text recall.
    """
    if not isinstance(payload, dict):
        return ""
    parts: list[str] = []
    for key in ("messages", "prompt", "input", "content", "system"):
        v = payload.get(key)
        if isinstance(v, str):
            parts.append(v)
        elif isinstance(v, list):
            for item in v:
                if isinstance(item, dict):
                    c = item.get("content")
                    if isinstance(c, str):
                        parts.append(c)
                    elif isinstance(c, list):
                        for sub in c:
                            if isinstance(sub, dict) and isinstance(sub.get("text"), str):
                                parts.append(sub["text"])
    choices = payload.get("choices")
    if isinstance(choices, list):
        for ch in choices:
            if isinstance(ch, dict):
                msg = ch.get("message")
                if isinstance(msg, dict):
                    c = msg.get("content")
                    if isinstance(c, str):
                        parts.append(c)
    text = " ".join(parts)
    if len(text) > _MAX_TEXT_CHARS:
        text = text[:_MAX_TEXT_CHARS]
    return text


def _extract_tool_names(event_attrs: dict[str, Any], payload: dict[str, Any] | None) -> list[str]:
    """Pull tool names from event attributes and payload."""
    names: list[str] = []
    attr_tools = event_attrs.get("tool_names") if isinstance(event_attrs, dict) else None
    if isinstance(attr_tools, list):
        for t in attr_tools:
            if isinstance(t, str):
                names.append(t)
    if payload and isinstance(payload, dict):
        for msg in payload.get("messages") or []:
            if isinstance(msg, dict):
                tcs = msg.get("tool_calls")
                if isinstance(tcs, list):
                    for tc in tcs:
                        if isinstance(tc, dict):
                            fn = tc.get("function")
                            if isinstance(fn, dict) and isinstance(fn.get("name"), str):
                                names.append(fn["name"])
                            elif isinstance(tc.get("name"), str):
                                names.append(tc["name"])
        # tool_calls_full is the Eden-canonical form already
        tcf = payload.get("tool_calls_full")
        if isinstance(tcf, list):
            for tc in tcf:
                if isinstance(tc, dict) and isinstance(tc.get("name"), str):
                    names.append(tc["name"])
    # De-dupe while preserving order
    seen: set[str] = set()
    out: list[str] = []
    for n in names:
        if n not in seen:
            seen.add(n)
            out.append(n)
    return out


def build_span_doc(event: Any) -> dict[str, Any]:
    """Convert a ``TelemetryEvent`` to a Typesense document.

    Pure function — easy to unit-test. Used by the collector's
    5th sink AND by the search service's reindex utility.
    """
    # Imports kept inline to avoid a circular import cycle with
    # eden.observability.telemetry_collector.
    from eden.observability.telemetry_collector import TelemetryEvent

    if not isinstance(event, TelemetryEvent):
        raise TypeError(f"expected TelemetryEvent, got {type(event).__name__}")

    # Timestamp → epoch seconds (Typesense int64 sort field).
    created_at = int(time.time())
    if isinstance(event.timestamp, str):
        try:
            from datetime import datetime
            ts = datetime.fromisoformat(event.timestamp.replace("Z", "+00:00"))
            created_at = int(ts.timestamp())
        except Exception:
            pass

    metrics = event.metrics if isinstance(event.metrics, dict) else {}
    cost = metrics.get("cost_usd") or metrics.get("_cost_usd") or 0.0
    ptoks = int(metrics.get("prompt_tokens") or metrics.get("_prompt_tokens") or 0)
    ctoks = int(metrics.get("completion_tokens") or metrics.get("_completion_tokens") or 0)

    input_text = _extract_text(event.request_body)
    output_text = _extract_text(event.response_body)

    # PII redaction before index — Wave 1 fail-closed: masker exceptions
    # refuse the document (raise) so unmasked PII is never indexed.
    # Tenant policy is resolved when ``event.tenant_id`` is present.
    try:
        from eden.data_platform.pii import PIIMasker, PIIMaskingError, PIIPolicy

        policy = PIIPolicy()
        tenant = getattr(event, "tenant_id", None) or ""
        if tenant:
            try:
                from eden.observability.ingestion.pii_policy import resolve_policy_sync

                policy = resolve_policy_sync(tenant) or policy
            except Exception:
                # Sync resolver may be unavailable; keep default policy.
                pass
        _masker = PIIMasker(policy=policy)
        if input_text:
            _masked = _masker.mask(input_text)
            input_text = _masked if isinstance(_masked, str) else input_text
        if output_text:
            _masked = _masker.mask(output_text)
            output_text = _masked if isinstance(_masked, str) else output_text
    except Exception as _pii_exc:
        from eden.data_platform.pii import PIIMaskingError

        if isinstance(_pii_exc, PIIMaskingError):
            raise
        logger.warning(
            "Typesense PII mask failed; refusing index for tenant=%s: %s",
            getattr(event, "tenant_id", None),
            _pii_exc,
        )
        raise

    attrs = event.attributes if isinstance(event.attributes, dict) else {}
    tool_names = _extract_tool_names(attrs, event.request_body)
    # Also surface tools from the top-level ``tool_calls_full`` field —
    # some decoders (Anthropic, OpenHands) populate that list directly
    # rather than embedding it in ``request_body``. De-dup against
    # the payload-derived list to avoid duplicate entries.
    for tc in event.tool_calls_full or []:
        if isinstance(tc, dict) and isinstance(tc.get("name"), str):
            if tc["name"] not in tool_names:
                tool_names.append(tc["name"])

    return {
        "id": f"{event.tenant_id}:{event.event_id}",
        "tenant_id": event.tenant_id,
        "project_id": event.project_id,
        "trace_id": event.trace_id,
        "realm": event.realm,
        "event_type": event.event_type,
        "agent_id": event.agent_id or "",
        "agent_version": event.agent_version or "",
        "span_id": event.span_id or "",
        "parent_span_id": event.parent_span_id or "",
        "name": event.name or event.event_type,
        "outcome": event.outcome or "",
        "model": attrs.get("model", "") if isinstance(attrs, dict) else "",
        "input_text": input_text,
        "output_text": output_text,
        "tool_names": tool_names,
        "tags": list(event.tags) if event.tags else [],
        "duration_ms": float(event.duration_ms or 0.0),
        "prompt_tokens": ptoks,
        "completion_tokens": ctoks,
        "cost_usd": float(cost or 0.0),
        "created_at": created_at,
    }


class TypesenseClient:
    """Thin async wrapper over the Typesense HTTP API.

    Uses :mod:`aiohttp` (already a project dep — see
    ``pyproject.toml``) to avoid adding a third-party Typesense
    SDK that lags the server's API surface. Every method is
    best-effort: a network error is logged at warning level and
    the method returns a safe default (``None`` or ``[]``).

    The client is process-wide singleton; ``get_typesense_client()``
    is the canonical accessor.

    Methods:

      * :meth:`ensure_collection` — create the ``eden_spans``
        collection if absent. Idempotent.
      * :meth:`index_span` / :meth:`index_many` — write docs.
      * :meth:`delete_span` — remove by id (used on trace cleanup).
      * :meth:`delete_trace` — bulk delete by trace_id filter.
      * :meth:`health` — for the docker healthcheck + tests.
    """

    name = "typesense_client"

    def __init__(self, *, host: str, port: int, api_key: str,
                 protocol: str = "http",
                 collection: str = "eden_spans",
                 timeout_s: float = 5.0) -> None:
        self._host = host
        self._port = port
        self._api_key = api_key
        self._protocol = protocol
        self._collection = collection
        self._timeout_s = timeout_s
        self._session: Any = None
        self._schema_ready = False
        # Circuit breaker: open after consecutive failures, exponential
        # backoff up to ``_max_backoff_s``, then half-open probe.
        self._last_failure: float | None = None
        self._failure_count: int = 0
        self._open_until: float = 0.0
        self._backoff_s: float = 5.0
        self._max_backoff_s: float = 60.0
        self._failure_threshold: int = 3

    @property
    def base_url(self) -> str:
        return f"{self._protocol}://{self._host}:{self._port}"

    async def _get_session(self) -> Any:
        if self._session is None or self._session.closed:
            try:
                import aiohttp
                # ``allow_redirects=False`` keeps a future re-target of
                # Typesense (e.g. operator misconfiguration pointing at
                # a user-supplied URL) from being coerced into following
                # a 30x into a private-IP endpoint — aiohttp has no
                # built-in SSRF guard at redirect time.
                self._session = aiohttp.ClientSession(
                    timeout=aiohttp.ClientTimeout(total=self._timeout_s),
                    headers={"X-TYPESENSE-API-KEY": self._api_key},
                    allow_redirects=False,
                )
            except Exception as exc:
                logger.warning(f"Typesense: aiohttp unavailable: {exc}")
        return self._session

    async def close(self) -> None:
        if self._session is not None and not self._session.closed:
            await self._session.close()
        self._session = None

    def _is_reachable(self) -> bool:
        # Closed / half-open: allow traffic once ``_open_until`` elapses.
        return time.time() >= self._open_until

    def _record_success(self) -> None:
        self._failure_count = 0
        self._open_until = 0.0
        self._last_failure = None

    def _record_failure(self) -> None:
        self._last_failure = time.time()
        self._failure_count += 1
        if self._failure_count < self._failure_threshold:
            return
        # Exponential backoff after threshold; half-open when timer elapses.
        exp = self._failure_count - self._failure_threshold
        delay = min(self._backoff_s * (2**exp), self._max_backoff_s)
        self._open_until = time.time() + delay

    async def _request(self, method: str, path: str, *,
                       json_body: Any = None,
                       params: dict[str, Any] | None = None) -> tuple[int, Any]:
        """Low-level HTTP helper. Returns ``(status_code, parsed_json_or_text)``.

        Catches all network exceptions and records them on the
        circuit breaker so we don't spam retries when Typesense
        is down. Returns ``(0, None)`` on network failure.
        """
        if not self._is_reachable():
            return 0, None
        session = await self._get_session()
        if session is None:
            return 0, None
        url = f"{self.base_url}{path}"
        try:
            async with session.request(
                method, url, json=json_body, params=params,
            ) as resp:
                text = await resp.text()
                try:
                    body: Any = json.loads(text) if text else None
                except json.JSONDecodeError:
                    body = text
                if resp.status >= 500:
                    self._record_failure()
                else:
                    self._record_success()
                return resp.status, body
        except Exception as exc:
            logger.debug(f"Typesense {method} {path} failed: {exc}")
            self._record_failure()
            return 0, None

    # ── Schema ─────────────────────────────────────────────────────

    async def ensure_collection(self) -> bool:
        """Create the spans collection if absent. Idempotent."""
        status, body = await self._request("GET", f"/collections/{self._collection}")
        if status == 200:
            self._schema_ready = True
            return True
        if status == 404:
            status, body = await self._request(
                "POST", "/collections", json_body=SPAN_SCHEMA,
            )
            if status in (200, 201):
                self._schema_ready = True
                logger.info(f"Typesense: created collection {self._collection}")
                return True
            logger.warning(f"Typesense: create collection failed: {status} {body}")
            return False
        logger.warning(f"Typesense: unexpected status {status} on GET collection")
        return False

    # ── Write ──────────────────────────────────────────────────────

    async def index_span(self, doc: dict[str, Any]) -> bool:
        """Upsert a single span doc."""
        if not self._schema_ready:
            await self.ensure_collection()
        status, body = await self._request(
            "POST",
            f"/collections/{self._collection}/documents?action=upsert",
            json_body=doc,
        )
        return status in (200, 201)

    async def index_many(self, docs: Iterable[dict[str, Any]]) -> int:
        """Bulk-upsert. Returns count successfully indexed.

        Uses Typesense's ``/documents/import?action=upsert`` endpoint
        which accepts newline-delimited JSON and returns one result
        per line. ``return_score=false`` skips the per-doc score
        payload (cheaper).
        """
        if not self._schema_ready:
            await self.ensure_collection()
        body = "\n".join(json.dumps(d, default=str) for d in docs)
        if not body:
            return 0
        session = await self._get_session()
        if session is None:
            return 0
        if not self._is_reachable():
            return 0
        url = (
            f"{self.base_url}/collections/{self._collection}"
            f"/documents/import?action=upsert&return_score=false"
        )
        try:
            async with session.post(url, data=body,
                                    headers={"Content-Type": "text/plain"}) as resp:
                text = await resp.text()
                # Each line is "OK" or '{"success":false,...}'
                ok = 0
                for line in text.splitlines():
                    if line.strip() == "OK":
                        ok += 1
                return ok
        except Exception as exc:
            logger.debug(f"Typesense bulk import failed: {exc}")
            self._last_failure = time.time()
            return 0

    async def delete_span(self, doc_id: str) -> bool:
        status, _ = await self._request(
            "DELETE", f"/collections/{self._collection}/documents/{doc_id}",
        )
        return status in (200, 201, 202)

    async def delete_older_than(self, cutoff_epoch_s: int) -> int:
        """Delete all docs with ``created_at`` older than ``cutoff_epoch_s``.

        Used by the 90-day TTL cleanup cron job. Returns the number of
        docs deleted, or 0 on Typesense failure. Best-effort; does not
        raise.
        """
        flt = f"created_at:<={cutoff_epoch_s}"
        status, body = await self._request(
            "DELETE",
            f"/collections/{self._collection}/documents",
            params={"filter_by": flt},
        )
        if status in (200, 201, 202) and isinstance(body, dict):
            deleted = int(body.get("num_deleted", 0))
            logger.info(
                "Typesense TTL cleanup: deleted %d docs older than epoch %d",
                deleted,
                cutoff_epoch_s,
            )
            return deleted
        return 0

    async def delete_trace(self, tenant_id: str, trace_id: str) -> int:
        """Bulk-delete all spans for a trace via filter expression.

        Returns the number of docs deleted (0 on Typesense failure).
        The ``filter_by`` syntax is ``tenant_id:='x' && trace_id:='y'``.
        """
        flt = f"tenant_id:={tenant_id} && trace_id:={trace_id}"
        return await self.delete_by_filter(flt)

    async def delete_by_filter(self, filter_by: str) -> int:
        """Bulk-delete docs matching a Typesense ``filter_by`` expression."""
        status, body = await self._request(
            "DELETE",
            f"/collections/{self._collection}/documents",
            params={"filter_by": filter_by},
        )
        if status in (200, 201, 202) and isinstance(body, dict):
            return int(body.get("num_deleted", 0))
        return 0

    async def delete_by_user(self, tenant_id: str, user_id: str) -> int:
        """RTBF: delete spans attributed to ``user_id`` within a tenant."""
        flt = f"tenant_id:={tenant_id} && user_id:={user_id}"
        return await self.delete_by_filter(flt)

    # ── Health ─────────────────────────────────────────────────────

    async def health(self) -> bool:
        """Return True if Typesense responds to ``/health``."""
        session = await self._get_session()
        if session is None:
            return False
        if not self._is_reachable():
            return False
        try:
            async with session.get(f"{self.base_url}/health") as resp:
                return resp.status == 200
        except Exception:
            return False


# ── Singleton accessor ──────────────────────────────────────────────

_typesense_client: TypesenseClient | None = None


def get_typesense_client() -> TypesenseClient | None:
    """Return the process-wide Typesense client, or ``None`` if disabled.

    Reads connection info from :class:`eden.config.Settings`. Returns
    ``None`` (not a stub object) when Typesense is disabled in
    Settings, so callers can use ``if client is None: return``
    without a try/except.
    """
    global _typesense_client
    if _typesense_client is not None:
        return _typesense_client

    # Lazy import to avoid pulling Settings at module-import time
    # (Settings reads env vars and is heavy).
    try:
        from eden.config import get_settings
        s = get_settings()
    except Exception as exc:
        logger.debug(f"Typesense: settings unavailable: {exc}")
        return None

    if not getattr(s, "typesense_enabled", True):
        return None
    if not getattr(s, "typesense_api_key", ""):
        logger.debug("Typesense: no API key configured, skipping client")
        return None

    client = TypesenseClient(
        host=getattr(s, "typesense_host", "localhost"),
        port=int(getattr(s, "typesense_port", 8108)),
        api_key=s.typesense_api_key,
        protocol=getattr(s, "typesense_protocol", "http"),
        collection=getattr(s, "typesense_collection", "eden_spans"),
    )
    _typesense_client = client
    return client


async def close_typesense_client() -> None:
    global _typesense_client
    if _typesense_client is not None:
        await _typesense_client.close()
        _typesense_client = None
