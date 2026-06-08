"""01 — Basic OpenAI chat traced end-to-end.

Prerequisites:
    export OPENAI_API_KEY=sk-...
    export EDEN_ORG_ID=org_...
    export EDEN_API_KEY=sk-eden-...
    # optional:
    export EDEN_BASE_URL=http://localhost:8000

Run:
    python examples/01_basic_chat.py

Expected:
    1) The script prints the model reply.
    2) A row appears in the ``telemetry_events`` table with
       ``source_format='openai'``, the model name, and full
       request/response payloads.
"""

from __future__ import annotations

import os

import eden

# ── Configure the SDK before importing OpenAI so the patch is live. ──
eden.configure(
    org_id=os.getenv("EDEN_ORG_ID", "demo-org"),
    api_key=os.getenv("EDEN_API_KEY", "demo-key"),
    base_url=os.getenv("EDEN_BASE_URL", "http://localhost:8000"),
    project_id=os.getenv("EDEN_PROJECT_ID", "examples"),
)
eden.instrument("openai")  # patches openai.resources.chat.completions


@eden.trace_agent(name="basic-chat", tags=["example", "openai"])
def ask(question: str) -> str:
    from openai import OpenAI

    client = OpenAI()
    resp = client.chat.completions.create(
        model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
        messages=[{"role": "user", "content": question}],
        max_tokens=128,
    )
    return resp.choices[0].message.content or ""


if __name__ == "__main__":
    answer = ask("In one sentence, what is the Eden SDK?")
    print(answer)
    eden.get_default_client().flush()
