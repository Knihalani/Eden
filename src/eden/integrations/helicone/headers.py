"""Per-request Helicone headers.

Helicone uses a fixed set of HTTP headers for routing, attribution,
and observability. This module centralises the header construction
so the LLM client doesn't have to know about Helicone's
schema.

Refs:
  - https://docs.helicone.ai/features/advanced-usage/custom-properties
  - https://docs.helicone.ai/features/advanced-usage/caching
"""
from __future__ import annotations

from typing import Any


def helicone_headers(
    *,
    user_id: str | None = None,
    org_id: str | None = None,
    job_id: str | None = None,
    cache_enabled: bool = False,
    cache_bucket: str | None = None,
    properties: dict[str, Any] | None = None,
) -> dict[str, str]:
    """Build the set of Helicone-specific request headers.

    All values are coerced to ``str`` so the dict is safe to splat
    into an httpx request. Unknown / falsy inputs are skipped.
    """
    headers: dict[str, str] = {}
    if user_id:
        headers["Helicone-User-Id"] = str(user_id)
    if org_id:
        headers["Helicone-Property-OrgId"] = str(org_id)
    if job_id:
        headers["Helicone-Property-JobId"] = str(job_id)
    if cache_enabled:
        headers["Helicone-Cache-Enabled"] = "true"
    if cache_bucket:
        headers["Helicone-Cache-Bucket"] = str(cache_bucket)
    if properties:
        for key, value in properties.items():
            # Helicone reserves the ``Helicone-`` prefix for its own
            # headers. To prevent user-defined keys from colliding
            # with Helicone internals, every property goes under
            # ``Helicone-Property-`` — including ones the caller
            # already namespaced (so ``Helicone-Foo`` becomes
            # ``Helicone-Property-Helicone-Foo`` rather than being
            # passed through and risking collision with a future
            # Helicone header).
            headers[f"Helicone-Property-{key}"] = str(value)
    return headers


__all__ = ["helicone_headers"]
