/**
 * POC 1 — Cold start: import-to-candidate in seconds, not days.
 *
 * Today a new user must run their agent until a workflow repeats ≥2 times
 * before the Workshop shows anything. The trace-import adapters already exist
 * (packages/core/src/ingest.ts) but sit behind `eden import`, a side command.
 * This POC proves the front door: feed a realistic observability export
 * straight into the production ingest → compile pipeline and measure how long
 * until a named, approvable candidate exists.
 *
 * Fixture: OpenTelemetry span export (GenAI conventions) holding 6 agent runs,
 * 4 of which repeat the same 4-step PR-review stretch.
 */
import { detectAndParse } from "../../packages/core/src/index.ts";
import { compileTraces } from "../../packages/compile/src/index.ts";
import { redact, type StretchTrace } from "../../packages/ir/src/index.ts";
import { nowMs, header, printRow } from "./lib.ts";

function span(traceId: string, name: string, args: Record<string, unknown>, seq: number) {
  const t0 = BigInt(1756000000_000000000) + BigInt(seq) * 300_000_000n;
  return {
    traceId,
    spanId: `${traceId}-s${seq}`,
    name,
    attributes: {
      "gen_ai.tool.name": name,
      "gen_ai.tool.call.arguments": JSON.stringify(args),
    },
    startTimeUnixNano: t0.toString(),
    endTimeUnixNano: (t0 + 120_000_000n).toString(),
    status: { code: "OK" },
  };
}

// One repeated PR-review stretch, with per-run variation in the ids.
function prReviewRun(runId: number): { traceId: string; spans: ReturnType<typeof span>[] } {
  const pr = 100 + runId;
  return {
    traceId: `run${runId}`,
    spans: [
      span(`run${runId}`, "gh_pr_view", { pr: String(pr), repo: "acme/app" }, 0),
      span(`run${runId}`, "gh_pr_checks", { pr: String(pr), repo: "acme/app" }, 1),
      span(`run${runId}`, "gh_api", { path: `repos/acme/app/pulls/${pr}/files` }, 2),
      span(`run${runId}`, "github_add_comment", { pr: String(pr), body: "review notes" }, 3),
    ],
  };
}

const runs = [prReviewRun(0), prReviewRun(1), prReviewRun(2), prReviewRun(3)];
// Noise: two runs that do something unrelated (must NOT produce a candidate).
runs.push({
  traceId: "run4",
  spans: [span("run4", "web_search", { q: "bun release notes" }, 0), span("run4", "file_write", { p: "/tmp/x" }, 1)],
});
runs.push({
  traceId: "run5",
  spans: [span("run5", "gh_issue_list", { repo: "acme/app" }, 0)],
});

const otelExport = JSON.stringify(runs.flatMap((r) => r.spans));

header("POC 1 — cold start: import → candidate");

const t0 = nowMs();
const detected = detectAndParse(otelExport);
const tDetect = nowMs() - t0;
if (!detected) throw new Error("fixture not detected as OTel");
printRow("format detected", `${detected.format} (${detected.traces.size} traces)`);

const traces: StretchTrace[] = [...detected.traces.entries()].map(([tid, events], j) => ({
  id: `otel-imp-${j}-${tid.slice(0, 12)}`,
  events: events.map((e) => ({
    ...e,
    ...(e.args !== undefined ? { args: redact(e.args) as Record<string, unknown> } : {}),
  })),
  input: {},
  // Real recordings carry what the stretch produced; vary per witness like reality does.
  output: tid === "run4" || tid === "run5" ? { done: true } : { pr: 100 + j, reviewed: true, notes: `notes-${j}` },
  // And what the human asked for — this is what the witnessed-input envelope
  // is mined from (the anti-hallucination admission gate).
  input: tid.startsWith("run") && j < 4 ? { issue: String(100 + j) } : { q: "misc" },
  llmCalls: events.length,
  duration_ms: events.reduce((a, e) => a + (e.duration_ms ?? 0), 0),
  cost_cents: 0,
}));

const t1 = nowMs();
const result = compileTraces(traces);
const tCompile = nowMs() - t1;
const total = nowMs() - t0;

printRow("ingest+redact time", `${tDetect.toFixed(1)} ms`);
printRow("compile time", `${tCompile.toFixed(1)} ms`);
printRow("total wall clock to candidate", `${total.toFixed(1)} ms  (budget: 60,000 ms)`);
console.log("");
for (const p of result.programs) {
  printRow(
    "CANDIDATE",
    `"${p.name}" — ${p.steps.length} steps, id ${p.id}`,
  );
}
for (const r of result.refusals.slice(0, 4)) {
  printRow("refusal (honest gate)", `${r.reason?.slice(0, 60) ?? "see code"}`);
}
console.log(
  `\nVERDICT: ${result.programs.length > 0 && total < 60_000 ? "WIN" : "LOSE"} — ${
    result.programs.length
  } approvable candidate(s) from a cold import in ${(total / 1000).toFixed(2)}s`,
);
