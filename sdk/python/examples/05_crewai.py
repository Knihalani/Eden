"""05 — CrewAI crew traced end-to-end.

Prerequisites:
    export OPENAI_API_KEY=sk-...
    export EDEN_ORG_ID=org_...
    export EDEN_API_KEY=sk-eden-...
    pip install "eden-sdk[crewai,openai]"

Run:
    python examples/05_crewai.py

Expected:
    A ``framework.callback`` event is emitted for every agent step,
    every tool call, and every task completion under the active
    crew.  The events flow through ``/orgs/{org_id}/ingest/framework``.
"""

from __future__ import annotations

import os

import eden

eden.configure(
    org_id=os.getenv("EDEN_ORG_ID", "demo-org"),
    api_key=os.getenv("EDEN_API_KEY", "demo-key"),
    base_url=os.getenv("EDEN_BASE_URL", "http://localhost:8000"),
)
# Patches crewai.Crew.step_callback / task_callback.  OpenAI is also
# wrapped so the LLM calls the agents make show up as ``llm_completion``
# events alongside the crew callbacks.
eden.instrument("openai", "crewai")


@eden.trace_agent(name="crewai-research", tags=["example", "crewai"])
def research(topic: str) -> str:
    from crewai import Agent, Crew, Process, Task

    researcher = Agent(
        role="Researcher",
        goal=f"Find three short facts about {topic}.",
        backstory="You are a meticulous research analyst.",
        allow_delegation=False,
        verbose=False,
    )
    writer = Agent(
        role="Writer",
        goal="Combine the research into a single sentence.",
        backstory="You write concisely.",
        allow_delegation=False,
        verbose=False,
    )

    research_task = Task(
        description=f"List three short facts about {topic}.",
        expected_output="A bullet list of three facts.",
        agent=researcher,
    )
    write_task = Task(
        description="Turn the bullet list into a single sentence.",
        expected_output="A single-sentence summary.",
        agent=writer,
    )

    crew = Crew(
        agents=[researcher, writer],
        tasks=[research_task, write_task],
        process=Process.sequential,
        verbose=False,
    )
    return str(crew.kickoff())


if __name__ == "__main__":
    out = research("Eden SDK")
    print("Crew output:", out)
    eden.get_default_client().flush()
