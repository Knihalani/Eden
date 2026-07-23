"""Third-party integrations for Eden.

Each integration (Langfuse, W&B, GitHub Action, Runloop, Helicone,
LangSmith, …) lives in its own subpackage. All integrations are
versioned via ``INTEGRATION_API_VERSION`` so a future breaking
change can ship a v2 without breaking existing customers.

Versioning policy
-----------------

* **Source-of-truth for version** — each integration reads
  ``INTEGRATION_API_VERSION`` from this module and pins the version
  in the payload it sends (HTTP header ``X-Eden-Integration-Version``,
  webhook event field ``integration_version``, etc.).
* **Backwards compatibility** — adding fields, adding new endpoints,
  or adding new event types is non-breaking and does not require a
  version bump. Removing a field, renaming a field, or changing
  authentication scheme IS breaking and requires v2.
* **Customer notification** — when the version is bumped, the
  release notes and ``docs/integrations/versioning.md`` MUST be
  updated. Customers are notified via the standard Eden changelog
  at least 30 days before the old version stops being accepted.
* **Per-integration overrides** — an integration that needs its own
  versioning (e.g. a third-party SDK pinned to a specific schema
  version) MAY declare ``INTEGRATION_API_VERSION = "1"`` locally and
  pin via the ``x-eden-integration-version`` header on outbound
  requests, but should still re-export the constant from here.

Closed risks
------------

* R2 (Langfuse/Runloop ship without a versioning story) — this
  module is the answer. Every integration is expected to read
  ``INTEGRATION_API_VERSION`` rather than hard-coding "1".
"""
from __future__ import annotations

# Bump this on any breaking change to the integration surface
# (see policy above). Non-breaking changes do NOT bump this.
INTEGRATION_API_VERSION: str = "1"

# Outbound header name. Incoming webhooks from Eden to customers
# also include this header so customers can pin to a specific
# integration surface.
INTEGRATION_VERSION_HEADER: str = "X-Eden-Integration-Version"

# Supported integration identifiers. Used by /integrations endpoint
# to enumerate which integrations are wired up.
SUPPORTED_INTEGRATIONS: tuple[str, ...] = (
    "helicone",
    "wandb",
    "langfuse",
    "langsmith",
    "runloop",
    "github_action",
    "support_webhook",
)


def integration_version_header_value() -> str:
    """Return the value to use for ``X-Eden-Integration-Version``."""
    return INTEGRATION_API_VERSION


__all__ = [
    "INTEGRATION_API_VERSION",
    "INTEGRATION_VERSION_HEADER",
    "SUPPORTED_INTEGRATIONS",
    "integration_version_header_value",
]
