"""Helicone integration.

Helicone is an OpenAI-compatible proxy that records LLM usage,
costs, and traces. When ``helicone_api_key`` is configured,
Eden's OpenRouter-compatible client routes every request through
``https://oai.helicone.ai/v1`` so the customer gets Helicone's
observability without changing the LLM call site.

Components
----------

* :mod:`headers` — per-request attribution + cache headers.
* :mod:`sync` — cost-sync webhook consumer (Helicone → Eden).
* :mod:`route` — the FastAPI surface mounted at
  ``/integrations/helicone``.

Versioning
----------

All outbound calls and inbound webhooks include the
``X-Eden-Integration-Version`` header. See
:mod:`eden.integrations` for the policy.
"""
from __future__ import annotations

from eden.integrations import INTEGRATION_API_VERSION
from eden.integrations.helicone.headers import helicone_headers

__all__ = ["INTEGRATION_API_VERSION", "helicone_headers"]
