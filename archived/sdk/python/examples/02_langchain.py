"""02 — LangChain chain traced via the BaseCallbackHandler.

Prerequisites:
    export OPENAI_API_KEY=sk-...
    export EDEN_ORG_ID=org_...
    export EDEN_API_KEY=sk-eden-...
    pip install "eden-sdk[langchain,openai]"

Run:
    python examples/02_langchain.py

Expected:
    Structured framework events for chain.start / chain.end /
    llm.start / llm.end are emitted to /orgs/{org_id}/ingest/framework.
"""

from __future__ import annotations

import os

import eden

eden.configure(
    org_id=os.getenv("EDEN_ORG_ID", "demo-org"),
    api_key=os.getenv("EDEN_API_KEY", "demo-key"),
    base_url=os.getenv("EDEN_BASE_URL", "https://api.edenobservability.com"),
)
eden.instrument("openai", "langchain")


@eden.trace_agent(name="langchain-summary", tags=["example", "langchain"])
def summarise(text: str) -> str:
    from langchain_core.output_parsers import StrOutputParser
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_openai import ChatOpenAI

    prompt = ChatPromptTemplate.from_messages(
        [("system", "Summarise the input in one sentence."),
         ("user", "{text}")]
    )
    model = ChatOpenAI(model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
                       max_tokens=128)
    chain = prompt | model | StrOutputParser()
    return chain.invoke({"text": text})


if __name__ == "__main__":
    out = summarise(
        "The Eden SDK provides fire-and-forget observability for "
        "LLM applications. It supports OpenAI, Anthropic, LangChain, "
        "and several other frameworks out of the box."
    )
    print("Summary:", out)
    eden.get_default_client().flush()
