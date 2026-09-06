/**
 * Wave 11 rotation: OpenCode MCP-shaped after-hook drop (issue #25918).
 *
 * Native `tool.execute.after` mutations to `output.output` land. MCP-shaped
 * `{ content: [{type,text}] }` is assembled AFTER the hook, so mutating
 * `output.output` is dropped. That is a new host-drop class — not Claude
 * Code's silent `updatedToolOutput` drop (`silent-drop.ts`).
 *
 * Remainder deny (S1b) still fires. additionalContext / inject still carry
 * the sentinel.
 *
 *   bun test benchmarks/campaign/opencode-drop.test.ts
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { respondToHook, type HookIn } from "../../packages/cli/src/hook";
import {
  applyOpenCodeAfter,
  type AppliedHook,
  type HookResponse,
} from "../../packages/cli/src/transcript-diff";
import { appendLedgerRow } from "../../packages/cli/src/remainder";
import type { LiveTool } from "../../packages/cli/src/transparent";

export const EXPECT =
  "OpenCode MCP-shaped after payload drops output.output mutation; remainder deny still holds; not silent-drop";

export const SENTINEL_MARK = "[eden:";

export const COMPILABLE_PROGRAM: LiveTool = {
  name: "pr_summary",
  sequence: ["Read", "Grep", "Bash"],
  id: "opencode-drop-pr",
  read_only: true,
  envelope: { inputs: { issue: ["101", "102", "103"] } },
};

export type OpenCodeCall = { tool: string; args: Record<string, unknown> };

export function compilableCalls(issue = "101"): OpenCodeCall[] {
  return [
    { tool: "read", args: { issue, file_path: "/repo/pr.ts" } },
    { tool: "grep", args: { issue, pattern: "TODO" } },
    { tool: "bash", args: { issue, command: "gh pr view" } },
  ];
}

export type StretchResult = {
  executions: number;
  denies: number;
  remainderExecutions: number;
  droppedRewrites: number;
  ledgerTransparent: number;
  ledgerSteeredSkip: number;
  ledgerHostDrop: number;
  steps: Array<{
    tool: string;
    denied: boolean;
    executed: boolean;
    applied?: AppliedHook;
    visibleText: string;
    additionalContext: string;
  }>;
};

function nativeString(tool: string): string {
  if (tool === "read" || tool === "Read") return "export {}";
  if (tool === "grep" || tool === "Grep") return "TODO none";
  if (tool === "bash" || tool === "Bash") return "reviews=6";
  return "ok";
}

/** Raw CallToolResult — the after hook sees this before OpenCode assembles text. */
export function mcpShapedResult(text = "export {}"): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: "text", text }] };
}

function countLedger(home: string): { transparent: number; steeredSkip: number; hostDrop: number } {
  const path = join(home, "ledger.jsonl");
  if (!existsSync(path)) return { transparent: 0, steeredSkip: 0, hostDrop: 0 };
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  return {
    transparent: lines.filter((l) => l.includes('"class":"transparent"')).length,
    steeredSkip: lines.filter((l) => l.includes('"class":"steered-skip"')).length,
    hostDrop: lines.filter((l) => l.includes('"class":"host-drop"')).length,
  };
}

let fetchDepth = 0;
let prevFetch: typeof fetch | undefined;

export function installPlayMock(): () => void {
  if (fetchDepth++ === 0) {
    prevFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (url: string | URL | Request) => {
        if (String(url).includes("/v1/play")) {
          return new Response(JSON.stringify({ ok: true, table: "reviews=6 | status=pending" }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
      { preconnect: prevFetch?.preconnect },
    );
  }
  return () => {
    fetchDepth = Math.max(0, fetchDepth - 1);
    if (fetchDepth === 0 && prevFetch) globalThis.fetch = prevFetch;
  };
}

export function isolateHome(): { home: string; restore: () => void } {
  const prevHome = process.env.EDEN_HOME;
  const prevKey = process.env.EDEN_API_KEY;
  const prevSteer = process.env.EDEN_STEER_HOOKS;
  const prevT = process.env.EDEN_TRANSPARENT;
  const home = join(import.meta.dir, `../../.tmp-eden-opencode-drop-${crypto.randomUUID().slice(0, 8)}`);
  mkdirSync(join(home, "runs"), { recursive: true });
  process.env.EDEN_HOME = home;
  process.env.EDEN_API_KEY = "eden_dev";
  process.env.EDEN_TRANSPARENT = "1";
  delete process.env.EDEN_STEER_HOOKS;
  return {
    home,
    restore: () => {
      if (prevHome === undefined) delete process.env.EDEN_HOME;
      else process.env.EDEN_HOME = prevHome;
      if (prevKey === undefined) delete process.env.EDEN_API_KEY;
      else process.env.EDEN_API_KEY = prevKey;
      if (prevSteer === undefined) delete process.env.EDEN_STEER_HOOKS;
      else process.env.EDEN_STEER_HOOKS = prevSteer;
      if (prevT === undefined) delete process.env.EDEN_TRANSPARENT;
      else process.env.EDEN_TRANSPARENT = prevT;
      rmSync(home, { recursive: true, force: true });
    },
  };
}

export function prepareHome(home: string, liveTools: LiveTool[]): void {
  mkdirSync(join(home, "runs"), { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ api_key: "eden_dev", base_url: "http://127.0.0.1:8787" }));
  writeFileSync(join(home, "live-tools.json"), JSON.stringify(liveTools));
}

function isPreDeny(out: Record<string, unknown> | null | undefined): boolean {
  const inner = out?.hookSpecificOutput as { permissionDecision?: string } | undefined;
  return inner?.permissionDecision === "deny";
}

export type RunOpts = {
  calls?: OpenCodeCall[];
  liveTools?: LiveTool[];
  /** First-call result shape. `mcp` is the Wave 11 host-drop class. */
  firstResult?: "native" | "mcp";
  session?: string;
};

/**
 * One OpenCode-shaped stretch: lowercase tools, string (or MCP) after payload,
 * `applyOpenCodeAfter` as the host.
 */
export async function runOpenCodeStretch(opts: RunOpts = {}): Promise<StretchResult> {
  const iso = isolateHome();
  const liveTools = opts.liveTools ?? [COMPILABLE_PROGRAM];
  const calls = opts.calls ?? compilableCalls("101");
  const session = opts.session ?? `oc-${crypto.randomUUID().slice(0, 8)}`;
  const firstResult = opts.firstResult ?? "native";
  const remainder = new Set((liveTools[0]?.sequence ?? []).slice(1).map((s) => s.toLowerCase()));
  prepareHome(iso.home, liveTools);
  const uninstall = installPlayMock();
  const steps: StretchResult["steps"] = [];
  let executions = 0;
  let denies = 0;
  let remainderExecutions = 0;
  let droppedRewrites = 0;
  let ledger = { transparent: 0, steeredSkip: 0, hostDrop: 0 };

  try {
    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      const pre = (await respondToHook({
        hook_event_name: "tool.execute.before",
        sessionID: session,
        tool: call.tool,
        args: call.args,
      } as HookIn)) as Record<string, unknown>;

      if (isPreDeny(pre)) {
        denies++;
        steps.push({ tool: call.tool, denied: true, executed: false, visibleText: "", additionalContext: "" });
        continue;
      }

      const original = i === 0 && firstResult === "mcp" ? mcpShapedResult() : nativeString(call.tool);
      executions++;
      if (remainder.has(call.tool.toLowerCase())) remainderExecutions++;

      const post = (await respondToHook({
        hook_event_name: "tool.execute.after",
        sessionID: session,
        tool: call.tool,
        args: call.args,
        tool_response: original,
      } as HookIn)) as HookResponse;

      const applied = applyOpenCodeAfter(call.tool, original, post);
      if (applied.droppedRewrite) {
        droppedRewrites++;
        const hit = liveTools.find((t) => (t.sequence ?? [])[0]?.toLowerCase() === call.tool.toLowerCase()) ?? liveTools[0];
        appendLedgerRow({
          session,
          class: "host-drop",
          program: hit?.name,
          programId: hit?.id,
          tool: call.tool,
        });
      }
      const vis = typeof applied.visible === "string" ? applied.visible : JSON.stringify(applied.visible);
      steps.push({
        tool: call.tool,
        denied: false,
        executed: true,
        applied,
        visibleText: vis,
        additionalContext: applied.additionalContext,
      });
    }
    ledger = countLedger(iso.home);
  } finally {
    uninstall();
    iso.restore();
  }

  return {
    executions,
    denies,
    remainderExecutions,
    droppedRewrites,
    ledgerTransparent: ledger.transparent,
    ledgerSteeredSkip: ledger.steeredSkip,
    ledgerHostDrop: ledger.hostDrop,
    steps,
  };
}
