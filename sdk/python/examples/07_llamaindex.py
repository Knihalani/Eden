"""07 — LlamaIndex query engine traced end-to-end.

Prerequisites:
    export OPENAI_API_KEY=sk-...
    export EDEN_ORG_ID=org_...
    export EDEN_API_KEY=sk-eden-...
    pip install "eden-sdk[llama-index,openai]"

Run:
    python examples/07_llamaindex.py

Expected:
    ``llm_completion`` events for every OpenAI call the query
    engine makes.  The ``@eden.trace_agent`` wrapper around the
    caller turns the whole RAG lookup into a single agent trace
    so the portal can show query → response latency end-to-end.
"""

from __future__ import annotations

import os

import eden

eden.configure(
    org_id=os.getenv("EDEN_ORG_ID", "demo-org"),
    api_key=os.getenv("EDEN_API_KEY", "demo-key"),
    base_url=os.getenv("EDEN_BASE_URL", "https://api.edenobservability.com"),
)
eden.instrument("openai", "llama_index")


@eden.trace_agent(name="llamaindex-rag", tags=["example", "llamaindex"])
def answer(question: str) -> str:
    from llama_index.core import Settings, VectorStoreIndex
    from llama_index.core.query_engine import RetrieverQueryEngine
    from llama_index.core.retrievers import VectorIndexRetriever
    from llama_index.llms.openai import OpenAI
    from llama_index.readers.documents import SimpleDirectoryReader  # type: ignore[import-not-found]

    # Cheap in-memory corpus so the example runs without external files.
    docs = SimpleDirectoryReader.from_texts(
        texts=[
            "The Eden SDK provides fire-and-forget observability for LLM apps.",
            "It batches events and ships them to the Eden gateway.",
        ],
    ).load_data()
    index = VectorStoreIndex.from_documents(docs)
    Settings.llm = OpenAI(model=os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
                          api_key=os.environ["OPENAI_API_KEY"])
    engine = index.as_query_engine(similarity_top_k=2)
    return str(engine.query(question))


if __name__ == "__main__":
    out = answer("What does the Eden SDK do?")
    print("LlamaIndex answer:", out)
    eden.get_default_client().flush()
