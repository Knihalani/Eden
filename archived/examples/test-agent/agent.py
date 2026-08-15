"""Basic OpenAI-compatible agent instrumented against prod Eden.

CLI entry point: configure + instrument before the OpenAI client is built,
trace the one agent turn, then flush before exit so batched telemetry lands.

Docs: https://docs.edenobservability.com/quickstart
Portal traces: https://edenobservability.com/traces

Setup:
    cd examples/test-agent
    cp .env.example .env   # fill MiniMax + Eden secrets
    uv sync
    uv run python agent.py
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")

import eden

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("eden.test-agent")

AGENT_ID = "test-agent"
_LAST_TRACE_ID: str | None = None


def _require(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if not value:
        raise SystemExit(f"Missing required env var: {name}")
    return value


def _configure_eden() -> None:
    org_id = _require("EDEN_ORG_ID")
    api_key = _require("EDEN_API_KEY")
    base_url = os.getenv("EDEN_BASE_URL", "https://api.edenobservability.com").strip()
    project_id = os.getenv("EDEN_PROJECT_ID", AGENT_ID).strip() or AGENT_ID

    # dry_run=False is explicit: EDEN_DEBUG=1 historically also flipped
    # dry_run on via env, which would silently drop real ingest.
    eden.configure(
        org_id=org_id,
        api_key=api_key,
        base_url=base_url or "https://api.edenobservability.com",
        project_id=project_id,
        tags=["smoke", "test-agent", "openai"],
        dry_run=False,
    )
    # Patch OpenAI in place before any client is constructed.
    eden.instrument("openai")
    log.info("Eden: %s project=%s", base_url, project_id)


@eden.trace_agent(name="test-agent")
def handle(question: str) -> str:
    """One agent turn: single chat completion someone would debug in the UI."""
    global _LAST_TRACE_ID
    from openai import OpenAI

    model = os.getenv("MINIMAX_MODEL", "MiniMax-M3").strip() or "MiniMax-M3"
    base_url = (
        os.getenv("MINIMAX_BASE_URL", "https://api.minimax.io/v1").strip()
        or "https://api.minimax.io/v1"
    )
    client = OpenAI(api_key=_require("MINIMAX_API_KEY"), base_url=base_url)
    log.info("LLM: %s @ %s", model, base_url)

    resp = client.chat.completions.create(
        model=model,
        messages=[
            {
                "role": "system",
                "content": (
                    "You are Eden Test Agent — answer briefly and precisely "
                    "in one or two sentences."
                ),
            },
            {"role": "user", "content": question},
        ],
        max_tokens=128,
        temperature=0.2,
    )
    ctx = eden.current_trace()
    _LAST_TRACE_ID = getattr(ctx, "trace_id", None) if ctx else None
    return (resp.choices[0].message.content or "").strip()


def main() -> None:
    _configure_eden()
    prompt = (
        os.getenv("AGENT_PROMPT")
        or "In one short sentence, what is LLM observability?"
    ).strip()
    log.info("Prompt: %s", prompt)

    session = eden.begin(agent_id=AGENT_ID, user_id="test-agent-runner")
    eden.identify("test-agent-runner")
    try:
        reply = handle(prompt)
        eden.complete_session(session, success=True)
        log.info("Agent reply:\n%s", reply)
        if _LAST_TRACE_ID:
            log.info("trace_id=%s", _LAST_TRACE_ID)
        log.info("session_id=%s", getattr(session, "session_id", None))
        log.info("Check traces → https://edenobservability.com/traces")
    except Exception:
        eden.complete_session(session, success=False)
        raise
    finally:
        # CLI exits immediately; flush so the batch is not lost.
        client = eden.get_default_client()
        client.flush()
        log.info("flush sent=%s failed=%s", client.sent, client.failed)


if __name__ == "__main__":
    main()
