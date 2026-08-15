"""W&B Weave integration for Eden.

See :mod:`eden.integrations.wandb.weave` for the client, and
:mod:`eden.api.routes.integrations_wandb` for the HTTP surface.
"""
from __future__ import annotations

from eden.integrations.wandb.weave import (
    WeaveClient,
    WeaveTracePayload,
    fan_out_bronze_event,
    from_bronze_event,
)

__all__ = ["WeaveClient", "WeaveTracePayload", "fan_out_bronze_event", "from_bronze_event"]
