"""Hermes entry point: prefer vendored ``eden_client``, else the installed package. Local mode discovers
``bin/eden-local`` beside this file; set EDEN_URL for hosted mode (then EDEN_USER_ID is required).
Configuration and profile-isolation rules: ``eden_client.hermes`` and docs/INTEGRATION.md, "Hermes Agent".
"""

try:
    from .eden_client.hermes import register as _r
except ImportError:
    from eden_client.hermes import register as _r


def register(ctx):
    _r(ctx, plugin_file=__file__)
