"""Tests for WS6 SDK additions: http capture, doctor, pydantic_ai stub."""

from __future__ import annotations

import logging
import sys
import types

import httpx
import pytest
import respx

import eden
from eden_sdk.client import get_default_client
from eden_sdk.doctor import run_doctor
from eden_sdk.http_capture import _detect_source_format, install, uninstall
from eden_sdk.logging_forwarder import install_logging, uninstall_logging


@pytest.fixture(autouse=True)
def _reset_eden(monkeypatch: pytest.MonkeyPatch) -> None:
    eden.reset_config()
    eden.uninstrument()
    eden.uninstall_http_capture()
    eden.uninstall_logging()
    monkeypatch.delenv("EDEN_DISABLED", raising=False)


def test_detect_source_format_openai() -> None:
    assert _detect_source_format("https://api.openai.com/v1/chat/completions") == "openai"


def test_detect_source_format_anthropic() -> None:
    assert _detect_source_format("https://api.anthropic.com/v1/messages") == "anthropic"


def test_http_capture_patches_httpx_and_emits(respx_mock: respx.MockRouter) -> None:
    eden.configure(org_id="org_test", api_key="key_test", base_url="http://localhost:8000")
    install()
    route = respx_mock.post("http://localhost:8000/orgs/org_test/ingest/openai").mock(
        return_value=httpx.Response(200, json={"accepted": 1})
    )
    respx_mock.post("https://api.openai.com/v1/chat/completions").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": "cmpl-1",
                "model": "gpt-4o-mini",
                "choices": [{"message": {"content": "hi"}}],
            },
        )
    )
    client = httpx.Client()
    with respx_mock:
        client.post(
            "https://api.openai.com/v1/chat/completions",
            json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "hi"}]},
        )
    get_default_client().flush(timeout=2.0)
    assert route.called
    uninstall()


def test_install_logging_attaches_handler() -> None:
    eden.configure(org_id="org_test", api_key="key_test", base_url="http://localhost:8000")
    install_logging("INFO")
    root = logging.getLogger()
    assert any(h.__class__.__name__ == "EdenLoggingHandler" for h in root.handlers)
    uninstall_logging()


def test_run_doctor_reports_missing_org() -> None:
    eden.configure(api_key="key", org_id=None, base_url="http://localhost:8000", dry_run=True)
    report = run_doctor(emit_test_event=False)
    assert not report.ok
    assert any(c.name == "org_id" and not c.ok for c in report.checks)


def test_pydantic_ai_install_patches_agent_run() -> None:
    fake_agent_mod = types.ModuleType("pydantic_ai")

    class FakeAgent:
        async def run(self, prompt: str, **kwargs):  # noqa: ANN001
            return types.SimpleNamespace(output=f"echo:{prompt}")

        def run_sync(self, prompt: str, **kwargs):  # noqa: ANN001
            return types.SimpleNamespace(output=f"echo:{prompt}")

    fake_agent_mod.Agent = FakeAgent
    sys.modules["pydantic_ai"] = fake_agent_mod
    from eden_sdk.instrumentations import pydantic_ai as pai

    pai.install()
    assert pai._installed is True
    pai.uninstall()
    assert pai._installed is False
