import { ensureHome, readConfig, resolveApiKey } from "./home";
import { codingRegistry } from "@eden/wrap";

/**
 * eden runner (G1a): laptop bridge for hosted-compiled CLI stretches.
 *
 * Hosted MCP cannot execute runner-kind steps (shell commands, file system
 * operations). This daemon polls the control plane for pending runner jobs,
 * executes them through the local coding registry, and posts receipts back —
 * so a stretch compiled on the server can execute through the user's hands
 * without any cloud sandbox infrastructure.
 *
 * Security model:
 * - The daemon only executes tools from the LOCAL coding registry (Bash, Read,
 *   Write, Edit, Glob, Grep) — never arbitrary code from the server.
 * - Each job carries a tool name + args; the registry validates and dispatches.
 * - The daemon authenticates with the user's own API key.
 */
export async function runner(args: string[]): Promise<void> {
  ensureHome();
  const cfg = readConfig();
  const key = resolveApiKey(args);
  const base = process.env.EDEN_BASE_URL || cfg?.base_url || "http://127.0.0.1:8788";
  const pollMs = Number(process.env.EDEN_RUNNER_POLL_MS || 3000);
  const cwd = args.find(a => a.startsWith("--cwd="))?.split("=")[1] ?? process.cwd();
  const registry = codingRegistry(cwd);

  console.log(`eden runner: polling ${base} every ${pollMs}ms`);
  console.log(`Working directory: ${cwd}`);
  console.log("Press Ctrl+C to stop.\n");

  let running = true;
  process.on("SIGINT", () => { running = false; });

  while (running) {
    try {
      const res = await fetch(`${base}/v1/runner/jobs`, {
        headers: { Authorization: `Bearer ${key}` },
      });
      if (res.ok) {
        const body = (await res.json()) as {
          jobs?: Array<{ id: string; tool_id: string; steps: Array<{ tool: string; args: Record<string, unknown> }> }>;
        };
        for (const job of body.jobs ?? []) {
          console.log(`Executing job ${job.id} (${job.steps.length} steps)...`);
          const results: Array<{ step: number; ok: boolean; value?: unknown; error?: string }> = [];
          let allOk = true;
          for (let i = 0; i < job.steps.length; i++) {
            const step = job.steps[i]!;
            try {
              if (!registry.has?.(step.tool)) throw new Error(`unknown tool ${step.tool}`);
              const value = await registry.execute(step.tool, step.args);
              results.push({ step: i, ok: true, value });
            } catch (err) {
              results.push({ step: i, ok: false, error: String(err) });
              allOk = false;
            }
          }
          // Post receipt back to control plane.
          await fetch(`${base}/v1/runner/receipt`, {
            method: "POST",
            headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
            body: JSON.stringify({ job_id: job.id, ok: allOk, results }),
          });
          console.log(`  → ${allOk ? "ok" : "FAILED"} (${results.filter(r => r.ok).length}/${results.length} steps)`);
        }
      }
    } catch {
      // Network error: silently retry on next poll.
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  console.log("Runner stopped.");
}
