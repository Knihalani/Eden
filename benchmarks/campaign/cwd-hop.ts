/**
 * Wave 17.1 rotation: cwd-relative remainder hop.
 *
 * Claude Code curls documented JSON to hookd. The body carries `cwd` and a
 * relative native `file_path` (`./a.ts`). The next PreToolUse Write uses the
 * absolute form (`path.resolve(cwd, "./a.ts")`). Remainder must join against
 * cwd so the two identities claim. Traversal `../other` must not. Mixed-file
 * noise must not steal the program head. A disagreeing `id` still refuses.
 *
 * Not a retune of `post-batch` (that world arms and claims the same absolute
 * string). This world is the relative/abs hop the live Claude payload actually
 * sends.
 *
 *   bun test benchmarks/campaign/cwd-hop.test.ts
 *
 * Pre-registered expect (ROADMAP §4.9) is `EXPECT` below.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { handleHookd } from "../../packages/cli/src/hookd";
import { ensureHookdKey } from "../../packages/cli/src/hookd-key";
import { hookCommand, preHookCommand } from "../../packages/cli/src/setup";

/**
 * Pre-registered Wave 17 rotation verdict. Recorded before the run.
 * expect: cwd-hop relative ./a.ts arms; abs claims; disagreeing id refuses; mixed-file takes head; ../other does not; not post-batch.
 */
export const EXPECT =
  "cwd-hop: relative ./a.ts arms; abs /Users/me/repo/a.ts claims; disagreeing id refuses; mixed-file takes head; ../other does not claim; not post-batch";

export const CWD = "/Users/me/repo";
export const RELATIVE = "./a.ts";
/** Independent of remainder — Node path.resolve is the locked identity. */
export const ABSOLUTE = resolve(CWD, RELATIVE);

export type CwdHopProbe = {
  expect: typeof EXPECT;
  via: "curl";
  relativeVsAbsClaim: 0 | 1;
  sameStringRelativeClaim: 0 | 1;
  disagreeingIdClaim: 0 | 1;
  mixedHeadClaim: 0 | 1;
  mixedOtherClaim: 0 | 1;
  traversalClaim: 0 | 1;
  traversalAbsClaim: 0 | 1;
  batchDecision: unknown;
};

function claudePostToolBatch(session: string, filePath: string, extra?: { id?: string; mixedOther?: string }) {
  const id = extra?.id;
  const withId = (rec: Record<string, unknown>) => (id ? { ...rec, id } : rec);
  const other = extra?.mixedOther;
  return {
    session_id: session,
    transcript_path: `/Users/me/.claude/projects/repo/00893aaf-19fa-41d2-8238-13269b9b3ca0.jsonl`,
    cwd: CWD,
    permission_mode: "default",
    hook_event_name: "PostToolBatch",
    tool_calls: [
      ...(other
        ? [
            {
              tool_name: "Grep",
              tool_input: withId({ pattern: "TODO", path: other }),
              tool_use_id: "toolu_01GrepOther",
              tool_response: "repo/other.ts:1:export {}",
            },
          ]
        : []),
      {
        tool_name: "Read",
        tool_input: withId({ file_path: filePath }),
        tool_use_id: "toolu_01ReadLive",
        tool_response: "     1\texport {}\n",
      },
      {
        tool_name: "Grep",
        tool_input: withId({ pattern: "TODO", path: filePath }),
        tool_use_id: "toolu_01GrepLive",
        tool_response: "repo/a.ts:1:export {}",
      },
      {
        tool_name: "Write",
        tool_input: withId({ file_path: filePath, content: "export {}\n" }),
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
    cwd: CWD,
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
      warm: hookCommand("/must-not-spawn/cli.ts", port),
    });
  } finally {
    server.stop(true);
  }
}

function denied(body: Record<string, unknown>): boolean {
  return (body.hookSpecificOutput as { permissionDecision?: string } | undefined)?.permissionDecision === "deny";
}

function bit(ok: boolean): 0 | 1 {
  return ok ? 1 : 0;
}

const LIVE = [
  {
    name: "pr_write",
    sequence: ["Read", "Grep", "Write"],
    id: "t-write",
  },
];

async function withCampaignHome<T>(tag: string, fn: () => Promise<T>): Promise<T> {
  const prevHome = process.env.EDEN_HOME;
  const prevSteer = process.env.EDEN_STEER_HOOKS;
  const home = join(import.meta.dir, `../../.tmp-eden-campaign-cwdhop-${tag}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, "runs"), { recursive: true });
  process.env.EDEN_HOME = home;
  delete process.env.EDEN_STEER_HOOKS;
  writeFileSync(join(home, "live-tools.json"), JSON.stringify(LIVE));
  try {
    return await fn();
  } finally {
    if (prevHome === undefined) delete process.env.EDEN_HOME;
    else process.env.EDEN_HOME = prevHome;
    if (prevSteer === undefined) delete process.env.EDEN_STEER_HOOKS;
    else process.env.EDEN_STEER_HOOKS = prevSteer;
    rmSync(home, { recursive: true, force: true });
  }
}

/**
 * Primary hop: arm relative `./a.ts` over hookd, claim the absolute form.
 * Same-string relative still claims. Hard cases share the curl hop.
 */
export async function probeCwdHop(): Promise<CwdHopProbe> {
  return withCampaignHome("main", async () =>
    withLiveHookd(async ({ pre, warm }) => {
      const batch = await curlAsClaude(warm, claudePostToolBatch("cwd-hop-abs", RELATIVE));
      const absWrite = await curlAsClaude(pre, claudePreToolUse("cwd-hop-abs", "Write", { file_path: ABSOLUTE }));

      await curlAsClaude(warm, claudePostToolBatch("cwd-hop-rel", RELATIVE));
      const relWrite = await curlAsClaude(pre, claudePreToolUse("cwd-hop-rel", "Write", { file_path: RELATIVE }));

      await curlAsClaude(warm, claudePostToolBatch("cwd-hop-id", RELATIVE, { id: "E-1" }));
      const disagree = await curlAsClaude(
        pre,
        claudePreToolUse("cwd-hop-id", "Write", { file_path: ABSOLUTE, id: "E-2" }),
      );

      await curlAsClaude(warm, claudePostToolBatch("cwd-hop-mix", RELATIVE, { mixedOther: "./other.ts" }));
      // Other path first: if the batch wrongly armed ./other.ts, this denies and mixedOtherClaim=1.
      const mixOther = await curlAsClaude(
        pre,
        claudePreToolUse("cwd-hop-mix", "Write", { file_path: resolve(CWD, "./other.ts") }),
      );
      const mixHead = await curlAsClaude(pre, claudePreToolUse("cwd-hop-mix", "Write", { file_path: ABSOLUTE }));

      await curlAsClaude(warm, claudePostToolBatch("cwd-hop-trav", RELATIVE));
      const trav = await curlAsClaude(pre, claudePreToolUse("cwd-hop-trav", "Write", { file_path: "../other" }));
      // Traversal must miss without consuming the a.ts arming.
      const travAbs = await curlAsClaude(pre, claudePreToolUse("cwd-hop-trav", "Write", { file_path: ABSOLUTE }));

      return {
        expect: EXPECT,
        via: "curl" as const,
        relativeVsAbsClaim: bit(denied(absWrite)),
        sameStringRelativeClaim: bit(denied(relWrite)),
        disagreeingIdClaim: bit(denied(disagree)),
        mixedHeadClaim: bit(denied(mixHead)),
        mixedOtherClaim: bit(denied(mixOther)),
        traversalClaim: bit(denied(trav)),
        traversalAbsClaim: bit(denied(travAbs)),
        batchDecision: batch.decision,
      };
    }),
  );
}
