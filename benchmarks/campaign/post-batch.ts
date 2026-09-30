/**
 * Wave 15.4: PostToolBatch remainder on the live Claude Code hop.
 *
 * Claude Code does not call `respondToHook` in-process. settings.json curls
 * documented JSON to hookd (`PreToolUse` 1s, `PostToolBatch` warm chain) with
 * `tool_calls[]` whose `tool_response` is the serialized model-visible result
 * and whose inputs are native Read/Grep/Write fields (`file_path`, `pattern`)
 * — not a fake `issue` envelope key.
 *
 *   bun test benchmarks/campaign/post-batch.test.ts
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleHookd } from "../../packages/cli/src/hookd";
import { ensureHookdKey } from "../../packages/cli/src/hookd-key";
import { hookCommand, preHookCommand } from "../../packages/cli/src/setup";

export type PostBatchProbe = {
  mutate: number;
  grepDenied: boolean;
  writeDenied: boolean;
  batchDecision: unknown;
  via: "curl";
};

/** Documented Claude Code PostToolBatch body (hooks.md). */
export function claudePostToolBatch(session: string, filePath: string) {
  return {
    session_id: session,
    transcript_path: `/Users/me/.claude/projects/repo/00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl`,
    cwd: "/Users/me/repo",
    permission_mode: "default",
    hook_event_name: "PostToolBatch",
    tool_calls: [
      {
        tool_name: "Read",
        tool_input: { file_path: filePath },
        tool_use_id: "toolu_01ReadLive",
        tool_response: "     1\texport {}\n",
      },
      {
        tool_name: "Grep",
        tool_input: { pattern: "TODO", path: filePath },
        tool_use_id: "toolu_01GrepLive",
        tool_response: "repo/a.ts:1:export {}",
      },
      {
        tool_name: "Write",
        tool_input: { file_path: filePath, content: "export {}\n" },
        tool_use_id: "toolu_01WriteLive",
        tool_response: { type: "text", file: { filePath, success: true } },
      },
    ],
  };
}

function claudePreToolUse(session: string, tool_name: string, tool_input: Record<string, unknown>) {
  return {
    session_id: session,
    transcript_path: `/Users/me/.claude/projects/repo/00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl`,
    cwd: "/Users/me/repo",
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name,
    tool_input,
  };
}

function parseHookJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text.trim() || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Exact settings.json command: stdin JSON, stdout hook JSON, fail-open `{}`. */
export async function curlAsClaude(cmd: string, body: unknown): Promise<Record<string, unknown>> {
  const proc = Bun.spawn(["sh", "-c", cmd], {
    stdin: new Blob([JSON.stringify(body)]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, EDEN_HOOKD: "0" },
  });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return parseHookJson(text);
}

async function withLiveHookd<T>(fn: (cmds: { pre: string; warm: string; port: number }) => Promise<T>): Promise<T> {
  // `eden hookd` creates its key at start; an in-process hookd needs it before the hooks run.
  ensureHookdKey();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handleHookd });
  const port = server.port;
  try {
    return await fn({
      port,
      pre: preHookCommand(port),
      // If curl misses hookd, bun must not quietly succeed — a missing spawn
      // path makes the warm chain fall through to `{}` and the probe fails.
      warm: hookCommand("/must-not-spawn/cli.ts", port),
    });
  } finally {
    server.stop(true);
  }
}

function denied(body: Record<string, unknown>): boolean {
  return (body.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === "deny";
}

export async function probePostBatchRemainder(): Promise<PostBatchProbe> {
  const prevHome = process.env.EDEN_HOME;
  const prevSteer = process.env.EDEN_STEER_HOOKS;
  const home = join(import.meta.dir, `../../.tmp-eden-campaign-postbatch`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, "runs"), { recursive: true });
  process.env.EDEN_HOME = home;
  delete process.env.EDEN_STEER_HOOKS;
  const filePath = "/Users/me/repo/a.ts";
  writeFileSync(
    join(home, "live-tools.json"),
    JSON.stringify([
      {
        name: "pr_write",
        sequence: ["Read", "Grep", "Write"],
        id: "t-write",
      },
    ]),
  );
  let mutate = 0;
  const executeWrite = () => {
    mutate += 1;
    return { wrote: true };
  };
  try {
    return await withLiveHookd(async ({ pre, warm }) => {
      executeWrite();
      const batch = await curlAsClaude(warm, claudePostToolBatch("campaign-batch", filePath));
      const grep = await curlAsClaude(pre, claudePreToolUse("campaign-batch", "Grep", { pattern: "TODO", path: filePath }));
      const write = await curlAsClaude(pre, claudePreToolUse("campaign-batch", "Write", { file_path: filePath }));
      const writeDenied = denied(write);
      if (!writeDenied) executeWrite();
      return {
        mutate,
        grepDenied: denied(grep),
        writeDenied,
        batchDecision: batch.decision,
        via: "curl",
      };
    });
  } finally {
    if (prevHome === undefined) delete process.env.EDEN_HOME;
    else process.env.EDEN_HOME = prevHome;
    if (prevSteer === undefined) delete process.env.EDEN_STEER_HOOKS;
    else process.env.EDEN_STEER_HOOKS = prevSteer;
    rmSync(home, { recursive: true, force: true });
  }
}

/** Unique-work / empty live catalog: hookd PreToolUse must not deny. */
export async function probeHookdNoArm(live: unknown[]): Promise<{ grepDenied: boolean; writeDenied: boolean; via: "curl" }> {
  const prevHome = process.env.EDEN_HOME;
  const prevSteer = process.env.EDEN_STEER_HOOKS;
  const home = join(import.meta.dir, `../../.tmp-eden-campaign-postbatch-noop`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, "runs"), { recursive: true });
  process.env.EDEN_HOME = home;
  delete process.env.EDEN_STEER_HOOKS;
  const filePath = "/Users/me/repo/a.ts";
  writeFileSync(join(home, "live-tools.json"), JSON.stringify(live));
  try {
    return await withLiveHookd(async ({ pre, warm }) => {
      await curlAsClaude(warm, claudePostToolBatch("campaign-unique", filePath));
      const grep = await curlAsClaude(pre, claudePreToolUse("campaign-unique", "Grep", { pattern: "TODO", path: filePath }));
      const write = await curlAsClaude(pre, claudePreToolUse("campaign-unique", "Write", { file_path: filePath }));
      return { grepDenied: denied(grep), writeDenied: denied(write), via: "curl" };
    });
  } finally {
    if (prevHome === undefined) delete process.env.EDEN_HOME;
    else process.env.EDEN_HOME = prevHome;
    if (prevSteer === undefined) delete process.env.EDEN_STEER_HOOKS;
    else process.env.EDEN_STEER_HOOKS = prevSteer;
    rmSync(home, { recursive: true, force: true });
  }
}

/** Drive-by Origin over the same HTTP hop Claude uses. */
export async function probeBrowserOrigin(): Promise<number> {
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handleHookd });
  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/hook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify(claudePostToolBatch("browser", "/Users/me/repo/a.ts")),
    });
    return res.status;
  } finally {
    server.stop(true);
  }
}
