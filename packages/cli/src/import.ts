import { detectAndParse } from "@eden/core";
import { protocolHeaders, redact, type StretchTrace } from "@eden/ir";
import { readConfig, resolveApiKey } from "./home";

/**
 * eden import: bulk-load existing trace history from observability exports.
 *
 * Reads a JSONL/JSON file containing tool-call traces (LangSmith, OTel spans,
 * OpenAI chat logs, or generic JSONL), normalizes them via the appropriate
 * adapter, redacts credential-shaped values, and posts them to the control
 * plane for compilation.
 *
 * Honesty rules:
 *   - Malformed lines are skipped and COUNTED, never silently dropped and
 *     never fatal for the rest of the export.
 *   - llmCalls/duration/cost are reconstructed from event counts (the exports
 *     do not carry them) and the traces are flagged `metrics_estimated`, so
 *     no gate mistakes a guess for a measurement.
 *
 * Usage: `eden import --file langsmith-export.json`
 */

/** Refuse to buffer absurd files; a multi-GB export would OOM before parsing. */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export async function importTraces(args: string[]): Promise<void> {
  const fileIdx = args.indexOf("--file");
  const filePath = fileIdx >= 0 ? args[fileIdx + 1] : args[0];
  if (!filePath) {
    console.error("eden import --file <path-to-trace-export>");
    console.error("Supported formats: LangSmith runs JSONL, OpenTelemetry spans JSON, generic JSONL");
    process.exit(1);
  }

  const { statSync, readFileSync } = await import("node:fs");
  try {
    const size = statSync(filePath).size;
    if (size > MAX_FILE_BYTES) {
      console.error(
        `${filePath} is ${(size / 1e6).toFixed(0)}MB — over the ${MAX_FILE_BYTES / 1e6}MB import limit. Split the export and import in parts.`,
      );
      process.exit(1);
    }
  } catch {
    console.error(`Cannot read ${filePath}`);
    process.exit(1);
  }
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    console.error(`Cannot read ${filePath}`);
    process.exit(1);
  }

  const detected = detectAndParse(content);
  if (!detected || detected.traces.size === 0) {
    console.error("Unrecognized trace format, or no tool calls found. Expected: LangSmith runs, OTel spans, or generic JSONL.");
    process.exit(1);
  }
  const { format, traces: traceMap } = detected;

  // Credential-shaped values are rewritten to sentinels before anything
  // leaves the machine. Exports routinely echo Authorization headers,
  // api_keys in args, and Set-Cookie in results.
  let totalEvents = 0;
  const traces: StretchTrace[] = [...traceMap.entries()].map(([tid, events], j) => {
    const cleanEvents = events.map((e) => ({
      ...e,
      ...(e.args !== undefined ? { args: redact(e.args) as Record<string, unknown> } : {}),
      ...(e.result !== undefined ? { result: redact(e.result) } : {}),
    }));
    totalEvents += cleanEvents.length;
    return {
      id: `${format}-imp-${j}-${tid.slice(0, 12)}`.replace(/[^\w.-]/g, "_"),
      events: cleanEvents,
      input: {},
      output: null,
      // The exports carry none of these; reconstructing them from event
      // counts keeps downstream arithmetic finite while metrics_estimated
      // marks them as guesses, never measurements.
      llmCalls: cleanEvents.length * 2,
      duration_ms: cleanEvents.length * 500,
      cost_cents: cleanEvents.length * 2,
      complete: true,
      metrics_estimated: true as const,
    };
  });
  const totalTraces = traces.length;
  console.log(`Detected ${format}: ${totalTraces} traces, ${totalEvents} tool calls (metrics estimated from event counts)`);

  // Post to the control plane in batches of 50 traces.
  const cfg = readConfig();
  const base = cfg?.base_url ?? "http://127.0.0.1:8788";
  const key = resolveApiKey(args.slice(args.indexOf("--file") + 2));

  let accepted = 0;
  for (let i = 0; i < traces.length; i += 50) {
    const batch = traces.slice(i, i + 50);
    try {
      const res = await fetch(`${base}/v1/traces`, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json", ...protocolHeaders() },
        body: JSON.stringify({ traces: batch }),
      });
      if (!res.ok) {
        console.error(`Batch ${Math.floor(i / 50)}: HTTP ${res.status}`);
        continue;
      }
      const body = (await res.json()) as { accepted?: number };
      accepted += body.accepted ?? 0;
    } catch (err) {
      console.error(`Batch ${Math.floor(i / 50)} failed:`, err);
    }
  }

  console.log(`Imported ${accepted}/${totalTraces} traces (${totalEvents} tool calls)`);
  console.log("Run `eden wrap` or check the dashboard to compile mined stretches.");
}
