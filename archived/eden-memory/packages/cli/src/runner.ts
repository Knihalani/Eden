import { join } from "node:path";
import { Store, executeLiveRun, toolMayFire, type LiveTool } from "@eden/control";
import type { ToolRegistry } from "@eden/ir";
import { codingRegistry, wrapTimeoutMs } from "@eden/wrap";
import { edenHome, ensureHome, readConfig, resolveApiKey } from "./home";

/**
 * eden runner (G1a, archived/compile-era/docs/generalization-plan.md §5): plays approved tools for the control plane.
 *
 * Threat model: the control plane, and anything that answers at `base`, is untrusted. A job is
 * `{ id, tool_id, version, input }`: it may only name a program a human Approved on this host (the
 * wrap's control.sqlite, state live), the version it is live at, and an input. The runner plays
 * that local program behind its witness envelope, as `eden play` does. It never executes steps
 * sent in a job, so a hostile control plane can at most replay approved programs on inputs inside
 * their envelopes.
 */

export type RunnerCtx = { store: Store; registry: ToolRegistry; timeoutMs: number };

export type RunnerReceipt = {
  job_id: string;
  ok: boolean;
  refused?: string;
  deopt?: string;
  error?: string;
  value?: unknown;
};

type Admitted = { ok: true; tool: LiveTool; input: Record<string, unknown> } | { ok: false; reason: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

/** Admits a job only if it names a program live on this host, at the version it is live at. */
function admitJob(job: unknown, store: Store): Admitted {
  if (!isRecord(job)) return { ok: false, reason: "job is not an object" };
  if ("steps" in job) return { ok: false, reason: "job carries raw steps; the runner plays approved programs only" };
  const { tool_id: toolId, version, input = {} } = job;
  if (typeof toolId !== "string" || typeof version !== "string") {
    return { ok: false, reason: "job must name a tool_id and a version" };
  }
  if (!isRecord(input)) return { ok: false, reason: "job input must be an object" };
  const gate = toolMayFire(store.tool(toolId));
  if (!gate.ok) return { ok: false, reason: `program ${toolId} is ${gate.reason} on this host` };
  if (gate.tool.version !== version) {
    return { ok: false, reason: `program ${toolId} is live at ${gate.tool.version}, not ${version}` };
  }
  return { ok: true, tool: gate.tool, input };
}

/** Plays one job, or refuses it. A refused job executes nothing. */
export async function runJob(job: unknown, ctx: RunnerCtx): Promise<RunnerReceipt> {
  const jobId = isRecord(job) && typeof job.id === "string" ? job.id : "";
  const admitted = admitJob(job, ctx.store);
  if (!admitted.ok) return { job_id: jobId, ok: false, refused: admitted.reason };
  const ran = await executeLiveRun({
    store: ctx.store,
    tool: admitted.tool,
    input: admitted.input,
    registry: ctx.registry,
    timeoutMs: ctx.timeoutMs,
    source: "runner",
  });
  if (ran.status === "ok") return { job_id: jobId, ok: true, value: ran.value };
  if (ran.status === "deopt") return { job_id: jobId, ok: false, deopt: ran.reason };
  return { job_id: jobId, ok: false, error: ran.error };
}

/** Job fields reach the terminal: drop control characters so a job cannot rewrite the log. */
function printable(line: string): string {
  return line.replace(/[\u0000-\u001f\u007f-\u009f]/g, "?");
}

function logReceipt(r: RunnerReceipt): void {
  if (r.refused) console.error(printable(`eden runner: refused job ${r.job_id}: ${r.refused}`));
  else if (r.ok) console.log(printable(`Job ${r.job_id} → ok`));
  else console.log(printable(`Job ${r.job_id} → ${r.deopt ? `deopt: ${r.deopt}` : `FAILED: ${r.error}`}`));
}

/** One poll: fetch the pending jobs, play or refuse each, and post a receipt for each. */
export async function pollOnce(base: string, key: string, ctx: RunnerCtx): Promise<void> {
  const res = await fetch(`${base}/v1/runner/jobs`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) return;
  const body = (await res.json()) as { jobs?: unknown } | null;
  const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
  for (const job of jobs) {
    const receipt = await runJob(job, ctx);
    logReceipt(receipt);
    await fetch(`${base}/v1/runner/receipt`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(receipt),
    });
  }
}

export async function runner(args: string[]): Promise<void> {
  ensureHome();
  const cfg = readConfig();
  const key = resolveApiKey(args);
  const base = process.env.EDEN_BASE_URL || cfg?.base_url || "http://127.0.0.1:8788";
  const pollMs = Number(process.env.EDEN_RUNNER_POLL_MS || 3000);
  const cwd = args.find((a) => a.startsWith("--cwd="))?.split("=")[1] ?? process.cwd();
  // The Approve record `eden wrap` serves from. `eden wrap` writes the same file, hence the wait.
  const store = new Store(process.env.EDEN_DB || join(edenHome(), "control.sqlite"));
  store.db.exec("PRAGMA busy_timeout = 5000");
  const ctx: RunnerCtx = { store, registry: codingRegistry(cwd), timeoutMs: wrapTimeoutMs() };

  console.log(`eden runner: polling ${base} every ${pollMs}ms`);
  console.log(`Working directory: ${cwd}`);
  console.log(`Plays only programs Approved on this host (live now: ${store.liveCount()}).`);
  console.log("Press Ctrl+C to stop.\n");

  let running = true;
  process.on("SIGINT", () => {
    running = false;
  });

  while (running) {
    try {
      await pollOnce(base, key, ctx);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  console.log("Runner stopped.");
}
