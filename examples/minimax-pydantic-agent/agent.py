"""MiniMax + Pydantic AI agent instrumented against prod Eden.

Uses MiniMax's OpenAI-compatible API as the LLM, Pydantic AI as the agent
framework, and the published ``eden-sdk`` to send traces to
``https://api.edenobservability.com``.

Docs: https://docs.edenobservability.com/quickstart
Portal traces: https://edenobservability.com/traces

Setup:
    cd examples/minimax-pydantic-agent
    cp .env.example .env   # fill MiniMax + Eden secrets
    uv sync                # or: pip install -e .
    uv run python agent.py
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parent / ".env")

import eden

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("eden.minimax-agent")

AGENT_ID = "minimax-pydantic-agent"
CITY_DIRECTORY: dict[str, dict[str, str]] = {
    "singapore": {
        "country": "Singapore",
        "timezone": "Asia/Singapore",
        "note": "UTC+8 year-round",
    },
    "san francisco": {
        "country": "United States",
        "timezone": "America/Los_Angeles",
        "note": "Pacific Time",
    },
    "london": {
        "country": "United Kingdom",
        "timezone": "Europe/London",
        "note": "GMT / BST",
    },
    "tokyo": {
        "country": "Japan",
        "timezone": "Asia/Tokyo",
        "note": "UTC+9 year-round",
    },
    "berlin": {
        "country": "Germany",
        "timezone": "Europe/Berlin",
        "note": "CET / CEST",
    },
}


def _require(name: str) -> str:
    value = (os.getenv(name) or "").strip()
    if not value:
        raise SystemExit(f"Missing required env var: {name}")
    return value


def _safe_calculate(expression: str) -> float:
    cleaned = expression.replace(" ", "")
    if not re.fullmatch(r"[\d.+\-*/()]+", cleaned):
        raise ValueError("Expression contains unsupported characters")
    value = eval(cleaned, {"__builtins__": {}}, {})  # noqa: S307 — intentionally constrained
    if not isinstance(value, (int, float)):
        raise ValueError("Expression did not evaluate to a number")
    out = float(value)
    if out != out or abs(out) >= 1e15:  # NaN / huge
        raise ValueError("Result out of range")
    return out


def build_agent():
    from pydantic_ai import Agent
    from pydantic_ai.models.openai import OpenAIChatModel
    from pydantic_ai.providers.openai import OpenAIProvider

    model_name = os.getenv("MINIMAX_MODEL", "MiniMax-M3").strip() or "MiniMax-M3"
    base_url = (
        os.getenv("MINIMAX_BASE_URL", "https://api.minimax.io/v1").strip()
        or "https://api.minimax.io/v1"
    )
    api_key = _require("MINIMAX_API_KEY")

    model = OpenAIChatModel(
        model_name,
        provider=OpenAIProvider(base_url=base_url, api_key=api_key),
    )

    agent = Agent(
        model,
        name=AGENT_ID,
        system_prompt=(
            "You are Eden MiniMax Smoke Agent — a careful tool-using assistant. "
            "Use tools when they help answer accurately (time, math, city lookup). "
            "Prefer short, precise answers. After tools return, summarize clearly."
        ),
    )

    @agent.tool_plain
    def get_current_time() -> dict[str, object]:
        """Return the current UTC ISO timestamp and unix epoch seconds."""
        now = datetime.now(timezone.utc)
        return {
            "iso_utc": now.isoformat().replace("+00:00", "Z"),
            "unix_seconds": int(now.timestamp()),
        }

    @agent.tool_plain
    def calculate(expression: str) -> dict[str, object]:
        """Evaluate a simple arithmetic expression (+ - * / parentheses)."""
        value = _safe_calculate(expression)
        return {"expression": expression, "value": value}

    @agent.tool_plain
    def lookup_city(city: str) -> dict[str, object]:
        """Look up a known city from a tiny built-in directory."""
        key = city.strip().lower()
        hit = CITY_DIRECTORY.get(key)
        if not hit:
            return {
                "found": False,
                "city": city,
                "available": sorted(CITY_DIRECTORY),
            }
        return {"found": True, "city": city, **hit}

    return agent, model_name, base_url


async def run_once(prompt: str) -> str:
    org_id = _require("EDEN_ORG_ID")
    api_key = _require("EDEN_API_KEY")
    base_url = os.getenv("EDEN_BASE_URL", "https://api.edenobservability.com").strip()
    project_id = os.getenv("EDEN_PROJECT_ID", AGENT_ID).strip() or AGENT_ID

    eden.configure(
        org_id=org_id,
        api_key=api_key,
        base_url=base_url or "https://api.edenobservability.com",
        project_id=project_id,
        tags=["smoke", "minimax", "pydantic-ai"],
        debug=True,
    )
    # Framework spans + OpenAI-compat LLM spans (MiniMax via openai client).
    eden.instrument("pydantic_ai")
    eden.instrument("openai")

    agent, model_name, minimax_base = build_agent()
    log.info("LLM: %s @ %s", model_name, minimax_base)
    log.info("Eden: %s project=%s", base_url, project_id)
    log.info("Docs: https://docs.edenobservability.com/quickstart")

    session = eden.begin(agent_id=AGENT_ID, user_id="minimax-smoke-tester")
    eden.identify("minimax-smoke-tester")
    try:
        with eden.trace(
            AGENT_ID,
            attributes={"smoke": True, "llm": "minimax", "framework": "pydantic-ai"},
        ):
            result = await agent.run(prompt)
        output = getattr(result, "output", None) or str(result)
        eden.complete_session(session, success=True)
        return str(output).strip()
    except Exception:
        eden.complete_session(session, success=False)
        raise
    finally:
        eden.get_default_client().flush()


def main() -> None:
    prompt = (
        os.getenv("AGENT_PROMPT")
        or "What time is it UTC, and what is (19.5 + 2.5) * 3? Also look up Singapore."
    ).strip()
    log.info("Prompt: %s", prompt)
    reply = asyncio.run(run_once(prompt))
    log.info("Agent reply:\n%s", reply)
    log.info("Check traces → https://edenobservability.com/traces")


if __name__ == "__main__":
    main()
