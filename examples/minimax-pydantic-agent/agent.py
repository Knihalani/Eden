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
        "utc_offset_hours": "8",
    },
    "san francisco": {
        "country": "United States",
        "timezone": "America/Los_Angeles",
        "note": "Pacific Time",
        "utc_offset_hours": "-8",
    },
    "london": {
        "country": "United Kingdom",
        "timezone": "Europe/London",
        "note": "GMT / BST",
        "utc_offset_hours": "0",
    },
    "tokyo": {
        "country": "Japan",
        "timezone": "Asia/Tokyo",
        "note": "UTC+9 year-round",
        "utc_offset_hours": "9",
    },
    "berlin": {
        "country": "Germany",
        "timezone": "Europe/Berlin",
        "note": "CET / CEST",
        "utc_offset_hours": "1",
    },
    "sydney": {
        "country": "Australia",
        "timezone": "Australia/Sydney",
        "note": "AEST / AEDT",
        "utc_offset_hours": "10",
    },
    "mumbai": {
        "country": "India",
        "timezone": "Asia/Kolkata",
        "note": "IST UTC+5:30",
        "utc_offset_hours": "5.5",
    },
}

# Tiny "knowledge base" so the agent must tool-call to retrieve facts.
KB_NOTES: dict[str, str] = {
    "llm-observability": (
        "LLM observability covers traces, spans, token/cost accounting, "
        "eval scores, and incident signals across agent runs."
    ),
    "standup-hygiene": (
        "A global standup works best when local clock for most attendees "
        "falls between 08:00 and 11:00. Prefer cities close to that band."
    ),
    "tool-calling": (
        "Tool-calling agents should ground numbers and directory facts in "
        "tool results rather than memorized guesses."
    ),
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
            "You are Eden MiniMax Multi-Step Agent — a careful tool-using assistant. "
            "For multi-part tasks you MUST call tools for every factual claim "
            "(time, math, city directory, knowledge notes). Never invent numbers. "
            "Plan → call tools (multiple rounds ok) → reason over results → "
            "write a structured final answer. Prefer precision over brevity when "
            "the user asks for a brief or report."
        ),
    )

    @agent.tool_plain
    def get_current_time() -> dict[str, object]:
        """Return the current UTC ISO timestamp and unix epoch seconds."""
        now = datetime.now(timezone.utc)
        return {
            "iso_utc": now.isoformat().replace("+00:00", "Z"),
            "unix_seconds": int(now.timestamp()),
            "weekday_utc": now.strftime("%A"),
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

    @agent.tool_plain
    def list_cities() -> dict[str, object]:
        """List every city available in the directory."""
        return {
            "cities": sorted(CITY_DIRECTORY),
            "count": len(CITY_DIRECTORY),
        }

    @agent.tool_plain
    def retrieve_note(topic: str) -> dict[str, object]:
        """Retrieve a short knowledge-base note by topic key."""
        key = topic.strip().lower().replace(" ", "-")
        aliases = {
            "observability": "llm-observability",
            "llm observability": "llm-observability",
            "standup": "standup-hygiene",
            "tools": "tool-calling",
        }
        key = aliases.get(key, key)
        note = KB_NOTES.get(key)
        if not note:
            return {
                "found": False,
                "topic": topic,
                "available": sorted(KB_NOTES),
            }
        return {"found": True, "topic": key, "note": note}

    @agent.tool_plain
    def local_hour_for_utc_hour(utc_hour: float, utc_offset_hours: float) -> dict[str, object]:
        """Convert a UTC hour (0-23) to local hour given a UTC offset."""
        local = (float(utc_hour) + float(utc_offset_hours)) % 24
        return {
            "utc_hour": utc_hour,
            "utc_offset_hours": utc_offset_hours,
            "local_hour": local,
            "is_morning_band": 8.0 <= local <= 11.0,
        }

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
        agent_id=AGENT_ID,
        tags=["smoke", "minimax", "pydantic-ai"],
        debug=True,
    )
    # Framework spans + OpenAI-compat LLM spans (MiniMax via openai client).
    eden.instrument("pydantic_ai")
    eden.instrument("openai")

    agent, model_name, minimax_base = build_agent()
    log.info("LLM: %s @ %s", model_name, minimax_base)
    log.info("Eden: %s agent=%s project=%s", base_url, AGENT_ID, project_id)
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


DEFAULT_LONG_PROMPT = """
You are preparing an internal multi-city research brief for Eden. Complete EVERY
step using tools — do not guess times, offsets, or arithmetic.

1. Call get_current_time.
2. Call list_cities, then lookup_city for Singapore, Tokyo, London, and Sydney.
3. Call retrieve_note for topics: llm-observability, standup-hygiene, tool-calling.
4. Using calculate, compute each of these separately (one tool call each):
   a) (19.5 + 2.5) * 3
   b) that prior result + 42
   c) that prior result / 7
   d) Singapore UTC offset minus London UTC offset (use directory offsets)
   e) 2*2*2*2*2*2*2*2*2*2
5. For a proposed standup at UTC hour 9, call local_hour_for_utc_hour for
   Singapore, Tokyo, London, and Sydney (use each city's utc_offset_hours).
6. Write a structured final brief with sections:
   - Current UTC
   - City directory (timezone + note per city)
   - Knowledge notes (quote the retrieved notes)
   - Calculations (list each expression → value)
   - Standup fitness (which cities fall in the 08:00–11:00 local morning band)
   - Recommendation (one city for a 09:00 UTC standup, with reasoning grounded
     in tool results)

Use as many tool rounds as you need. Be thorough.
""".strip()


def main() -> None:
    prompt = (os.getenv("AGENT_PROMPT") or DEFAULT_LONG_PROMPT).strip()
    log.info("Prompt (%d chars):\n%s", len(prompt), prompt)
    reply = asyncio.run(run_once(prompt))
    log.info("Agent reply:\n%s", reply)
    log.info("Check traces → https://edenobservability.com/traces")


if __name__ == "__main__":
    main()
