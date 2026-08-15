"""03 — Anthropic Messages traced end-to-end.

Prerequisites:
    export ANTHROPIC_API_KEY=sk-ant-...
    export EDEN_ORG_ID=org_...
    export EDEN_API_KEY=sk-eden-...
    pip install "eden-sdk[anthropic]"

Run:
    python examples/03_anthropic.py
"""

from __future__ import annotations

import os

import eden

eden.configure(
    org_id=os.getenv("EDEN_ORG_ID", "demo-org"),
    api_key=os.getenv("EDEN_API_KEY", "demo-key"),
    base_url=os.getenv("EDEN_BASE_URL", "https://api.edenobservability.com"),
)
eden.instrument("anthropic")


@eden.trace_agent(name="anthropic-ask", tags=["example", "anthropic"])
def ask(question: str) -> str:
    import anthropic

    client = anthropic.Anthropic()
    resp = client.messages.create(
        model=os.getenv("ANTHROPIC_MODEL", "claude-3-5-haiku-latest"),
        max_tokens=128,
        messages=[{"role": "user", "content": question}],
    )
    # Find the first text block.
    for block in resp.content:
        if getattr(block, "type", None) == "text":
            return block.text
    return ""


if __name__ == "__main__":
    out = ask("In one sentence, what does the @trace_agent decorator do?")
    print(out)
    eden.get_default_client().flush()
