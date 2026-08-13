"""Typed MCP errors that carry their own HTTP status.

Modelled on ``eden.observability.ingestion.errors``: a base exception with an
``http_status`` attribute, so the transport maps failures by type instead of
threading status codes through return values.
"""

from __future__ import annotations


class McpError(Exception):
    """Base for MCP transport errors."""

    http_status: int = 500
    #: Stable machine-readable code for the JSON-RPC error body.
    code: str = "mcp_error"

    def __init__(self, message: str = "") -> None:
        super().__init__(message or self.__class__.__name__)
        self.message = message or self.__class__.__name__


class McpAuthError(McpError):
    """Missing, unknown, or org-mismatched credentials."""

    http_status = 401
    code = "unauthorized"


class McpScopeError(McpError):
    """Authenticated, but the key lacks the scope this tool needs."""

    http_status = 403
    code = "forbidden"


class McpUnavailableError(McpError):
    """The request could not be served without weakening a guarantee.

    Used both when authentication machinery is unreachable and when an HTTP
    caller reaches a tool whose only implementation is a local Postgres
    fallback — answering it would bypass the API's authorization.
    """

    http_status = 503
    code = "service_unavailable"
