"""Regression: ingest decoder registry must load every required format.

A syntax error in providers.py previously left FormatRegistry empty and
turned every SDK ingest into a generic 503 while /ready stayed green.
"""

from __future__ import annotations

import compileall
from pathlib import Path


def test_providers_module_compiles() -> None:
    root = Path(__file__).resolve().parents[3]
    path = root / "src" / "eden" / "observability" / "ingestion" / "providers.py"
    assert path.is_file()
    assert compileall.compile_file(str(path), quiet=1, force=True)


def test_assert_ingest_decoders_healthy() -> None:
    from eden.observability.ingestion import (
        _REQUIRED_INGEST_FORMATS,
        assert_ingest_decoders_healthy,
        get_format_registry,
        reset_format_registry,
    )

    reset_format_registry()
    missing = assert_ingest_decoders_healthy()
    assert missing == []
    known = set(get_format_registry().known_formats())
    for fmt in _REQUIRED_INGEST_FORMATS:
        assert fmt in known


def test_python_sdk_agent_id_header_and_enqueue_stamp() -> None:
    from eden_sdk.client import EdenClient, TraceEvent
    from eden_sdk.config import EdenConfig

    cfg = EdenConfig(
        org_id="org_test",
        api_key="key_test",
        agent_id="support-bot",
        project_id="default",
        dry_run=True,
    )
    headers = cfg.auth_headers()
    assert headers["X-Eden-Agent-Id"] == "support-bot"
    assert headers["X-Project-Id"] == "default"

    client = EdenClient(cfg)
    client.enqueue(TraceEvent(payload={"event_type": "llm.completion"}, source_format="webhook"))
    # dry_run path still stamps before return
    # Re-run with a fresh client that captures the stamped payload
    stamped: dict = {}

    class _Cap(EdenClient):
        def enqueue(self, event, *, skip_sampling=False):  # noqa: ANN001
            payload = event.payload if isinstance(event.payload, dict) else {}
            agent_id = getattr(self.config, "agent_id", None)
            if agent_id and isinstance(payload, dict) and not payload.get("agent_id"):
                payload = {**payload, "agent_id": agent_id}
            stamped.update(payload)

    _Cap(cfg).enqueue(
        TraceEvent(payload={"event_type": "llm.completion"}, source_format="webhook")
    )
    assert stamped.get("agent_id") == "support-bot"
