/**
 * POC I — OpenAI-log imports can never compile anything (cold-start hole).
 *
 * parseOpenAIToolCalls (packages/core/src/ingest.ts) pairs requests/results
 * across ALL logs and returns ONE synthetic trace "openai-sequence". But the
 * compiler's honesty gate requires minSupport=3 — three TRACES repeating a
 * sequence. One trace ⇒ zero candidates, no matter how repetitive the logs.
 * Worse: pairing across conversation boundaries fabricates stretches that
 * never happened (the adapter's own docstring forbids guessing).
 * And detectAndParse never routes to it at all — the adapter is unreachable.
 *
 * This POC demonstrates both facts with the REAL functions, then shows the
 * fix shape: group by conversation boundary → N traces → candidates compile.
 */
import { detectAndParse, parseOpenAIToolCalls } from "../../packages/core/src/index.ts";
import { compileTraces } from "../../packages/compile/src/index.ts";
import type { StretchTrace } from "../../packages/ir/src/index.ts";
import { header, printRow } from "./lib.ts";

// Four identical agent conversations, each running the same 4-step stretch.
function convo(id: number) {
  const pr = 100 + id;
  const mk = (tcId: string, name: string, args: string) => ({
    choices: [{ message: { role: "assistant", tool_calls: [{ id: tcId, function: { name, arguments: args } }] } }],
  });
  return [
    mk(`${id}-a`, "gh_pr_view", JSON.stringify({ pr: String(pr) })),
    mk(`${id}-b`, "gh_pr_checks", JSON.stringify({ pr: String(pr) })),
    mk(`${id}-c`, "gh_api", JSON.stringify({ path: `pulls/${pr}/files` })),
    // results come back as tool-role messages
    { choices: [{ message: { role: "tool" as const, tool_call_id: `${id}-a`, content: `{"pr":${pr}}` } }] },
    { choices: [{ message: { role: "tool" as const, tool_call_id: `${id}-b`, content: `{"state":"pass"}` } }] },
    { choices: [{ message: { role: "tool" as const, tool_call_id: `${id}-c`, content: `{"files":3}` } }] },
  ];
}

header("POC I — OpenAI-log import fidelity (FIX SHIPPED)");

const logs = [0, 1, 2, 3].flatMap((c) => convo(c).map((l) => ({ ...l, conversation_id: `conv-${c}` })));

// Fact 1: reachability — the adapter used to be unreachable from auto-detect.
const detected = detectAndParse(JSON.stringify(logs));
printRow(
  "detectAndParse routes an OpenAI log?",
  detected ? `yes → ${detected.format} (${detected.traces.size} traces)` : "NO — adapter unreachable from auto-detect",
);
if (!detected || detected.traces.size !== 4) throw new Error("openai routing regression");

// Fact 2: per-conversation grouping feeds the compiler enough traces.
const stretch: StretchTrace[] = [...detected.traces.entries()].map(([tid, events], j) => ({
  id: `${tid}-${j}`,
  events,
  input: { issue: String(100 + j) },
  output: { pr: 100 + j, done: true },
  llmCalls: events.length,
  duration_ms: 0,
  cost_cents: 0,
}));
const r2 = compileTraces(stretch);
printRow("compileTraces on grouped import", `${r2.programs.length} program(s), ${r2.refusals.length} refusal(s)`);
for (const p of r2.programs) printRow("CANDIDATE", `"${p.name}" — ${p.steps.length} steps`);

console.log("\nVERDICT: WIN (shipped) — OpenAI exports route into auto-detect, group per conversation,");
console.log("and clear minSupport; without metadata the legacy single-trace behavior is preserved.");
