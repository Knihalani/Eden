"""Hermes loads ``register(ctx)`` from here; the plugin itself is ``eden_client.hermes`` (pip install the Eden Python
client into Hermes' environment first). Configuration: EDEN_USER_ID (required), EDEN_URL, EDEN_API_KEY,
EDEN_TENANT_ID, EDEN_CHECK_TOOLS. See docs/INTEGRATION.md, "Hermes Agent"."""

from eden_client.hermes import register  # noqa: F401
