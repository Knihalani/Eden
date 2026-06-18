"""Tenant + project + auth attribution for ingested telemetry events.

``Attribution`` is the context object every decoder receives. It carries
the resolved tenant identity, the project scope, the upstream source
format, and the auth method that produced the request. Decoders stamp
these onto the ``TelemetryEvent`` they emit so the rest of the pipeline
(Postgres row, WebSocket fanout, detectors) can attribute correctly.

Resolution happens once per request, in the route handler, by combining:

- ``X-Org-Id`` + ``X-Org-Api-Key`` headers (programmatic / SDK / 3rd-party)
- Cookie JWT (browser / portal)
- ``X-Project-Id`` header (optional; defaults to ``"default"``)
- The URL path's ``{format}`` segment (the source format)

The new combined auth dependency in ``src/eden/api/deps.py`` (added in
the same Phase 0 batch) returns the same fields this dataclass expects.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Attribution:
    """Resolved tenant context for one ingest request.

    Attributes:
        tenant_id: The org the events belong to. Stamped onto every
            emitted ``TelemetryEvent.tenant_id``.
        project_id: The project scope. Stamped onto every
            ``TelemetryEvent.project_id``. Defaults to ``"default"`` when
            the request does not set ``X-Project-Id``.
        source_format: Which decoder is producing the events. Stamped
            onto every ``TelemetryEvent.source_format``. One of
            ``"otel" | "helicone" | "langfuse" | "openai" | "anthropic" |
            "bedrock" | "gemini" | "framework" | "webhook"``.
        user_id: The user identity, when the request is cookie-authed.
            ``None`` for API-key callers (service identity).
        api_key_id: The API key id, when the request is API-key-authed.
            ``None`` for cookie callers.
        auth_method: ``"api_key"`` or ``"cookie"`` — which path resolved
            the tenant. Useful for downstream audit logging.
        client_ip: Best-effort client IP from the request. For rate
            limit / abuse detection downstream.
    """

    tenant_id: str
    project_id: str = "default"
    source_format: str = "webhook"
    user_id: str | None = None
    api_key_id: str | None = None
    auth_method: str = "api_key"
    client_ip: str | None = None

    def with_source_format(self, source_format: str) -> Attribution:
        """Return a copy with the source format overridden. Useful when
        the route knows the format from the URL path but the decoder
        also writes it for clarity."""
        return Attribution(
            tenant_id=self.tenant_id,
            project_id=self.project_id,
            source_format=source_format,
            user_id=self.user_id,
            api_key_id=self.api_key_id,
            auth_method=self.auth_method,
            client_ip=self.client_ip,
        )
