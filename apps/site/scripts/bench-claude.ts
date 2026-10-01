#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";

const ORIGIN = "http://127.0.0.1:8000";
const urls = [
  `${ORIGIN}/forge/repos/acme/app/issues/12`,
  `${ORIGIN}/forge/repos/acme/app/issues/12/comments`,
  `${ORIGIN}/forge/repos/acme/app/pulls/12`,
  `${ORIGIN}/forge/repos/acme/app/pulls/12/reviews`,
  `${ORIGIN}/forge/repos/acme/app/commits/abc12/status`,
  `${ORIGIN}/forge/repos/acme/app/actions/runs?pr=12`,
];

const withoutPrompt = `You are measuring a baseline. Do not install packages.
Using curl only (no MCP), fetch ALL of these URLs:
${urls.map((u) => `- ${u}`).join("\n")}
Write exactly one line to /tmp/eden-bench-without/summary.txt:
issue_title | comment_count | pr_title | review_count | commit_state | latest_run_conclusion
Then stop.`;

const withPrompt = `You have MCP tool mcp__eden__fetch_issue_bundle. You MUST call it once with issue "12". Do not curl the forge URLs. Do not call gh.
From the tool result, write exactly one line to /tmp/eden-bench-with/summary.txt:
issue_title | comment_count | pr_title | review_count | commit_state | latest_run_conclusion
Then stop.`;

function parseStream(text: string) {
  const lines = text.trim().split("\n").filter(Boolean);
  let toolCalls = 0;
  let result: Record<string, unknown> | null = null;
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "assistant" && Array.isArray(ev.message?.content)) {
        toolCalls += ev.message.content.filter((c: { type?: string }) => c.type === "tool_use").length;
      }
      if (ev.type === "result") result = ev;
    } catch {
      /* ignore */
    }
  }
  return { toolCalls, result };
}

async function run(label: "without" | "with") {
  mkdirSync(`/tmp/eden-bench-${label}`, { recursive: true });
  const args = [
    "-p",
    label === "without" ? withoutPrompt : withPrompt,
    "--output-format",
    "json",
    "--dangerously-skip-permissions",
    "--max-budget-usd",
    "2",
  ];
  if (label === "with") {
    args.push(
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{"eden":{"type":"http","url":"http://127.0.0.1:8000/mcp"}}}',
    );
  }
  const t0 = Date.now();
  const proc = Bun.spawn(["claude", ...args], {
    cwd: `/tmp/eden-bench-${label}`,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;
  const wall = Date.now() - t0;
  writeFileSync(`/tmp/eden-bench/${label}.jsonl`, stdout);
  writeFileSync(`/tmp/eden-bench/${label}.err`, stderr);
  let result: Record<string, unknown> | null = null;
  try {
    result = JSON.parse(stdout);
  } catch {
    result = null;
  }
  const usage = (result?.usage || {}) as Record<string, number>;
  const summary = {
    label,
    wall_ms: wall,
    duration_ms: result?.duration_ms,
    duration_api_ms: result?.duration_api_ms,
    num_turns: result?.num_turns,
    tool_calls: Array.isArray((result as { modelUsage?: unknown })?.permission_denials) ? undefined : result?.num_turns,
    total_cost_usd: result?.total_cost_usd,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_creation_input_tokens: usage.cache_creation_input_tokens,
    cache_read_input_tokens: usage.cache_read_input_tokens,
    result_text: String(result?.result || "").slice(0, 400),
    is_error: result?.is_error,
  };
  writeFileSync(`/tmp/eden-bench/${label}.summary.json`, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

const without = await run("without");
const withEden = await run("with");
writeFileSync("/tmp/eden-bench/compare.json", JSON.stringify({ without, with: withEden }, null, 2));
console.log("wrote /tmp/eden-bench/compare.json");
