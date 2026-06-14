"""Runloop integration — alternative sandbox runner.

Runloop is a cloud sandbox provider (https://runloop.ai). Eden
supports a polymorphic :class:`eden.sandbox.runner.SandboxRunner`
contract; this module ships a Runloop-backed implementation so
operators can route env execution through Runloop's Devboxes
when Firecracker is unavailable (e.g., on a Mac dev machine or
in a hosted environment without nested-virt support).

The actual Runloop SDK is only imported when the integration is
enabled, so the dependency is optional. A no-op ``NullRunner``
is used when Runloop is disabled (matching the existing
``NullSandboxRunner`` pattern in ``eden.sandbox.runner``).
"""
from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass, field
from typing import Any

from eden.integrations import INTEGRATION_API_VERSION

logger = logging.getLogger(__name__)


@dataclass
class RunloopDevboxSpec:
    """A specification for a Runloop devbox that hosts an Eden env.

    Attributes
    ----------
    blueprint_id:
        Runloop's blueprint identifier (a saved container layout).
    name:
        Customer-visible name for the devbox.
    env_vars:
        Environment variables to set in the devbox (typically the
        same ones Eden would have set in a Firecracker VM).
    metadata:
        Free-form dict; serialised into the devbox label so Eden
        can find it again later.
    """

    blueprint_id: str
    name: str
    env_vars: dict[str, str] = field(default_factory=dict)
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class RunloopDevbox:
    id: str
    spec: RunloopDevboxSpec
    state: str = "starting"
    metadata: dict[str, Any] = field(default_factory=dict)


class RunloopClient:
    """Minimal Runloop client.

    Real Runloop SDK calls (``runloop.create_devbox``,
    ``runloop.exec``, etc.) are deferred behind a lazy import so
    the dependency is optional. When the SDK isn't installed or
    no API key is set, the runner is a no-op that logs a warning
    so dev environments without Runloop credentials still work.
    """

    def __init__(self, *, api_key: str = "", enabled: bool = False, sdk_module: str = "runloop"):
        self.api_key = api_key
        self.enabled = enabled
        self.sdk_module_name = sdk_module
        self._sdk: Any | None = None

    def _load_sdk(self) -> Any | None:
        if self._sdk is not None:
            return self._sdk
        if not self.api_key:
            return None
        try:
            import importlib
            sdk = importlib.import_module(self.sdk_module_name)
        except ImportError:
            logger.warning(
                "Runloop SDK (%s) not installed; RunloopRunner is a no-op",
                self.sdk_module_name,
            )
            return None
        # Most SDKs take an API key in their constructor.
        try:
            self._sdk = sdk.Client(api_key=self.api_key)
        except Exception:
            self._sdk = sdk
        return self._sdk

    async def create_devbox(self, spec: RunloopDevboxSpec) -> RunloopDevbox:
        sdk = self._load_sdk()
        if sdk is None:
            return RunloopDevbox(id=f"null-{os.urandom(4).hex()}", spec=spec, state="stub")
        # Real call: defer to SDK in a thread so the async loop isn't blocked.
        def _create() -> Any:
            return sdk.create_devbox(
                blueprint_id=spec.blueprint_id,
                name=spec.name,
                env_vars=spec.env_vars,
                metadata={**spec.metadata, "eden_integration_version": INTEGRATION_API_VERSION},
            )

        result = await asyncio.to_thread(_create)
        return RunloopDevbox(
            id=str(getattr(result, "id", "unknown")),
            spec=spec,
            state=str(getattr(result, "state", "running")),
            metadata=dict(getattr(result, "metadata", {}) or {}),
        )

    async def execute(self, devbox: RunloopDevbox, command: str) -> dict[str, Any]:
        sdk = self._load_sdk()
        if sdk is None:
            return {"exit_code": 0, "stdout": "", "stderr": "runloop not configured", "stub": True}
        def _exec() -> Any:
            return sdk.exec(devbox.id, command)
        result = await asyncio.to_thread(_exec)
        return {
            "exit_code": int(getattr(result, "exit_code", 0)),
            "stdout": str(getattr(result, "stdout", "")),
            "stderr": str(getattr(result, "stderr", "")),
        }

    async def destroy(self, devbox: RunloopDevbox) -> None:
        sdk = self._load_sdk()
        if sdk is None:
            return
        def _destroy() -> Any:
            return sdk.destroy_devbox(devbox.id)
        await asyncio.to_thread(_destroy)


__all__ = [
    "RunloopClient",
    "RunloopDevbox",
    "RunloopDevboxSpec",
]
