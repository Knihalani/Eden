"""09 — Pydantic AI agent with Eden auto-instrumentation.

Prerequisites:
    pip install "eden-sdk[pydantic_ai]"
    export OPENAI_API_KEY=sk-...
    export EDEN_ORG_ID=org_...
    export EDEN_API_KEY=sk-eden-...

Run:
    python examples/09_pydantic_ai.py
"""

from __future__ import annotations

import asyncio
import logging
import os

import eden

logging.basicConfig(level=logging.INFO, format="%(message)s")
log = logging.getLogger("eden.example")


async def main() -> None:
    eden.configure(
        org_id=os.getenv("EDEN_ORG_ID", "demo-org"),
        api_key=os.getenv("EDEN_API_KEY", "demo-key"),
        base_url=os.getenv("EDEN_BASE_URL", "http://localhost:8000"),
        project_id=os.getenv("EDEN_PROJECT_ID", "examples"),
    )

    eden.instrument("pydantic_ai")
    log.info("Instrumented pydantic_ai — source_format will be pydantic-ai")

    try:
        from pydantic_ai import Agent
    except ImportError:
        log.warning("pydantic-ai not installed; pip install 'eden-sdk[pydantic_ai]'")
        return

    agent = Agent(
        os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
        system_prompt="You are a concise assistant.",
    )
    result = await agent.run("Say hello in one short sentence.")
    log.info("agent output: %s", result.output)
    eden.get_default_client().flush()


if __name__ == "__main__":
    asyncio.run(main())
