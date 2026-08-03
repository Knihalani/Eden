"""Request-side gzip decompression for a narrow set of ingest routes.

``GZipMiddleware`` (Starlette) only compresses *responses*; it has no
symmetric counterpart that decompresses `Content-Encoding: gzip`
*requests*. The main telemetry ingest routes
(``eden.api.routes.ingestion``) handle this themselves by reading the
raw request body and calling
``eden.observability.ingestion.providers.maybe_gunzip_body_async``
before decoding JSON.

Two newer ingest-shaped routers — agent-session lifecycle
(``eden.api.routes.ingest_agent_sessions``) and live trace streaming
(``eden.api.routes.observability_live``) — instead use typed Pydantic
``Body(...)`` parameters, which FastAPI parses as JSON *before* any
``Depends`` dependency runs (see ``fastapi.routing.get_request_handler``:
``body_bytes = await request.body()`` / ``await request.json()`` happens
ahead of ``solve_dependencies()``). That ordering means a
dependency-based hook can never intercept a gzip-compressed body in
time for those routes — by the time a dependency runs, FastAPI has
already tried and failed to ``json.loads`` the raw compressed bytes.

This middleware sits at the ASGI layer (ahead of routing entirely) and
transparently gunzips the request body for exactly those two routers,
so their SDKs can add ``Content-Encoding: gzip`` the same way the main
ingest path already does, without either router's endpoint signatures
(or the tests that call them directly with typed models) having to
change.

Scoped tightly by path substring so it can never touch the main
``/orgs/{org_id}/ingest/{format}`` telemetry routes, which already do
their own gunzip: decompressing here too would hand them already-plain
JSON still labelled ``Content-Encoding: gzip``, and their own gunzip
attempt would then raise ("Not a gzipped file").
"""

from __future__ import annotations

import logging

from starlette.types import ASGIApp, Message, Receive, Scope, Send

logger = logging.getLogger(__name__)

#: Path substrings this middleware applies to. Matched with ``in``, not
#: ``startswith``, because both routers are mounted under the
#: per-org-scoped prefix ``/orgs/{org_id}/...``.
_GZIP_DECODE_PATH_MARKERS = ("/ingest/agent-sessions", "/stream/traces")

_MUTATING_METHODS = ("POST", "PUT", "PATCH")


def _content_encoding(scope: Scope) -> str:
    for name, value in scope.get("headers") or ():
        if name == b"content-encoding":
            return str(value.decode("latin-1").lower())
    return ""


async def _buffer_body(receive: Receive) -> bytes:
    """Drain the full request body from the ASGI receive channel."""
    chunks: list[bytes] = []
    while True:
        message = await receive()
        if message["type"] != "http.request":
            continue
        chunks.append(message.get("body", b""))
        if not message.get("more_body", False):
            break
    return b"".join(chunks)


class GunzipRequestMiddleware:
    """Transparently gunzip ``Content-Encoding: gzip`` request bodies
    for the agent-session and live-trace-streaming ingest routers.

    No-op (and does not read the body at all) for every other path,
    every non-mutating method, and every request without a ``gzip``
    ``Content-Encoding`` — so the common case pays nothing beyond one
    header lookup and one path substring check.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = (scope.get("method") or "GET").upper()
        path = scope.get("path", "")
        if method not in _MUTATING_METHODS or not any(
            marker in path for marker in _GZIP_DECODE_PATH_MARKERS
        ):
            await self.app(scope, receive, send)
            return

        encoding = _content_encoding(scope)
        if "gzip" not in encoding:
            await self.app(scope, receive, send)
            return

        raw = await _buffer_body(receive)
        try:
            from eden.observability.ingestion.providers import (
                maybe_gunzip_body_async,
            )

            decoded = await maybe_gunzip_body_async(raw, "gzip")
        except Exception as exc:  # noqa: BLE001
            # Leave the body untouched — downstream JSON parsing will
            # raise a clear 400/422 rather than this middleware
            # swallowing a corrupt request silently.
            logger.warning("gunzip request middleware: decode failed: %s", exc)
            decoded = raw

        sent = False

        async def _replay_receive() -> Message:
            nonlocal sent
            if not sent:
                sent = True
                return {
                    "type": "http.request",
                    "body": decoded,
                    "more_body": False,
                }
            return {"type": "http.disconnect"}

        await self.app(scope, _replay_receive, send)
