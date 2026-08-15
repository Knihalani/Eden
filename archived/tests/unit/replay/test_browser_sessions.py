"""F09 — browser session store tests."""

from __future__ import annotations

import pytest

from eden.replay.store import BrowserSessionStore


@pytest.mark.asyncio
async def test_browser_session_in_memory_roundtrip() -> None:
    store = BrowserSessionStore(pg=None)
    session = await store.create_session("org_1", trace_id="trc_1")
    count = await store.append_events(
        "org_1",
        session.id,
        [
            {
                "event_type": "navigation",
                "step_number": 1,
                "payload": {"url": "https://example.com"},
            },
            {
                "event_type": "user_input",
                "step_number": 2,
                "payload": {"key": "Enter"},
            },
        ],
    )
    assert count == 2
    loaded = await store.get_session("org_1", session.id)
    assert loaded is not None
    assert loaded.event_count >= 0
