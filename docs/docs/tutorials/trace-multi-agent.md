---
id: trace-multi-agent
title: Trace a multi-agent run
sidebar_label: Trace multi-agent run
sidebar_position: 3
---

# Tutorial — Trace a multi-agent run

Time: **20 minutes**. By the end you'll have a LangChain multi-agent
run that emits a tree of spans (planner → retriever → LLM → tool)
into the portal.

## What you'll build

A "research agent" that takes a question, plans a few search queries,
runs them, and synthesises an answer. Each of those steps becomes a
span in one trace.

## Step 1 — Set up

```bash
mkdir eden-research-agent && cd eden-research-agent
python -m venv .venv && source .venv/bin/activate
pip install eden-sdk langchain langchain-openai wikipedia
```

```bash
export EDEN_API_KEY="sk_eden_..."
export EDEN_ORG_ID="org_..."
export OPENAI_API_KEY="sk-..."
```

## Step 2 — Build the agent

```python
# agent.py
import os
from langchain_openai import ChatOpenAI
from langchain.agents import AgentExecutor, create_react_agent
from langchain.tools import WikipediaQueryRun
from langchain_community.utilities import WikipediaAPIWrapper
from langchain import hub

import eden

eden.configure(
    api_key=os.environ["EDEN_API_KEY"],
    org_id=os.environ["EDEN_ORG_ID"],
)
eden.instrument()  # patches langchain + openai

llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
tools = [WikipediaQueryRun(api_wrapper=WikipediaAPIWrapper())]
prompt = hub.pull("hwchase17/react")
agent = create_react_agent(llm, tools, prompt)
executor = AgentExecutor(agent=agent, tools=tools, verbose=True)

@eden.trace_agent(name="research-agent", tags=["research"])
def run(question: str) -> str:
    return executor.invoke({"input": question})["output"]

if __name__ == "__main__":
    q = input("Question: ")
    print(run(q))
```

Run it:

```bash
python agent.py
Question: Who was Marie Curie?
Marie Curie was a Polish-French physicist and chemist...
```

## Step 3 — Read the trace

Open the portal's **Traces** tab and click into the
`research-agent` row. You'll see:

```
research-agent  (root span, 1.84 s)
├── openai.chat.completions  (plan step, 0.61 s)
├── wikipedia.search  (tool call, 0.42 s)
├── openai.chat.completions  (synthesis step, 0.79 s)
```

Each step carries:

- The prompt and response (truncated at 8 KiB)
- The model (gpt-4o-mini)
- Tokens (input + output)
- Cost (USD, computed from the pricing table)
- Latency

Click any span to see the full prompt and response.

## Step 4 — Filter by tool or outcome

The **Traces** tab supports filtering by:

- `outcome` — `success`, `error`, `timeout`
- `agent_id` — your registered agent
- `tags` — any of the tags you set
- `min_duration_ms` / `max_duration_ms`
- `since` / `until` (ISO-8601)
- `search` — full-text over prompt and response

Try filtering to `outcome: error` to find the runs that hit the
tool but failed.

## Step 5 — Add attributes for richer context

```python
@eden.trace_agent(name="research-agent")
def run(question: str, user_id: str = "anon") -> str:
    eden.set_attribute("user_id", user_id)
    eden.set_attribute("question_length_chars", len(question))
    result = executor.invoke({"input": question})
    eden.set_attribute("answer_length_chars", len(result["output"]))
    return result["output"]
```

The portal indexes every attribute; you can now find traces where
the answer was unusually short or unusually long.

## Step 6 — Read the agent graph

Open the **Agent Graph** tab (it's in the trace detail page). It
shows the call sequence as a node-and-edge diagram:

```
[research-agent]
       │
       ▼
[openai: plan]──▶[wikipedia.search]
       │                 │
       └────[openai: synthesis]──▶ answer
```

Useful for finding loops, dead branches, and redundant calls.

## What you learned

- `eden.instrument()` patches both LangChain and OpenAI, so you don't
  have to wire them separately.
- `@eden.trace_agent` is a tree root: every LLM call and tool call
  inside it becomes a child span.
- `eden.set_attribute(...)` adds metadata that's both searchable
  and visible in the trace detail view.
- The portal's trace view supports filters over `outcome`, `tags`,
  `duration`, and full-text search over the prompt/response.

## Where next

- [Tutorial — Judge a model output](/tutorials/judge-model-output)
- [How-to — Detect regressions with judge scores](/how-to/judges)
- [Reference — Traces API](/reference/api-traces)