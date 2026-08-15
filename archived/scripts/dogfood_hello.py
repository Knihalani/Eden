#!/usr/bin/env python3
"""Minimal dogfood hello — same shape as the customer quickstart.

Requires EDEN_API_KEY + EDEN_ORG_ID in the environment (never hard-code keys).

    export EDEN_API_KEY=...
    export EDEN_ORG_ID=<your-org-uuid>
    export OPENAI_API_KEY=...   # or use OpenRouter via OPENAI_BASE_URL
    PYTHONPATH=sdk/python uv run python scripts/dogfood_hello.py
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
_SDK = _ROOT / "sdk" / "python"
if str(_SDK) not in sys.path:
    sys.path.insert(0, str(_SDK))

import eden  # noqa: E402  # type: ignore


def main() -> int:
    api_key = os.environ.get("EDEN_API_KEY") or os.environ.get("EDEN_ORG_API_KEY")
    org_id = os.environ.get("EDEN_ORG_ID") or os.environ.get("EDEN_DEFAULT_ORG")
    if not api_key or not org_id:
        print("Set EDEN_API_KEY and EDEN_ORG_ID", file=sys.stderr)
        return 2

    eden.configure(
        api_key=api_key,
        org_id=org_id,
        base_url=os.environ.get("EDEN_BASE_URL", "https://api.edenobservability.com"),
        agent_id=os.environ.get("EDEN_AGENT_ID", "eden-platform"),
    )
    eden.instrument()

    @eden.trace_agent(name="hello-world", tags=["quickstart", "dogfood"])
    def answer(question: str) -> str:
        from openai import OpenAI

        client = OpenAI()
        resp = client.chat.completions.create(
            model=os.environ.get("EDEN_DOGFOOD_MODEL", "gpt-4o-mini"),
            messages=[{"role": "user", "content": question}],
        )
        return resp.choices[0].message.content or ""

    print(answer("Say hello in five languages"))
    eden.get_default_client().flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
