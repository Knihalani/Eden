/**
 * Eden TypeScript SDK Quick-Start
 *
 * Demonstrates:
 *   • Creating a job
 *   • Streaming progress
 *   • Downloading the result
 *   • Running a benchmark
 *
 * Run:
 *     export EDEN_API_KEY=sk_...
 *     export EDEN_DEFAULT_ORG=org_...
 *     npx tsx examples/typescript_quickstart.ts
 */

import { Eden } from "@eden/sdk";

async function main() {
  const eden = new Eden({
    apiKey: process.env.EDEN_API_KEY!,
    defaultOrg: process.env.EDEN_DEFAULT_ORG!,
  });

  // 1. Create a job
  console.log("=== Creating job ===");
  const job = await eden.jobs.create({
    description: "A multi-agent negotiation environment with 3 agents",
    tags: ["multi-agent", "negotiation"],
  });
  console.log(`Job ID: ${job.job_id}`);
  console.log(`Status: ${job.status}`);

  // 2. Stream progress in real time
  console.log("\n=== Streaming progress ===");
  const stream = await eden.jobs.stream(job.job_id);
  for await (const event of stream) {
    const data = event.data;
    if (event.event === "status") {
      console.log(`  [${data.status ?? "?"}] ${data.current_stage ?? "?"}`);
    } else if (event.event === "complete") {
      console.log(`  Complete! Outcome: ${data.outcome_tier ?? "-"}`);
      break;
    } else if (event.event === "error") {
      console.log(`  Error:`, data);
      break;
    }
  }

  // 3. Get result
  console.log("\n=== Result ===");
  try {
    const result = await eden.jobs.getResult(job.job_id);
    console.log(`Outcome tier: ${result.outcome_tier}`);
    if (result.environment_code) {
      console.log(`Code length: ${result.environment_code.length} chars`);
    }
  } catch (e) {
    console.log(`Result not ready: ${e}`);
  }

  // 4. Download as ZIP
  console.log("\n=== Download ZIP ===");
  try {
    const zipBytes = await eden.environments.download(job.job_id);
    console.log(`Downloaded ${zipBytes.length} bytes`);
  } catch (e) {
    console.log(`Download failed: ${e}`);
  }

  // 5. Create and run a benchmark
  console.log("\n=== Benchmark ===");
  try {
    const bench = await eden.benchmarks.create({
      benchmarkName: "Multi-agent negotiation benchmark",
      targetAgents: ["agent_a", "agent_b", "agent_c"],
      criteria: { min_score: 0.8, max_rounds: 50 },
    });
    console.log(`Benchmark ID: ${bench.benchmark_id}`);

    const run = await eden.benchmarks.run(bench.benchmark_id, {
      targetCode: "// your agent code here",
    });
    console.log(`Run ID: ${run.run_id}`);
    console.log(`Passed: ${run.passed}`);
    console.log(`Scores:`, run.scores);
  } catch (e) {
    console.log(`Benchmark failed: ${e}`);
  }
}

main().catch(console.error);
