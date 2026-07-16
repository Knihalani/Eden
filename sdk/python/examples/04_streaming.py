"""04 — OpenAI streaming chat traced end-to-end.

Prerequisites:
    export OPENAI_API_KEY=sk-...
    export EDEN_ORG_ID=org_...
    export EDEN_API_KEY=sk-eden-...
    # optional:
    export EDEN_BASE_URL=https://api.edenobservability.com

Run:
    python examples/04_streaming.py

Expected:
    1) The script prints the streamed model reply token-by-token.
    2) One ``llm_completion_stream`` event lands in ``telemetry_events``
       with TTFT/ITL/TPOT/output-token estimates.
    3) One row per chunk lands in the streaming chunks table
       (``/ingest/chunks``).
"""

from __future__ import annotations

import os

import eden

# ── Configure the SDK before importing OpenAI so the patch is live. ──
eden.configure(
    org_id=os.getenv("EDEN_ORG_ID", "demo-org"),
    api_key=os.getenv("EDEN_API_KEY", "demo-key"),
    base_url=os.getenv("EDEN_BASE_URL", "https://api.edenobservability.com"),
    project_id=os.getenv("EDEN_PROJECT_ID", "examples"),
)
eden.instrument("openai")  # patches openai.resources.chat.completions


@eden.trace_agent(name="basic-stream", tags=["example", "openai", "streaming"])
def stream(question: str) -> str:
    from openai import OpenAI

    client = OpenAI()
    response = client.chat.completions.create(
        model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
        messages=[{"role": "user", "content": question}],
        max_tokens=128,
        stream=True,
    )
    out = []
    for chunk in response:
        delta = chunk.choices[0].delta.content if chunk.choices else None
        if delta:
            print(delta, end="", flush=True)
            out.append(delta)
    print()
    return "".join(out)


if __name__ == "__main__":
    stream("Write a one-sentence haiku about observability.")
    eden.get_default_client().flush()
    eden.get_default_client().flush_chunks(timeout=2.0)
