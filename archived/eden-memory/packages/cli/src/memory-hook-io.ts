/**
 * What every memory hook entry point shares (`memory-hook.ts`, and the PreToolUse guard's `memory-guard-hook.ts`):
 * the payload on stdin, the memory root, the window and repo of an event, and the wide event each invocation logs.
 * Kept apart from `memory-hook.ts`, so the guard, which runs before every matching command, loads none of the store.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { childSessionName } from "../../../src/memory-session";
import { tripIfOverBudget } from "../../../src/memory-breaker";
import { memoryNow } from "../../../src/memory-clock";
import { appendWideEvent, type WideEvent } from "../../../src/memory-events";
import { flagModes, type FlagState } from "../../../src/memory-flags";
import { repoIdentity, type RepoIdentity } from "../../../src/memory-repo";
import { recordStart, startCwd } from "../../../src/memory-window";

export function asRec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The memory root: `EDEN_MEMORY_DIR`, else `$EDEN_HOME/memory`, else `~/.eden/memory`. */
export function memoryRoot(): string {
  if (process.env.EDEN_MEMORY_DIR) return process.env.EDEN_MEMORY_DIR;
  return process.env.EDEN_HOME ? join(process.env.EDEN_HOME, "memory") : join(homedir(), ".eden", "memory");
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

/** What one invocation logs (`memory-events.ts`), filled in as the handler runs; `aborted` only when it was. */
export type Trace = Omit<WideEvent, "t" | "ms" | "aborted" | "flags"> & { aborted?: true };

/**
 * Appends the invocation's wide event; after an exception or a budget abort at a delivery point, the breaker checks
 * its budget.
 */
export function logInvocation(trace: Trace, flags: FlagState | undefined, ms: number): void {
  try {
    const root = memoryRoot(),
      t = memoryNow();
    appendWideEvent(root, {
      t,
      ...trace,
      ...(flags ? { flags: flagModes(flags) } : {}),
      ms: Math.round(ms * 100) / 100,
      aborted: trace.aborted === true,
    });
    if ((trace.err || trace.aborted) && trace.point && flags) tripIfOverBudget(root, trace.point, flags, t);
  } catch {}
}

/**
 * The window a hook payload belongs to (D2): its session, or `session--agent` in a subagent (`child`), and the
 * session it runs in (`parent`).
 */
export function resolveSession(
  r: Record<string, unknown>,
  event: string,
): { session?: string; parent?: string; child: boolean } {
  try {
    const parent = [
        r.session_id,
        r.sessionID,
        r.sessionId,
        r.parent_session_id,
        process.env.EDEN_MEMORY_PARENT,
        process.env.EDEN_MEMORY_SESSION,
      ]
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .find(Boolean),
      childId = [r.agent_id, r.agentId, r.subagent_id, r.subagentId, r.child_session_id, process.env.EDEN_MEMORY_CHILD]
        .map((v) => (typeof v === "string" ? v.trim() : ""))
        .find(Boolean);
    const asChild = event === "SubagentStop" || !!(childId && childId !== parent),
      session = asChild ? childSessionName(parent, childId || "sub") : parent;
    return { session: asChild && session ? session : parent, parent, child: !!(asChild && session) };
  } catch {
    return { child: false };
  }
}

/**
 * The repo of an event (D1). Outside git it is the directory the session started in: SessionStart records it in
 * the session's window (`starting`), and later events, a subagent's included, read it back.
 */
export function eventRepo(cwd: string, sessionWin: string | undefined, starting: boolean): RepoIdentity | undefined {
  const repo = repoIdentity(cwd, () => (starting || !sessionWin ? undefined : startCwd(sessionWin)));
  if (repo && !repo.top && starting && sessionWin)
    try {
      recordStart(sessionWin, cwd);
    } catch {}
  return repo;
}

/** The transcript a payload names. */
export function transcriptOf(r: Record<string, unknown>): string {
  return str(r.transcript_path) ?? str(r.transcriptPath) ?? "";
}

/** The hook payload on stdin; `{}` when it is missing or not JSON. */
export async function readHookPayload(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(
      (await new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        process.stdin.on("data", (c) => chunks.push(c as Buffer));
        process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        if (process.stdin.isTTY) resolve("{}");
      })) || "{}",
    ) as Record<string, unknown>;
  } catch {
    return {};
  }
}
