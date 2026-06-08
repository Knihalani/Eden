"""Eden Python SDK Quick-Start

Demonstrates:
  • Creating a job
  • Streaming progress
  • Downloading the result
  • Running a benchmark

Run:
    export EDEN_API_KEY=sk_...
    export EDEN_DEFAULT_ORG=org_...
    python examples/python_quickstart.py
"""

from __future__ import annotations

import asyncio

from eden.sdk import Eden


async def main():
    eden = Eden()

    # 1. Create a job
    print("=== Creating job ===")
    job = await eden.jobs.create(
        description="A multi-agent negotiation environment with 3 agents",
        tags=["multi-agent", "negotiation"],
    )
    print(f"Job ID: {job.job_id}")
    print(f"Status: {job.status}")

    # 2. Stream progress in real time
    print("\n=== Streaming progress ===")
    async for event in eden.jobs.stream(job.job_id):
        data = event.data
        if event.event == "status":
            print(f"  [{data.get('status', '?')}] {data.get('current_stage', '?')}")
        elif event.event == "complete":
            print(f"  Complete! Outcome: {data.get('outcome_tier', '-')}")
            break
        elif event.event == "error":
            print(f"  Error: {data}")
            break

    # 3. Get result
    print("\n=== Result ===")
    try:
        result = await eden.jobs.get_result(job.job_id)
        print(f"Outcome tier: {result.outcome_tier}")
        if result.environment_code:
            print(f"Code length: {len(result.environment_code)} chars")
    except Exception as e:
        print(f"Result not ready: {e}")

    # 4. Download as ZIP
    print("\n=== Download ZIP ===")
    try:
        zip_bytes = await eden.environments.download(job.job_id)
        print(f"Downloaded {len(zip_bytes)} bytes")
    except Exception as e:
        print(f"Download failed: {e}")

    # 5. Create and run a benchmark
    print("\n=== Benchmark ===")
    try:
        bench = await eden.benchmarks.create(
            benchmark_name="Multi-agent negotiation benchmark",
            target_agents=["agent_a", "agent_b", "agent_c"],
            criteria={"min_score": 0.8, "max_rounds": 50},
        )
        print(f"Benchmark ID: {bench.benchmark_id}")

        run = await eden.benchmarks.run(
            bench.benchmark_id,
            target_code="# your agent code here",
        )
        print(f"Run ID: {run.run_id}")
        print(f"Passed: {run.passed}")
        print(f"Scores: {run.scores}")
    except Exception as e:
        print(f"Benchmark failed: {e}")

    await eden.close()


if __name__ == "__main__":
    asyncio.run(main())
