"""06 — AutoGen (pyautogen) two-agent chat traced end-to-end.

Prerequisites:
    export OPENAI_API_KEY=sk-...
    export EDEN_ORG_ID=org_...
    export EDEN_API_KEY=sk-eden-...
    pip install "eden-sdk[autogen,openai]"

Run:
    python examples/06_autogen.py

Expected:
    A ``framework.callback`` event is emitted for every reply on
    each ``ConversableAgent`` plus the underlying ``llm_completion``
    events for the OpenAI calls.  All events share the same
    ``trace_id`` so the chat shows up as one trace in the portal.
"""

from __future__ import annotations

import os

import eden

eden.configure(
    org_id=os.getenv("EDEN_ORG_ID", "demo-org"),
    api_key=os.getenv("EDEN_API_KEY", "demo-key"),
    base_url=os.getenv("EDEN_BASE_URL", "http://localhost:8000"),
)
eden.instrument("openai", "autogen")


@eden.trace_agent(name="autogen-chat", tags=["example", "autogen"])
def chat(question: str) -> str:
    # ``pyautogen`` renamed to ``autogen`` in the 0.2+ line; import
    # inside the traced function so a missing dep is deferred to
    # call time, not import time of the example file.
    from autogen import AssistantAgent, UserProxyAgent

    llm_config = {
        "model": os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
        "api_key": os.environ["OPENAI_API_KEY"],
    }

    assistant = AssistantAgent(
        name="assistant",
        llm_config=llm_config,
        system_message="You answer concisely in one sentence.",
    )
    user = UserProxyAgent(
        name="user",
        human_input_mode="NEVER",
        max_consecutive_auto_reply=1,
        code_execution_config=False,
    )

    user.initiate_chat(assistant, message=question)
    # The assistant's last message is the answer.
    return assistant.last_message()["content"]


if __name__ == "__main__":
    out = chat("What is the capital of France?")
    print("Assistant:", out)
    eden.get_default_client().flush()
